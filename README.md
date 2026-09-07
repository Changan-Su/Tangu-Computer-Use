# Tangu Computer Use

Let a Forsion agent **observe and control desktop apps** on macOS, Windows and Linux — see the screen,
click, type, scroll, and wait for UI changes — through the accessibility tree + OCR + screenshots.
A **Forsion 捆绑包**: one directory that carries the engine plugin (11 tools), a companion skill, and a
desktop view that shows the window being controlled. Forked from
[pi-computer-use](https://github.com/injaneity/pi-computer-use) (MIT), synced at v0.5.0.

> macOS 14+ (Swift helper), Windows (Rust UIA helper), Linux (Rust AT-SPI2/X11 helper).
> On macOS the helper needs Accessibility + Screen Recording; the other platforms need no system grant.

## Install

```bash
npm install && npm run build     # 引擎入口必须先构建出来
sh install.sh dev                # → ~/.forsion-dev/plugins/tangu-computer-use   (prod = ~/.forsion)
```

> 0.2.0 起不再走 `tangu install`:仓根已没有 `tangu-plugin.json`,引擎侧内容在 `tangu-plugins/computer-use/`。
> 发布的 npm 包是**捆绑包的分发载体**(市场解包到 `plugins/<id>/`),不是可直装的独立引擎插件。
> 若你装过 0.1.x,`<home>/tangu/plugins/` 或 `~/.tangu/plugins/` 里那份要删掉——同一个插件 id 会重复装载,
> `install.sh` 会把它们列出来。

Then enable **电脑操作** in **设置 → 插件**. That is the whole setup — **the native helper installs
itself** the first time a tool runs, and reinstalls itself when a plugin update ships a newer helper
(the binary rides along in the bundle, so this works offline). No terminal required.

The CLI is still there for repairs and for scripting:

```bash
tangu computer-use doctor     # check helper / Accessibility / Screen Recording / macOS version
tangu computer-use setup      # force a reinstall of the helper
tangu computer-use stop       # stop the helper
```

macOS will ask you to grant **Accessibility** and **Screen Recording** to *Tangu Computer Use*
in System Settings → Privacy & Security — the agent opens the right pane for you, but only you can
flip the switch. The agent cannot see or touch anything until you do.
Since v0.5.0 the helper installs to `~/Applications` unless a writable `/Applications` copy already
exists — **no administrator password needed**.

## What's in the bundle

| path | what the host does with it |
|---|---|
| `manifest.json` + `main.js` | 桌面插件:注册视图 `plugin:tangu-computer-use:live`(被操控窗口的实时画面) |
| `skills/computer-use/SKILL.md` | 配套技能:工具循环、后台优先、上 Agent Desk、不可逆动作的确认规则 |
| `tangu-plugins/computer-use/` | 引擎插件:11 个工具 + `tangu computer-use` 子命令 |
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

Build the helper with `npm run build:native` (or the source fallback in setup-helper) and pair it with Genesis's Mini Panel adapter update. `npm run check:mini-foreground` tests signal lifetime without controlling any application. Existing installed helpers must be rebuilt through the normal signed-helper workflow before Genesis can follow foreground input.

macOS helper 会向 socket 同目录发布短时前台输入信号，供 Genesis Mini Panel 跟随光标。后台 AX/PID 调用不触发；必须配套更新 Genesis 并按现有签名流程重建 helper。验证命令为 `npm run check:mini-foreground`，不会操控用户应用。
