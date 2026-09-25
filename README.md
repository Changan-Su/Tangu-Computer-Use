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
