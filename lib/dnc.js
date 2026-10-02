// Do-not-call list: one E.164 number per line in dnc.txt.
const fs = require('fs');
const path = require('path');

const DNC_FILE = path.join(__dirname, '..', 'dnc.txt');

function normalize(number) {
  const digits = String(number).replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

function isOnDnc(number) {
  if (!fs.existsSync(DNC_FILE)) return false;
  const target = normalize(number);
  return fs
    .readFileSync(DNC_FILE, 'utf8')
    .split('\n')
    .some((line) => line.trim() && normalize(line) === target);
}

function addToDnc(number) {
  if (!number || isOnDnc(number)) return;
  fs.appendFileSync(DNC_FILE, `+${normalize(number)}\n`);
}

module.exports = { isOnDnc, addToDnc };
