// Real-time bidirectional audio streaming with Deepgram + Claude + ElevenLabs.
const WebSocket = require('ws');
const { createWriteStream } = require('fs');
const { Readable } = require('stream');
const { streamTurn } = require('./brain');
const { synthesize } = require('./elevenlabs');

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

// Stream audio through Plivo back to the caller
function streamAudioToCaller(plivoWs, audioBuffer) {
  if (!audioBuffer || audioBuffer.length === 0) return;
  // Plivo expects audio events with base64-encoded mulaw audio
  plivoWs.send(
    JSON.stringify({
      event: 'playback',
      audio_data: audioBuffer.toString('base64'),
    }),
  );
}

// Handle a live call via Plivo's WebSocket
async function handleStream(plivoWs, history, initialTranscript) {
  const deepgramApiKey = process.env.DEEPGRAM_API_KEY;
  if (!deepgramApiKey) {
    console.error('DEEPGRAM_API_KEY not set');
    plivoWs.close();
    return;
  }

  let dgWs;
  let transcript = '';
  let responseInProgress = false;

  try {
    dgWs = await connectDeepgram(deepgramApiKey);
  } catch (err) {
    console.error('Could not connect to Deepgram:', err.message);
    plivoWs.close();
    return;
  }

  // Listen to Deepgram transcription
  dgWs.on('message', async (data) => {
    const msg = JSON.parse(data);
    if (msg.is_final && msg.channel?.alternatives?.[0]?.transcript) {
      const text = msg.channel.alternatives[0].transcript.trim();
      if (text && !responseInProgress) {
        transcript = text;
        responseInProgress = true;
        initialTranscript.push({ speaker: 'prospect', text });
        console.log(`[stream] prospect: ${text}`);

        // Get Claude's response while still listening
        const onSegment = async (segmentText) => {
          try {
            const audio = await synthesize(segmentText);
            streamAudioToCaller(plivoWs, audio);
          } catch (err) {
            console.error('[stream] voice failed:', err.message);
          }
        };

        streamTurn(history, text, onSegment)
          .then((reply) => {
            initialTranscript.push({ speaker: 'bot', text: reply.text });
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
  });

  // Receive audio from Plivo and send to Deepgram
  plivoWs.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'playback' && msg.audio_data) {
        const audio = Buffer.from(msg.audio_data, 'base64');
        dgWs.send(audio);
      }
    } catch (err) {
      console.error('[stream] message error:', err.message);
    }
  });

  plivoWs.on('close', () => {
    dgWs.close();
    console.log('[stream] call ended');
  });

  plivoWs.on('error', (err) => {
    console.error('[stream] plivo error:', err.message);
    dgWs.close();
  });
}

module.exports = { handleStream, connectDeepgram, streamAudioToCaller };
