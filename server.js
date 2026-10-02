require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const plivo = require('plivo');
const WebSocket = require('ws');

const { synthesize, OUTPUT_FORMAT } = require('./lib/elevenlabs');
const { streamTurn, OPENING_PITCH, OPENING_GREETING, MODEL } = require('./lib/brain');
const { addToDnc } = require('./lib/dnc');
const { placeCall } = require('./lib/dialer');
const { handleStream } = require('./lib/streaming');
const { initEmailService, sendCreditCardReceipt, sendSalesEmail, sendBulkEmails } = require('./lib/email');

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

const staticAudio = {}; // name -> public URL (only pitch, for fallback mode)

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
      transcript: [{ speaker: 'bot', text: OPENING_GREETING }],
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
  // Generate opening greeting
  const text = OPENING_GREETING;
  const hash = crypto
    .createHash('sha1')
    .update([text, process.env.ELEVEN_LABS_VOICE_ID, process.env.ELEVEN_LABS_MODEL, OUTPUT_FORMAT].join('|'))
    .digest('hex')
    .slice(0, 10);
  const fileName = `static-greeting-${hash}.mp3`;
  if (fs.existsSync(path.join(AUDIO_DIR, fileName))) {
    staticAudio.greeting = `${BASE_URL}/audio/${fileName}`;
  } else {
    staticAudio.greeting = await saveAudio(fileName, text);
    console.log('Generated greeting audio');
  }
}

// ---- Server ----

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c]);
}

const app = express();
require('express-ws')(app);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
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

function playAndGetInput(audioUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <GetInput action="${escapeXml(`${BASE_URL}/plivo/respond`)}" method="POST" inputType="speech" language="en-US" executionTimeout="10" speechEndTimeout="auto">
    <Play>${escapeXml(audioUrl)}</Play>
  </GetInput>
  <Redirect method="POST">${escapeXml(`${BASE_URL}/plivo/no-input`)}</Redirect>
</Response>`;
}

function handleSilence(res) {
  sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Hangup/>
</Response>`);
}

app.get('/health', (req, res) => res.json({ ok: true, activeCalls: calls.size }));

// ---- Email service endpoints ----

app.post('/api/send-receipt', express.json(), async (req, res) => {
  try {
    const result = await sendCreditCardReceipt(req.body);
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    console.error('Failed to send receipt:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/send-sales-email', express.json(), async (req, res) => {
  try {
    const result = await sendSalesEmail(req.body);
    res.json({ success: true, messageId: result.messageId });
  } catch (err) {
    console.error('Failed to send sales email:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

app.post('/api/send-bulk-emails', express.json(), async (req, res) => {
  try {
    const { emails, template } = req.body;
    if (!Array.isArray(emails)) {
      return res.status(400).json({ success: false, error: 'emails must be an array' });
    }
    const results = await sendBulkEmails(emails, template);
    const successful = results.filter(r => r.success).length;
    res.json({
      success: true,
      total: results.length,
      successful,
      failed: results.length - successful,
      results
    });
  } catch (err) {
    console.error('Failed to send bulk emails:', err.message);
    res.status(400).json({ success: false, error: err.message });
  }
});

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
  // Use streaming if Deepgram is configured, otherwise fall back to XML
  if (process.env.DEEPGRAM_API_KEY) {
    sendXml(res, `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Stream bidirectional="true" audioFormat="mulaw" audioFrequency="8000">${escapeXml(`${BASE_URL}/plivo/stream/${call.uuid}`)}</Stream>
</Response>`);
  } else {
    sendXml(res, playAndGetInput(staticAudio.greeting));
  }
});

// ---- Fallback XML mode endpoints (used when DEEPGRAM_API_KEY not set) ----
app.post('/plivo/respond', verifyPlivo, (req, res) => {
  handleSilence(res);
});

app.post('/plivo/no-input', verifyPlivo, (req, res) => {
  handleSilence(res);
});

// ---- Real-time streaming via WebSocket ----
app.ws('/plivo/stream/:callUuid', (plivoWs, req) => {
  const callUuid = req.params.callUuid;
  const call = calls.get(callUuid);
  if (!call) {
    console.error(`[stream] unknown call: ${callUuid}`);
    plivoWs.close();
    return;
  }
  console.log(`[${callUuid}] streaming started`);
  handleStream(plivoWs, call.history, call.transcript).catch((err) => {
    console.error(`[${callUuid}] streaming error:`, err.message);
  });
});

// Plivo hits this when the call ends: save the transcript.
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
    calls.delete(call.uuid);
  }
  res.sendStatus(200);
});

Promise.all([prepareStaticAudio(), initEmailService()])
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
      console.log('Email service ready - endpoints: /api/send-receipt, /api/send-sales-email, /api/send-bulk-emails');
    });
  })
  .catch((err) => {
    console.error('Could not start server:', err.message);
    process.exit(1);
  });
