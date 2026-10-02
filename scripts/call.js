// Place an outbound call: npm run call -- +15551234567
require('dotenv').config();
const plivo = require('plivo');
const { isOnDnc } = require('../lib/dnc');

const to = process.argv[2];
if (!to || !/^\+\d{10,15}$/.test(to)) {
  console.error('Usage: npm run call -- +15551234567');
  process.exit(1);
}
if (isOnDnc(to)) {
  console.error(`${to} is on the do-not-call list (dnc.txt). Not calling.`);
  process.exit(1);
}

const from = process.env.PLIVO_FROM_NUMBER || process.env.PLIVO_PHONE_NUMBER || '+17163673144';
const baseUrl = process.env.WEBHOOK_URL.replace(/\/+$/, '');
const client = new plivo.Client(process.env.PLIVO_AUTH_ID, process.env.PLIVO_AUTH_TOKEN);

client.calls
  .create(from, to, `${baseUrl}/plivo/answer`, {
    answerMethod: 'POST',
    hangupUrl: `${baseUrl}/plivo/hangup`,
    hangupMethod: 'POST',
    // Hang up on voicemail rather than pitching an answering machine.
    machineDetection: 'hangup',
  })
  .then((res) => console.log(`Calling ${to} from ${from}. Request UUID: ${res.requestUuid}`))
  .catch((err) => {
    console.error('Plivo call failed:', err.message || err);
    process.exit(1);
  });
