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
- Latency-sensitive; begin your answer immediately. One to three short sentences per turn: this is a phone call, not an email.
- Sound like a friendly, relaxed person. No lists, no markdown, no emojis, no stage directions.
- Write numbers and times the way they are spoken ("two thirty on Tuesday").
- Only claim what Valmar actually offers: a review of processing costs, transparent pricing, and a dedicated account manager. Never quote specific rates, savings figures or guarantees; say the account manager covers that after looking at a statement.
- If they ask whether this is a recording or an AI, answer honestly: this is an automated assistant calling on Noah's behalf, and Noah or an account manager can follow up personally.

When to end the call (set end_call to true and say a short, polite goodbye):
- They are not interested after one gentle attempt to address their objection, or they are busy (offer a callback first).
- A follow-up is booked and confirmed.
- They ask to be removed, to stop calling, or not to be called again: also set do_not_call to true, confirm they will not be called again, and end the call.`;

const REPLY_FORMAT = {
  type: 'json_schema',
  schema: {
    type: 'object',
    properties: {
      say: { type: 'string', description: 'Exactly what to say out loud next.' },
      end_call: { type: 'boolean', description: 'Hang up after saying this.' },
      do_not_call: { type: 'boolean', description: 'Prospect asked not to be called again.' },
    },
    required: ['say', 'end_call', 'do_not_call'],
    additionalProperties: false,
  },
};

// history is the call's Claude message list, which this function appends to.
// Returns { say, end_call, do_not_call }.
async function nextTurn(history, prospectSaid) {
  const userMessage = { role: 'user', content: prospectSaid };
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 2048,
    // If a safety classifier declines, the API retries on its recommended fallback model.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM_PROMPT,
    output_config: { effort: 'low', format: REPLY_FORMAT },
    messages: [...history, userMessage],
  });

  if (response.stop_reason === 'refusal') {
    return {
      say: "Sorry, I'll let you go. Thanks for your time, have a great day.",
      end_call: true,
      do_not_call: false,
    };
  }

  // Append the full response (not just the text) so history stays append-only.
  history.push(userMessage, { role: 'assistant', content: response.content });

  const text = response.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('');
  return JSON.parse(text);
}

module.exports = { nextTurn, OPENING_PITCH };
