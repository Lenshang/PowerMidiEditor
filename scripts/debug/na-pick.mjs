// Drives the native folder chooser with SendKeys and verifies the round trip.
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const list = await fetch('http://127.0.0.1:9223/json').then(r=>r.json());
const page = list.find(t=>t.type==='page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pend = new Map();
const send = (m, p = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method: m, params: p })); });
ws.onmessage = e => { try { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } } catch {} };
await new Promise(r => ws.onopen = r);
const ev = (expr) => send('Runtime.evaluate', { expression: expr, returnByValue: true }).then(r => r.result.value);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

await sleep(200);
// click + to open the chooser
await ev(`[...document.querySelectorAll('.browser-folders-head .mini-btn')].find(function(b){return b.textContent==='+';}).click()`);
await sleep(800);

// drive the native dialog (title: Add MIDI folder)
const ps = [
  'Add-Type -AssemblyName System.Windows.Forms',
  '$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*Add MIDI folder*" } | Select-Object -First 1',
  'if ($p) { Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) }',
  'Start-Sleep -Milliseconds 300',
  '[System.Windows.Forms.SendKeys]::SendWait("Z:\\CodeProject\\drummap")',
  'Start-Sleep -Milliseconds 200',
  '[System.Windows.Forms.SendKeys]::SendWait("{ENTER}")',
].join('; ');
execSync('powershell -NoProfile -Command "' + ps.replace(/"/g, '`"') + '"', { stdio: 'inherit' });
await sleep(1200);

const count = await ev(`document.querySelectorAll('.browser-folder').length`);
let prefs = 'ERR';
try { prefs = JSON.stringify(JSON.parse(fs.readFileSync('C:/Users/lensh/AppData/Roaming/PowerMidiEditor/ui_prefs.json', 'utf8')).browserFolders || []); } catch (e) { prefs = String(e); }
console.log('folders in UI:', count, '| ui_prefs browserFolders:', prefs);
ws.close(); process.exit(0);
