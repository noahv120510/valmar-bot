require('dotenv').config();

const crypto = require('crypto');
const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const express = require('express');
const plivo = require('plivo');

const { synthesize, OUTPUT_FORMAT } = require('./lib/elevenlabs');
const { streamTurn, OPENING_PITCH, MODEL } = require('./lib/brain');
const { addToDnc } = require('./lib/dnc');
const { placeCall } = require('./lib/dialer');

const PORT = Number(process.env.PORT) || 3003;
const BASE_URL = (process.env.WEBHOOK_URL || '').replace(/\/+$/, '');
const VERIFY_SIGNATURE = process.env.VERIFY_PLIVO_SIGNATURE !== 'false';
const USE_FILLERS = process.env.FILLERS !== 'false';
const AUDIO_DIR = path.join(__dirname, 'audio');
const CALL_LOG_DIR = path.join(__dirname, 'call-logs');

if (!BASE_URL) {
  console.error('WEBHOOK_URL is not set in .env (your ngrok URL)');
  process.exit(1);
}
fs.mkdirSync(AUDIO_DIR, { recursive: true });
fs.mkdirSync(CALL_LOG_DIR, { recursive: true });

// Fixed lines are synthesized once at startup, so the pitch plays the instant the call connects.
const STATIC_LINES = {
  pitch: OPENING_PITCH,
  reprompt: "Sorry, I didn't catch that. Who handles payment processing for your business?",
  retry: 'Sorry, could you say that one more time?',
  goodbye: "No worries, I'll let you go. Have a great day.",
  // Quick acknowledgements played the instant the prospect stops talking, while the real reply is generated.
  filler0: 'Mm-hmm.',
  filler1: 'Gotcha.',
  filler2: 'Okay.',
  filler3: 'Yeah, okay.',
};
const FILLER_NAMES = Object.keys(STATIC_LINES).filter((name) => name.startsWith('filler'));
const staticAudio = {}; // name -> public URL

// Active calls, keyed by Plivo CallUUID.
const calls = new Map();

function getCall(body) {
  const uuid = body.CallUUID;
  if (!calls.has(uuid)) {
    calls.set(uuid, {
      uuid,
      to: body.To,
      startedAt: new Date().toISOString(),
      history: [],
      transcript: [{ speaker: 'bot', text: OPENING_PITCH }],
      audioFiles: [],
      silences: 0,
      turnCount: 0,
      turn: null,
    });
  }
  return calls.get(uuid);
}

async function saveAudio(fileName, text) {
  const audio = await synthesize(text);
  fs.writeFileSync(path.join(AUDIO_DIR, fileName), audio);
  return `${BASE_URL}/audio/${fileName}`;
}

async function prepareStaticAudio() {
  for (const [name, text] of Object.entries(STATIC_LINES)) {
    // The hash in the file name means editing a line regenerates its audio.
    const hash = crypto
      .createHash('sha1')
      .update([text, process.env.ELEVEN_LABS_VOICE_ID, process.env.ELEVEN_LABS_MODEL, OUTPUT_FORMAT].join('|'))
      .digest('hex')
      .slice(0, 10);
    const fileName = `static-${name}-${hash}.mp3`;
    if (fs.existsSync(path.join(AUDIO_DIR, fileName))) {
      staticAudio[name] = `${BASE_URL}/audio/${fileName}`;
    } else {
      staticAudio[name] = await saveAudio(fileName, text);
      console.log(`Generated ${name} audio`);
    }
  }
}

// ---- Plivo XML ----

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

// Play audio, then listen for the prospect's reply. If they say nothing, Plivo falls through to the Redirect.
function playAndListen(audioUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(`${BASE_URL}/plivo/respond`)}" method="POST" inputType="speech" language="en-US" executionTimeout="10" speechEndTimeout="auto">
    <Play>${escapeXml(audioUrl)}</Play>
  </GetInput>
  <Redirect method="POST">${escapeXml(`${BASE_URL}/plivo/no-input`)}</Redirect>
</Response>`;
}

// Listen without playing anything first (used when the reply's audio has already played).
function listenOnly() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(`${BASE_URL}/plivo/respond`)}" method="POST" inputType="speech" language="en-US" executionTimeout="10" speechEndTimeout="auto"/>
  <Redirect method="POST">${escapeXml(`${BASE_URL}/plivo/no-input`)}</Redirect>
</Response>`;
}

// Play one piece of a reply, then fetch the next piece (which is usually ready by then).
function playAndContinue(audioUrl, nextUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Redirect method="POST">${escapeXml(nextUrl)}</Redirect>
</Response>`;
}

function hangupOnly() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`;
}

function playAndHangup(audioUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Play>${escapeXml(audioUrl)}</Play>
  <Hangup/>
</Response>`;
}

// ---- Server ----

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/audio', express.static(AUDIO_DIR));

// Reject webhook requests that weren't signed by Plivo with your auth token.
function verifyPlivo(req, res, next) {
  if (!VERIFY_SIGNATURE) return next();
  const signature = req.get('X-Plivo-Signature-V3');
  const nonce = req.get('X-Plivo-Signature-V3-Nonce');
  const url = `${BASE_URL}${req.originalUrl}`;
  const valid =
    signature &&
    nonce &&
    plivo.validateV3Signature(req.method, url, nonce, process.env.PLIVO_AUTH_TOKEN, signature, req.body);
  if (!valid) {
    console.warn(`Rejected unsigned request to ${req.originalUrl}`);
    return res.status(403).send('Invalid signature');
  }
  next();
}

function sendXml(res, xml) {
  res.type('application/xml').send(xml);
}

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: calls.size }));

// ---- Control page (only reachable from this computer, never through ngrok) ----

function localOnly(req, res, next) {
  const fromLoopback = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
  const viaTunnel = req.get('X-Forwarded-For') || req.get('X-Forwarded-Host') || req.get('ngrok-skip-browser-warning');
  const localHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.get('Host') || '');
  if (fromLoopback && !viaTunnel && localHost) return next();
  res.status(404).send('Not found');
}

app.get('/', localOnly, (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/call', localOnly, express.json(), async (req, res) => {
  try {
    const result = await placeCall(req.body.phone_number);
    console.log(`Dialing ${result.to} from ${result.from}`);
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Call failed:', err.message || err);
    res.status(400).json({ success: false, error: err.message || String(err) });
  }
});

app.get('/api/calls', localOnly, (req, res) => {
  const active = [...calls.values()].map((c) => ({ callUuid: c.uuid, to: c.to, startedAt: c.startedAt, active: true, transcript: c.transcript }));
  const past = fs
    .readdirSync(CALL_LOG_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(CALL_LOG_DIR, f), 'utf8')))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20);
  res.json([...active, ...past]);
});

// Plivo hits this when the prospect picks up.
app.post('/plivo/answer', verifyPlivo, (req, res) => {
  const call = getCall(req.body);
  console.log(`[${call.uuid}] answered by ${call.to}`);
  sendXml(res, playAndListen(staticAudio.pitch));
});

// ---- Replies ----
// A reply is streamed: Claude's first sentence is turned into audio while Claude writes the rest,
// and Plivo plays each piece as soon as it's ready.

function waitFor(turn, ready, timeoutMs = Infinity) {
  if (ready()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let timer;
    const check = () => {
      if (!ready()) return;
      clearTimeout(timer);
      turn.events.off('change', check);
      resolve(true);
    };
    turn.events.on('change', check);
    if (timeoutMs !== Infinity) {
      timer = setTimeout(() => {
        turn.events.off('change', check);
        resolve(false);
      }, timeoutMs);
    }
  });
}

function startTurn(call, speech) {
  const turn = {
    id: String(call.turnCount++),
    segments: [], // promises of audio URLs, in speaking order
    done: false,
    endCall: false,
    events: new EventEmitter(),
    startedAt: Date.now(),
  };
  call.turn = turn;
  const changed = () => turn.events.emit('change');

  const onSegment = (text) => {
    const index = turn.segments.length;
    const fileName = `${call.uuid}-${turn.id}-${index}.mp3`;
    call.audioFiles.push(fileName);
    const textAt = Date.now();
    const audio = saveAudio(fileName, text).then((url) => {
      if (index === 0) {
        const now = Date.now();
        console.log(
          `[${call.uuid}] first audio ready ${now - turn.startedAt}ms after they stopped talking ` +
            `(Claude ${textAt - turn.startedAt}ms, first word at ${turn.firstTokenMs}ms + voice ${now - textAt}ms)`,
        );
      }
      return url;
    });
    audio.catch(() => {}); // errors are handled where the audio is played
    turn.segments.push(audio);
    changed();
  };

  streamTurn(call.history, speech, onSegment, () => (turn.firstTokenMs = Date.now() - turn.startedAt))
    .then((reply) => {
      turn.endCall = reply.endCall;
      call.transcript.push({ speaker: 'bot', text: reply.text });
      console.log(`[${call.uuid}] bot: ${reply.text}${reply.endCall ? ' [END]' : ''}${reply.doNotCall ? ' [DNC]' : ''}`);
      if (reply.doNotCall) {
        addToDnc(call.to);
        call.doNotCall = true;
      }
    })
    .catch((err) => console.error(`[${call.uuid}] Claude failed:`, err.message || err))
    .finally(() => {
      turn.done = true;
      changed();
    });

  return turn;
}

// Plivo XML for piece number `index` of a reply.
async function replyXml(call, turn, index) {
  await waitFor(turn, () => turn.segments.length > index || turn.done);

  if (turn.segments.length <= index) {
    // Nothing more to say. If nothing was said at all, Claude failed: ask them to repeat.
    if (index === 0) return playAndListen(staticAudio.retry);
    return turn.endCall ? hangupOnly() : listenOnly();
  }

  let audioUrl;
  try {
    audioUrl = await turn.segments[index];
  } catch (err) {
    console.error(`[${call.uuid}] voice failed:`, err.message || err);
    if (index === 0) return playAndListen(staticAudio.retry);
    return turn.endCall ? hangupOnly() : listenOnly();
  }

  // Claude usually finishes while this piece's audio is generated. Wait briefly to find out whether
  // this is the last piece, so it can play inside GetInput (or before the hang-up) without an extra hop.
  await waitFor(turn, () => turn.segments.length > index + 1 || turn.done, 1500);
  const isLast = turn.done && turn.segments.length === index + 1;
  if (isLast) return turn.endCall ? playAndHangup(audioUrl) : playAndListen(audioUrl);
  return playAndContinue(audioUrl, `${BASE_URL}/plivo/reply/${turn.id}/${index + 1}`);
}

// Plivo posts the prospect's transcribed speech here.
app.post('/plivo/respond', verifyPlivo, async (req, res) => {
  const call = getCall(req.body);
  const speech = (req.body.Speech || '').trim();

  if (!speech) return handleSilence(call, res);
  call.silences = 0;
  call.transcript.push({ speaker: 'prospect', text: speech });
  console.log(`[${call.uuid}] prospect: ${speech}`);

  const turn = startTurn(call, speech);
  if (USE_FILLERS) {
    // Answer Plivo instantly with a quick "mm-hmm" while the real reply is generated.
    const filler = FILLER_NAMES[Math.floor(Math.random() * FILLER_NAMES.length)];
    return sendXml(res, playAndContinue(staticAudio[filler], `${BASE_URL}/plivo/reply/${turn.id}/0`));
  }
  sendXml(res, await replyXml(call, turn, 0));
});

// Plivo fetches each further piece of a reply here.
app.post('/plivo/reply/:turnId/:index', verifyPlivo, async (req, res) => {
  const call = calls.get(req.body.CallUUID);
  if (!call || !call.turn || call.turn.id !== req.params.turnId) return sendXml(res, listenOnly());
  sendXml(res, await replyXml(call, call.turn, Number(req.params.index)));
});

// GetInput timed out with no speech.
app.post('/plivo/no-input', verifyPlivo, (req, res) => handleSilence(getCall(req.body), res));

function handleSilence(call, res) {
  call.silences += 1;
  if (call.silences >= 2) {
    console.log(`[${call.uuid}] no response, hanging up`);
    return sendXml(res, playAndHangup(staticAudio.goodbye));
  }
  sendXml(res, playAndListen(staticAudio.reprompt));
}

// Plivo hits this when the call ends: save the transcript and clean up audio.
app.post('/plivo/hangup', verifyPlivo, (req, res) => {
  const call = calls.get(req.body.CallUUID);
  console.log(`[${req.body.CallUUID}] ended: ${req.body.HangupCause || 'unknown'} (${req.body.Duration || 0}s)`);
  if (call) {
    const log = {
      callUuid: call.uuid,
      to: call.to,
      startedAt: call.startedAt,
      endedAt: new Date().toISOString(),
      durationSeconds: Number(req.body.Duration) || 0,
      hangupCause: req.body.HangupCause,
      doNotCall: Boolean(call.doNotCall),
      transcript: call.transcript,
    };
    fs.writeFileSync(path.join(CALL_LOG_DIR, `${call.uuid}.json`), JSON.stringify(log, null, 2));
    for (const file of call.audioFiles) fs.rm(path.join(AUDIO_DIR, file), { force: true }, () => {});
    calls.delete(call.uuid);
  }
  res.sendStatus(200);
});

prepareStaticAudio()
  .then(() => {
    app.listen(PORT, (err) => {
      if (err) {
        console.error(
          err.code === 'EADDRINUSE'
            ? `Port ${PORT} is already in use. Another copy of the bot (or the old server) is still running: press Control + C in that Terminal tab, then run npm start again.`
            : `Could not start the server: ${err.message}`,
        );
        process.exit(1);
      }
      console.log(`Valmar bot listening on port ${PORT}`);
      console.log(`Control page: http://localhost:${PORT}`);
      console.log(`Answer URL: ${BASE_URL}/plivo/answer`);
      console.log(`Pitch audio: ${staticAudio.pitch}`);
      console.log(`Claude model: ${MODEL}${USE_FILLERS ? '' : ' (fillers off)'}`);
    });
  })
  .catch((err) => {
    console.error('Could not generate voice audio from ElevenLabs:', err.message);
    process.exit(1);
  });
