# ZCode 内置浏览器面板实现研究（只读解析 3.16.2 应用包，2026-10-20）

## 研究方式与边界

只读解析本机已安装 `C:\Users\l\AppData\Local\Programs\ZCode\resources\app.asar`（`@zcode/desktop 3.16.2`），提取主进程（`out/main`）、宿主进程（`out/host`）、预加载（`out/preload`）与渲染层相关 chunk 做静态阅读；未运行、未注入其进程，未复制其代码或资产。以下文件名与符号均可在该安装包中核对。对照对象是 Easel 的辅助面板（快照+指令模型）。

## 结论：它是"桌面应用里的真实浏览器视图 + 双向控制通道"

ZCode 的浏览器面板能"直接点、直接输入"，因为它是 **Electron 桌面应用**，把整个 Chromium 访客视图嵌进了自己的工作台 UI，而不是把网页渲染成图片：

1. **渲染层用的是 Electron `<webview>` 标签**（`out/renderer/assets/styles-n-UNIiNg.js`）：
   `<webview allowpopups src partition="persist:zcode-embedded-browser" nodeintegrationinsubframes="true" data-browser-compositor-scale data-browser-layout-scale data-browser-transform-scale data-testid="browser-webview">`
   - `persist:` 前缀 = 独立持久分区（Cookie/登录态跨重启保留，且与主界面会话隔离）；
   - `allowpopups` + 主进程弹窗策略配合（见下）；
   - 三个 `data-browser-*-scale` 是把 webview 做 CSS 缩放，避免每次调宽都真实改视口（配合 `browserViewportSet/Reset` 命令）；
   - 面板 UI 自带工具条标记：`browser-element-picker-button`（元素拾取）、`browser-devtools-button`（打开 DevTools）、`browser-open-external-item`（用外置浏览器打开）、`browser-permission-*`（权限请求的允许一次/始终/拒绝）。
   - 面板开合由 `sidePaneState`/`shouldReveal` 管理；`onOpenBrowserUrl` 事件可以把一个 URL"在右侧浏览器面板打开"——这就是"切换面板使用浏览器"的入口。

2. **用户交互走原生输入通道**：网页是活的 Chromium 视图，鼠标/键盘直接送进访客进程，无需快照往返——这是与 Easel 面板体验差异的根本来源。

3. **Agent 操作走主进程 CDP**（`out/main/index.js`）：
   - 点击/滚动：`webContents.debugger` → `cdp.send("Input.dispatchMouseEvent", {mouseMoved|mousePressed|mouseReleased})`（`dispatchClickAt`）；
   - 按元素标识操作：注入页内脚本维护 `window.__zcodeRefs`（ref→元素），点击前用 `executeJavaScript` 把 ref 解析成中心坐标（`resolveRefCenter`）；
   - 快照：`SNAPSHOT_SCRIPT` 在页内生成 `{url,title,dom,elements}`（带 ref 的元素清单），供 `domSnapshot()`/定位器使用；
   - 截图：`Page.captureScreenshot` + `Page.getLayoutMetrics`，并做 **CSS 像素校正**（`captureScreenshotWithCssPixelCorrection`），保证截图坐标与输入坐标一致；
   - 弹窗策略：`setWindowOpenHandler` 决定"收编为面板新标签页"还是"交给外置浏览器"（含 `background-tab` 等 disposition 判断）；插件沙箱 webview 则一律 `{action:"deny"}`；
   - 网络：面板分区(`fromPartition`)可配置代理兜底（`fallbackProxyMode:"system"`）与自签证书开关；
   - JS 对话框：专用 `preload/embeddedBrowserJavaScriptDialog.cjs` 接管 `alert/confirm/prompt`；
   - 录制：`out/main/browserWebmRecorder.js` + `preload/browserVideoRecorder.cjs`（面板/网页录制裁剪件）；标签页跨重启恢复用内置 `zcode-browser-restore://` 状态（版本化 entries/decisions）。

4. **宿主进程与桌面进程之间的命令协议**（`out/host/index.js` + `out/main/chunk-XYX2CJ3H.js`）：
   - Agent 侧看到的注册表项：`{type:'iab', name:'ZCode In-app Browser', capabilities:[visibility], metadata:{provider:'zcode-desktop-iab'}}`；
   - `execute()` 把命令 `postToMain({type: BrowserExecuteRequest, requestId, browserId, browserGeneration, sessionId, turnId, workspaceKey, clientMode, command})` 发给桌面主进程；
   - 方法面完整列举：`list / newTab / activateTab / listUserTabs / claimTab / finalize(Tabs) / markDeliverable / markHandoff / nameSession / turnEnded / closeSession / cancelRequest / close / browserVisibility(Get|Set) / browserViewport(Set|Reset) / recording(Start|Status|Cancel)`，加上 `playwright`/`playwrightWaitForTimeout` 包装（locator 的 click/fill/press 等映射到上述原语）；
   - 可靠性设计：requestId 去重、`generation` 代次校验（后端重启即判 stale）、超时自动 `cancelRequest` 并把可能已产生副作用的方法标记 `sideEffect:"uncertain"`；
   - `clientMode` 有两种：`desktop-continuous`（桌面实时）与 `web-remote-replayable`（面向 Web 端的"可回放"模式）——即其 Web 形态并非直连这个 webview，而是回放命令流。
   - host 与桌面之间的 RPC 走本地套接字（`node:net createConnection`，带 peer 凭据校验，拒绝 world-writable socket）。

## 与 Easel 现状对照（回答"我们貌似也有吧"）

- **Easel 没有 Electron 外壳**：Windows 交付是 .NET WinForms 启动器（`scripts/portable_entry.cs`）+ 本地服务；`scripts/desktop_launcher.py`、`portable_launcher.py`、`start_workspace.py` 全部是 `webbrowser.open(...)` 打开**系统默认浏览器**。工作台始终跑在普通浏览器页面里。
- **Easel 的"内置浏览器"不是嵌入式视图**：指随包分发的 Playwright 驱动 Chromium（登录态在 `~/.easel-browser-profiles`），由后端另开窗口运行，用于读链接/自动化；面板里看不到它。
- **Easel 面板是"快照+指令"**：截图+无障碍元素清单，点击/滚动/填写是一次次后端回合（`easel/browser_runtime.py`），并设计性关闭新窗口弹窗。因此"面板里直接操作网页"当前不可能。
- 既往结论可复用：`docs/desktop-harness-assessment-2026-10-12.md` 已给出桌面路线取舍——"Windows 优先验证现有 C# 入口配合 WebView2；只有内置多标签浏览器等成为明确核心需求时才优先 Electron"。

## 若要让 Easel 具备同类能力的三条路线

1. **C# 启动器升级为 WebView2 桌面窗口**（与既有评估一致）：窗口内嵌 WebView2 承载工作台，浏览器面板可用 WebView2 的能力嵌第二个真实视图；改动集中在启动器，服务端不动。需验证多视图合成/输入焦点与窄屏。
2. **Electron 桌面壳**（ZCode 同款）：可直接用 `<webview>` 复制该交互模型；代价是包体与双运行时，按既有评估仅在"内置浏览器"成为核心需求时采用。
3. **留在 Web 工作台 + CDP 画面流（screencast）**：后端把 Playwright Chromium 以 `Page.startScreencast`（JPEG 帧）或节流截图推给面板，前端把鼠标/键盘坐标经现有 `/api/browser/sessions/{sid}/commands` 回传（`click/drag/scroll/press/fill` 已具备大部分原语）。无需换壳，面板即可得到"近实时画面+可用鼠标键盘"的体验；代价是延迟（约 100–300ms）、缩放/坐标映射与帧率控制。ZCode 对 Web 形态选择"回放"而非直连，说明这条路的工程成本确实存在，但对 Easel 是唯一不动交付形态的选项。

实现优先级建议：若近期以"读网页、带回对话"为定位，先补 UX（新窗口链接提示、点击文本元素直接引导填写、过期提示）；若明确要"面板里能直接操作"，先做路线 3 的最小验证（screencast 一帧流 + 一次点击回传），再决定是否走桌面壳。

## 边界

本文只做只读静态解析与对照，不复制 ZCode 代码/资产、不改变 Easel 现有面板行为；不含对 ZCode 服务端或模型能力推断。Easel 三条路线均为待验证候选，未排期、未实施。
