# UI ⇄ C++ 桥接协议 v1

PowerMidiEditor 的 WebView UI 与 JUCE/C++ 之间只有**一条 RPC 通道**和**一条事件通道**。
本文档是两端共同遵守的契约；前端类型定义在 `frontend/src/bridge/protocol.ts`，
C++ 实现集中在 `Source/Bridge/UiBridge.cpp`。

## 传输层（JUCE WebView 原生互操作）

- 页面必须由 `withNativeIntegrationEnabled()` 注入的 `window.__JUCE__.backend` 驱动。
- **UI → C++（RPC）**：向 `__juce__invoke` 事件发送
  `{ name, params: [payload], resultId }`；应答在 `__juce__complete` 事件上，
  载荷 `{ promiseId, result }`，其中 `result` 即 RPC 返回值。
  本插件注册的原生函数名固定为 **`invoke`**，`params[0] = 协议名`，`params[1] = payload`。
- **C++ → UI（推送）**：C++ 通过 `emitEventIfBrowserIsVisible("pme", msg)` 推送，
  UI 监听 `pme` 事件。`msg = { kind, ... }`，`kind ∈ { doc, settings, transport, midi }`。
- RPC 返回值统一为 `{ ok: true, data }` 或 `{ ok: false, error }`；前端桥接层把
  `data` 解包为 Promise 结果、把 `error` 转为 rejected。

## RPC（invoke 的 name → payload → data）

| name | payload | data | 说明 |
|---|---|---|---|
| `init` | – | `{ doc, settings, version }` | UI 加载后首先调用；此后 C++ 开始推送增量 |
| `doc.edit` | `{ ops: EditOp[], name }` | `{ revision, canUndo, canRedo }` | 事务性编辑，一个事务对应一条撤销记录 |
| `doc.undo` / `doc.redo` | – | `{ revision, canUndo, canRedo }` | |
| `doc.clear` | – | `{ revision }` | 清空全部音符 |
| `settings.update` | 完整或部分 `SettingsState` | `{ settings, revision }` | C++ 端合并已提供的键并持久化 |
| `audition.start` | `{ ppq }` | `true` | 试听工具：从该位置开始本地播放 |
| `audition.stop` | – | `true` | 停止试听并清理发声音符 |
| `preview.note` | `{ p, c, v }` | `true` | 短预览音（约 0.35 s 自动收尾） |
| `panic` | – | `true` | 立即全部 Note Off |

### EditOp（doc.edit 的原子操作）

```ts
type EditOp =
  // 音符
  | { op: 'add';        note: NoteDraft }        // id 由 C++ 分配
  | { op: 'update';     note: Partial<Note> & { id } }
  | { op: 'remove';     id: number }
  | { op: 'updateMany'; notes: Array<Partial<Note> & { id }> }
  | { op: 'removeMany'; ids: number[] }
  // CC 控制器（力度在音符上：update note.v）
  | { op: 'addCC';        ev: Omit<ControllerEvent, 'id'> }
  | { op: 'updateManyCC'; evs: Array<Partial<ControllerEvent> & { id }> }
  | { op: 'removeManyCC'; ids: number[] }
  // Pitch Bend（14 位，8192 = 居中）
  | { op: 'addPB';        ev: Omit<PitchBendEvent, 'id'> }
  | { op: 'updateManyPB'; evs: Array<Partial<PitchBendEvent> & { id }> }
  | { op: 'removeManyPB'; ids: number[] };
```

### Note（线格式，键名刻意取短）

```ts
interface Note { id: number; p: number; s: number; l: number; v: number; m: boolean; c: number }
//            id | pitch | start(四分音符) | length | velocity 0..1 | muted | channel 1..16
```

时间单位一律为**四分音符（PPQ=1.0）**，与宿主 tick 分辨率无关。

### SettingsState

```ts
interface SettingsState {
  theme: string;                 // 'dark' | 'light' | 'cubase'
  shortcuts: Record<string, Binding>;  // 见下；缺省动作使用内置默认
  gridPpq: number;               // 网格精度，0.25 = 1/16
  snap: boolean; triplet: boolean;
  lengthQuantize: string;        // 'off' | 'grid'（Phase 2 生效）
  autoQuantizeInput: boolean;
}
// Binding = { type:'key', code, ctrl, alt, shift, meta }
//         | { type:'wheel', dir:'up'|'down', ctrl, alt, shift }
//         | { type:'none' }   // 显式解除默认绑定
```

## 推送事件（kind → 载荷）

| kind | 载荷 | 时机 |
|---|---|---|
| `doc` | `{ revision, notes: Note[], ccs: ControllerEvent[], pbs: PitchBendEvent[] }`（全量快照） | 文档 revision 变化 |
| `settings` | `SettingsState` | settingsRevision 变化 |
| `transport` | `{ playing, ppqValid, ppq, loopValid, loopStart, loopEnd, tempo, sampleRate }` | 每 33 ms 轮询、值变化时；UI 端在两帧之间按 tempo 插值播放头 |
| `midi` | `Array<{ on, p, c, v }>` | 输入 MIDI 音符（步进输入 / 键位高亮用） |

```ts
interface ControllerEvent { id: number; cc: number; c: number; t: number; v: number }
//                        cc 号 0..127 | 通道 1..16 | 时间(四分音符) | 值 0..127
interface PitchBendEvent  { id: number; c: number; t: number; v: number }
//                                                    值 0..16383，8192 = 居中
```

## 交互语义约定

- **UI 交互期间**（拖拽/框选/画笔预览）本地先行渲染"幽灵"层，鼠标抬起才提交
  `doc.edit`——避免 60Hz 全量推送。
- `revision` 单调递增；UI 收到的推送与本地一致时直接应用（当前为单一数据源模式，
  UI 不本地合并编辑）。
- Mock 后端（浏览器开发用）按同一契约实现以上全部行为，仅无真实 MIDI 输出。
