// Real-time bidirectional audio streaming with Deepgram + Claude + ElevenLabs.
const WebSocket = require('ws');
const { synthesize } = require('./elevenlabs');
const { streamTurn, OPENING_GREETING } = require('./brain');

// Deepgram WebSocket connection for speech-to-text
async function connectDeepgram(apiKey, model = 'nova-2') {
  return new Promise((resolve, reject) => {
    const dgWs = new WebSocket(
      `wss://api.deepgram.com/v1/listen?model=${model}&encoding=mulaw&sample_rate=8000&vad=true`,
      { headers: { Authorization: `Token ${apiKey}` } },
    );
    dgWs.on('open', () => resolve(dgWs));
    dgWs.on('error', reject);
  });
}

// Convert MP3 to mulaw (Plivo's format). This is a simplified approach using ffmpeg.
// For production, use a proper audio codec library.
async function mp3ToMulaw(mp3Buffer) {
  const { spawnSync } = require('child_process');
  const fs = require('fs');
  const tmpInput = `/tmp/in-${Date.now()}.mp3`;
  const tmpOutput = `/tmp/out-${Date.now()}.mulaw`;
  fs.writeFileSync(tmpInput, mp3Buffer);
  try {
    spawnSync('ffmpeg', [
      '-i', tmpInput,
      '-acodec', 'pcm_mulaw',
      '-ar', '8000',
      '-ac', '1',
      tmpOutput,
    ], { stdio: 'pipe' });
    const mulaw = fs.readFileSync(tmpOutput);
    fs.rmSync(tmpInput, { force: true });
    fs.rmSync(tmpOutput, { force: true });
    return mulaw;
  } catch (err) {
    console.error('Audio conversion failed:', err.message);
    return Buffer.alloc(0);
  }
}

// Handle a live call via Plivo's WebSocket
async function handleStream(plivoWs, history, transcript) {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) {
    console.error('DEEPGRAM_API_KEY not set');
    plivoWs.close();
    return;
  }

  let dgWs;
  let prospectSaid = '';
  let responseInProgress = false;
  let lastTranscriptTime = 0;

  try {
    dgWs = await connectDeepgram(deepgramApiKey);
    console.log('[stream] connected to Deepgram');
  } catch (err) {
    console.error('[stream] Deepgram connection failed:', err.message);
    plivoWs.close();
    return;
  }

  // Play the opening greeting first
  try {
    const greetingMp3 = await synthesize(OPENING_GREETING);
    const greetingMulaw = await mp3ToMulaw(greetingMp3);
    plivoWs.send(JSON.stringify({
      event: 'playback',
      payload: greetingMulaw.toString('base64'),
    }));
    console.log('[stream] sent greeting');
  } catch (err) {
    console.error('[stream] failed to send greeting:', err.message);
    plivoWs.close();
    return;
  }

  // Listen to Deepgram transcription
  dgWs.on('message', async (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === 'Results' && msg.channel?.alternatives?.[0]?.transcript) {
        const text = msg.channel.alternatives[0].transcript.trim();
        prospectSaid = text;
        lastTranscriptTime = Date.now();

        // If final and not already responding, generate Claude's reply
        if (msg.is_final && text && !responseInProgress) {
          responseInProgress = true;
          transcript.push({ speaker: 'prospect', text });
          console.log(`[stream] prospect: ${text}`);

          const onSegment = async (segmentText) => {
            try {
              const mp3 = await synthesize(segmentText);
              const mulaw = await mp3ToMulaw(mp3);
              // Send back to Plivo as base64-encoded mulaw
              plivoWs.send(JSON.stringify({
                event: 'playback',
                payload: mulaw.toString('base64'),
              }));
            } catch (err) {
              console.error('[stream] voice failed:', err.message);
            }
          };

          streamTurn(history, text, onSegment)
            .then((reply) => {
              transcript.push({ speaker: 'bot', text: reply.text });
              console.log(`[stream] bot: ${reply.text}${reply.endCall ? ' [END]' : ''}`);
              responseInProgress = false;
              if (reply.endCall) {
                setTimeout(() => plivoWs.close(), 500);
              }
            })
            .catch((err) => {
              console.error('[stream] Claude failed:', err.message);
              responseInProgress = false;
            });
        }
      }
    } catch (err) {
      console.error('[stream] Deepgram message error:', err.message);
    }
  });

  // Receive audio from Plivo and send to Deepgram
  plivoWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'start') {
        console.log('[stream] Plivo WebSocket started');
      } else if (msg.event === 'media' && msg.media?.payload) {
        // Plivo sends base64-encoded mulaw; decode and send to Deepgram
        const audio = Buffer.from(msg.media.payload, 'base64');
        dgWs.send(audio);
      } else if (msg.event === 'stop') {
        console.log('[stream] Plivo WebSocket stopped');
      }
    } catch (err) {
      console.error('[stream] message parse error:', err.message);
    }
  });

  plivoWs.on('close', () => {
    dgWs.close();
    console.log('[stream] call ended');
  });

  plivoWs.on('error', (err) => {
    console.error('[stream] plivo WebSocket error:', err.message);
    try { dgWs.close(); } catch (_) {}
  });
}

module.exports = { handleStream, connectDeepgram };
