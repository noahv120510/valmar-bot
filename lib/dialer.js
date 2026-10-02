// Places outbound calls through Plivo. Used by the control page and scripts/call.js.
const plivo = require('plivo');
const { isOnDnc } = require('./dnc');

function normalizeNumber(input) {
  const raw = String(input || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+') && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

async function placeCall(input) {
  const to = normalizeNumber(input);
  if (!to) throw new Error(`"${input}" is not a valid phone number`);
  if (isOnDnc(to)) throw new Error(`${to} is on the do-not-call list (dnc.txt)`);

  const from = process.env.PLIVO_FROM_NUMBER || process.env.PLIVO_PHONE_NUMBER || '+17163673144';
  const baseUrl = process.env.WEBHOOK_URL.replace(/\/+$/, '');
  const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

  const res = await client.calls.create(from, to, `${baseUrl}/plivo/answer`, {
    answerMethod: 'POST',
    hangupUrl: `${baseUrl}/plivo/hangup`,
    hangupMethod: 'POST',
    // Hang up on voicemail rather than pitching an answering machine.
    machineDetection: 'hangup',
  });
  return { to, from, requestUuid: res.requestUuid };
}

module.exports = { placeCall, normalizeNumber };
