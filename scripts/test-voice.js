// Generate the opening pitch in your cloned voice and save it locally, no phone call needed:
// npm run test-voice   ->   writes test-pitch.mp3
require('dotenv').config();
const fs = require('fs');
const { synthesize } = require('../lib/elevenlabs');
const { OPENING_PITCH } = require('../lib/brain');

synthesize(process.argv[2] || OPENING_PITCH)
  .then((audio) => {
    fs.writeFileSync('test-pitch.mp3', audio);
    console.log(`Saved test-pitch.mp3 (${Math.round(audio.length / 1024)} KB). Open it to hear your voice.`);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
