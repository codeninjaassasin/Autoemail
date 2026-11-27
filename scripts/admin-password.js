'use strict';
// Set or reset the admin password (stored hashed in data/admin.json).
// Usage: npm run admin-password   (asks twice, input hidden)
//    or: printf '%s\n' 'new password' | npm run admin-password
const readline = require('readline');
const adminPassword = require('../server/adminPassword');

function ask(prompt) {
  if (!process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(prompt)) process.stdout.write(s); };
    rl.question(prompt, (answer) => { rl.close(); process.stdout.write('\n'); resolve(answer); });
  });
}

async function fromPipe() {
  let data = '';
  for await (const chunk of process.stdin) data += chunk;
  return data.replace(/\r?\n$/, '');
}

(async () => {
  let pw;
  if (process.stdin.isTTY) {
    pw = await ask('New admin password: ');
    if ((await ask('Again: ')) !== pw) throw new Error('The two entries differ.');
  } else {
    pw = await fromPipe();
  }
  await adminPassword.set(pw);
  console.log('Admin password saved (hashed) in data/admin.json. Existing admin sessions stay signed in.');
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
