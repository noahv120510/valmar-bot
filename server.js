require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const plivo = require('plivo');

const { synthesize } = require('./lib/elevenlabs');
const { nextTurn, OPENING_PITCH } = require('./lib/brain');
const { addToDnc } = require('./lib/dnc');

const PORT = Number(process.env.PORT) || 3003;
const BASE_URL = (process.env.WEBHOOK_URL || '').replace(/\/+$/, '');
const VERIFY_SIGNATURE = process.env.VERIFY_PLIVO_SIGNATURE !== 'false';
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
};
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
    const hash = crypto.createHash('sha1').update(text + process.env.ELEVEN_LABS_VOICE_ID).digest('hex').slice(0, 10);
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

// Plivo hits this when the prospect picks up.
app.post('/plivo/answer', verifyPlivo, (req, res) => {
  const call = getCall(req.body);
  console.log(`[${call.uuid}] answered by ${call.to}`);
  sendXml(res, playAndListen(staticAudio.pitch));
});

// Plivo posts the prospect's transcribed speech here.
app.post('/plivo/respond', verifyPlivo, async (req, res) => {
  const call = getCall(req.body);
  const speech = (req.body.Speech || '').trim();

  if (!speech) return handleSilence(call, res);
  call.silences = 0;
  call.transcript.push({ speaker: 'prospect', text: speech });
  console.log(`[${call.uuid}] prospect: ${speech}`);

  try {
    const reply = await nextTurn(call.history, speech);
    call.transcript.push({ speaker: 'bot', text: reply.say });
    console.log(`[${call.uuid}] bot: ${reply.say}${reply.end_call ? ' [END]' : ''}${reply.do_not_call ? ' [DNC]' : ''}`);

    if (reply.do_not_call) {
      addToDnc(call.to);
      call.doNotCall = true;
    }

    const fileName = `${call.uuid}-${call.audioFiles.length}.mp3`;
    const audioUrl = await saveAudio(fileName, reply.say);
    call.audioFiles.push(fileName);

    sendXml(res, reply.end_call ? playAndHangup(audioUrl) : playAndListen(audioUrl));
  } catch (err) {
    console.error(`[${call.uuid}] turn failed:`, err);
    sendXml(res, playAndListen(staticAudio.retry));
  }
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
    app.listen(PORT, () => {
      console.log(`Valmar bot listening on port ${PORT}`);
      console.log(`Answer URL: ${BASE_URL}/plivo/answer`);
      console.log(`Pitch audio: ${staticAudio.pitch}`);
    });
  })
  .catch((err) => {
    console.error('Could not generate voice audio from ElevenLabs:', err.message);
    process.exit(1);
  });
