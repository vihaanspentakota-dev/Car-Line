'use strict';
const $ = (s, r = document) => r.querySelector(s);

// Tiny DOM builder. Uses textContent semantics, so names never become HTML.
function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...kids.flat().filter(x => x != null && x !== false));
  return el;
}

// Errors with .status are the server answering (bad PIN, bad tag).
// Errors without it mean the network is down.
async function api(path, body) {
  const res = await fetch(path, body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status });
  return data;
}

function askPin(title, check) {
  const msg = h('small', { class: 'mut' });
  const input = h('input', { type: 'password', placeholder: 'PIN', autocomplete: 'off' });
  $('#app').replaceChildren(h('h1', {}, title), h('form', {
    onsubmit: async e => {
      e.preventDefault();
      try { await check(input.value); }
      catch (err) { msg.textContent = err.status ? 'Wrong PIN' : 'No connection'; }
    },
  }, input, h('button', {}, 'Enter')), msg);
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
