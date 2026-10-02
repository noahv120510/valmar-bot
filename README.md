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

# 3. Call your own cell phone first: open http://localhost:3003 and click Call,
#    or from a terminal:
npm run call -- +1YOURCELL
```

The control page at http://localhost:3003 places calls and shows live and recent transcripts. It only answers requests from your own computer, never through the public ngrok URL.

Watch the `npm start` terminal: it prints each thing the prospect says and each reply from the bot. If a request is rejected with `Invalid signature`, make sure `WEBHOOK_URL` exactly matches the ngrok URL. You can set `VERIFY_PLIVO_SIGNATURE=false` temporarily to rule it out.

## Speed

After each reply the `npm start` window prints how long it took, for example:

```
first audio ready 1450ms after they stopped talking (Claude 1100ms + voice 350ms)
```

Replies are streamed: your voice starts on Claude's first sentence while Claude is still writing the rest. Plivo's own speech recognition also needs a moment to decide the prospect has finished talking, and that time comes before this number.

## Tuning

| Setting | Default | Notes |
|---|---|---|
| `CLAUDE_MODEL` | `claude-opus-5-5` | Runs at low effort. `claude-sonnet-5-5` runs with thinking off and usually replies faster. |
| `FILLERS` | on | Plays a quick "mm-hmm" or "gotcha" in your voice the moment they stop talking. Set `false` to turn off. |
| `ELEVEN_LABS_FORMAT` | `mp3_22050_32` | Small files download faster. Phone audio can't carry more quality than this anyway. |
| `ELEVEN_LABS_MODEL` | `eleven_flash_v2_5` | Fastest model. `eleven_multilingual_v2` sounds closer to you but is slower. |
| `ELEVEN_LABS_STABILITY` / `ELEVEN_LABS_SIMILARITY` | `0.5` / `0.8` | Raise similarity if it doesn't sound enough like you. |

The opening pitch and the sales instructions are in `lib/brain.js`. Fixed lines such as the re-prompt and goodbye are in `server.js`, under `STATIC_LINES`. Their audio regenerates automatically when you edit the text.
