// Simulates the real flow: C++ browser.addFolder with {path} payload saves
// prefs + pushes browserFolders; the modal listener must refresh the list.
const list = await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const page = list.find(t=>t.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id=0; const pend=new Map();
const send=(m,p={})=>new Promise((res,rej)=>{const i=++id;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
ws.onmessage=e=>{try{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){const p=pend.get(m.id);pend.delete(m.id);m.error?p.rej(new Error(m.error.message)):p.res(m.result);}}catch{}};
await new Promise(r=>ws.onopen=r);
const ev=(expr)=>send('Runtime.evaluate',{expression:expr,returnByValue:true}).then(r=>r.result.value);
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await sleep(300);
await ev(`window.__PME_STORE__.getState().clearDoc()`);
await sleep(150);
await ev(`[...document.querySelectorAll('.toolbar .tb-btn')].find(function(b){return (b.textContent||'')==='Browser';}).click()`);
await sleep(300);
console.log('modal open:', await ev(`!!document.querySelector('.browser-modal')`));
console.log('folders before:', await ev(`document.querySelectorAll('.browser-folder').length`));
// the + button opens the native chooser — drive it via SendKeys (ps1 file)
ws.close(); process.exit(0);
