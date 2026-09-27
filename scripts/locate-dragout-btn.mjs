// Locate the 拖出 (drag-out) toolbar button via the WebView2 CDP endpoint and
// print its CSS center + viewport metrics so the host-side drag test can map
// it to physical screen coordinates.
const list = await fetch('http://127.0.0.1:9223/json').then((r) => r.json());
const page = list.find((t) => t.type === 'page');
if (!page) { console.error('no page target'); process.exit(1); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
function send(method, params) {
  return new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params: params ?? {} }));
  });
}
ws.onmessage = (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  }
};
await new Promise((res) => { ws.onopen = res; });

const expr = `(() => {
  const btns = [...document.querySelectorAll('.tb-btn')];
  const b = btns.find((x) => (x.textContent || '').includes('拖出'));
  if (!b) return JSON.stringify({ found: false, labels: btns.map((x) => x.textContent).join('|') });
  const r = b.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    cx: r.x + r.width / 2,
    cy: r.y + r.height / 2,
    innerW: window.innerWidth,
    innerH: window.innerHeight,
    dpr: window.devicePixelRatio,
  });
})()`;

const res = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
console.log(res.result.value);
ws.close();
process.exit(0);
