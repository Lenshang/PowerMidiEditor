// Add-folder E2E with chooser automation + verification.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

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
await ev(`[...document.querySelectorAll('.toolbar .tb-btn')].find(function(b){return (b.textContent||'')==='Browser';}).click()`);
await sleep(300);
await ev(`[...document.querySelectorAll('.browser-folders-head .mini-btn')].find(function(b){return b.textContent==='+';}).click()`);
await sleep(500);
// drive chooser: type path, enter
const psFile = 'D:/LocalProject/PowerMidiEditor/Scripts/debug/pick-folder.ps1';
try { execSync('powershell -NoProfile -ExecutionPolicy Bypass -File "' + psFile + '"', { stdio: 'inherit', cwd: 'D:/LocalProject/PowerMidiEditor' }); } catch (e) { console.log('ps1 exit nonzero (ok if keys delivered)'); }
await sleep(1200);
const r = JSON.parse(await ev(`JSON.stringify({
  folders: document.querySelectorAll('.browser-folder').length,
  files: document.querySelectorAll('.browser-file').length,
  firstFile: (document.querySelector('.browser-file-name')||{}).textContent || '(none)',
  hint: (document.querySelector('.browser-hint')||{}).textContent || ''
})`));
console.log('after chooser:', JSON.stringify(r));
let prefs = 'ERR';
try { prefs = JSON.stringify(JSON.parse(fs.readFileSync('C:/Users/lensh/AppData/Roaming/PowerMidiEditor/ui_prefs.json','utf8')).browserFolders || []); } catch (e) { prefs = 'ERR'; }
console.log('prefs browserFolders:', prefs);
ws.close(); process.exit(0);
