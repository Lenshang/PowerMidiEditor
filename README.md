# PowerMidiEditor

一个基于 **JUCE 9 + WebView2** 的 VST3 MIDI 钢琴窗编辑器插件。作为 MIDI 效果器运行在
宿主的 Note FX / MIDI 插槽中（如 Bitwig Studio 的 Note FX），编辑后的 MIDI 实时发送给
下游音源，并与 DAW 播放严格同步。

> 背景：Bitwig 的 MIDI Clip 导出不是标准 MIDI 格式，且缺少 Cubase 式的表达映射、
> 和弦轨等功能。本项目用"插件内钢琴窗"的方式补齐这些能力。

## 当前状态（Phase 0–5 已完成）

- ✅ **PowerMidiEditor** VST3：纯 MIDI 总线（MIDI 输入/输出，无音频总线），
  专用于 **Bitwig Note FX** 与 Cubase MIDI 插槽；WebView UI 嵌入插件本体，
  静态链接 WebView2（无额外 DLL 依赖）；另附 Standalone 独立运行版
- ✅ 自动化端到端测试（`scripts\test.ps1`）：内置迷你宿主加载构建出的 VST3，
  伪造宿主走带校验音符/CC/弯音调度与 MIDI 直通，并自动打开编辑器等待
  WebView 桥接连通——**不需要打开 Bitwig 即可完成回归验证**
- ✅ MIDI 直通 + 内置 pattern 播放引擎：按宿主 playhead 采样级调度、循环区间截断、
    追赶音符（播放中途开始也能听到长音）、重定位自动清理挂音
- ✅ **全部 8 工具**：箭头（点选/框选/拖动移动/右缘缩放/Alt+拖动复制）、
    范围选择（时间范围选音符）、铅笔（拖动画音符+拖长）、喷灌（按网格批量画）、
    剃刀（网格处切分）、擦除（拖过即删）、试听（按住从点击处播放）、
    步进输入（MIDI 输入自动写入并按网格前进）
- ✅ 剪贴板：复制/剪切/粘贴到光标（标尺点击设定）/Ctrl+D 重复所选
- ✅ 量化：量化所选起始位置（Q）/ 量化长度（Shift+Q）；网格 1/1–1/64 + 三连音 + 吸附（J）
- ✅ **表达映射**：命名表情（Keyswitch 音符和/或 CC 输出），播放时自动在表情切换处
    注入；音符携带表情标签（工具栏下拉选择绘制表情）；JSON 导入/导出
- ✅ **和弦轨**：和弦事件车道（点击添加/拖动移动/拖缘改长/工具栏改根音与性质），
    钢琴窗中当前和弦的和弦内音自动高亮
- ✅ **力度/CC/弯音车道**：力度柱拖拽（选中可整体调）、CC 折线点编辑、弯音点编辑，
    播放时全部随走带输出
- ✅ **MIDI 输出监视器**：状态栏实时显示最近发给下游的弯音值和 CC 值——
    用于区分"插件没发"还是"音源没响应"
- ✅ **标准 MIDI 文件导入/导出**（480 PPQ，音符+CC+弯音，工具栏一键），**拖出**：
  「拖出」按钮按住不放直接拖到宿主轨道/桌面（OLE 拖拽在鼠标按下时启动——
  松开状态进入 DoDragDrop 会被系统立即取消，因此触发点在 pointerdown），**拖入**：
  把 .mid 文件拖到钢琴窗上松开即导入（音符/CC/弯音）
- ✅ **实时录音**：工具栏红点布防后，宿主播放时弹奏的音符自动写入 pattern
  （可配合「自动量化」开关吸附到网格）
- ✅ **右键菜单**：音符上右键 → 删除/复制/静音/Legato/人性化/清除表情；空白处右键 → 粘贴到此处/全选
- ✅ **编辑增强**：M 静音切换、Alt+↑↓ 半音微调、Ctrl+↑↓ 转置、Alt+Shift+↑↓ 八度、
  L Legato（延长到同音高下一音符）、H 力度人性化（±15% 随机）、A/B 快照对比
- ✅ **CC 车道绘制模式**：点编辑 / 直线填充 / 自由绘制；支持多条 CC 泳道堆叠显示
  （CC 下拉选择新编号即自动加泳道）
- ✅ **鼓组模式**：键位列显示 GM 鼓件名，音符渲染为菱形点
- ✅ **和弦辅助**：开启后画音符自动吸附到当前和弦内音；选中和弦一键**生成琶音**
- ✅ **拍号显示**：跟随宿主拍号渲染小节线与位置读数（小节.拍.十六分）
- ✅ **小地图概览条**：底部总览 + 视口框，点击/拖动快速导航
- ✅ 跟随播放头开关；编辑光标可直接在标尺上拖动
- ✅ **工程文件**：保存/打开 `.pmeproj`（Standalone 模式下亦可持久化工作）
- ✅ **Cubase `.expressionmap` 导入**（尽力解析名称与 Keyswitch）
- ✅ 快捷键引擎：所有动作（8 工具、视图、编辑、网格、滚轮修饰键方案）可在设置面板
    「捕获」重映射；主题：深邃 / 明亮 / 蓝调（Cubase 风）
- ✅ 钢琴窗：分层 Canvas 渲染（键盘 / 网格 / 音符 / 标尺 / 播放头），DPR 自适应
- ✅ 四向缩放滚动：默认 `滚轮=纵向`、`Alt+滚轮=横向`、`Ctrl+滚轮=横向缩放（鼠标锚点）`、
- ✅ 中键拖动平移：钢琴窗内按住鼠标中键拖动，自由纵向/横向滚动（拓展手式）
    `Ctrl+Alt+滚轮=纵向缩放（鼠标锚点）`；另有 `+ / -` 缩放、方向键滚动、`F` 缩放到内容
- ✅ 快捷键引擎：所有动作（8 个工具、视图、编辑、网格、含滚轮修饰键方案）均可在
    设置面板中点击「捕获」重映射，支持冲突自动解除，随插件状态持久化
- ✅ 工具栏 8 工具按钮（数字键 1-8 切换）：箭头 / 范围 / 铅笔 / 喷灌 / 剃刀 / 擦除 /
    试听 / 步进输入（编辑逻辑在 Phase 2 实现，箭头工具的框选/点选/删除已可用）
- ✅ 网格设置：吸附开关（J）、1/1–1/64 精度、三连音；长度量化选项（Phase 2 生效）
- ✅ 表情编辑车道（下方面板）：
  - **力度**：逐音符力度柱拖拽调整；先框选音符可整体等量调整
  - **CC 控制器**：折线点编辑（点击添加 / 拖动移动 / Alt+点击删除 / Delete 删除选中 /
    清空车道），CC 号下拉快捷选择（11 表情 / 1 调制 / 7 音量 / 10 声像 / 64 延音）或
    任意输入 0-127；播放时随宿主走带输出
  - **Pitch Bend**：14 位弯音点编辑，带中线参考；播放时输出弯轮事件
  - 三种车道编辑全部进入撤销/重做体系，并同步到浏览器 Mock 后端
- ✅ 主题：深邃（默认）/ 明亮 / 蓝调（Cubase 风），设置面板一键切换
- ✅ 试听工具（按住从点击位置播放、松开停止）与琴键点击试听已接入引擎
- ✅ 引擎单元测试（调度 / 循环 / 试听 / 撤销 / JSON）全部通过

## 目录结构

```
PowerMidiEditor/
├─ CMakeLists.txt            # 插件 + 测试构建（JUCE 本地副本、WebView2 自动探测）
├─ Source/                   # C++（数据的权威端）
│  ├─ PluginProcessor.*      #   音频/MIDI 处理、状态持久化
│  ├─ PluginEditor.*         #   编辑器外壳
│  ├─ Bridge/UiBridge.*      #   WebView 桥接（invoke RPC + 事件推送 + 资源服务）
│  ├─ Model/MidiClipDocument.* # 文档模型（命令式撤销 + 无锁快照发布）
│  ├─ Playback/PlaybackEngine.*# 播放引擎（音频线程实时调度）
│  └─ Util/VarUtil.h
├─ frontend/                 # React + TypeScript + Vite（视觉与交互层）
│  ├─ src/bridge/            #   JUCE 互操作 + 浏览器 Mock 后端
│  ├─ src/pianoroll/         #   Canvas 渲染、坐标变换、指针交互
│  ├─ src/state/             #   zustand 状态、快捷键系统、动作分发
│  ├─ src/ui/                #   工具栏 / 设置面板 / 状态栏 / 主题
│  └─ scripts/make-zip.mjs   #   打包 dist -> assets.zip（编译期嵌入插件）
├─ Tests/PmeTests.cpp        # 引擎单元测试
├─ scripts/build.ps1         # 一键构建
└─ scripts/install-vst3.ps1  # 安装到系统 VST3 目录
```

## 构建

依赖：**CMake ≥ 3.24、Visual Studio 2022（含 MSVC v143）、Node.js LTS、WebView2 运行时**
（Win10/11 一般自带）。本仓库自带 `JUCE/`（9.0.2）；WebView2 SDK 会自动从
`~/.nuget/packages/microsoft.web.webview2` 探测并镜像，无需手动安装。

```powershell
# 一键构建（首次会自动 npm install）
powershell -ExecutionPolicy Bypass -File scripts\build.ps1 -Config Release

# 产物
build\PowerMidiEditor_artefacts\Release\VST3\PowerMidiEditor.vst3        # 纯 MIDI（Note FX）
build\PowerMidiEditor_artefacts\Release\Standalone\PowerMidiEditor.exe   # 独立运行版
```

可选开关（传给 CMake）：

| 开关 | 说明 |
|---|---|
| `-DPME_DEV_MODE=ON` | 编辑器直接加载 Vite 开发服务器（前端热更新） |
| `-DPME_BUILD_TESTS=OFF` | 跳过两个测试程序 |

## 自动化测试（不需要打开 Bitwig）

```powershell
powershell -ExecutionPolicy Bypass -File scripts\test.ps1 -Config Release
```

`scripts\test.ps1` 会启动内置迷你宿主 **PmeHost**，对构建出的 VST3 完成四类检查，
全部通过输出 `== PASS ==` 并返回 0，任何一项失败即非零退出：

1. 插件加载与总线布局（MIDI-only：0 音频进出、有 MIDI 事件总线）
2. 走带调度：伪造宿主 playhead（120 BPM、播放态）驱动 processBlock，
   校验示例内容的 10 个音符开关事件落在正确的采样位置、5 个 CC11、3 个弯音
3. MIDI 直通：外部输入的 Note On / CC64 原样出现在输出
4. WebView 桥接：自动打开插件编辑器，30 秒内等待 UI 完成 init RPC
   （通过内部 "UI Connected" 参数信号判定），超时即失败

另有纯引擎单元测试（文档/撤销/调度/MIDI 内存导入）：`build\PmeTests_artefacts\Release\PmeTests.exe`。

### 拖出手势自动化自测（真实鼠标事件）

```powershell
# 前提：Standalone 已运行且带远程调试（调试用，可选）：
#   $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9223"
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\dragout-test.ps1
```

脚本通过 WebView2 CDP 精确定位「拖出」按钮，把插件窗口临时置顶，然后用
SendInput 发送真实的 按下→按住→移动→松开 序列（模拟用户手势），用于回归验证
"松开状态进入 DoDragDrop 即取消" 的拖出问题。

### 前端独立开发

```powershell
cd frontend
npm install
npm run dev      # http://localhost:5173 —— 浏览器直接运行，自动启用 Mock 后端
```

浏览器里没有 `window.__JUCE__` 时自动切换 Mock 后端（模拟播放头/循环、WebAudio 试听、
localStorage 持久化、右下角 Mock 控制条），UI 开发完全不依赖 DAW。

## 安装与在 Bitwig 中验收

1. 安装（任选其一）：
   - **批处理（推荐，无执行策略限制）**：双击或在终端运行 `scripts\install-vst3.cmd`
     ——会同时安装 **VST3 与 CLAP** 两个格式
   - PowerShell：`powershell -ExecutionPolicy Bypass -File scripts\install-vst3.ps1 -Config Release`
   - 手动：`PowerMidiEditor.vst3` → `C:\Program Files\Common Files\VST3\`；
     `PowerMidiEditor.clap` → `C:\Program Files\Common Files\CLAP\`（需要管理员权限）
2. 启动 Bitwig → 设置 → Plug-ins → Rescan（建议关掉 "Ignore plug-in failure" 再扫）
3. 在乐器轨上添加 **Note FX → PowerMidiEditor**
4. **弯音/CC 下游不生效？请优先使用 CLAP 版**：VST3 规范没有原生 MIDI 输出，
   CC/弯音只能走 "Legacy MIDI CC out" 事件，而 Bitwig 对该事件的处理存在缺口
   （音符正常、CC/弯音丢失，社区多处反馈）。CLAP 格式有原生 MIDI 输出
   （Bitwig 正是 CLAP 的联合创造者），本插件的 CLAP 版走 `clap_event_midi`，
   不受此限制。两个格式可共存，功能一致。
4. 验收清单：
   - [ ] 插件窗口打开且显示钢琴窗（含示例音符与力度/CC/弯音车道）
   - [ ] 在轨上放一个 Clip 播放，插件下方音源发声（MIDI 直通）
   - [ ] 按住试听工具（7）在钢琴窗拖动：从点击位置开始发声，松开停止
   - [ ] 点击左侧琴键：音源发声
   - [ ] Ctrl+滚轮缩放、Alt+滚轮横移，1-8 切换工具
   - [ ] 拖动 CC11 曲线播放，音源表情随之变化；拖弯音点可听到弯音
   - [ ] **弯音/CC 到达下游音源**：VST3 版在 Bitwig 上受宿主限制可能不通；
         此时改加载 **CLAP 版**再验一遍（原生 MIDI 输出，应全通）
   - [ ] 「拖出」：按下「拖出」按钮不放，拖到 Bitwig 轨道/桌面后松开生成 Clip；
         再把该 .mid 从资源管理器拖回钢琴窗，内容应被导入
   - [ ] 设置面板切换主题、重映射快捷键，重开窗口后设置保留（随工程保存）

> 常见问题：
> - `无法加载 …ps1，因为在此系统上禁止运行脚本` —— PowerShell 执行策略限制，
>   命令里加 `-ExecutionPolicy Bypass`，或直接用 `scripts\install-vst3.cmd`。
> - 打开插件停留在"正在连接后端…"或显示后端连接失败 —— 先跑 `scripts\test.ps1`，
>   把失败项反馈到项目中。
> - **拖出不生效**：必须「按下鼠标并保持按住」，拖到目标后松开；松开状态点击
>   （click）进入 OLE 拖拽会被系统立即取消，这是 Windows 的行为而非插件缺陷。
> - **弯音/CC 在音源上没反应（Bitwig + VST3 版）**：这是 Bitwig 对 VST3
>   Legacy MIDI CC out 事件的处理缺口（音符正常、CC/弯音丢失）。改用 **CLAP 版**
>   即可（`C:\Program Files\Common Files\CLAP\PowerMidiEditor.clap`，CLAP 有原生
>   MIDI 输出）。状态栏的输出监视器（"弯音 XXXX · CC11 XXX"）可确认插件侧在发：
>   播放时数值在变 = 插件在发，是宿主/音源侧没接住。注意 Serum 默认只响应弯音和
>   CC1（调制轮），**CC11 需要在 Serum 的调制矩阵手动分配**。

## 架构速览

- **单一数据源**：文档/设置存放在 C++ 侧；UI 通过 `invoke(name, payload)` RPC 提交
  编辑（事务 + 撤销），C++ 通过 `pme` 事件通道推送文档 / 设置 / 传输 / MIDI 输入。
  详见 `docs/PROTOCOL.md`。
- **实时安全**：音频线程只读不可变文档快照（`std::atomic<shared_ptr>`），命令与
  试听走自实现的 SPSC 无锁队列；消息线程负责全部编辑。
- **宿主同步**：`processBlock` 读取 playhead（PPQ/tempo/循环），按采样精度调度
  音符；支持循环截断、中途开始的长音追赶、传输停止/重定位的挂音清理。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 0 | 骨架、WebView 桥接、VST3 加载、MIDI 直通 | ✅ |
| Phase 1 | 钢琴窗渲染、四向缩放滚动、快捷键系统、主题、力度/CC/弯音车道 | ✅ |
| Phase 2 | 8 工具编辑、剪贴板、量化/长度量化、步进输入 | ✅ |
| Phase 3 | 表达映射（编辑器、按音符标签、输出 Keyswitch/CC、JSON 导入导出） | ✅ |
| Phase 4 | 和弦轨（和弦事件、编辑车道、和弦内音高亮） | ✅ |
| Phase 5 | 标准 .mid 导入导出 | ✅ |
| Phase 6 | 实时录音、鼓组模式、多 CC 泳道、小地图、右键菜单、和弦辅助/琶音、人性化/Legato/转置/微调、A/B 快照、拖出导出、工程文件、拍号、Cubase 映射导入 | ✅ |
| 后续 | 大数据量增量推送、录制量化进阶（长度量化录制）、多拍号分段、预设库 | ⬜ |

## 许可说明

本仓库自身的代码许可未定；JUCE 按 GPLv3 / 商业双授权发布——**闭源发布此插件时需要
JUCE 商业授权**（个人开发与内部测试无影响）。
