// MIDI Library E2E: drives the real Standalone over WebView2 CDP.
// Creates two folders with known-content MIDI files, then asserts per-folder
// listing, recursive scan, probe info, last-folder persistence and the actual
// rendered UI (folder switching, search, keyboard).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const EXE = String.raw`D:\CodeProject\PowerMidiEditor\build\PowerMidiEditor_artefacts\Release\Standalone\PowerMidiEditor.exe`;
const ROOT_A = 'C:\\Temp\\PmeLibTest\\KitA';
const ROOT_B = 'C:\\Temp\\PmeLibTest\\KitB';

let failures = 0;
const ok = (cond, label, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${cond ? '' : '  ' + extra}`);
  if (!cond) failures++;
};

// ---- minimal valid MIDI: `n` sequential quarter notes, pitch 60+i ----------
function midiFile(n, tempoBpm = null) {
  const ev = [];
  if (tempoBpm) {
    const us = Math.round(60e6 / tempoBpm);
    ev.push(0x00, 0xFF, 0x51, 0x03, (us >> 16) & 255, (us >> 8) & 255, us & 255);
  }
  for (let i = 0; i < n; i++) {
    ev.push(0x00, 0x90, 60 + i, 0x64);
    ev.push(0x83, 0x60, 0x80, 60 + i, 0x00);  // delta 480 → 1 quarter long
  }
  ev.push(0x00, 0xFF, 0x2F, 0x00);
  const trackLen = ev.length;
  return Buffer.concat([
    Buffer.from([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0]),
    Buffer.from([0x4D, 0x54, 0x72, 0x6B, trackLen >> 24 & 255, trackLen >> 16 & 255, trackLen >> 8 & 255, trackLen & 255]),
    Buffer.from(ev),
  ]);
}

fs.rmSync('C:\\Temp\\PmeLibTest', { recursive: true, force: true });
fs.mkdirSync(path.join(ROOT_A, 'sub'), { recursive: true });
fs.mkdirSync(ROOT_B, { recursive: true });
fs.writeFileSync(path.join(ROOT_A, 'a1.mid'), midiFile(3, 138));
fs.writeFileSync(path.join(ROOT_A, 'a2.mid'), midiFile(5));
fs.writeFileSync(path.join(ROOT_A, 'sub', 'a3.mid'), midiFile(2));
fs.writeFileSync(path.join(ROOT_B, 'b1.mid'), midiFile(1));
fs.writeFileSync(path.join(ROOT_A, 'notes.txt'), 'not a midi');

// chordMidi: bars = [startQuarter, [pitches]] — one 4-quarter chord each
function chordMidi(bars) {
  const vlq = (n) => { const b = [n & 0x7f]; while ((n >>= 7)) b.unshift((n & 0x7f) | 0x80); return b; };
  const events = [];
  for (const [start, pitches] of bars)
    for (const p of pitches) {
      events.push({ t: start * 480, b: [0x90, p, 0x64] });
      events.push({ t: (start + 4) * 480, b: [0x80, p, 0x00] });
    }
  events.sort((a, b) => a.t - b.t);
  const ev = [];
  let last = 0;
  for (const e of events) { ev.push(...vlq(e.t - last), ...e.b); last = e.t; }
  ev.push(0, 0xFF, 0x2F, 0x00);
  const trackLen = ev.length;
  return Buffer.concat([
    Buffer.from([0x4D, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0xE0]),
    Buffer.from([0x4D, 0x54, 0x72, 0x6B, trackLen >> 24 & 255, trackLen >> 16 & 255, trackLen >> 8 & 255, trackLen & 255]),
    Buffer.from(ev),
  ]);
}
fs.writeFileSync(path.join(ROOT_A, 'prog.mid'),
  chordMidi([[0, [60, 64, 67]], [4, [57, 60, 64]]]));  // Cmaj bar, Amin bar

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let userFolders = [];
let userLast = '';
let ws = null;
let evalJs = null;

const app = spawn(EXE, [], {
  env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9223' },
  stdio: 'ignore',
});

try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    await sleep(500);
    try {
      const targets = await fetch('http://127.0.0.1:9223/json').then((r) => r.json());
      page = targets.find((t) => t.type === 'page') ?? null;
    } catch {}
  }
  if (! page) throw new Error('no CDP page target');

  const ws2 = new WebSocket(page.webSocketDebuggerUrl);
  ws = ws2;
  let id = 0; const pend = new Map();
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id; pend.set(i, { res, rej });
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  ws.onmessage = (e) => {
    try { const m = JSON.parse(e.data);
      if (m.id && pend.has(m.id)) { const p = pend.get(m.id); pend.delete(m.id);
        m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } } catch {}
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; setTimeout(() => j(new Error('ws timeout')), 8000); });

  const evalJson = async (expr, awaitPromise = true) => {
    const v = await evalInner(expr, awaitPromise);
    return typeof v === 'string' ? JSON.parse(v) : v;
  };
  const evalInner = async (expr, awaitPromise = true) => {
    const res = await send('Runtime.evaluate', { expression: expr, awaitPromise, returnByValue: true });
    if (res.exceptionDetails) throw new Error('page exception: ' + JSON.stringify(res.exceptionDetails.exception?.description ?? res.exceptionDetails.text));
    return res.result.value;
  };
  evalJs = evalInner;
  const api = (name, payload) => evalJs(`__PME_BRIDGE__.invoke(${JSON.stringify(name)}, ${JSON.stringify(payload ?? null)})`);
  const waitJs = async (expr, timeoutMs = 8000) => {
    const t0 = Date.now();
    for (;;) {
      if (await evalJs(expr, false) === true) return;
      if (Date.now() - t0 > timeoutMs) throw new Error('waitJs timeout: ' + expr);
      await sleep(150);
    }
  };
  // wait for the app UI to be ready
  for (let i = 0; i < 30; i++) {
    try { if (await evalJs('!!window.__PME_BRIDGE__', false)) break; } catch {}
    await sleep(500);
  }

  // ---- reset library state, remember the user's folders ------------------
  userFolders = (await api('browser.folders')) ?? [];
  userLast = ((await api('browser.lastFolder')) ?? {}).path ?? '';
  for (const f of userFolders) await api('browser.removeFolder', { path: f });

  // ---- API-level ----------------------------------------------------------
  await api('browser.addFolder', { path: ROOT_A });
  await api('browser.addFolder', { path: ROOT_B });
  let folders = (await api('browser.folders')) ?? [];
  ok(folders.includes(ROOT_A) && folders.includes(ROOT_B), 'addFolder: both folders registered', JSON.stringify(folders));

  let r = await api('browser.listFiles', { folder: ROOT_A });
  ok(r.files.length === 4, 'listFiles(KitA): exactly 4 files (folder-scoped)', JSON.stringify(r.files?.length));
  ok(r.files.some((f) => f.rel === 'sub/a3.mid'), 'listFiles(KitA): recursive hit sub/a3.mid', JSON.stringify(r.files?.map((f) => f.rel)));
  ok(!r.files.some((f) => f.name === 'notes.txt'), 'listFiles(KitA): non-MIDI excluded');

  r = await api('browser.listFiles', { folder: ROOT_B });
  ok(r.files.length === 1 && r.files[0].name === 'b1.mid', 'listFiles(KitB): exactly 1 file (no bleed from KitA)', JSON.stringify(r.files));

  r = await api('browser.listFiles');
  ok(r.files.length === 5, 'listFiles(all): 5 files across both folders', JSON.stringify(r.files?.length));

  r = await api('browser.probe', { paths: [
    ROOT_A + '\\a1.mid', ROOT_A + '\\a2.mid', ROOT_A + '\\nope.mid',
  ]});
  const byPath = Object.fromEntries((r.info ?? []).map((e) => [e.path, e]));
  ok(byPath[ROOT_A + '\\a1.mid']?.notes === 3, 'probe a1: 3 notes', JSON.stringify(byPath[ROOT_A + '\\a1.mid']));
  ok(byPath[ROOT_A + '\\a2.mid']?.notes === 5, 'probe a2: 5 notes', JSON.stringify(byPath[ROOT_A + '\\a2.mid']));
  ok((byPath[ROOT_A + '\\a2.mid']?.bars ?? 0) > 0, 'probe a2: bars > 0', JSON.stringify(byPath[ROOT_A + '\\a2.mid']?.bars));
  ok(byPath[ROOT_A + '\\nope.mid']?.ok === false, 'probe missing file: ok=false');

  await api('browser.setLastFolder', { path: ROOT_B });
  r = await api('browser.lastFolder');
  ok(r?.path === ROOT_B, 'lastFolder persists', JSON.stringify(r));

  // ---- UI-level -----------------------------------------------------------
  // open the modal via the toolbar button (labelled MIDI库 in zhHans)
  await evalJs(`[...document.querySelectorAll('.tb-btn .tb-text')].find((s) => s.textContent === 'MIDI库')?.parentElement.click()`, false);
  await waitJs(`!!document.querySelector('.browser-modal')`);
  await waitJs(`document.querySelectorAll('.browser-folder-btn').length === 2`);
  ok(true, 'UI: modal opens with 2 folders');

  // lastFolder was KitB from the API test above → UI must restore KitB active
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 1`);
  const activeTxt = await evalJs(`document.querySelector('.browser-folder.sel .browser-folder-btn')?.textContent`, false);
  ok(activeTxt === 'KitB', 'UI: restores last selected folder (KitB)', JSON.stringify(activeTxt));

  // switch to KitA → exactly 3 rows, subpath shown
  await evalJs(`[...document.querySelectorAll('.browser-folder-btn')].find((b) => b.textContent === 'KitA')?.click()`, false);
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 4`);
  const hasSub = await evalJs(`!!document.querySelector('.browser-file-rel')`, false);
  ok(hasSub, 'UI: KitA shows 4 rows incl. relative subpath');
  ok(await evalJs(`document.querySelectorAll('.browser-folder.sel .browser-folder-btn')[0]?.textContent === 'KitA'`, false), 'UI: KitA marked selected');

  // lazy probe fills note counts
  await waitJs(`document.querySelectorAll('.browser-file-meta span')[0]?.textContent.includes('♪')`, 10000);
  const notes = await evalJs(`[...document.querySelectorAll('.browser-file-name')].map((n) => n.textContent.trim())`, false);
  const meta = await evalJs(`[...document.querySelectorAll('.browser-file-meta')].map((m) => m.textContent)`, false);
  const a1 = notes.findIndex((n) => n === 'a1.mid');
  ok(meta[a1]?.includes('3♪'), 'UI: probe fills a1 with 3♪', JSON.stringify(meta));

  // search filters within the folder
  const setInput = (v) => evalJs(`(() => {
    const el = document.querySelector('.browser-search');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(el, ${JSON.stringify(v)});
    el.dispatchEvent(new Event('input', { bubbles: true }));
  })()`, false);
  await setInput('a1');
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 1`);
  ok(true, 'UI: search "a1" narrows to 1 row');
  await setInput('zzz');
  await waitJs(`!!document.querySelector('.browser-empty')`);
  ok(await evalJs(`document.querySelector('.browser-empty')?.textContent.length > 0`, false), 'UI: empty-state shown for no match');
  await setInput('');
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 4`);

  // keyboard: ArrowDown + Enter loads the second row (a2)
  await evalJs(`document.querySelector('.browser-files').focus()`, false);
  await evalJs(`document.querySelector('.browser-files').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))`, false);
  await waitJs(`document.querySelectorAll('.browser-file')[1]?.classList.contains('cursor')`);
  ok(true, 'UI: ArrowDown moves keyboard cursor');
  await evalJs(`document.querySelector('.browser-files').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`, false);
  await waitJs(`document.querySelector('.sb-hint')?.textContent.includes('载入')`, 6000);
  ok(true, 'UI: Enter loads file (status hint shows 已载入编辑器)');

  // refresh keeps the list
  await evalJs(`document.querySelector('.browser-refresh')?.click()`, false);
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 4`, 6000);
  ok(true, 'UI: refresh rescans');

  // ---- preview player: thumbnail + tempo mode -----------------------------
  r = await api('browser.preview', { path: [ROOT_A, 'a1.mid'].join('\\') });
  ok(r.ok === true && r.fileBpm > 137 && r.fileBpm < 139, 'preview: file tempo parsed (138)', JSON.stringify(r.fileBpm));
  ok(Array.isArray(r.notes) && r.notes.length === 3 && r.len > 0, 'preview: thumbnail notes returned', JSON.stringify(r.notes));
  r = await api('browser.previewControl', { action: 'pause' });
  ok(r === true, 'previewControl: pause ok');
  r = await api('browser.previewControl', { action: 'resume' });
  ok(r === true, 'previewControl: resume ok');
  r = await api('browser.setPreviewTempoMode', { useFileTempo: true });
  ok(r === true, 'setPreviewTempoMode: file tempo ok');
  r = await api('browser.setPreviewTempoMode', { useFileTempo: false });
  ok(r === true, 'setPreviewTempoMode: project tempo ok');

  // UI: the modal is open — install a push-event collector, then click a row
  // to preview. The chain under test: audio thread → pushPreview → WebView.
  await evalJs(`window.__pv = []; __PME_BRIDGE__.onEvent((e) => { if (e.kind === 'preview') window.__pv.push({ t: performance.now(), ...(e.preview ?? {}) }); });`, false);
  await evalJs(`[...document.querySelectorAll('.browser-file')].find((b) => b.textContent.includes('a1.mid'))?.click()`, false);
  await waitJs(`!!document.querySelector('.browser-thumb')`, 6000);
  const cw = await evalJs(`document.querySelector('.browser-thumb')?.clientWidth ?? 0`, false);
  ok(cw > 100, 'UI: thumbnail canvas rendered', String(cw));
  await waitJs(`document.querySelectorAll('.browser-tempo-seg .mini-btn').length === 2`, 4000);
  ok(await evalJs(`!!document.querySelector('.browser-transport .mini-btn')`, false), 'UI: transport buttons rendered');

  // progress must actually advance (pushes arrive with growing pos)
  await sleep(1300);
  let stats = await evalJson(`(() => {
    const act = window.__pv.filter((e) => e.active);
    return JSON.stringify({ n: act.length, maxPos: Math.max(0, ...act.map((e) => e.pos)) });
  })()`, false);
  ok(stats.n >= 10, 'chain: preview pushes arriving', JSON.stringify(stats));
  ok(stats.maxPos > 0.05, 'chain: progress advances', JSON.stringify(stats));
  ok(await evalJs(`document.querySelector('.browser-transport .mini-btn')?.textContent === '⏸'`, false), 'UI: playing state shows ⏸');

  // PAUSE via the real button: pushes say paused, position frozen
  await evalJs(`document.querySelectorAll('.browser-transport .mini-btn')[0]?.click()`, false);
  await waitJs(`window.__pv.some((e) => e.paused)`, 4000);
  const frozen = await evalJs(`window.__pv.filter((e) => e.active).map((e) => e.pos).pop()`, false);
  await sleep(700);
  const frozenStats = await evalJson(`(() => {
    const recent = window.__pv.filter((e) => e.t > performance.now() - 500 && e.active);
    return JSON.stringify({ last: recent.map((e) => e.pos).pop() ?? -1, btn: document.querySelector('.browser-transport .mini-btn')?.textContent });
  })()`, false);
  ok(Math.abs(frozenStats.last - frozen) < 1e-6, 'chain: position frozen while paused', frozen + ' vs ' + JSON.stringify(frozenStats));
  ok(frozenStats.btn === '▶', 'UI: paused state shows ▶ (stays paused)', JSON.stringify(frozenStats.btn));

  // RESUME via the same button — the regression the user hit: the button must
  // be able to send resume and playback must continue. The preview loops, so
  // the cursor may wrap past the end: assert it MOVED off the frozen point.
  await evalJs(`document.querySelectorAll('.browser-transport .mini-btn')[0]?.click()`, false);
  await waitJs(`window.__pv.some((e) => !e.paused && e.active && e.t > performance.now() - 2000)`, 4000);
  await sleep(800);
  const resumeStats = await evalJson(`(() => {
    const recent = window.__pv.filter((e) => e.t > performance.now() - 500 && e.active);
    return JSON.stringify({ n: recent.length, last: recent.map((e) => e.pos).pop() ?? -1, paused: recent.some((e) => e.paused), btn: document.querySelector('.browser-transport .mini-btn')?.textContent });
  })()`, false);
  ok(resumeStats.n >= 3 && resumeStats.last !== frozen && !resumeStats.paused,
    'chain: progress moves after resume', JSON.stringify({ frozen, ...resumeStats }));
  ok(resumeStats.btn === '⏸', 'UI: resume shows ⏸ again', JSON.stringify(resumeStats.btn));
  await api('browser.stopPreview');

  // ---- loading overlay on slow folder switches ----------------------------
  // Monkey-patch the bridge's invoke to delay listFiles, then switch folder
  // via the real sidebar: the spinner overlay must appear during the delay
  // and disappear once the rows land.
  await evalJs(`(() => {
    const orig = __PME_BRIDGE__.invoke.bind(__PME_BRIDGE__);
    window.__origInvoke = orig;
    __PME_BRIDGE__.invoke = (name, payload, opts) =>
      name === 'browser.listFiles'
        ? new Promise((res, rej) => setTimeout(() => orig(name, payload, opts).then(res, rej), 900))
        : orig(name, payload, opts);
  })()`, false);
  await evalJs(`[...document.querySelectorAll('.browser-folder-btn')].find((b) => b.textContent === 'KitB')?.click()`, false);
  await waitJs(`!!document.querySelector('.browser-loading .browser-spinner')`, 2500);
  ok(true, 'UI: spinner overlay appears during slow scan');
  await waitJs(`!document.querySelector('.browser-loading')`, 8000);
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 1`, 4000);
  ok(true, 'UI: overlay clears and KitB rows render after scan');
  await evalJs(`__PME_BRIDGE__.invoke = window.__origInvoke;`, false);

  // ---- explicit load button (double-click removed) -------------------------
  // record browserLoaded pushes; double-clicking a row must NOT load, the
  // 载入 button must.
  await evalJs(`window.__bl = []; __PME_BRIDGE__.onEvent((e) => { if (e.kind === 'browserLoaded') window.__bl.push(e.browserLoaded ?? {}); });`, false);
  // switch back to KitA for rows
  await evalJs(`[...document.querySelectorAll('.browser-folder-btn')].find((b) => b.textContent === 'KitA')?.click()`, false);
  await waitJs(`document.querySelectorAll('.browser-files .browser-file').length === 4`, 6000);
  const a2row = await evalJs(`!![...document.querySelectorAll('.browser-file')].find((b) => b.textContent.includes('a2.mid'))`, false);
  ok(a2row === true, 'UI: KitA rows visible for load test');
  // a double click on the row must not load (no button on the page shows a
  // loaded hint, and no browserLoaded event arrives)
  await evalJs(`(() => {
    const row = [...document.querySelectorAll('.browser-file')].find((b) => b.textContent.includes('a2.mid'));
    row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
    row?.click(); row?.click();   // rapid double click (detail counts up)
  })()`, false);
  await sleep(500);
  const blAfterDbl = await evalJs(`window.__bl.length`, false);
  ok(blAfterDbl === 0, 'chain: double-click no longer loads', String(blAfterDbl));
  // the explicit load button does load
  await evalJs(`[...document.querySelectorAll('.browser-file')].find((b) => b.textContent.includes('a2.mid'))?.querySelector('.browser-file-load')?.click()`, false);
  await waitJs(`window.__bl.length >= 1 && window.__bl[0].ok === true`, 8000);
  ok(true, 'chain: load button triggers browserLoaded(ok)');
  await waitJs(`document.querySelector('.sb-hint')?.textContent.includes('载入')`, 4000);
  ok(true, 'UI: load hint shown');
  // overlay must be gone once loaded
  await waitJs(`!document.querySelector('.browser-modal > .browser-loading')`, 4000);
  ok(true, 'UI: load overlay clears after completion');

  // chord analysis: loading prog.mid (Cmaj + Amin) must fill the chord track
  await evalJs(`window.__docEv = []; __PME_BRIDGE__.onEvent((e) => { if (e.kind === 'doc') window.__docEv.push(e.doc); });`, false);
  await evalJs(`[...document.querySelectorAll('.browser-file')].find((b) => b.textContent.includes('prog.mid'))?.querySelector('.browser-file-load')?.click()`, false);
  await waitJs(`(window.__docEv.at(-1)?.chords?.length ?? 0) >= 2`, 8000);
  const chords = await evalJs(`window.__docEv.at(-1)?.chords?.map((c) => [c.r, c.q, Math.round(c.s)])`, false);
  ok(JSON.stringify(chords) === '[[0,0,0],[9,1,4]]', 'chain: chord track auto-filled (Cmaj, Amin)', JSON.stringify(chords));
  await api('browser.stopPreview');

  // ---- fit-to-chords button ------------------------------------------------
  // The standalone persists its document across runs, so clear it first via
  // doc.edit, then build a known doc: Cmaj chord over bar 1 + F#4 (nearest
  // tone G), on-chord E4 (stays), Bb4 beyond the chord (untouched).
  await evalJs(`window.__fitEv = []; __PME_BRIDGE__.onEvent((e) => { if (e.kind === 'doc') window.__fitEv.push(e.doc); });`, false);
  // clear whatever the standalone persisted from earlier runs: pull the
  // current doc via 'init', then remove everything
  const cur = await evalJs(`__PME_BRIDGE__.invoke('init').then((r) => JSON.stringify({
    n: r.doc.notes.map((x) => Math.round(x.id)),
    c: r.doc.chords.map((x) => Math.round(x.id)),
  }))`, true);
  const curDoc = typeof cur === 'string' ? JSON.parse(cur) : cur;
  await evalJs(`__PME_BRIDGE__.invoke('doc.edit', { name: 'reset', ops: [
    { op: 'removeMany', ids: ${JSON.stringify(curDoc.n)} },
    { op: 'removeManyChords', ids: ${JSON.stringify(curDoc.c)} },
  ] })`, false);
  await waitJs(`(window.__fitEv.at(-1)?.notes?.length ?? 0) === 0`, 6000);
  await evalJs(`__PME_BRIDGE__.invoke('doc.edit', { name: 'setup', ops: [
    { op: 'addChord', chord: { s: 0, l: 4, r: 0, q: 0 } },
    { op: 'add', note: { p: 66, s: 0.5, l: 1, v: 0.8, m: false, c: 1, a: -1 } },
    { op: 'add', note: { p: 64, s: 1.5, l: 1, v: 0.8, m: false, c: 1, a: -1 } },
    { op: 'add', note: { p: 70, s: 6.0, l: 1, v: 0.8, m: false, c: 1, a: -1 } },
  ] })`, false);
  await waitJs(`(window.__fitEv.at(-1)?.notes?.length ?? 0) === 3 && (window.__fitEv.at(-1)?.chords?.length ?? 0) === 1`, 6000);
  await evalJs(`[...document.querySelectorAll('.tb-btn .tb-text')].find((b) => b.textContent === '适配和弦')?.parentElement.click()`, false);
  await waitJs(`(() => {
    const d = window.__fitEv.at(-1);
    return d?.notes?.length === 3 && d.notes.every((n) => n.p !== 66) && d.notes.filter((n) => n.p === 67).length === 1;
  })()`, 6000);
  const fit = await evalJson(`(() => {
    const d = window.__fitEv.at(-1);
    return JSON.stringify({ ps: d.notes.map((n) => n.p).sort((a, b) => a - b), hint: document.querySelector('.sb-hint')?.textContent });
  })()`, false);
  ok(JSON.stringify(fit.ps) === '[64,67,70]', 'chain: fit moved F#4 to G4', JSON.stringify(fit));
  ok(String(fit.hint).includes('已将 1 个音符适配'), 'UI: hint shows 1 note fitted', JSON.stringify(fit));

  // empty chord track → clear hint, no crash
  await evalJs(`__PME_BRIDGE__.invoke('doc.edit', { name: 'rm', ops: [ { op: 'removeManyChords', ids: window.__fitEv.at(-1).chords.map((c) => Math.round(c.id)) } ] })`, false);
  await waitJs(`(window.__fitEv.at(-1)?.chords?.length ?? 0) === 0`, 6000);
  await evalJs(`[...document.querySelectorAll('.tb-btn .tb-text')].find((b) => b.textContent === '适配和弦')?.parentElement.click()`, false);
  await waitJs(`document.querySelector('.sb-hint')?.textContent.includes('和弦轨为空')`, 4000);
  ok(true, 'UI: empty chord track hint');
  await evalJs(`__PME_BRIDGE__.invoke('doc.edit', { name: 'clear', ops: window.__fitEv.at(-1).notes.map((n) => ({ op: 'remove', id: Math.round(n.id) })) })`, false);
  await api('browser.stopPreview');

  // close modal, restore the user's library
  await evalJs(`document.querySelector('.browser-modal .modal-head .tb-btn')?.click()`, false);
  await sleep(400);
  console.log(failures === 0 ? '\nALL E2E TESTS PASSED' : `\n${failures} E2E FAILURE(S)`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.log('E2E ERROR:', String(err));
  process.exitCode = 1;
} finally {
  // always restore the user's library and drop the test folders, even when a
  // step above threw — a failed run must not lose the user's folders.
  try {
    const alive = await Promise.race([
      fetch('http://127.0.0.1:9223/json').then((r) => r.ok), () => false,
    ]).catch(() => false);
    if (alive && evalJs && ws && ws.readyState === 1) {
      const apiFix = (name, payload) =>
        evalJs(`__PME_BRIDGE__.invoke(${JSON.stringify(name)}, ${JSON.stringify(payload ?? null)})`).catch(() => {});
      for (const f of [ROOT_A, ROOT_B]) await apiFix('browser.removeFolder', { path: f });
      for (const f of userFolders) await apiFix('browser.addFolder', { path: f });
      await apiFix('browser.setLastFolder', { path: userLast });
      console.log('cleanup: user library restored');
    }
  } catch {}
  app.kill();
  fs.rmSync('C:\\Temp\\PmeLibTest', { recursive: true, force: true });
}
