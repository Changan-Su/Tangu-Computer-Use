# Tangu Computer Use

Let a Forsion agent **observe and control desktop apps** on macOS, Windows and Linux — see the screen,
click, type, scroll, and wait for UI changes — through the accessibility tree + OCR + screenshots.
A **Forsion 捆绑包**: one directory that carries the engine plugin (12 tools), a companion skill, and a
desktop view that shows the window being controlled. Forked from
[pi-computer-use](https://github.com/injaneity/pi-computer-use) (MIT), synced at v0.5.0.

> macOS 14+ (Swift helper), Windows (Rust UIA helper), Linux (Rust AT-SPI2/X11 helper).
> On macOS the helper needs Accessibility + Screen Recording; the other platforms need no system grant.

## Install

**It ships inside Forsion Desktop (0.5.0+).** Nothing to install: the desktop seeds this bundle into
`<home>/plugins/tangu-computer-use/` on startup (replacing it only when the shipped version is newer, never
downgrading a copy you installed yourself), and it appears under **设置 → 插件** as 「内置」 with no uninstall
button — turn the **电脑操作** switch off if you do not want it. The native helper still installs itself the
first time a tool runs, and reinstalls itself when an update ships a newer helper (the binary rides along in
the bundle, so this works offline). No terminal required.

macOS will ask you to grant **Accessibility** and **Screen Recording** to *Tangu Computer Use*
in System Settings → Privacy & Security — the agent opens the right pane for you, but only you can
flip the switch. The agent cannot see or touch anything until you do.
Since v0.5.0 the helper installs to `~/Applications` unless a writable `/Applications` copy already
exists — **no administrator password needed**.

The CLI is still there for repairs and for scripting:

```bash
tangu computer-use doctor     # check helper / Accessibility / Screen Recording / macOS version
tangu computer-use setup      # force a reinstall of the helper
tangu computer-use stop       # stop the helper
```

### Developer loop (iterating on this bundle alone)

```bash
npm install && npm run build     # 引擎入口必须先构建出来
sh install.sh dev                # → ~/.forsion-dev/plugins/tangu-computer-use   (prod = ~/.forsion)
```

> 0.2.0 起不再走 `tangu install`:仓根已没有 `tangu-plugin.json`,引擎侧内容在 `tangu-plugins/computer-use/`。
> 若你装过 0.1.x,`<home>/tangu/plugins/` 或 `~/.tangu/plugins/` 里那份要删掉——同一个插件 id 会重复装载,
> `install.sh` 会把它们列出来。

### Release / 发布

Bump `version` in both `package.json` and `manifest.json`, add a CHANGELOG entry, then push a `v<version>` tag.
`.github/workflows/release.yml` builds every native helper, runs the checks, verifies the package contents
(`node scripts/verify-package.mjs`), attaches the helpers and the `.tgz` to the GitHub Release, and publishes the
`.tgz` to npm through trusted publishing (no npm token is stored anywhere). Running the workflow by hand is a dry
run: it builds and verifies, but creates no release and publishes nothing. The macOS helper is signed with the
release certificate from the secrets `CU_SIGNING_P12` (base64 of the `.p12`) and `CU_SIGNING_P12_PASSWORD`; the
workflow fails without them rather than shipping an ad-hoc helper.

Forsion Desktop picks a new version up in two ways. Running desktops check npm in the background, download the
new version, and switch to it on the next launch. New desktop builds bundle it: Dependabot opens a PR that bumps
the pinned version in `Forsion-Genesis/desktop`. A copy is only replaced when the version number is higher, so
forgetting the bump means the update silently never lands. Declare `minAppVersion` in `manifest.json` whenever a
version needs a newer desktop; older desktops then skip it instead of loading something they cannot run.

**First publish (once).** npm only lets you register a trusted publisher for a package that already exists:

```bash
gh release download v<version> -R Changan-Su/Tangu-Computer-Use -p 'forsion-tangu-computer-use-*.tgz'
npm publish forsion-tangu-computer-use-<version>.tgz --access public
```

Then on npmjs.com open the package → Settings → Trusted publishing → GitHub Actions, with owner `Changan-Su`,
repository `Tangu-Computer-Use`, workflow `release.yml` (or `npm trust github @forsion/tangu-computer-use
--repo Changan-Su/Tangu-Computer-Use --file release.yml --allow-publish` with a current npm 11). Every later tag publishes by itself.

发版 = 两处 version 一起升 + CHANGELOG + 推 `v<version>` tag,CI 构建全部 helper、校验包内容、挂 Release、经 trusted
publishing 发 npm(仓库里没有 npm 令牌)。桌面端两路拿到新版:在跑的桌面后台从 npm 下载、下次启动换上;新桌面版由
Dependabot 提 PR 升级内置版本。首个版本需按上面两条命令人工发一次,再到 npm 包设置里登记 trusted publisher。

## What's in the bundle

| path | what the host does with it |
|---|---|
| `manifest.json` + `main.js` | 桌面插件:注册视图 `plugin:tangu-computer-use:live`(被操控窗口的实时画面) |
| `skills/computer-use/SKILL.md` | 配套技能:工具循环、后台优先、上 Agent Desk、不可逆动作的确认规则 |
| `tangu-plugins/computer-use/` | 引擎插件:12 个工具 + `tangu computer-use` 子命令 |
| `native/`, `scripts/`, `prebuilt/` | 三平台原生 helper 与它的构建/安装脚本 |

## Tools

`find_roots` · `observe_ui` · `search_ui` · `expand_ui` · `inspect_ui` · `act_ui` · `ensure_app` ·
`read_text` · `wait_for` · `launch_browser` · `navigate_browser` · `evaluate_browser`

All are host-only (require `hostExec`) and gated on the plugin being enabled + a supported platform.
Action tools (`act_ui`, `launch/navigate/evaluate_browser`) require approval (same tier as `run_bash`);
observation tools do not. `observe_ui` screenshots are fed back to the model as images. Oversized tool
output is truncated with an `@o` continuation ref you read back through `read_text`.

## Seeing what the agent is doing

- **Edge glow** — the window currently being acted on gets a glowing border drawn by the native helper
  (click-through, never takes focus, follows the window as it moves). Off switch: the *操作可视化*
  setting, same one that controls the agent cursor.
- **Live view** — `plugin:tangu-computer-use:live` shows that window's picture, polled ~8fps from the
  helper's background capture. The skill tells the agent to put it on the **Agent Desk** at the start of
  a session (`desk_present`), so the user watches instead of guessing. macOS only for now — the Windows
  helper is a stdio child process with no server for the desktop to talk to.

## When to use it vs. browser tools

Computer Use drives **any on-screen desktop app**. For **pure web** tasks prefer `browser_task` /
`browser_*` (lighter), or plain `curl` when the page is directly fetchable. Use the Computer Use browser
tools only when a desktop workflow must also touch a web page in the same root forest.

## Settings

- **browser_use** (default on) — allow the CDP browser tools.
- **managed_browser** (default Chrome) — which browser `launch_browser` starts.
- **headless / 严格后台** (default off) — actions stay in the background; no foreground focus grab or
  cursor move. Things the background genuinely cannot do then fail instead of stealing focus.
- **cursor_overlay / 操作可视化** (default on) — the agent cursor *and* the controlled-window edge glow.

## Development

```bash
npm install
npm run build          # esbuild → tangu-plugins/computer-use/dist/index.js  +  tsc --noEmit
npm run check          # foreground note · helper path · highlight geometry · desktop plugin
npm run check:live     # real machine, needs an authorized helper:
                       #   check:blindclick  background click lands without taking the foreground
                       #   check:liveview    the live view really streams, at the window's aspect
                       #   check:overlay     both overlays are ON SCREEN and ABOVE the target window
                       # (briefly opens Calculator; not runnable in CI, so not part of `check`)
npm run build:native   # build the macOS Swift helper (arm64 + x86_64)
npm run build:windows  # Windows Rust helper (must run on Windows)
npm run build:linux    # Linux Rust helper (must run on Linux)
sh install.sh dev      # deploy the bundle to ~/.forsion-dev
```

See `UPSTREAM.md` for the vendor strategy and how to re-sync upstream.

## License

MIT (see `LICENSE`). Derived from pi-computer-use — upstream license in `LICENSE.upstream`.

### Mini Panel foreground signal

The macOS helper publishes a short-lived `foreground.json` beside its socket for Genesis Mini Panel. It becomes active only when real HID input is posted or the input path activates the target app; successful AX and PID background operations do not activate it. Nested physical-input scopes keep the signal active until the outer action finishes. A 1-second heartbeat renews a lease of at most 2500ms; short completed clicks remain observable for 350ms. Desktop checks expiry and helper liveness, never starts the helper or requests screenshots for this feature.

Build the helper with `npm run build:native` and pair it with Genesis's Mini Panel adapter update. Builds produce a sealed App ZIP alongside each binary; installation never compiles or signs on the user's machine. `npm run check:mini-foreground` tests signal lifetime without controlling any application.

macOS helper 会向 socket 同目录发布短时前台输入信号，供 Genesis Mini Panel 跟随光标。后台 AX/PID 调用不触发；必须配套更新 Genesis 并按现有签名流程重建 helper。验证命令为 `npm run check:mini-foreground`，不会操控用户应用。

### Computer History recorder / 电脑历史采集（`recordSubscribe`, protocol 13, macOS）

Forsion Desktop opens a **dedicated** connection to the helper socket and sends one line: `{"id":"…","cmd":"recordSubscribe","policy":{"excludeBundleIds":[],"titleOnlyBundleIds":[],"excludeDomains":[],"text":true,"clicks":true,"keys":true}}` (every policy field is optional; a trailing `.*` in a bundle id is a prefix match). The first reply line is `{"id":"…","ok":true,"result":{"subscribed":true,"protocolVersion":13,"axTrusted":true}}`, or `ok:false` with `accessibility_denied` (that connection then stays an ordinary request connection). After an ok reply the connection only carries events, one `{"ev":{…}}` per line (`kind` = `app` / `window` / `text` / `click` / `key` / `system`; the shape lives in Genesis `desktop/shared/computerHistory.ts`). After a stretch that was not recorded (a private window, an excluded app or site), the first recordable `app` or `window` event carries `resumed: true`. It says nothing about that stretch, and consumers must not merge spans across it. The subscription ends when the client closes the socket; to change the policy, close and subscribe again. Several subscribers may be open at once, and each is filtered by its own policy. A slow reader never blocks the recorder: its backlog is capped and overflow is reported later as `{"kind":"system","state":"dropped","count":N}`. When the last subscriber leaves, the helper removes every observer and global monitor.

The recorder (`native/macos/activity_recorder.swift`) watches only the frontmost app through one AXObserver on its own thread, never enables AXEnhancedUserInterface / AXManualAccessibility, and never walks whole trees; the browser URL comes from a capped walk that never enters web content. Password managers, Keychain, the helper itself, secure text fields, Secure Input and private windows are never recorded, whatever the policy says. Safari is recorded as untitled switches only, because its private windows carry no title marker and no other signal has been verified yet (`node scripts/probe-recorder.mjs` dumps candidate signals). When a subscriber excludes sites and a browser's URL can't be read, that moment counts as an excluded site. An excluded app leaves only the untitled switch to it (no window events inside it); an excluded site also leaves one window marker without a title or URL. Before text, clicks and shortcuts are recorded, the helper re-reads the browser URL through the web area or address field it remembered for that window, so a navigation that keeps the title is still treated as a new context. The URL walk reads a node's role before its children and never asks a web area for its children. `diagnostics` reports private-scan counts (`recorderPrivateScans`, `recorderPrivateScanIncomplete`, `recorderPrivateScanStops`). A click is recorded only when the topmost window at that point belongs to the frontmost app. The helper writes nothing to disk. Only the peer's user is checked, not its code signature: while the helper runs, any process of the same user can subscribe with its own policy, even when Computer History is off or paused in Desktop and regardless of Desktop's exclusions (the built-in exclusions still apply). That is the same exposure as the helper's existing Accessibility commands such as `getUserContext` and `axReadText`. `npm run check:recorder-logic` runs the pure-logic tests; `npm run check:recorder` starts a throwaway helper from `prebuilt/` on a temporary socket and checks the subscription wiring without any grant.

Forsion 桌面端开启「电脑历史」后，用一条**专用**连接发 `recordSubscribe`：首行是回包，之后这条连接只推事件（一行一条 `{"ev":{…}}`），客户端关闭即退订；改策略就断开重订。无痕窗口、排除的 App 或站点这类没记录的时段之后，第一条可记录的 `app` / `window` 事件带 `resumed: true`：它不含那段的任何时间或内容，消费方折叠时不能跨过它合并。多个订阅者可并存、各按自己的策略过滤；读得慢的订阅者只会丢事件并在之后收到 `dropped` 计数，不会拖住采集。最后一个订阅者断开后，所有观察者随即拆除。helper 不落盘；密码管理器、钥匙串、安全输入框、Secure Input 与无痕窗口在任何策略下都不记录。Safari 私密窗口的标题没有标记、别的信号也还没验证过，所以 Safari 暂时只记不带标题的切换（`node scripts/probe-recorder.mjs` 可导出候选信号）。设了排除站点而浏览器网址读不到时，按排除站点处理；排除的 App 只留切到它的那一条不带标题的切换（App 里的窗口变化不发），排除站点另留一条不带标题和网址的窗口标记。记录文字、点击和快捷键之前，helper 会按记住的网页区域或地址栏重读一次网址，所以标题不变的导航也算换了情境。查网址的遍历先读角色再读子节点，绝不向网页区域要子节点；`diagnostics` 报无痕扫描计数（`recorderPrivateScans`、`recorderPrivateScanIncomplete`、`recorderPrivateScanStops`）。点击只在那一点最上面的窗口属于前台 App 时记录。只校验对端是同一用户、不校验代码签名：helper 在运行时，同一用户的任何进程都能带自己的策略订阅，桌面端关闭或暂停电脑历史、设置排除都管不到它（helper 内置的排除照常生效）。这和 `getUserContext`、`axReadText` 等现有辅助功能命令是同一个暴露面。验证：`npm run check:recorder-logic`（纯逻辑）与 `npm run check:recorder`（临时 helper 接线，无需授权）。

### macOS installation and signing / 安装与签名

Run `node scripts/build-native.mjs --arch all` before packaging, then `node scripts/verify-macos-bundles.mjs` and `npm run check:installer`. Both architectures must include `tangu-computer-use.app.zip` and its JSON checksum manifest. ZIP transport preserves the helper signature through Electron's recursive signing. Runtime setup only verifies and copies these archives; missing or damaged artifacts fail without trying a user's signing identity or creating keys. `setup-helper.mjs --check` is read-only (exit 0: current, 10: installation/repair needed, 1: package error).

Release builds are signed with the project's fixed self-signed certificate (`releaseCertSha1` in `scripts/macos-bundle.mjs`). macOS files the Accessibility and Screen Recording grants under the bundle id plus that certificate's hash, so helper updates keep the grants as long as neither changes. Never replace the certificate: every user would have to grant access again. `scripts/verify-package.mjs` refuses to release a helper signed by anything else. Local builds without `--sign-identity` stay ad-hoc and are for development only. This is not Developer ID signing or notarization.

打包前构建完整双架构 App，运行上述两项校验。首次安装、升级及旧签名被拒绝后的修复都不再访问用户钥匙串；缺失或损坏的随包件会明确失败。发布版用固定的自签名证书签名(指纹见 `scripts/macos-bundle.mjs` 的 `releaseCertSha1`),macOS 按「bundle id + 证书指纹」记授权,两者不变则 helper 更新不用重新授权;**证书永远不能换**。本地不带 `--sign-identity` 的构建仍是 ad-hoc,只供开发。这不是 Developer ID 签名,也没有公证。

### Mini Panel helper delivery / 辅助程序交付

工具与平台指引离线回归：`npm run build && npm run check:platform`。在隔离进程中验证 macOS / Windows / Linux 工具可见性、macOS 专用启动工具的边界，以及常驻工具直接调用的说明，不启动 helper 或操作用户界面。Windows 真机仍需另验原生助手启动、发现窗口、观察和动作；不能把该检查等同于整机验收。

Offline platform regression: `npm run build && npm run check:platform` checks tool visibility and guidance in isolated processes without starting a helper or controlling a UI. Native Windows acceptance still requires verifying helper startup, window discovery, observation and actions on Windows hardware.

Genesis 的自动 Mini 依赖 helper socket 同目录的 `foreground.json`。升级 helper 行为时必须提升捆绑包版本并重建所有随包 native 产物；桌面按 manifest 版本播种，不覆盖同版本副本。0.5.2 起自动更新成功后重启常驻 helper，避免协议号与路径相同但内存中仍为旧版本。

运行 `npm run check:helper-refresh` 检查升级顺序，`npm run check:helper-signal` 启动随包真实二进制并检查初始闲置信号；后者可追加已安装的可执行文件路径。完整前台触发与 Mini 过渡在 Genesis desktop 的 `npm run check:mininative` 中验证，需要已安装并授权的 macOS helper。该测试只操作隔离测试窗口。

Automatic Mini requires the helper’s foreground signal. Bump the bundle version whenever shipping changed helper bits, rebuild all native artifacts, and restart the daemon after replacement. `check:helper-refresh` covers upgrade ordering; `check:helper-signal` probes real packaged bits. Genesis `check:mininative` covers actual physical input, external focus, current-session Mini and cursor motion against an isolated window.
