// ElevenLabs text-to-speech: turns text into MP3 audio in Noah's cloned voice.
const API_BASE = 'https://api.elevenlabs.io/v1';

// eleven_flash_v2_5 is ElevenLabs' lowest-latency model, which matters on a live call.
// Set ELEVEN_LABS_MODEL=eleven_multilingual_v2 for higher fidelity at the cost of speed.
const MODEL_ID = process.env.ELEVEN_LABS_MODEL || 'eleven_flash_v2_5';

// Phone audio is 8 kHz, so a small MP3 sounds the same on a call and downloads faster.
const OUTPUT_FORMAT = process.env.ELEVEN_LABS_FORMAT || 'mp3_22050_32';

async function synthesize(text) {
  const apiKey = process.env.ELEVEN_LABS_API_KEY;
  const voiceId = process.env.ELEVEN_LABS_VOICE_ID;
  if (!apiKey || !voiceId) {
    throw new Error('ELEVEN_LABS_API_KEY and ELEVEN_LABS_VOICE_ID must be set in .env');
  }

  const res = await fetch(
    `${API_BASE}/text-to-speech/${voiceId}?output_format=${OUTPUT_FORMAT}`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: MODEL_ID,
        voice_settings: {
          stability: Number(process.env.ELEVEN_LABS_STABILITY ?? 0.5),
          similarity_boost: Number(process.env.ELEVEN_LABS_SIMILARITY ?? 0.8),
        },
      }),
    },
  );

  if (!res.ok) {
    throw new Error(`ElevenLabs TTS failed (${res.status}): ${await res.text()}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { synthesize, OUTPUT_FORMAT };
