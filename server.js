'use strict';
// Car Line server: zero dependencies (Node 18+). Queue lives in memory on purpose
// (wiped daily for privacy); only the roster (first names + zones) is saved to disk.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const STAFF_PIN = process.env.STAFF_PIN || '1234';
const ADMIN_PIN = process.env.ADMIN_PIN || '9999';
const PUB = path.join(__dirname, 'public');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const ROSTER_FILE = path.join(DATA_DIR, 'roster.json');
const DEMO_CSV = ['101,Maya,Zone A', '101,Leo,Zone B', '102,Ava,Zone A',
  '103,Noah,Zone A', '104,Sofia,Zone B', '105,Ethan,Zone A'].join('\n');

// ---------- roster ----------
function buildRoster(csv, old = { families: {} }) {
  const families = {};
  for (const line of String(csv).split('\n')) {
    const [tag, name, zone] = line.split(',').map(s => (s || '').trim());
    if (!tag || !name || !zone || tag.toLowerCase() === 'tag') continue;
    const fam = families[tag] ||= {
      token: old.families[tag]?.token || crypto.randomBytes(5).toString('hex'),
      kids: [],
    };
    fam.kids.push({ name: name.slice(0, 30), zone: zone.slice(0, 20) });
  }
  const zones = [...new Set(Object.values(families).flatMap(f => f.kids.map(k => k.zone)))].sort();
  return { zones, families };
}
function loadRoster() {
  try { return JSON.parse(fs.readFileSync(ROSTER_FILE, 'utf8')); }
  catch { return buildRoster(DEMO_CSV); }
}
function saveRoster() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ROSTER_FILE, JSON.stringify(roster));
}

// ---------- queue state ----------
let roster = loadRoster();
let queue = [];            // [{ tag, at, via, kids: [{ name, zone, out }] }] sorted by arrival time
const finished = new Map(); // tag -> time all kids were released today
let releases = [];         // timestamps, used for wait estimates
let day = new Date().toDateString();
const clients = new Set();

// Ordered by the arrival time, not by when the request reached the server, so
// actions replayed after an offline stretch still land in the right place.
function arrive(tag, at, via) {
  const fam = roster.families[tag];
  if (!fam) fail(404, 'Unknown tag');
  if (via === 'staff') finished.delete(tag);            // lets staff re-queue a mistake
  if (queue.some(c => c.tag === tag) || finished.has(tag)) return; // duplicate taps are harmless
  queue.push({ tag, at, via, kids: fam.kids.map(k => ({ ...k, out: false })) });
  queue.sort((a, b) => a.at - b.at);
}

// A car leaves only when every sibling, in every zone, has been sent out.
function setOut(tag, name, out) {
  const car = queue.find(c => c.tag === tag);
  const kid = car && car.kids.find(k => k.name === name);
  if (!kid) return; // already released or removed
  kid.out = out;
  if (car.kids.every(k => k.out)) {
    queue = queue.filter(c => c !== car);
    finished.set(tag, Date.now());
    releases.push(Date.now());
  }
}

// Position = worst place in line across the zones where a child is still waiting.
function position(i) {
  return Math.max(...queue[i].kids.filter(k => !k.out).map(k =>
    queue.slice(0, i + 1).filter(o => o.kids.some(x => x.zone === k.zone && !x.out)).length));
}
function avgMs() { // rolling average gap between the last 8 releases
  const r = releases.slice(-8);
  return r.length < 3 ? 45000 : Math.max(10000, (r.at(-1) - r[0]) / (r.length - 1));
}
function endDay() {
  queue = []; finished.clear(); releases = [];
  day = new Date().toDateString();
  broadcast();
}
setInterval(() => { if (new Date().toDateString() !== day) endDay(); }, 60000).unref();

// ---------- views ----------
const snapshot = () => ({ zones: roster.zones, queue, avgMs: avgMs(), now: Date.now() });
function broadcast() {
  const msg = `data: ${JSON.stringify(snapshot())}\n\n`;
  for (const res of clients) res.write(msg);
}
function tagFor(token) {
  const tag = Object.keys(roster.families).find(t => roster.families[t].token === token);
  return tag || fail(404, 'Link not recognized');
}
function me(token) { // a parent only ever sees their own children
  const tag = tagFor(token);
  const i = queue.findIndex(c => c.tag === tag);
  if (i < 0) return { status: finished.has(tag) ? 'done' : 'idle', kids: roster.families[tag].kids };
  const pos = position(i);
  return {
    status: 'queued', position: pos,
    etaMin: Math.max(1, Math.round(pos * avgMs() / 60000)),
    kids: queue[i].kids.map(({ name, zone, out }) => ({ name, zone, out })),
  };
}

// ---------- http plumbing ----------
const fail = (code, msg) => { throw Object.assign(new Error(msg), { code }); };
const send = (res, code, data) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
};
function pinOk(given, want) {
  const a = Buffer.from(String(given)), b = Buffer.from(want);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function auth(pin, adminOnly = false) {
  if (!(pinOk(pin, ADMIN_PIN) || (!adminOnly && pinOk(pin, STAFF_PIN)))) fail(401, 'Wrong PIN');
}
const clampTime = at => (Number.isFinite(at) && at <= Date.now() && at > Date.now() - 36e5 ? at : Date.now());
const readJson = req => new Promise((ok, no) => {
  let s = '';
  req.on('data', d => { s += d; if (s.length > 2e5) req.destroy(); });
  req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no(Object.assign(new Error('Bad JSON'), { code: 400 })); } });
});

function stream(req, res, pin) {
  auth(pin);
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
}
setInterval(() => { for (const r of clients) r.write(': ping\n\n'); }, 25000).unref();

async function route(req, res, url) {
  const p = url.pathname, q = url.searchParams;
  if (req.method === 'GET') {
    if (p === '/api/events') return stream(req, res, q.get('pin'));
    if (p === '/api/me') return send(res, 200, me(q.get('t')));
    if (p === '/api/roster') { auth(q.get('pin'), true); return send(res, 200, roster); }
    fail(404, 'Not found');
  }
  if (req.method !== 'POST') fail(405, 'Method not allowed');
  const b = await readJson(req);
  if (p === '/api/auth') { auth(b.pin, b.admin); return send(res, 200, { ok: true }); }
  if (p === '/api/arrive' && b.t) arrive(tagFor(b.t), Date.now(), 'parent');
  else if (p === '/api/arrive') { auth(b.pin); arrive(String(b.tag || '').trim(), clampTime(b.at), 'staff'); }
  else if (p === '/api/out') { auth(b.pin); setOut(String(b.tag), b.kid, b.out !== false); }
  else if (p === '/api/remove') { auth(b.pin); queue = queue.filter(c => c.tag !== String(b.tag)); }
  else if (p === '/api/roster') { auth(b.pin, true); roster = buildRoster(b.csv, roster); saveRoster(); queue = []; finished.clear(); }
  else if (p === '/api/endday') { auth(b.pin, true); endDay(); }
  else fail(404, 'Not found');
  broadcast();
  send(res, 200, { ok: true });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const PAGES = { '/': 'index.html', '/staff': 'staff.html', '/admin': 'admin.html' };
function serveStatic(res, p) {
  const file = path.normalize(path.join(PUB, PAGES[p] || p));
  if (!file.startsWith(PUB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, { error: 'Not found' });
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await route(req, res, url);
    else serveStatic(res, url.pathname);
  } catch (e) {
    if (!res.headersSent) send(res, e.code || 500, { error: e.message });
  }
}).listen(PORT, () => console.log(`Car Line running on http://localhost:${PORT}  (staff /staff, office /admin)`));
