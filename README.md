# Valmar Bot

Outbound calling bot for Valmar Merchant Services. Plivo places the call, ElevenLabs speaks in Noah's cloned voice, and Claude decides what to say next.

## How a call works

1. `npm run call -- +1XXXXXXXXXX` asks Plivo to dial from +17163673144.
2. When the prospect picks up, Plivo hits `POST /plivo/answer`. The server returns XML that plays the opening pitch, which was synthesized in your voice at startup, and listens for speech.
3. Plivo transcribes the reply and posts it to `/plivo/respond`. Claude writes the next line, ElevenLabs turns it into an MP3, and Plivo plays it with `<Play>`. This repeats until Claude ends the call.
4. `/plivo/hangup` saves the transcript to `call-logs/<CallUUID>.json` and deletes that call's audio.

The bot never uses Plivo's built-in `<Speak>` voice. Every line is your ElevenLabs voice.

If someone asks not to be called again, the bot confirms, hangs up, and adds their number to `dnc.txt`. `npm run call` refuses to dial anyone on that list.

## Setup

```bash
npm install
cp .env.example .env   # or add the new keys to your existing .env
```

Add these to `.env` alongside your existing Plivo, Anthropic, and `WEBHOOK_URL` values:

```
ELEVEN_LABS_API_KEY=...
ELEVEN_LABS_VOICE_ID=...
```

`WEBHOOK_URL` must be the public ngrok URL that forwards to port 3003, with no trailing path.

## Test, step by step

```bash
# 1. Hear your cloned voice without making a call (writes test-pitch.mp3)
npm run test-voice

# 2. Start the tunnel and the server (in two terminals)
ngrok http --url=fastness-hankie-blurry.ngrok-free.dev 3003
npm start

# 3. Call your own cell phone first
npm run call -- +1YOURCELL
```

Watch the `npm start` terminal: it prints each thing the prospect says and each reply from the bot. If a request is rejected with `Invalid signature`, make sure `WEBHOOK_URL` exactly matches the ngrok URL. You can set `VERIFY_PLIVO_SIGNATURE=false` temporarily to rule it out.

## Tuning

| Setting | Default | Notes |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Runs at low effort to keep reply latency down. |
| `ELEVEN_LABS_MODEL` | `eleven_flash_v2_5` | Fastest model. `eleven_multilingual_v2` sounds closer to you but is slower. |
| `ELEVEN_LABS_STABILITY` / `ELEVEN_LABS_SIMILARITY` | `0.5` / `0.8` | Raise similarity if it doesn't sound enough like you. |

The opening pitch and the sales instructions are in `lib/brain.js`. Fixed lines such as the re-prompt and goodbye are in `server.js`, under `STATIC_LINES`. Their audio regenerates automatically when you edit the text.
