// Place an outbound call: npm run call -- +15551234567
require('dotenv').config();
const { placeCall } = require('../lib/dialer');

const to = process.argv[2];
if (!to) {
  console.error('Usage: npm run call -- +15551234567');
  process.exit(1);
}

placeCall(to)
  .then(({ to, from, requestUuid }) => console.log(`Calling ${to} from ${from}. Request UUID: ${requestUuid}`))
  .catch((err) => {
    console.error('Call failed:', err.message || err);
    process.exit(1);
  });
