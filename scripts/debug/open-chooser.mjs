const list = await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const page = list.find(t=>t.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } } catch {} };
await new Promise(r => ws.onopen = r);
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => r.result.value);
await sleep(200); function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
await ev(`[...document.querySelectorAll('.browser-folders-head .mini-btn')].find(function(b){return b.textContent==='+';}).click()`);
console.log('chooser opened');
process.exit(0);
