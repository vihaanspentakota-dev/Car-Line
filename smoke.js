'use strict';
// End-to-end check of the rules that matter: duplicate taps, ordering, siblings in two zones.
const { spawn } = require('child_process');
const assert = require('assert');
const os = require('os'), fs = require('fs'), path = require('path');

const PORT = 3999, base = `http://localhost:${PORT}`;
const env = { ...process.env, PORT, DATA_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'carline-')) };
const srv = spawn('node', ['server.js'], { env, stdio: 'inherit' });
const call = async (p, body) => {
  const r = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: r.status, data: await r.json() };
};

(async () => {
  await new Promise(r => setTimeout(r, 600));
  assert.strictEqual((await call('/api/roster?pin=bad')).status, 401);
  const { data: roster } = await call('/api/roster?pin=9999');
  const t101 = roster.families['101'].token, t102 = roster.families['102'].token;

  await call('/api/arrive', { t: t101 });
  await call('/api/arrive', { t: t101 });                  // duplicate tap is harmless
  await call('/api/arrive', { pin: '1234', tag: '102' });  // staff adds a car by tag
  assert.strictEqual((await call('/api/me?t=' + t101)).data.position, 1);
  assert.strictEqual((await call('/api/me?t=' + t102)).data.position, 2);

  await call('/api/out', { pin: '1234', tag: '101', kid: 'Maya', out: true });
  assert.strictEqual((await call('/api/me?t=' + t101)).data.status, 'queued'); // sibling still waiting
  await call('/api/out', { pin: '1234', tag: '101', kid: 'Leo', out: true });
  assert.strictEqual((await call('/api/me?t=' + t101)).data.status, 'done');
  console.log('smoke test passed');
})().catch(e => { console.error(e); process.exitCode = 1; }).finally(() => srv.kill());
