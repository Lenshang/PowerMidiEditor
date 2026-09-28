// Frontend drummap modal flow: import fills draft, confirm applies.
import fs from 'node:fs';

const p = new URL('../frontend/src/ui/Toolbar.tsx', import.meta.url);
let s = fs.readFileSync(p, 'utf8');

// 1) modal map-name state
if (!s.includes('drumModalName')) {
  s = s.replace(
    "  const [drumMapEditorOpen, setDrumMapEditorOpen] = useState(false);",
    "  const [drumMapEditorOpen, setDrumMapEditorOpen] = useState(false);\n  const [drumModalName, setDrumModalName] = useState('Custom');");
}

// 2) draft-sync effect: reset to a blank row when nothing applied yet
s = s.replace(
  "    const entries = useStore.getState().drumMap.entries ?? [];\n    if (entries.length > 0) setDrumDraft(entries.map((e) => ({ ...e })));",
  "    const entries = useStore.getState().drumMap.entries ?? [];\n    setDrumDraft(entries.length > 0 ? entries.map((e) => ({ ...e })) : [{ i: 36, o: 36, c: 0, name: '' }]);");

// 3) import button: one-shot drummapDraft listener fills the draft
const oldImport = `                <button className="mini-btn" onClick={() => {
                  void getBridge().invoke('drummap.load').then(() => {
                    const st = useStore.getState();
                    setDrumDraft((st.drumMap.entries ?? []).map((e) => ({ ...e })));
                    setHint(\`已导入: \${st.drumMap.name}\`);
                  }).catch(() => {});
                }}>{t('exp.importJson')}</button>`;
const newImport = `                <button className="mini-btn" onClick={() => {
                  const off = getBridge().onEvent((ev: unknown) => {
                    const e = ev as { kind?: string; drummapDraft?: { name: string; entries: Array<{ i: number; o: number; c: number; name: string }> } };
                    if (e.kind !== 'drummapDraft' || !e.drummapDraft) return;
                    off();
                    setDrumDraft(e.drummapDraft.entries.map((x) => ({ ...x })));
                    setDrumModalName(e.drummapDraft.name || 'Custom');
                    setHint(\`已导入: \${e.drummapDraft.name}（确认后生效）\`);
                  });
                  void getBridge().invoke('drummap.load').catch(() => off());
                }}>{t('exp.importJson')}</button>`;
if (!s.includes(oldImport)) { console.error('import button not found'); process.exit(1); }
s = s.replace(oldImport, newImport);

// 4) clear button: local draft reset only (apply persists the empty map)
const oldClear = `                <button className="mini-btn" onClick={() => {
                  void getBridge().invoke('drummap.clear').then(() => {
                    setDrumDraft([{ i: 36, o: 36, c: 0, name: '' }]);
                    setHint('已清除鼓组映射（恢复 GM 名称）');
                  }).catch(() => {});
                }}>清除</button>`;
const newClear = `                <button className="mini-btn" onClick={() => {
                  setDrumDraft([{ i: 36, o: 36, c: 0, name: '' }]);
                  setDrumModalName('Custom');
                }}>清除</button>`;
if (s.includes(oldClear)) s = s.replace(oldClear, newClear);

// 5) apply uses the modal name
s = s.replace(
  "void getBridge().invoke('drummap.set', { name: drumMapName || 'Custom', entries: clean })",
  "void getBridge().invoke('drummap.set', { name: drumModalName || 'Custom', entries: clean })");

// 6) export uses the modal name
s = s.replace(
  "name: drumMapName || 'Custom',\n                    entries: drumDraft.filter",
  "name: drumModalName || 'Custom',\n                    entries: drumDraft.filter");

// 7) toolbar button: fixed label
const oldBtn = `          <button className="tb-btn" title={drumMapName ? \`鼓组映射: \${drumMapName} — 点击加载 .bwdrm/.drm\` : '加载 .bwdrm/.drm 鼓组映射'}
            onClick={openDrumMapEditor}>
            <span className="tb-text">{drumMapName ? drumMapName.slice(0, 8) : t('tb.drumMap')}</span>
          </button>`;
const newBtn = `          <button className="tb-btn" title={t('tb.drumMapEditor')}
            onClick={openDrumMapEditor}>
            <span className="tb-text">{t('tb.drumMap')}</span>
          </button>`;
if (s.includes(oldBtn)) s = s.replace(oldBtn, newBtn);

fs.writeFileSync(p, s);
console.log('frontend flow rewired:', s.includes('drummapDraft') && s.includes('drumModalName'));
