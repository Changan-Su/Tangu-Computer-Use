# Upstream & vendor strategy

Forked from **[injaneity/pi-computer-use](https://github.com/injaneity/pi-computer-use)**
@ `c838d3a` (v0.5.0), MIT. Upstream license: `LICENSE.upstream`.

> Repo shape: this repo **is a Forsion bundle** (`manifest.json` + `main.js` + `skills/` at the root,
> engine plugin under `tangu-plugins/computer-use/`). See "Bundle layout" at the bottom.

## Vendor strategy — vendor is verbatim except a mechanical brand rename

`src/vendor/` is the upstream `src/` copied verbatim **except one mechanical, greppable rename**
(see "Brand rename" below — the helper's identity/path constants must match the branded native
app or nothing connects) **and one deliberate behavioural constant**: `HELPER_PROTOCOL_VERSION` in
`platform/macos/helper.ts`, which we hold above upstream's (see "Helper protocol version" below).
Re-syncing must not blindly restore upstream's number — that silently disables every native feature
we added. The entire *code* coupling to pi (`@earendil-works/pi-coding-agent`)
is 5 files:

| upstream file | pi import | how it's satisfied |
|---|---|---|
| `bridge.ts` | `AgentToolResult`, `AgentToolUpdateCallback`, `ExtensionContext` (type) | `src/pi-compat.ts` |
| `permissions.ts`, `platform/types.ts`, `platform/macos/permissions.ts` | `ExtensionContext` (type) | `src/pi-compat.ts` |
| `config.ts` | `getAgentDir` (runtime) | `src/pi-compat.ts` |

`tsconfig.json` `paths` + `scripts/build.mjs` esbuild `alias` both map
`@earendil-works/pi-coding-agent` → `src/pi-compat.ts`, so **the vendor import lines are not
edited**. Config is injected by mutating the `activeConfig` object returned by
`getComputerUseConfig()` (see `src/tools.ts` → `syncSettings`), so `config.ts` is unmodified too.

### Tangu adaptation layer (NOT vendored — hand-written)
- `src/pi-compat.ts` — the pi shim (only the shapes vendor actually uses).
- `src/tools.ts` — upstream's 11 `defineTool` → Tangu `ToolDef[]`; typebox schema hand-translated
  to plain JSON Schema; `AgentToolResult.content` → return string + `ctx.collectImage` (screenshots).
- `src/settings.ts` — 3 keys (browser_use / headless / cursor_overlay).
- `src/setup.ts` — `tangu computer-use setup|doctor|stop` (readline `ExtensionContext` reuses
  vendor `ensureComputerUseSetup`).
- `src/index.ts` — the `TanguPlugin` entry.

### Brand rename (the one vendor patch)
The native helper is branded (`com.forsion.tangu-computer-use`, `/Applications/tangu-computer-use.app`,
socket `~/Library/Caches/tangu-computer-use/bridge.sock`, Windows exe under `tangu-computer-use/`).
The vendor **runtime** must point at those exact names — `HELPER_BUNDLE_ID` (used by `open -b`),
`HELPER_APP_PATH`, the socket dir, and `WINDOWS_HELPER_PATH`. So the vendor gets one mechanical
rename applied across `src/vendor/**.ts`:

```
s/\bpi-computer-use\b/tangu-computer-use/g   # lowercase token: bundle id, app/socket/exe paths, user-facing strings, config filename
s/\binjaneity\b/forsion/g                    # com.injaneity.… → com.forsion.…
```

Plus these **exact user-facing phrases** (never a blanket `\bpi\b` — that would hit the
`@earendil-works/pi-coding-agent` import specifier the alias depends on):

```
Restart Pi to use the installed helper.        → Restart Tangu to use the installed helper.
Restart Pi so the canonical helper is used.    → Restart Tangu so the canonical helper is used.
Start pi in interactive mode.                  → Run 'tangu computer-use setup' in a terminal.   (single quotes — the string sits inside a template literal)
Windows helper closed because the Pi session ended. → … the Tangu session ended.
Enable browser_use in ~/.pi/agent/extensions/… or .pi/computer-use.json to allow browser windows.
                                               → Enable the computer-use plugin's browser_use setting to allow browser windows.
```

Also `Linux helper closed because the Pi session ended.` → `… the Tangu session ended.` (v0.5.0's
Linux backend mirrors the Windows string).

Case matters: the `PI_COMPUTER_USE_*` / `PI_CU_*` **env-var names are a different token** (uppercase +
underscores) and are deliberately left unchanged, as are code comments mentioning Pi. After the rename,
`grep -rn "pi-computer-use\|injaneity" src/vendor` must be empty (the rename now also covers `.mjs` /
`.d.mts` — v0.5.0 added `platform/macos/helper-path.mjs`). This mismatch was a
real bug once (native branded, vendor still `pi-*`): the runtime launched an unregistered bundle id and
connected to the wrong socket, so `doctor` reported ready while a real observe/act failed.

### PACKAGE_ROOT — no longer patched, but still guarded
`platform/{macos,windows,linux}/helper.ts` locate `scripts/setup-helper.mjs` via
`path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")`. Correct in the source
tree (`src/vendor/platform/<os>/` → package root). Once bundled it depends on **where the bundle lands**:

| bundle output | 3 levels up | verdict |
|---|---|---|
| `<root>/dist/index.js` (v0.1, engine-plugin layout) | two levels *above* the repo | ✗ — needed a build-time rewrite |
| `<root>/tangu-plugins/computer-use/dist/index.js` (bundle layout) | `<root>` | ✔ — upstream's own math is right |

So the bundle move **deleted a whole vendor patch**. `scripts/build.mjs` keeps two guards instead:
① the expression must still be present in every platform helper (upstream changing it fails the build),
② after the build it resolves 3 levels up from the real output dir and asserts `scripts/setup-helper.mjs`
is there. Move the output and the build tells you.

`scripts/setup-helper.mjs` gets one path patch of its own: upstream imports
`../src/platform/macos/helper-path.mjs`; ours is `../src/vendor/platform/macos/helper-path.mjs`
(and that file is listed in package.json `files`, or the published package can't install its helper).
Plus the CN shortening (`Tangu CU Local Signing …` — openssl caps commonName at 64 bytes) and a
`removeSigningTempFiles()` sweep right before `codesign` in `signHelper()`.

⚠️ That sweep is not cosmetic. `codesign --sign <local cert>` needs the private key, so it raises a
**keychain dialog** — run it anywhere nobody can click and it hangs, and killing it leaves a
`MacOS/*.cstemp` behind. The next `codesign --deep` then seals that temp file into `CodeResources`
and deletes it on the way out, so the signature fails verification **forever**
(`a sealed resource is missing or invalid`). Because TCC matches the *designated requirement*, the
app silently loses Accessibility/Screen Recording and **toggling the checkbox in System Settings can
never fix it** — the stored grant no longer matches the binary. Re-signing cleanly with the same cert
restores the original requirement and the existing grants light up again; no uninstall, no
`tccutil reset`. (2026-07-28, cost a long debugging session.)

### Native
`native/macos` (Swift), `native/windows` (Rust) and `native/linux` (Rust) are vendored with the same
brand strings rewritten. **Never change the bundle id or signing identity across releases** — macOS ties
Accessibility/Screen-Recording (TCC) grants to them.

> ⚠️ v0.5.0 changed where the macOS helper installs: an existing **writable** `/Applications` install
> stays put, everything else goes to `~/Applications` (no admin needed). Users whose `/Applications`
> is not writable will be asked to re-grant TCC once, because the path moved.

**Helper protocol version — bumped by us.** Upstream v0.5.0 is at 6; we run **11**, in two places that must
always match: `native/macos/bridge.swift` (`private let protocolVersion`) and
`src/vendor/platform/macos/helper.ts` (`HELPER_PROTOCOL_VERSION`). Bump it whenever the helper gains a
command **or changes native behaviour** — `src/onboarding.ts` now notices a stale binary *on disk*, but a
**already-running** daemon is only re-validated through the protocol number, so without a bump the old
process keeps serving after the update lands. 0.4.0 is the cautionary case: it changed only overlay window
levels and one CGWindowList call, no new commands — a same-protocol daemon would have gone on drawing
invisible overlays and the user would have reported the bug a fourth time. Without a bump, an old installed helper keeps serving observe/act while
every new native feature silently does nothing (that is exactly how the first live-view build shipped
"working"). With a bump, `ensureProtocol()` restarts the daemon and then throws a clear
"reinstall or rebuild the helper app" error. On resync, if upstream has moved past 6, go one above theirs.

**Tangu-only native additions (not upstream, replay them after every sync):**
- `native/macos/agent_highlight.swift` + `agent_highlight_tests.swift` — the glowing edge around the
  window being controlled. Listed in `helperSourcePaths` (setup-helper.mjs) and `macosSourcePaths`
  (build-native.mjs); forget either and the helper compiles without it.
- `native/macos/live_stream.swift` — `LiveWindowStream`, a **persistent `SCStream`** for the controlled
  window plus a window-sized one-shot (`captureOnce`). Same two source lists as the highlight.
  Two things it exists to fix, both measured, both easy to undo by accident:
  ① `SCScreenshotManager.captureImage` renegotiates a capture session per frame — fine for one
  screenshot, a 1fps slideshow for a live view. The stream keeps the latest frame; a fetch is ~12ms.
  ② upstream's `captureWindow` sets **no** `config.width/height`, so ScreenCaptureKit renders at
  *display* size with the window pinned top-left and the rest blank — a 230×408 Calculator comes back
  as 1920×1080 mostly white. That whitespace is baked into the JPEG; no amount of CSS fixes it.
  Anything serving the live view must set width/height. `captureWindow` itself is left alone because
  `look` depends on its coordinate space.
- `bridge.swift` `act()`: **coordinate clicks try an AX hit-test first** (`backgroundPressAtPoint`).
  Upstream sends coordinate clicks straight to HID/foreground (`needsForeground` in `actions.ts`)
  because `CGEventPostToPid` is dropped by non-key windows — so "look at the screenshot and click"
  always stole the foreground. Hit-testing **against the target app element** (never systemWide: the
  occluding window would answer) and pressing via AX keeps it in the background. Guarded to
  left-button single clicks, non-web, non-text, and the hit must be inside the target window's subtree.
  `npm run check:blindclick` proves all of it on a real machine.
- `bridge.swift`: `noteControlledWindow()` called at the top of `act()`, a matching write inside
  `storeLookRecord()`, and the `liveView` command (case + method). The highlight reuses the existing
  `cursorOverlay` request flag — no new config key, so `platform/macos/backend.ts` is untouched.
- `agent_cursor.swift` (vendor file, small patch): the overlay window spans **every** display and is
  re-framed on each `animate()`, and the global CG point is converted to overlay-local coordinates via
  `OverlayGeometry.canvasPoint`. Upstream sizes it to `NSScreen.main?.frame` only, so a click on a
  secondary display draws the cursor outside the window — invisible, which reads exactly like "the
  assistive cursor never appears". The geometry lives in `agent_highlight.swift` (our file) so
  `npm run check:highlight` can pin it; single-display setups are an exact identity, unchanged.
  ⚠️ "Primary" means the screen whose frame origin is `(0,0)` — not `NSScreen.main` (that follows the
  key window) and not necessarily `screens.first`.
- `bridge.swift` `postMouseClick()`: save/restore the **physical cursor** around HID clicks. A
  `.cghidEventTap` post drags the user's real pointer to the target and leaves it there; having the
  foreground taken is bad enough without also losing your mouse. Guarded — it only warps back when the
  pointer is still where we put it (so it never fights a user who grabbed the mouse mid-click), and
  `CGAssociateMouseAndMouseCursorPosition(1)` after the warp or the pointer appears stuck. The
  background (pid) path needs none of this: it never moves the system pointer, it draws `AgentCursor`.

- **Overlay z-order and window bounds — two bugs that made both overlays invisible (0.4.0).** Replay
  these after any sync; both are one-liners and both fail *silently*.
  ① `cgWindowBounds()` must use `CGWindowListCopyWindowInfo([.optionIncludingWindow], id)`.
  **Never** `CGWindowListCreateDescriptionFromArray` — it returns an **empty array** for windows owned
  by another process (measured on the same window id: 0 vs 1 entries). `AgentHighlight.show()` bails on
  a nil rect, so the glowing edge had never rendered once since it was written.
  ② Both overlay windows must set `window.level` (`.floating` for the glow, `.screenSaver` for the
  cursor). They live in an `.accessory` app that never activates, so at the default level 0 they sink
  below the controlled app the moment it is activated. Upstream's
  `window.order(.above, relativeTo: <foreign window number>)` is a **no-op across processes** (measured:
  the window neither rises nor disappears) — cross-process stacking is only expressible as a level.
  `npm run check:overlay` samples the on-screen window stack at 100ms and asserts both overlays are
  present **and above the controlled window**. Geometry unit tests cannot see either bug: "the rect is
  correct", "the window exists" and "the user can see it" are three different claims.

- **Never spawn `Contents/MacOS/bridge` directly** — launch the daemon with
  `open -n -g <APP> --args serve --socket <path>` (what `launchDaemon()` does). TCC attributes grants to
  the *responsible process*, so a direct spawn inherits the caller's identity and `diagnostics` reports
  "no Accessibility permission". It looks exactly like lost grants and is not.

### Onboarding — the helper installs itself (0.4.0)
`ensureInstalled()` already shells out to `scripts/setup-helper.mjs` (re-entering Electron/Bun via
`ELECTRON_RUN_AS_NODE`), so a **first** install needs no terminal. Two things break that, and both were
ours:
- Any "helper not installed → return instructions" early-return in `src/tools.ts` **defeats it**. Don't
  add one back.
- `ensureInstalled()` returns as soon as the executable *exists* and never notices a **stale** binary, so
  plugin updates used to dead-end at a protocol-mismatch error telling the user to open a terminal.
  `src/onboarding.ts` `helperNeedsUpdate()` compares the bundle's `prebuilt/macos/<arch>/bridge` against
  the installed executable by hash (memoised per process) and reinstalls when they differ. This is why
  the bundle must keep shipping the prebuilt binary — `npm run check:helper-path` asserts it does.

Permissions deliberately still require the user: granting Accessibility/Screen Recording is a system
security setting. `guideMissingPermissions()` pre-registers the app in the Privacy panes and opens the
right pane (once per kind per process, or a retrying agent spams System Settings).

### Known residual: same-app window pairing
`backgroundPressAtPoint` scopes its hit-test to the target app and then requires the hit to sit inside
the AX subtree of `windowElement(pid:windowId:)`. That last step relies on upstream's greedy
title/geometry pairing between CG window ids and AX windows, which has no tie-break for two windows of
one app with the same title **and** near-identical overlapping frames. In that (rare) case the press
can land in the front window instead of the one the screenshot came from. The `ref` path has exactly
the same exposure — fixing it means real AX↔CG window identity, which needs private API
(`_AXUIElementGetWindow`). Deliberately not done; noted so nobody assumes the subtree check is airtight.

### Bundle layout
```
manifest.json  main.js  check.mjs  skills/computer-use/     ← Forsion 桌面侧(视图 + 配套技能)
tangu-plugins/computer-use/{tangu-plugin.json,dist/}        ← 引擎侧插件(11 工具)
src/  native/  scripts/  prebuilt/                          ← 源码与原生 helper(位置不变)
```
`bundles.ts` finds the engine plugin at `<bundle>/tangu-plugins/<pid>/tangu-plugin.json` and skills at
`<bundle>/skills/<slug>/SKILL.md`. There is **no root `tangu-plugin.json` any more** — a stale
`tangu install --link` symlink from v0.1 now points at a directory without one.

## Re-syncing upstream
1. `git clone https://github.com/injaneity/pi-computer-use` and `git diff <pinned>..HEAD` to see the scope.
2. Copy its `src/` over `src/vendor/`, then re-run the brand rename over `src/vendor/**` (`.ts` + `.mjs`
   + `.mts`; the two `perl -pe` subs plus the exact phrases in "Brand rename"). `grep -rn
   "pi-computer-use\|injaneity" src/vendor` must come back empty. Import lines need no change — the alias
   handles pi.
3. Copy `scripts/{setup-helper,build-native,make-signing-cert}` over, rename, then re-apply our two
   setup-helper patches (vendor path for `helper-path.mjs`, short signing CN).
4. Copy `native/{macos,windows,linux}` over, rename — then **replay the Tangu native additions** listed
   under "Native" (the highlight file and the three `bridge.swift` hooks). `grep -n
   "noteControlledWindow\|liveView\|AgentHighlight" native/macos/bridge.swift` must find them.
5. If `extensions/computer-use.ts` changed (new tools or schema), mirror it in `src/tools.ts` (`SPECS`),
   and mirror new config keys in `src/settings.ts` + `syncSettings`.
6. `npm run build && npm run check`, plus `node scripts/build-native.mjs --arch arm64 --no-sign` to prove
   the Swift still compiles. Bump the commit at the top of this file.
7. Real-machine greens (need an installed, authorized helper — not runnable in CI, hence not in
   `npm run check`): `npm run check:live` = `check:blindclick` (coordinate click goes AX, keeps the
   foreground, **and the Calculator readout actually changes**) + `check:liveview` (frames come from
   the stream, sub-100ms, actually differ, and every frame matches the window's aspect ratio).
   For the view's layout, serve the repo and open `harness/harness.html`, then press 「量一量」 —
   it walks every window shape and asserts canvas-aspect / fill / snug / no-overflow. The DOM shim in
   `check.mjs` does no layout, so CSS regressions are only visible there.

- Mini Panel foreground activity: `native/macos/foreground_activity.swift` emits a bounded, data-only lease beside the daemon socket. Hooked into actual HID/focus delivery and recursive input scopes, not the requested delivery policy. Included in both native-build and source-install inputs. No change to upstream tool schemas or input behavior.
