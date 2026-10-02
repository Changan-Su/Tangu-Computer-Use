# 更新日志

## 未发布

- 「电脑历史」采集支持 Windows（协议仍是 13，与 macOS 同一套 `recordSubscribe` 订阅格式）。新增 `windows-bridge.exe serve --pipe <名字>` 常驻模式：采集器跑在独立进程里，监听只有当前用户和 SYSTEM 能连、拒绝远程客户端的命名管道，最后一个订阅者断开 60 秒后自行退出；`windows-bridge.exe recorder-protocol` 打印协议号。原有的 stdio 助手和它的协议版本不变。
- 记录内容与 macOS 相同：前台 App 切换（exe 名 + 文件说明里的显示名）、窗口标题、浏览器地址栏网址（去掉查询串）、焦点可编辑输入框里新打的字（UI Automation 的 Value / Text 模式）、点击的控件类型和按钮名、Ctrl / Win 组合快捷键。不截图，不录原始按键；键盘钩子只用来判断「有没有在打字」和识别组合键。锁屏、睡眠期间暂停。
- 始终不记录：密码框（UI Automation 的 IsPassword，报出前再复核一次）、密码管理器与 Windows 凭据界面、无痕 / InPrivate 窗口。Edge 与 Firefox 系的无痕窗口按标题标记识别；Chrome 等 Chromium 系浏览器在 Windows 上无痕窗口的标题没有标记，只能看工具栏上的无痕按钮，遍历没走完时这个窗口先按无痕处理（只留一条不带标题的切换），之后自动重走，最多 5 次。
- agent 通过 Computer Use 操作（`act`、`actBatch`、`focusWindow`、`openBrowserLocation`）期间及之后 750 毫秒，stdio 助手持有命名互斥体 `Local\tangu-computer-use-agent-active`，采集器据此把这段时间的事件标成 agent 所为。
- 已知限制：与 macOS 相同，管道只校验同一 Windows 用户，不校验对端身份。第一次读某个 Chromium 窗口时，Chrome 会在那一刻打开自己的无障碍支持，这一次可能要 1 秒左右。
- 新增 `scripts/probe-recorder-windows.mjs` 与 CI 工作流 `windows-recorder-probe`：在 Windows 真桌面上操作记事本、Chrome、Edge，核对事件与隐私边界。

Computer History recording now works on Windows too, with the same `recordSubscribe` format and protocol 13 as macOS. The new `windows-bridge.exe serve --pipe <name>` mode runs the recorder as its own resident process. It listens on a named pipe that only the current user and SYSTEM can open, rejects remote clients, and exits 60 seconds after its last subscriber disconnects. `windows-bridge.exe recorder-protocol` prints the protocol number. The stdio helper and its protocol version are unchanged. The recorder captures the same things as on macOS: app switches (exe name plus the display name from the file description), window titles, browser URLs from the address bar without query strings, newly typed text in the focused editable field (UI Automation Value or Text pattern), the type and label of clicked controls, and Ctrl and Win shortcuts. It takes no screenshots and records no raw keystrokes. The keyboard hook only tells whether someone is typing and recognizes key combinations. Recording pauses while the session is locked or asleep.

Password fields (UI Automation IsPassword, checked again before text is reported), password managers, Windows credential prompts and private or InPrivate windows are never recorded. Private windows in Edge and Firefox-based browsers are recognized by their title. On Windows, private windows in Chrome and other Chromium browsers have no marker in the title, so the recorder looks for the private-mode button in the toolbar. Until that walk finishes, the window is treated as private and leaves only an untitled switch, and the walk is retried automatically up to 5 times. While an agent acts through Computer Use (`act`, `actBatch`, `focusWindow`, `openBrowserLocation`) and for 750 ms afterwards, the stdio helper holds the named mutex `Local\tangu-computer-use-agent-active`, and the recorder marks events from that time as agent actions.

Known limitations: as on macOS, the pipe only checks that the client runs as the same Windows user. It doesn't check who the client is. The first time the recorder reads a Chromium window, Chrome turns on its accessibility support, which can take about a second once. The new `scripts/probe-recorder-windows.mjs` and the `windows-recorder-probe` CI workflow drive Notepad, Chrome and Edge on a real Windows desktop and check the events and privacy limits.

## 0.6.0 — 2026-09-27

- 新增「电脑历史」采集（macOS，协议 13）：Forsion 桌面端开启该功能后，helper 通过新的 `recordSubscribe` 订阅，把前台 App 切换、窗口标题、浏览器网址（去掉查询串）、焦点输入框里新打的字、点击的控件名和 ⌘ / ⌃ 快捷键推给桌面端。只需要「辅助功能」授权，不截图、不录原始按键。helper 自己不落盘，保存、保留期、清除、暂停都由桌面端负责；最后一个订阅者断开后，所有观察者随即拆除。
- 始终不记录：密码管理器与钥匙串、安全输入框和 Secure Input 期间的内容，以及无痕 / 私密窗口（只留一条不带标题的切换）。桌面端下发的排除 App、排除站点和只记标题的 App 在读取辅助功能数据之前就生效。agent 通过 Computer Use 操作期间产生的事件会标成 agent 所为。
- 排除的 App 只留切到它的那一条不带标题的切换，App 里的窗口变化一概不发，连时间点和次数都不外泄。排除站点另留一条不带标题和网址的窗口标记，用来结束同一浏览器里上一个页面的计时。
- 无痕窗口、排除的 App 或站点这类没记录的时段过后，第一条可记录的 App 切换或窗口事件带 `resumed: true`。它不含那段的任何时间或内容；桌面端和引擎折叠时间线时在这里断开，没记录的时间不会算进前后的页面。
- 标题不变的导航也会被识别（同名的登录页换了站点、单页应用换了路由）：记录文字、点击和快捷键之前，以及一段输入停手时，helper 会按记住的网页区域或地址栏重读一次网址（1–2 次辅助功能读取，不重新遍历）。网址变了就当换了情境：还没报出的输入先按原来的页面报出，新页面是排除站点就直接丢掉。
- 查找浏览器网址的有上限遍历先读节点角色，再决定要不要读它的子节点，绝不向网页区域（AXWebArea）要子节点，不会逼浏览器生成整棵网页的无障碍树。
- `diagnostics` 新增无痕扫描计数 `recorderPrivateScans`、`recorderPrivateScanIncomplete`、`recorderPrivateScanStops`（只有计数，不含内容）。遍历找到网页区域后不再展开，碰到深度、节点数或时间上限也会停下，这时工具栏上的无痕标记可能没被看到；这类窗口目前仍按普通窗口记录，等真机数据再决定要不要改。
- Safari 暂时只记不带标题的切换：Safari 私密窗口的标题里没有任何标记，在真机上找到可靠的判定办法之前，整个 Safari 按私密窗口处理（`node scripts/probe-recorder.mjs` 可用来找这个信号）。其他浏览器的无痕窗口按标题和工具栏上的无痕标记识别。
- 设置了排除站点时，浏览器（含 Chrome / Edge 的 Beta、Dev、Canary 渠道，以及 Opera、Arc、Dia、Zen、Orion、DuckDuckGo、Firefox Developer Edition 等）的网址读不到，就按排除站点处理：只记一条不带标题的切换。
- 点击只在那一点最上面的窗口属于前台 App 时才记录。点在 Spotlight、Raycast、通知、Dock、菜单栏图标这类不抢前台的窗口上，不会被记成前台 App 里的点击。
- 已知限制：`recordSubscribe` 只校验连接方和 helper 是同一个 macOS 用户，不校验对端的代码签名，helper 也不知道桌面端是否开着电脑历史。只要 helper 在运行（Computer Use 和电脑历史都会拉起它），同一用户下的任何进程都能自己订阅、带上自己的策略：即使桌面端的电脑历史已关闭或暂停，这条订阅照样收到事件，桌面端设置的排除 App 和排除站点也管不到它。helper 内置的排除（密码管理器、钥匙串、安全输入框、Secure Input、无痕窗口）照常生效。同一用户的进程本来就能在同一个 socket 上调用 `getUserContext`、`axReadText`、`focusedElement`、`look` 等辅助功能命令读取屏幕上的内容，这是同一个暴露面，所以这一版接受这个风险。对端签名校验留作后续工作。
- 新增 `npm run check:recorder-logic`（单测，已并入 `npm run check`）与 `npm run check:recorder`（起一个临时 helper 验证订阅接线，无需授权）。

The macOS helper can now record Computer History for Forsion Desktop (protocol 13). While the feature is on, Desktop opens a `recordSubscribe` stream and the helper pushes app switches, window titles, browser URLs without query strings, newly typed text in the focused field, the names of clicked controls and ⌘/⌃ shortcuts. It needs only the Accessibility permission: no screenshots and no raw keystrokes. The helper stores nothing itself. Desktop owns storage, retention, clearing and pausing, and the helper removes every observer once the last subscriber disconnects. Password managers, Keychain, secure text fields, Secure Input and private browser windows are never recorded (a private window leaves only an untitled switch). Excluded apps, excluded sites and title-only apps from Desktop apply before any Accessibility data is read, and events caused by an agent's Computer Use actions are marked as such. An excluded app leaves only the untitled switch to it. Window changes inside it aren't sent at all, so not even their timing or count leaves the helper. An excluded site also leaves one window marker without a title or URL, which ends the timing of the previous page in the same browser. After a stretch that wasn't recorded (a private window, an excluded app or an excluded site), the first recordable app or window event carries `resumed: true`. It carries nothing about that stretch. Desktop and the engine break the timeline there, so the unrecorded time isn't counted toward the pages around it.

Navigation that keeps the page title is caught too, such as a sign-in page with the same name on another site or a route change in a single-page app. Before it records text, a click or a shortcut, and when a stretch of typing settles, the helper reads the URL again from the web area or address field it remembered for that window. That's one or two Accessibility reads, with no new walk. A changed URL counts as a new context: pending text is reported for the page it was typed on, or dropped if the new page is an excluded site. The capped walk that looks for the browser URL now reads each node's role before deciding whether to read its children, and it never asks a web area (AXWebArea) for its children, so the browser isn't pushed into building the accessibility tree of the whole page. `diagnostics` now reports private-scan counts: `recorderPrivateScans`, `recorderPrivateScanIncomplete` and `recorderPrivateScanStops` (counts only, no content). The walk stops expanding once it finds the web area, and it also stops at its depth, node and time limits, so a private-mode marker in the toolbar can be missed. Such windows are still recorded as normal windows for now, until real-machine data settles whether that should change.

Safari is recorded as untitled app switches only for now. Its private windows carry no marker in the title, so every Safari window is treated as private until a reliable signal is found on a real machine (`node scripts/probe-recorder.mjs` helps look for one). Private windows in other browsers are detected from the title and from private-mode labels in the toolbar. When sites are excluded and a browser's URL can't be read, that moment is treated as an excluded site and leaves only an untitled switch. This covers Chrome and Edge Beta, Dev and Canary as well as Opera, Arc, Dia, Zen, Orion, DuckDuckGo, Firefox Developer Edition and similar browsers. A click is recorded only when the topmost window at that point belongs to the frontmost app. Clicks on Spotlight, Raycast, notifications, the Dock or menu bar icons are not recorded as clicks in the frontmost app.

Known limitation: `recordSubscribe` only checks that the client runs as the same macOS user as the helper. It doesn't check the client's code signature, and the helper doesn't know whether Computer History is on in Forsion Desktop. While the helper is running (Computer Use and Computer History both start it), any process of that user can open its own subscription with its own policy. That subscription gets events even when Computer History is off or paused in Desktop, and Desktop's excluded apps and sites don't apply to it. The helper's built-in exclusions (password managers, Keychain, secure text fields, Secure Input and private windows) still apply. Any process of that user can already call the helper's Accessibility commands on the same socket, such as `getUserContext`, `axReadText`, `focusedElement` and `look`, to read what's on screen. That's the same exposure, so this release accepts the risk. A peer signature check is future work.

## 0.5.8 — 2026-09-26

- 修复 Windows 助手在没装过 VC++ 运行库的干净 Windows 上起不来：助手改为静态链接 MSVC 运行库，不再依赖 `VCRUNTIME140.dll`。发布前的包内容检查会拦下仍依赖 VC++ 运行库的 Windows 助手。

The Windows helper now links the MSVC runtime statically, so it starts on clean Windows machines without the Visual C++ Redistributable (it no longer needs `VCRUNTIME140.dll`). The release check rejects a Windows helper that still depends on the Visual C++ runtime.

## 0.5.7 — 2026-09-25

- 修复 Windows / Linux 上 `tangu computer-use setup` 与 `doctor` 打印结果后进程不退出：这两个一次性命令结束前会关掉助手进程。macOS 不受影响。

On Windows and Linux, `tangu computer-use setup` and `doctor` now exit after printing their result. Both one-off commands close the helper process before they return. macOS was not affected.

## 0.5.6 — 2026-09-25

- macOS 助手改用固定证书签名。从这一版起，助手更新会保留「辅助功能」与「屏幕录制」授权，不用再重新授予。从旧版升级上来时需要最后授权一次。安装过程仍然不访问钥匙串，也不会要你输入密码。
- 第一个发布到 npm 的版本，随包带齐 macOS（arm64 / x64）、Windows 与 Linux 助手。已安装 Forsion 的机器会在后台下载新版，下次启动时换上。

The macOS helper is now signed with a fixed certificate, so later helper updates keep the Accessibility and Screen Recording grants. Upgrading from an earlier version asks for them one last time. Installation still never touches the keychain or asks for a password. This is also the first version published to npm, and it ships the macOS (arm64 and x64), Windows and Linux helpers. Installed copies of Forsion download new versions in the background and switch to them on the next launch.

## 0.5.5 — 2026-09-21

- 首次引导改由 Forsion 桌面端实测「辅助功能」与「屏幕录制」两项授权：都已授权就不再弹引导卡，缺哪项就在卡里直接安装 helper 并请求授权；引导说明补齐英文。

The setup card is now driven by the Accessibility and Screen Recording grants that Forsion Desktop checks itself. It only appears while a grant is missing, and it can install the helper and request access in place. The setup guide now has English text.

## 0.5.4 — 2026-09-10

- 修正 Windows / Linux 桌面操作指引：从窗口发现开始，不再要求调用仅 macOS 支持的应用启动工具。
- 明确已可用的工具可以直接调用，避免误把重复加载提示当成整个电脑控制功能故障。
- 新增三平台离线契约检查；这是工具与指引校验，不代替 Windows 真机操作验收。

Windows and Linux guidance now starts with window discovery instead of the macOS-only app launcher. Available tools can be called directly without loading them again. Offline checks cover tool visibility and instructions on all three platforms; native Windows GUI acceptance testing remains separate.

## 0.5.3 — 2026-09-09

- 修复首次安装 Computer Use 时弹出 `codesign` 钥匙串密钥访问框：macOS 助手在构建阶段组装、签名，以完整 App ZIP 随包交付；安装时只校验和复制，不再查找用户 Developer ID、导入本地证书或访问私钥。
- 修复拒绝旧签名弹窗后留下的半安装 App；校验完整签名与随包内容，采用临时目录验证、互斥安装和失败回滚，并识别同协议号的旧助手。
- 新增 `check:installer` 与 `scripts/verify-macos-bundles.mjs`，验证首次安装、升级、半安装修复、损坏包、并发和回滚；桌面打包之后再次校验 ZIP，防止递归签名改写内置助手。
- 当前构建使用 ad-hoc 签名，不等于 Developer ID 或 Apple 公证。从旧本地证书迁移及助手升级后，macOS 可能要求重新授予辅助功能与屏幕录制；安装无需钥匙串密码，已有钥匙串条目不会自动删除。

macOS helpers now ship as complete, sealed app archives. Installation never discovers signing identities, imports certificates or accesses private keys. Interrupted older installations are repaired, concurrent installs are serialized, and failed replacements restore the previous app. The current ad-hoc build is not Developer ID-signed or notarized; macOS may request Accessibility and Screen Recording access again after migration or updates.

## 0.5.2 — 2026-09-08

- 修复旧 0.5.1 插件与新版前台信号 helper 同版本导致桌面播种跳过更新：发布独立版本，随包携带已构建的 macOS arm64 / x64 helper。
- 自动升级 helper 后显式重启常驻进程，即使协议号和安装路径相同，也不会继续运行旧二进制；安装或重启失败均交给现有引导反馈。
- 新增真实二进制启动信号检查 `check:helper-signal` 与安装/重启顺序回归 `check:helper-refresh`。

Computer Use now ships as a distinct version so Desktop replaces older 0.5.1 bundles. Successful helper upgrades restart the daemon even when its protocol and path are unchanged. Tests cover actual packaged signal output and installer/restart failures.

## 0.5.1 — 2026-09-08

- 为 Genesis Mini Panel 提供 macOS 前台输入活动信号：实际 HID 输入/前台激活开始发布短期租约，递归输入作用域结束后停止；AX 和 PID 后台路径不触发。
- 信号在 helper socket 同目录的 `foreground.json`，带 PID 与过期时间；进行中每秒续期，避免每帧写盘。构建/安装脚本已纳入 reporter，新行为需要重新构建 helper。
- 新增隔离 Swift 回归仪器 `npm run check:mini-foreground`，覆盖后台静默、嵌套输入、结束及短点击宽限。

为 Forsion Desktop 权限引导提供独立的原生接口：

- `permissionStatus` 只读取辅助功能信任状态、屏幕录制预检和授权主体，不抓图、不请求权限、不缓存。
  同时返回 `settingsFrontmost` 和可选 `settingsWindow: {x,y,width,height}`，坐标为 CG 全局坐标
  （左上原点、y 向下）；窗口按系统设置的 PID、layer 0、可见有效矩形筛选，取最大窗口，不依赖 AX 或窗口标题。
  调用端必须只连接已有 socket：`macosHelper.command()` 会自动启动 helper，不适合页面首屏状态读取。
- `registerPermissions` 可选 `kind: 'accessibility' | 'screenRecording'`，只请求该项；单项屏幕录制
  返回系统 request 的 `screenRecording` 结果，不做 capturable probe。省略 `kind` 保持原先的双项请求行为。
- `checkPermissions` 可选 `fresh: true`，绕过并重新建立成功缓存，验证失败会清除旧成功；只用于用户主动
  授权后的验证。此参数不清除 macOS 自身的 TCC 缓存，预检通过仍不等于实际可采集。

原生 arm64 / x64 产物随包更新；兼容原有命令，协议号保持 12。新增隔离系统 API 的权限检查，
验证状态读取无授权副作用、单项请求隔离、撤权后 fresh 不残留成功缓存及未授权时的窗口矩形筛选。

## 0.5.0 — 2026-09-07

**随 Forsion Desktop 内置。** 不再需要从市场安装或跑 `install.sh`:桌面启动时把随包的捆绑包播种进
`<home>/plugins/tangu-computer-use/`(只在随包版本比已装的新时替换;不降级、不碰更新的手装副本),
设置里显示「内置」且不提供卸载 —— 不想用就关掉开关。native helper 仍在第一次用到工具时自动装。
开发者装法 `sh install.sh dev` 保留,用于只迭代本包。

**同步上游 v0.5.1**(自 v0.5.0,`4b8dbd7e`,2026-08-31)。工具契约零变化;拿到三处 macOS 修复:
`find_roots` 的性能与 ScreenCaptureKit 探测死锁(窗口封顶 128、广度发现时 AX 超时 1.0s→0.25s、
探测改回调)、**小窗口截图不再落进 1920×1080 的默认画布**(此前坐标映射错乱的根因)、同进程的
AXDialog 不再抢走显式选中的目标窗口(新文件 `root-selection.ts`);`setup-helper` 下载加 120s 超时;
Windows helper 路径可用 `PI_COMPUTER_USE_WINDOWS_HELPER_PATH` 覆盖。
⚠️ 上游 git 里跟踪的 prebuilt 二进制在两版之间字节相同而 `bridge.swift` 改了 —— 同步只拷源码、
native 一律本地重编;本包随附 arm64 + x64 两份新编 helper(`build-native.mjs --arch all`)。

**协议号 11 → 12**:上游改了 helper 的原生行为(截图画布尺寸、根列表时序),按纪律 bump。
已在跑的老 daemon 会被识别出来重启,并按 0.4.0 的引导自愈就地重装。

顺手修掉文档漂移:包里一直是 12 个工具(上游 11 + 自研 `ensure_app`),六处写着 11。

## 0.4.0 — 2026-07-29

**示意光标和边缘光效终于真的画在屏幕上了。** 0.3.0 那轮修的是几何(算得对不对),这轮才发现算得再对
也没用 —— 两个覆盖层压根没被用户看见,而且是两个互不相干的原因:

- **边缘光效从未出现过一次**。定位窗口矩形用的 `CGWindowListCreateDescriptionFromArray` 对**别的进程**
  的窗口恒返回空数组(同一个 windowId:它 count=0,`CGWindowListCopyWindowInfo(.optionIncludingWindow)`
  count=1 且 bounds 正确)。拿不到矩形就 `return`,窗口连建都没建过。这个功能自加进来就一直是死的。
- **示意光标随时会被压在下面**。两个覆盖层都没设 `window.level`,待在普通层(0);而宿主是 `.accessory`
  永不激活,所以只要被操控的 App 被激活一次,覆盖层就沉到它下面。上游想用
  `window.order(.above, relativeTo: 目标窗口号)` 解决,但那个 API 只在**本进程自己的窗口之间**有意义,
  传别的进程的窗口号是**空操作**(实测:既不上移也不消失)。现在光效 `.floating`、光标 `.screenSaver`。

留了仪器:`npm run check:overlay` 按 100ms 采样 `CGWindowListCopyWindowInfo` 的窗口栈,断言两个覆盖层
**都上了屏、且 z 序在被操控窗口之上**。"窗口存在"和"用户看得见"是两件事,只有前者的测试骗了我们两轮。

**首次安装和更新不再需要开终端。** 也是两半:

- vendor 的 `ensureInstalled()` 本来就会自动跑 `scripts/setup-helper.mjs`(还正确处理了
  `ELECTRON_RUN_AS_NODE`)—— 是我们自己在 tools.ts 里加的「没装就返回指导文本」抢在它前面 return,
  把上游的自动安装堵死了。
- 而 `ensureInstalled()` 只判断可执行文件**存不存在**,不判断新旧;插件升级后老二进制留在原地 →
  协议不匹配 → 报错让用户去终端。现在比对 bundle 随包二进制与已装二进制的哈希,过期就地重装。

权限仍然只能用户自己拨(系统安全设置),但现在会自动把 App 预登记进隐私面板并**打开对应面板**,
用户只需拨一下开关;每个面板每进程只开一次,免得 agent 重试时刷屏。

四处用户可见文案同步改掉了「去终端敲 `tangu computer-use setup`」:`manifest.json` 的引导卡
(用户真正看到的那张)、`skills/computer-use/SKILL.md`(不然 agent 还会照旧念给用户听)、
`main.js` 的旧 helper 提示、`install.sh` 结尾。CLI 本身保留,当修复入口用。

**Codex 评审后修掉的(16 条,全收)**,其中三条足以让上面两件事白做:

- **协议号还停在 10** —— 装新二进制不等于换掉正在跑的 daemon。协议号不变的话,0.3 的 daemon 能通过
  `ensureProtocol()` 继续服务,你重启 Forsion 也还是看不见叠层。现为 **11**。
  这轮只改了窗口层级和一个 CGWindowList 调用、没加新命令,正是最容易忘 bump 的形状。
- **「过期」判定恒为真** —— `installHelperApp()` 是复制后**在原地重签**,Mach-O 字节必然变,
  拿随包源二进制去比已装的可执行文件永远不等 → 每个新进程都跑一遍完整安装,还可能每次弹钥匙串。
  改比 `Contents/Resources/source.sha256`(签名前的源哈希,`installHelperApp` 专门写它就是为这个)。
- **发布只编了一个架构** —— CI 跑在 arm64 runner 上,`npm run build:native` 不带参数只编 `process.arch`,
  发出去的包里没有 x64 那份。Intel Mac 的「随包自动安装」会退化成本地 Swift 编译,没装 Xcode 命令行
  工具就直接失败。改 `--arch all` 并加发版前的硬门槛。

其余:权限真值改问 `checkPermissions`(`diagnostics` 那项只是 `CGPreflight` 缓存值,bridge.swift 自己的
注释就写着这点);一次只开一个隐私面板(系统设置是单窗口,连开两个后一个会顶掉前一个,而两个都被记成
"开过了");安装的共享 Promise 只跟子进程生死绑定,超时/取消只中断**等待**;`cgWindowBounds` 增加
`kCGWindowIsOnscreen` 检查(最小化的窗口也会返回 bounds,光效会留在它原来的位置);光标层级从
`.screenSaver`(1000)降到 `.popUpMenu + 1`(102)—— 够盖住 agent 会碰到的一切,但不再盖住屏保和系统警告;
就绪失败时只有「自动安装真的失败了」才提终端命令(否则 Linux 缺 AT-SPI 这类错误会被这句话盖住)。

仪器也修了三条,其中两条是**假绿灯通道**:`check:overlay` 现在要求先有干净起跑线(光标空闲 8 秒才隐藏,
上一个仪器留下的窗口足以让断言通过)、断言只看动作**之后**的帧;不再写死 `/Applications`
(标准用户装在 `~/Applications`);`killCalculator` 超时改抛错而不是静默放行。
并在脚本头写清它**不证明**什么:只看窗口的创建/层级/z 序,画布画了个空照样能过。

## 0.3.0 — 2026-07-27

**后台点击不再抢前台**。之前 agent 看着截图"盲点"(只给坐标、没有元素引用)一定会把目标 App 拉到前台、
顺手把你的鼠标拽走 —— 这是上游的设计:物理事件走后台通道会被非活动窗口直接丢掉,所以坐标点击一律直连前台。
现在坐标点击**先在目标 App 自己的层级里做一次 AX 命中测试**,命中可按压控件就直接按下去:不抢焦点、不动
真鼠标、照常画示意光标和边缘光效。命不中(网页内容、文本框、画布)才退回原来的前台路径,行为与上游一致。
右键/中键/双击语义 AX 表达不了,仍走前台。

**实时画面真的是实时的了**。helper 改为给被操控的窗口开一条**常驻 ScreenCaptureKit 取景流**,取一帧只是
从缓存拿最新那张(实测中位 12ms,之前每帧都要重新协商一次采集会话),视图轮询从 1 秒提到 120ms ≈ 8fps。
没人看了自动停流。分辨率相应调低(默认最长边 800),放大取景时才要高清原图。

**画面不再有留白**。两处各占一半:

- helper 那头:上游截窗口时不设输出尺寸,ScreenCaptureKit 会**按整块屏幕出图**、把窗口摆在左上角、
  其余全是白的 —— 230×408 的计算器出来是一张 1920×1080 的大白图。留白是烤进 JPEG 的,前端救不回来。
  现在取景流和单帧兜底都按窗口尺寸出图。
- 视图那头:画布(取景框)会**按窗口的宽高比变形**,画面严丝合缝铺满它;卡片里剩下的空间是卡片底色,
  不再是画中的黑边。宽窗口 → 矮画布,竖窗口 → 窄画布。

**Codex 评审后的第二轮**(11 条,9 条修掉):

- 示意光标的覆盖层原来只开**主屏**那么大 —— 副屏上的点击把光标画到了窗口之外,看不见。现在横跨所有
  显示器,单屏行为完全不变(几何有单测钉住)。**这多半才是"辅助鼠标没有出现"剩下的那一半。**
- 后台 AX 点击原来会被**反着报**成「抢了前台」:坐标点击在 TS 层永远被判 needsForeground,
  于是 policy 恒为 foreground,而 helper 已经在后台完成了它。
- 用户放大取景时我们会换更高清的原图,像素翻倍而倍率不动 → 画面凭空放大一倍。现在按像素比补偿,
  保住看到的大小。
- 拖动窗口边缘时尺寸每帧都在变,一变就重开流 = 整个拖动过程都在重开(而重开期间只能回落单帧截图)。
  加了 0.6 秒的稳定去抖。
- 静止的窗口原来每秒被重编 8 次 JPEG。现在带帧号来,没变就只回一句 `unchanged`。
- 三个竞态:停流前会复核是不是真的还闲着;启动后、采纳前就失败的流不再被当活流装进来(否则永远
  不吐帧且再也不会重开,加了看门狗兜底);共享单飞落地时只清自己那一份槽。

**协议号 7 → 10**。helper 必须重装(`tangu computer-use setup`;本地 ad-hoc 签名的机器加
`PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1`),否则新功能一件都不会出现。

**留下的仪器**(下次从跑脚本开始,不从重新推演开始):`npm run check:live` 真机验后台点击与实时画面
(会开一下计算器);`harness/harness.html` 的「量一量」逐一走过每种窗口形状验布局。

## 0.2.0 — 2026-07-26

**改成 Forsion 捆绑包**。一个目录同时带上引擎侧的 11 个工具、配套技能和桌面视图,装一次就位,不用再单独
`tangu install`。装法改为 `sh install.sh dev|prod`。旧的独立引擎插件(0.1.x,装在 `<home>/tangu/plugins/`)
与新捆绑包是同一个插件 id,两份同时在会重复装载 —— `install.sh` 会检测并提示你自行删掉旧的。

**看得见 agent 在动哪个窗口**:

- 被操控的窗口会亮起一圈**边缘光效**(原生绘制,点击穿透、不抢焦点、跟着窗口移动;窗口关掉就熄灭)。
  开关沿用「操作可视化」那一项,和示意光标同一个 —— 它俩本来就是同一件事。
- 新增视图**「被操控的窗口」**:实时显示那个窗口的画面。配套技能会让 agent 在开始操作前把它摆到
  Agent Desk 上,于是你能直接看着它做事。看不见的时候(面板收起/切走标签页)自动停止取画面,不白烧。
  目前仅 macOS —— Windows 的 helper 是个 stdio 子进程,桌面端够不着它。
- 拿不到画面时如实说明原因(最常见是没给「屏幕录制」权限),不会留着上一帧假装实时。
- 实时画面的取景请求做了收敛:「最近被操控的窗口还算数多久」封了 2 分钟硬上界 —— 没有这道闸,一个插件
  就能把早已结束的一次操作变成对那个窗口的长期取景权。多个视图同时在场只发一次请求(每帧都是真实截屏)。

**同步上游 pi-computer-use v0.5.0**(自 v0.4.3,50 个提交):

- **工具输出封顶**:超长结果会被截断并给一个 `@o` 续读句柄(`read_text`),不再有一次 observe 或
  evaluate_browser 就把上下文撑爆的可能。
- **helper 不再需要管理员**:已有的可写 `/Applications` 安装留在原地,其余一律装进 `~/Applications`。
  ⚠️ 如果你的 `/Applications` 不可写,helper 会搬家,macOS 会要求重新授权一次。
- **启动 helper 改用直接路径**而不是 bundle id —— 系统里若残留同 id 的旧副本,不会再被它抢走。
  运行中的 daemon 也会校验是不是当前这份二进制,不匹配就重启。
- 工具契约收紧(**破坏性**):删掉 `doubleClick`(用 `clickCount`)与 `wait` 动作(用 `wait_for` /
  `expect`);`click` 拆成「按 ref」与「按坐标」两个互斥形态;`observe_ui` 只认 `@r` root,不再猜
  app/窗口标题;`search_ui` 的 `action` 改名 `capability` 且不再分页;`wait_for` 与 `act_ui.expect`
  改用同一套条件字段;`act_ui.headless` 参数取消 —— 严格后台改由插件设置控制。
- `launch_browser` 不再收 `browser`/`port` 参数,改由新设置项**受管浏览器**(Chrome / Helium)决定。
- 新增 **Linux 支持**(AT-SPI2 + X11);macOS 的窗口发现范围收窄、幽灵光标生命周期修复、浏览器条件与
  鼠标键校验、wait 结果 JSON 安全等一批上游修复。

## 0.1.0 — 2026-07-16

- 首发。fork `injaneity/pi-computer-use`(MIT)成 Tangu 引擎插件,macOS + Windows。
