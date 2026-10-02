// Claude decides what the bot says next, based on what the prospect just said.
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();
const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';

const OPENING_PITCH =
  "Hey, this is Noah with Valmar Merchant Services. Do you have 30 seconds? " +
  "We help businesses review their credit card processing costs and see whether there's a better fit. " +
  "We offer transparent pricing and a dedicated account manager you can actually reach. " +
  'Who handles payment processing for your business?';

const SYSTEM_PROMPT = `You are Noah, an outbound sales rep for Valmar Merchant Services, speaking on a live phone call. Everything you write is converted to speech in Noah's voice and played to the prospect, so write exactly what should be said out loud.

The call has already started and you have just said this opening line:
"${OPENING_PITCH}"

Each user message is a speech-to-text transcript of what the prospect said. Transcripts can contain recognition errors; interpret them charitably.

Goal: find out who handles payment processing and, if there's interest, book a short follow-up where an account manager reviews a recent processing statement. Get a good time and confirm the best number or email.

How to talk:
- Latency-sensitive; begin your answer immediately. One to three short sentences per turn: this is a phone call, not an email. Keep the first sentence especially short.
- Sound like a friendly, relaxed person: contractions, plain words, the occasional "honestly" or "totally". No lists, no markdown, no emojis, no stage directions.
- Right before your reply plays, the prospect already hears you say a quick "mm-hm", "yeah", "okay" or "gotcha". So don't open with an acknowledgement like "Got it" or "Sure"; go straight to the substance.
- Write numbers and times the way they are spoken ("two thirty on Tuesday").
- Only claim what Valmar actually offers: a review of processing costs, transparent pricing, and a dedicated account manager. Never quote specific rates, savings figures or guarantees; say the account manager covers that after looking at a statement.
- If they ask whether this is a recording or an AI, answer honestly: this is an automated assistant calling on Noah's behalf, and Noah or an account manager can follow up personally.

Ending the call: after your spoken words, add the tag [END] when the call should hang up after this reply:
- After you ask "Do you have any questions?" and they say "no", "nope", "nothing", or similar: say "Great, thanks so much. Have a great day." and add [END].
- They clearly state they are not interested and you've tried once: offer a callback, and if they decline again, say "No problem, thanks for your time" and add [END].
- They ask to be removed, to stop calling, or not to be called again: confirm they won't be called again, and add both [DNC] and [END].
- Always ask "Do you have any questions?" before ending a successful call (after booking a follow-up or getting their info).
Tags go only at the very end and are never spoken.`;

// Model-specific settings, tuned for the lowest reply latency each model allows.
function modelParams() {
  if (MODEL.startsWith('claude-haiku')) return {};
  if (MODEL.startsWith('claude-sonnet-5-5')) {
    // between_tools turns extended thinking off on Sonnet 5.5.
    return { thinking: { type: 'between_tools' }, output_config: { effort: 'low' }, ...FALLBACKS };
  }
  // Claude Opus 5.5 always thinks; low effort keeps that short.
  return { output_config: { effort: 'low' }, ...FALLBACKS };
}

// If a safety classifier declines, the API retries on its recommended fallback model.
const FALLBACKS = { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' };

const TAG_RE = /\[(END|DNC)\]/gi;
const SENTENCE_END_RE = /[.!?](?=\s)/;

function clean(text) {
  return text.replace(TAG_RE, '').replace(/\s+/g, ' ').trim();
}

// Streams Claude's reply. Calls onSegment(text) with the first sentence as soon as it is
// written, then once more with the rest of the reply when Claude finishes.
// history is the call's Claude message list, which this function appends to.
// Resolves to { text, endCall, doNotCall }.
async function streamTurn(history, prospectSaid, onSegment, onFirstToken) {
  const userMessage = { role: 'user', content: prospectSaid };
  const stream = client.beta.messages.stream({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [...history, userMessage],
    ...modelParams(),
  });

  let full = '';
  let pending = '';
  let sentFirst = false;
  let restStart = 0; // index in full where the text after the first sentence begins
  let sawFirstToken = false;
  stream.on('text', (delta) => {
    if (!sawFirstToken) {
      sawFirstToken = true;
      if (onFirstToken) onFirstToken();
    }
    full += delta;
    if (sentFirst) return;
    pending += delta;
    const match = pending.match(SENTENCE_END_RE);
    if (match) {
      const first = clean(pending.slice(0, match.index + 1));
      // pending is always the tail of full, so this maps the boundary back into full.
      const boundary = full.length - pending.length + match.index + 1;
      pending = pending.slice(match.index + 1);
      if (first) {
        restStart = boundary;
        sentFirst = true;
        onSegment(first);
      }
    }
  });

  const message = await stream.finalMessage();

  if (message.stop_reason === 'refusal') {
    const goodbye = "Sorry, I'll let you go. Thanks for your time, have a great day.";
    if (!sentFirst) onSegment(goodbye);
    return { text: goodbye, endCall: true, doNotCall: false };
  }

  const rest = clean(full.slice(restStart));
  if (rest) onSegment(rest);

  // Append the full response (not just the text) so history stays append-only.
  history.push(userMessage, { role: 'assistant', content: message.content });

  const tags = (full.match(TAG_RE) || []).map((t) => t.toUpperCase());
  return { text: clean(full), endCall: tags.includes('[END]'), doNotCall: tags.includes('[DNC]') };
}

module.exports = { streamTurn, OPENING_PITCH, MODEL };
