import { clickReceipt, recoveryExhausted } from './backgroundRecovery.ts';
/**
 * 上游与 Tangu 的工具通过同一套执行策略注册。翻译要点:
 *   - parameters:上游 typebox schema 手翻成纯 JSON Schema 字面量(零依赖,不引 typebox)。
 *   - execute 签名:pi 的 (toolCallId, params, signal, onUpdate, ctx) → Tangu 的 (args, ctx)。
 *   - 结果:AgentToolResult.content 的 text block 拼成返回 string;image block(observe 截图)→ ctx.collectImage(回灌模型)。
 *   - 门禁:host + hostExec + 插件启用 + macOS(stickers 同款);浏览器三工具再叠 browser_use 设置。
 *   - 审批:动作类(act_ui/launch/navigate/evaluate_browser)声明 approval:'command'(与 run_bash 同档);观察类免审。
 *   - setup:每次工具执行前惰性 ensureComputerUseSetup(hasUI=false)→ 权限缺时 vendor 抛 nonInteractiveError,
 *     被 catch 成指导文本返回给模型(提示跑 `tangu computer-use setup`)。
 */
import { browserRegions } from './vendor/contract.ts';
import { assertPublicHttpUrl } from './publicUrl.ts';
import { macAppIdentifiers, macAppPathPids, macScreenLocked } from './macosApp.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef, ToolProvider, ToolContext, AppProfile, PluginStore } from '@forsion/tangu-agent';
import { presentLiveViewOnce } from './deskPresent.ts';
import type { ExtensionContext, AgentToolResult } from './pi-compat.ts';
import {
  executeFind, executeObserve, executeSearchUi, executeExpandUi, executeInspectUi,
  executeAct, executeReadText, executeWaitFor, executeLaunchBrowser, executeNavigateBrowser,
  executeEvaluateBrowser, ensureComputerUseSetup, toolSurface, pixelBinding,
} from './vendor/bridge.ts';
import { getComputerUseConfig, loadComputerUseConfig } from './vendor/config.ts';
import { currentPlatformBackend } from './vendor/platform/index.ts';
import { isSupportedPlatform } from './helperState.ts';
import { autoInstallFailed, ensureHelperCurrent, guideMissingPermissions } from './onboarding.ts';
import { executionNote, expectNote, foregroundNote, goneHint, imageNote, noRootsHint, scrollNote, selfWindowNote } from './foregroundNote.ts';
import { runJev, parseJevArgs } from './jevRun.ts';
import { inspectScreenshot } from './pixelInspection.ts';
import { reportLaunchForeground, watchRunAbort, withOverlayRun } from './overlayState.ts';

const execFileP = promisify(execFile);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const PLUGIN_ID = 'computer-use';

type PiExecute = (
  toolCallId: string,
  params: any,
  signal: AbortSignal | undefined,
  onUpdate: undefined,
  ctx: ExtensionContext,
) => Promise<AgentToolResult<any>>;

// ── JSON Schema 片段(翻译自上游 extensions/computer-use.ts 的 typebox;v0.5.0 契约)──
// v0.5.0 收紧了整个工具面:动作里删掉 doubleClick(用 clickCount)与 wait(用 wait_for/expect);
// click 拆成「按 ref」与「按坐标」两个互斥变体(不再混着给);observe 只认 @r root(app/windowTitle
// 猜名字那套没了);search 用 capability 且不分页(refine 而非 paging);read_text 兼收 @e 与 @o
// (@o = 输出被截断时给的续读句柄,不需要 stateId);wait_for 与 act.expect 共用同一套条件字段。
const S = (description?: string, maxLength?: number) => ({ type: 'string', ...(description ? { description } : {}), ...(maxLength ? { maxLength } : {}) });
const N = (description?: string, extra: Record<string, number> = {}) => ({ type: 'number', ...(description ? { description } : {}), ...extra });
const stateId = { type: 'string', description: 'Required state id owning every @e ref used by this operation' };
const screenshotPoint = (description: string) => ({
  type: 'array', items: { type: 'integer', minimum: 0 }, minItems: 2, maxItems: 2, description,
});
const view = S('Handle printed on one browser screenshot. Its coordinates belong to that exact full image or detail.');
const mouseButton = { type: 'string', enum: ['left', 'right', 'middle'] };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required });

// wait_for 与 act_ui.expect 共用的条件字段(上游 conditionProperties)。
const conditionProps = {
  ref: S('Specific @e ref to test', 128),
  scopeRef: S('Restrict matching to this @e subtree', 128),
  text: S('Text that must match', 512),
  role: S('Exact normalized role', 128),
  value: S('Exact normalized value; normally pair with ref'), // 上游此项刻意无 maxLength(要比对的可能是整段文本值)
  until: { type: 'string', enum: ['present', 'absent'], description: 'Desired condition, default present' },
  timeoutMs: N('Maximum wait, default 10000ms', { minimum: 100, maximum: 60_000 }),
};

const clickCount = N('1-3', { minimum: 1, maximum: 3 });
// 坐标一律是「最近一张截图里的像素」。反馈 55b984eb:这里以前没有任何说明,模型把它当成屏幕坐标去换算。
const point = {
  x: N('Pixels from the left edge of the screenshot identified by stateId (full image or focused browser detail). A magnified detail has a separate origin and scale; convert its coordinates using the observation result.'),
  y: N('Pixels from the top edge of the same screenshot'),
};

// act_ui 的 actions:上游 uiAction union(8 变体)→ anyOf
const uiAction = {
  anyOf: [
    obj({ action: { const: 'press' }, ref: S('Actionable outline ref') }, ['action', 'ref']),
    obj({ action: { const: 'click' }, ref: S('Actionable outline ref'), button: mouseButton, clickCount }, ['action', 'ref']),
    obj({ action: { const: 'click' }, ...point, button: mouseButton, clickCount }, ['action', 'x', 'y']),
    obj({ action: { const: 'setText' }, ref: S('Editable outline ref'), text: { type: 'string' } }, ['action', 'ref', 'text']),
    obj({ action: { const: 'typeText' }, ref: S('Omit to type into the current focus: needs a click earlier in this same call, or a target window that is already frontmost'), text: { type: 'string' } }, ['action', 'text']),
    obj({ action: { const: 'keypress' }, ref: S('Omit to send keys to the current focus: needs a click earlier in this same call, or a target window that is already frontmost'), keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['action', 'keys']),
    obj({ action: { const: 'scroll' }, ref: S('Outline ref to scroll. Without ref or x/y it scrolls where the previous click/moveMouse of this same call landed'), ...point, scrollX: N('Horizontal distance. For a coordinate scroll on macOS: pixels of the latest screenshot, the same scale as x / y'), scrollY: N('Vertical distance, positive scrolls down. For a coordinate scroll on macOS: pixels of the latest screenshot, the same scale as x / y') }, ['action']),
    obj({ action: { const: 'drag' }, path: { type: 'array', items: obj(point, ['x', 'y']), minItems: 2 } }, ['action', 'path']),
    obj({ action: { const: 'moveMouse' }, ...point }, ['action', 'x', 'y']),
  ],
};

interface ToolSpec {
  name: string;
  description: string;
  parameters: ReturnType<typeof obj>;
  exec?: PiExecute;
  // 适配层自有工具(非 vendor 委托),给定则走它,拿到 args/tcx/pctx 直接返回 string。
  run?: (args: Record<string, any>, tcx: ToolContext, pctx: ExtensionContext, store: PluginStore) => Promise<string>;
  sideEffect: 'read' | 'system' | 'browser';
  approval?: 'command' | 'always';
  browserOnly?: boolean;
  darwinOnly?: boolean;
  jevOnly?: boolean;
  timeoutMs: number;
}

const toolSpecs = (compact: boolean, panels = false): ToolSpec[] => [
  {
    name: 'jev_ui', sideEffect: 'system', approval: 'command', darwinOnly: true, jevOnly: true, timeoutMs: 180_000,
    description: 'Experimental Jev acceleration for ONE native desktop root: you plan, Jev acts and checks. Plan the whole on-screen sequence yourself, then send it as 1–8 steps in one call. Actions: click; double_click (play a row, open a file); fill (atomic setText, native text fields only); type (clicks target when given, then types text at the caret; works on canvas, CEF and web windows where fill is refused, and does not clear the field; keys, e.g. ["return"], are pressed right after the text in the same input: for a search box or a form that applies on Return, never to send a message, which stays a step of its own after you checked the screenshot); key (keys such as ["return"] or ["cmd","a"], after clicking target when given, else to the current focus, which only works while that window is in front); scroll (target = the list or panel; Jev scrolls it, three quarters of the list per wheel and short wheels once part of the item shows, at most maxScrolls times (default 12, up to 30 for a long list), until `until` is fully in view, checking every frame itself; then click the item in the same call). Describe targets by what is drawn (a label, a row\'s title text), never by pixel coordinates; for a list row, target its title text, not the whole row. Give every other step that changes the screen an expect: what the window will certainly show once it worked (e.g. "the Daily picks song list is shown", "row 3 shows a playing icon"); do not guess text you have not seen, such as a page title. Jev locates each target on a fresh observation, sends the input, then looks for expect on new screenshots for up to 4 s (page loads included) and only then moves on, with no main-model round trip per step. It hands back early, with the latest screenshot, when a target is missing/ambiguous/low-confidence, an expect does not appear, a scroll does not reach until, or a step without expect cannot be confirmed natively (canvas/web windows never confirm natively, so always give expect there). A rejected target means Jev does not see it as described: describe it differently and call again. mode=elements selects accessibility refs and never takes screenshots (click and fill only; expect is then not checked); vision uses screenshot boxes; auto tries elements then vision. preview=true locates ONE target without acting. point in the report is in Jev\'s own capture; use pointFraction to compare with other screenshots. Unknown is an unverified input, not a failed one: inspect the returned screenshot before repeating anything with any tool, and continue only the unconfirmed steps. Same executor and foreground policy as act_ui; only drag needs act_ui. key ["return"] in a message field sends it: do not batch irreversible/outward-facing actions without the authorization the normal Computer Use rules require. Never put API keys in arguments.',
    parameters: obj({
      root: S('Exact native desktop @r root from find_roots'),
      steps: { type: 'array', minItems: 1, maxItems: 8, items: obj({
        action: { type: 'string', enum: ['click', 'double_click', 'fill', 'scroll', 'type', 'key'] },
        target: S('The control by what is drawn in its surrounding UI (label, row title text), never pixel coordinates. scroll: the list or panel. type / key: optional; given, Jev clicks it first, omitted, input goes to the current focus', 512),
        text: S('fill: exact replacement text. type: text typed at the caret (added to what the field already holds)', 10_000),
        keys: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 16, description: 'key: the keys to press. type: optional, pressed right after the text (e.g. ["return"]). ["cmd","a"] is one chord (modifiers first), ["return"] one key, ["cmd+a","delete"] presses them in turn' },
        until: S('scroll only: what must come fully into view, e.g. "the row titled Blue Skies"', 512),
        direction: { type: 'string', enum: ['down', 'up'], description: 'scroll only; default down' },
        maxScrolls: { type: 'integer', minimum: 1, maximum: 30, description: 'scroll only: most wheels before handing back, default 12; raise it for a long list (all contacts, a big playlist)' },
        expect: S('What the window will certainly show once this step worked, checked by Jev on fresh screenshots; give it for every step that changes the screen (scroll uses until instead)', 512),
      }, ['action']) },
      mode: { type: 'string', enum: ['auto', 'elements', 'vision'], description: 'Override the plugin default for comparison' },
      preview: { type: 'boolean', description: 'Locate one target without input; default false' },
    }, ['root', 'steps']),
    run: async (args, tcx, pctx, store) => {
      const result = await runJev(args, () => store.getScopeSettings(PLUGIN_ID, 'global'), () => store.isPluginEnabledSync(PLUGIN_ID), pctx, tcx.signal);
      return JSON.stringify(result.report) + (result.last ? '\n' + render(result.last, tcx) : '');
    },
  },
  {
    name: 'find_roots', exec: executeFind as PiExecute, sideEffect: 'read', timeoutMs: 30_000,
    description: 'Find a bounded, ranked set of controllable UI roots with refs, geometry, and focus state. Find a target root before observe_ui when needed.',
    parameters: obj({
      text: S('Ranked app or title text', 256),
      app: S('Exact normalized app name', 256),
      bundleId: S('Exact bundle id'),
      pid: N('Exact process id'),
      kind: { type: 'string', enum: ['window', 'menu', 'sheet', 'popover', 'dialog', 'browser_page'], description: 'Exact root kind' },
    }),
  },
  {
    name: 'observe_ui', exec: executeObserve as PiExecute, sideEffect: 'read', timeoutMs: 60_000,
    description: 'Capture the current/frontmost root or one exact @r root and return a bounded UI outline. Use mode=semantic to skip OCR and images, visual to force them, fused for automatic selection. For screenshot-only work use pixels. For '
      + (panels ? 'a small browser target, use focus with a full screenshot or named panel handle and click in the returned image. For exact colors use samplePixels. For native windows use magnify' : compact ? 'a small browser target, use focus with the full screenshot handle and click in the returned image. For exact colors use samplePixels. For native windows use magnify' : 'small icons or exact colors, choose magnify or samplePixels on the target root')
      + '. Primary UI observation tool; follow with search_ui/expand_ui/inspect_ui/act_ui. Use @e outline refs from observe_ui/search_ui for act_ui; pictureOnly refs are coordinate-only.',
    parameters: obj({
      root: S('Exact @r ref issued by find_roots'),
      ...(compact ? { view } : {}),
      ...(panels ? { region: { type: 'string', enum: browserRegions, description: 'Zoom a named position of the full browser viewport. Each region includes the surrounding panel. Use view or stateId and click in the returned image. You may inspect a different region from a detail.' } } : {}),
      stateId: S(compact ? 'Alternative to view. The full stateId of the browser screenshot.' : 'State owning the full browser screenshot when using focus.'),
      focus: { ...obj({x:N(), y:N()}, ['x','y']), description: panels ? 'Render a high-resolution detail around x/y from the full screenshot or a named panel. Supply its view handle or stateId. Click directly in the returned detail.' : compact ? 'Inspect small controls in a fresh high-resolution browser detail centered on full-image x/y. Supply its view handle or stateId. Click directly in the returned detail.' : 'Inspect small controls in a fresh high-resolution browser detail centered on full-image x/y. Requires root and stateId from the full screenshot. Click directly in the returned detail.' },
      samplePixels: { type: 'array', items: obj(point, ['x', 'y']), minItems: 1, maxItems: 8, description: 'Read RGB at these full screenshot coordinates to check swatches or edits. Requires an exact root. Implies pixels mode.' },
      magnify: { ...obj({ ...point, width: N(), height: N() }, ['x', 'y']), description: 'Attach a 2× detail. Give only x and y to center the detail on a point. With width and height, x and y specify the top-left of the rectangle (max 320 × 320). Requires an exact root. Implies pixels mode.' },
      mode: { type: 'string', enum: ['semantic', 'visual', 'fused', 'pixels'], description: 'pixels shows only the screenshot and its coordinates, including for a native desktop root. visual includes the outline as well. Default fused.' },
    }),
  },
  {
    name: 'search_ui', exec: executeSearchUi as PiExecute, sideEffect: 'read', timeoutMs: 15_000,
    description: 'Return a bounded, deterministically ranked search of the cached outline. At least one predicate is required. Find targets not shown in the compact observe_ui output; refine broad searches instead of paging matches.',
    parameters: obj({ text: S('Human-readable text or label', 256), role: S('Exact normalized role, e.g. button', 128), capability: S('Exact capability, e.g. press', 128), stateId }, ['stateId']),
  },
  {
    name: 'expand_ui', exec: executeExpandUi as PiExecute, sideEffect: 'read', timeoutMs: 15_000,
    description: 'Unfold bounded local outline context for one @e ref. Expand a specific ref instead of dumping unrelated UI.',
    parameters: obj({ ref: S('Outline ref from observe_ui/search_ui, e.g. @e12'), depth: N('Subtree depth, default 3', { minimum: 1, maximum: 8 }), stateId }, ['ref', 'stateId']),
  },
  {
    name: 'inspect_ui', exec: executeInspectUi as PiExecute, sideEffect: 'read', timeoutMs: 15_000,
    description: 'Inspect one exact outline ref with fields, geometry, capabilities, and annotations. Use when a target\'s evidence or provenance matters.',
    parameters: obj({ ref: S('Outline ref from observe_ui/search_ui, e.g. @e12'), stateId }, ['ref', 'stateId']),
  },
  {
    name: 'act_ui', exec: executeAct as PiExecute, sideEffect: 'system', approval: 'command', timeoutMs: 120_000,
    description: 'Perform one or more precisely targeted checked actions and return the successor state. '
      + (compact ? 'For a single left click in a browser screenshot, pass click:[x,y] and its view or stateId. ' : '')
      + (panels ? 'For an unfamiliar icon on a live page, hover:[x,y] can reveal its tooltip or status text before you click. ' : '')
      + 'When the state says Screenshot only, send exactly ONE action, then inspect the successor image and use its new stateId. For other states, batch only actions whose targets are already present in this state (for example focus then type). After navigation or opening a popup, inspect the successor state before targeting a newly revealed control; do not guess its coordinates from the old screenshot. Use expect for observable completion. expect reads accessibility text only, never the pixels: on a window whose outline has almost no text it will rarely match, so prefer leaving it out there and judging from the attached screenshot. Coordinates (x / y, drag path) are pixels in the latest attached screenshot, whose size the result states on an [image] line. After clicking an editable region in the same call, omit ref from typeText/keypress so input follows that focus; a later call can omit ref only while the target window is still frontmost, otherwise click again first. To fill a text field prefer a single setText action — it writes the value in the background without taking focus; only click the field first (which takes the foreground) if setText reports it did not take, as happens on some web/Electron inputs. When any action takes the foreground the result says so on a [foreground] line. For strict background-only runs, turn on the plugin\'s "strict background" setting.',
    parameters: obj({
      ...(compact ? { view, click: screenshotPoint('Single left click at [x,y] in the identified screenshot.') } : {}),
      ...(panels ? { hover: screenshotPoint('Move the browser pointer to [x,y] without clicking and capture the full page viewport after a short dwell.') } : {}),
      stateId, expect: obj(conditionProps),
      actions: { type: 'array', items: uiAction, minItems: 1, maxItems: 20 },
    }, compact ? [] : ['stateId', 'actions']),
  },
  {
    name: 'ensure_app', run: (args, tcx, pctx) => runEnsureApp(args, tcx, pctx), sideEffect: 'system', approval: 'command', darwinOnly: true, timeoutMs: 25_000,
    description: 'Start here for a named Mac app. Resolve its localized name, find its running window and return its first screenshot and actionable state in one call. Use pixels for screenshot-only work. Running apps stay in their Space. Cold launches follow the host’s normal tool permission tier. If several windows match, choose a returned root. Use this again to recover a stale window.',
    parameters: obj({
      app: S('Installed app name in the user’s language, or an app bundle path'),
      bundleId: S('Exact bundle identifier, if already known'),
      foregroundRoot: S('Use the exact root indicated by a background click only after its screenshot shows the requested result is missing. May switch Spaces. Also supports an explicit user request to raise an onscreen window.'),
      mode: { type: 'string', enum: ['visual', 'pixels', 'roots'], description: 'Default visual. Use roots to list windows without capturing an image.' },
    }),
  },
  {
    name: 'read_text', exec: executeReadText as PiExecute, sideEffect: 'read', timeoutMs: 30_000,
    description: 'Read a fixed-size page from an @e UI ref or immutable @o truncated-output ref. Use @e with its stateId; @o continuation refs (handed out when a tool result was truncated) do not need stateId.',
    parameters: obj({ ref: S('@e UI ref or @o output ref'), offset: N('Byte offset, default 0', { minimum: 0 }), stateId }, ['ref']),
  },
  {
    name: 'wait_for', exec: executeWaitFor as PiExecute, sideEffect: 'read', timeoutMs: 30_000,
    description: 'Wait for one scoped UI condition and return the successor state. Use after asynchronous UI changes instead of polling observe_ui.',
    parameters: obj({ ...conditionProps, stateId }, ['stateId']),
  },
  {
    name: 'launch_browser', exec: executeLaunchBrowser as PiExecute, sideEffect: 'browser', approval: 'command', browserOnly: true, timeoutMs: 60_000,
    description: 'Open a fresh background browser for this conversation. No Chrome extension or desktop permissions are needed. For a URL or web form, start here and use the returned state with act_ui. This separate profile has no personal tabs or logins. Use browser_tabs when the user needs their existing browser.',
    parameters: obj({ url: S('Initial URL', 8192), mode: { type:'string', enum:['auto','pixels'], description:'pixels for screenshot-only control (canvas, remote desktop, or when explicitly requested). Launch and each action return an image. Click or drag at image coordinates.' }, visible: { type: 'boolean', description: 'Show a window on the user’s desktop only when requested. Screenshots work without this flag. Requires strict background to be off and approval for this task.' } }),
  },
  {
    name: 'navigate_browser', exec: executeNavigateBrowser as PiExecute, sideEffect: 'browser', approval: 'command', browserOnly: true, timeoutMs: 60_000,
    description: 'Navigate an observed CDP browser-page state to an HTTP(S) URL. Native browser windows use act_ui; this tool is CDP-only.',
    parameters: obj({ url: S('HTTP(S) URL', 8192), stateId }, ['url', 'stateId']),
  },
  {
    name: 'evaluate_browser', exec: executeEvaluateBrowser as PiExecute, sideEffect: 'browser', approval: 'command', browserOnly: true, timeoutMs: 30_000,
    description: 'Evaluate targeted JavaScript in a CDP browser-page state; returned output is strictly bounded. Prefer observe/search/read; return selected fields, aggregates, or bounded slices.',
    parameters: obj({ stateId, expression: S('JavaScript expression', 65_536) }, ['stateId', 'expression']),
  },
];

/** 把 pluginStore 的设置注入 vendor 的配置。
 *  ⚠️只改 activeConfig 不够:vendor 每次工具调用都重新加载配置(ensureReady → loadComputerUseConfig = 缺省值 + 配置文件 +
 *  环境变量,整个对象换新),刚注入的值在执行器跑起来之前就被冲掉 —— 实测「严格后台」「光标动画」等开关因此从未生效(10-11)。
 *  所以同时写进它每次加载都会重读、且优先级最高的那组环境变量;vendor 一行不用改。 */
export function syncSettings(store: PluginStore): void {
  const s = store.getScopeSettings(PLUGIN_ID, 'global');
  const cfg = getComputerUseConfig() as unknown as Record<string, unknown>;
  const env = (key: string) => `PI_COMPUTER_USE_${key.toUpperCase()}`;
  const set = (key: string, value: boolean | string) => { cfg[key] = value; process.env[env(key)] = String(value); owned.add(key); };
  // 这次没给的项:把我们上次写的环境变量撤掉(不撤的话旧值会一直压着);不是我们写的不碰。
  const unset = (key: string) => { if (owned.delete(key)) delete process.env[env(key)]; };
  if (typeof s.browser_use === 'boolean') set('browser_use', s.browser_use); else unset('browser_use');
  if (typeof s.headless === 'boolean') set('headless', s.headless); else unset('headless');
  if (typeof s.cursor_overlay === 'boolean') set('cursor_overlay', s.cursor_overlay); else unset('cursor_overlay');
  if (s.managed_browser === 'chrome' || s.managed_browser === 'helium') set('managed_browser', s.managed_browser); else unset('managed_browser');
}
const owned = new Set<string>();

/** 构造 vendor 需要的 ExtensionContext。工具执行 hasUI=false(权限缺→vendor 抛指导文本);sessionManager 给空 stub。 */
export function makePiCtx(tcx: ToolContext, hasUI: boolean): ExtensionContext {
  return {
    cwd: tcx.cwd || process.cwd(),
    browserOwner: JSON.stringify([tcx.userId, tcx.appId, tcx.sessionId]),
    hasUI,
    ui: { notify: () => {}, select: async () => undefined },
    sessionManager: { getBranch: () => [] },
    signal: tcx.signal,
  };
}

/** 每个 state 属于哪个 App;「窗口不在了」的报错靠它给出一条能照抄的 ensure_app 调用。
 *  按 state 记而不是记「最近看的那个」:先看微信再看别的 App,拿微信的旧 state 操作失败时不该建议去打开后者。 */
const targets = new Map<string, { app?: string; bundleId?: string }>();

/** 「窗口不在了」的报错补上原因和出路(见 goneHint),目标按这次调用带的 stateId 查;查不到就只说工具名。 */
export function explainGone(e: unknown, args?: Record<string, any>): void {
  if (e instanceof Error && process.platform === 'darwin') e.message = goneHint(e.message, targets.get(String(args?.stateId ?? '')));
}

/** AgentToolResult → 返回给模型的 string;image block(截图)经 collectImage 回灌;末尾附几行 vendor 只写进 details 的事实:
 *  截图的坐标空间、expect 有没有满足、是否抢了前台、「这是 Forsion 自己的窗口」、按 App 找却没有 root 时的出路。 */
export function render(result: AgentToolResult, tcx: ToolContext, args?: Record<string, any>): string {
  const parts: string[] = [];
  let attached = false;
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image' && tcx.collectImage) {
      const queued = tcx.collectImage({ url: `data:${block.mimeType || 'image/jpeg'};base64,${block.data}`, name: block.mimeType === 'image/png' ? 'screen.png' : 'screen.jpg' });
      if (queued === false) parts.push('Screenshot omitted because the image queue is full. Observe this target again in a new model round before using coordinates.');
      else attached = true;
    }
  }
  const details = (result as { details?: { pixelsOnly?: boolean; tool?: string; root?: { ref?: string }; execution?: unknown; target?: { app?: string; bundleId?: string; pid?: number }; capture?: { stateId?: string } } }).details;
  if (details?.pixelsOnly && !attached && details.root?.ref) {
    const status = details.tool === 'act_ui' ? executionNote(details) : '';
    return status + `Screenshot unavailable for ${details.root.ref}. Request a fresh image with observe_ui({root:"${details.root.ref}",mode:"pixels"}) before using coordinates.`;
  }
  const body = parts.join('\n') || '(no output)';
  const stateId = details?.capture?.stateId;
  if (stateId && (details?.target?.app || details?.target?.bundleId)) {
    targets.set(stateId, { app: details.target.app, bundleId: details.target.bundleId });
    if (targets.size > 64) targets.delete(targets.keys().next().value!);
  }
  return executionNote(details) + body + imageNote(details, attached) + expectNote(details) + scrollNote(args?.actions, details?.execution) + foregroundNote(details?.execution, details?.target?.pid) + selfWindowNote(details) + noRootsHint(details);
}

/** Inspect a running app in place. Cold starts use a background launch when settings allow it. */
const nativeDiscovery = { activate: currentPlatformBackend.activateWindow, screenLocked: macScreenLocked, listApps: (signal?: AbortSignal) => currentPlatformBackend.listApps(signal), find: executeFind, observe: executeObserve };
export async function runEnsureApp(args: Record<string, any>, tcx: ToolContext, pctx: ExtensionContext, discovery = nativeDiscovery): Promise<string> {
  if (process.platform !== 'darwin') {
    return 'ensure_app (background launch) is macOS-only. On other platforms, launch the app yourself, then use observe_ui.';
  }
  let bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : '';
  const app = typeof args.app === 'string' ? args.app.trim() : '';
  if (!bundleId && !app) return 'ensure_app requires "app" or "bundleId".';
  const foregroundRoot = args.foregroundRoot;
  if (foregroundRoot !== undefined && (typeof foregroundRoot !== 'string' || !/^@r\d+$/.test(foregroundRoot))) return 'Choose an exact window root returned by discovery.';
  if (foregroundRoot && (!tcx.runId || !pctx.foregroundAllowed)) return 'Foreground access is unavailable for this run.';
  const mode = args.mode ?? 'visual';
  if (!['visual', 'pixels', 'roots'].includes(mode)) throw new Error('Choose visual, pixels, or roots.');
  const absolute = app.startsWith('/');
  if (absolute && bundleId) return 'Choose one app path or one bundleId.';
  let pathPids = absolute ? await macAppPathPids(app, tcx.signal) : [];
  const appName = app.replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '');
  const apps = () => discovery.listApps(tcx.signal);
  const running = await apps();
  const byName = running.filter(a => a.appName.toLowerCase() === appName.toLowerCase());
  if (!bundleId && !app.startsWith('/') && new Set(byName.map(a => a.bundleId)).size > 1)
    return 'Several running apps have that name. Choose a bundleId: ' + byName.map(a => a.bundleId).join(', ');
  if (!bundleId && (!byName.length || app.startsWith('/'))) {
    const matches = await macAppIdentifiers(app, tcx.signal).catch(() => {
      tcx.signal?.throwIfAborted();
      return [];
    });
    if (matches.length > 1) return 'Several installed apps have that name. Choose a bundleId: ' + matches.join(', ');
    bundleId = matches[0] ?? '';
  }
  if (pathPids.length > 1) return 'Several processes use that app path. Choose a window with find_roots.';
  const mine = (a: { appName: string; bundleId?: string; pid: number }) => absolute ? pathPids.includes(a.pid) : bundleId ? a.bundleId === bundleId : a.appName.toLowerCase() === appName.toLowerCase();
  let wasRunning = running.some(mine);
  if (!bundleId && !wasRunning && !app.startsWith('/')) {
    // Some running bundles expose an executable name while the user knows the
    // window title. A title alone is insufficient to identify its owner.
    const nameTokens = (name: string) => name.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[\s._-]+/);
    const namedOwners = running.filter(a => nameTokens(a.appName).includes(app.toLowerCase()));
    // A title-only WindowServer query misses windows on other Spaces. Verify the window title inside a unique potential owner.
    const query = namedOwners.length === 1 ? { pid: namedOwners[0].pid } : { text: app, kind: 'window' as const };
    const candidates = await discovery.find('', query, tcx.signal, undefined, pctx);
    const exact = candidates.details.windows.filter(w => w.windowTitle.localeCompare(app, undefined, { sensitivity: 'accent' }) === 0);
    const owners = new Set(exact.map(w => w.bundleId));
    const ownerNames = exact[0] ? nameTokens(exact[0].app) : [];
    if (owners.size === 1 && exact[0]?.bundleId && ownerNames.includes(app.toLowerCase())) {
      bundleId = exact[0].bundleId;
      wasRunning = true;
    } else if (exact.length) {
      return 'Matching window titles were found under other app names. Choose the intended owner before acting.\n' +
        exact.map(w => `${w.windowRef} ${w.app} (${w.bundleId || w.pid})`).join('\n');
    }
  }
  const name = bundleId || app;
  const lockedMessage = `[screen_locked] macOS is locked and ${name} has no observable window. Stop this desktop task and tell the user to unlock their Mac. Wait for their reply before any further tool calls.`;
  // -g:启动但不置前台。execFile 传 argv(非 shell),bundleId/app 作单参无注入。
  const openInBackground = () => execFileP('open', ['-g', ...(bundleId && !absolute ? ['-b', bundleId] : ['-a', app])], { timeout: 8000, signal: tcx.signal });
  const strict = loadComputerUseConfig(pctx.cwd).config.headless;
  // 查找已运行的 App 时不重复发送 open 事件，有的 App 收到它会自己跳到前台。
  if (foregroundRoot && (strict || !wasRunning)) return 'The requested window cannot be raised in this run.';
  if (!wasRunning) {
    if (await discovery.screenLocked(tcx.signal)) return lockedMessage;
    if (absolute && running.some(a => bundleId && a.bundleId === bundleId)) return 'Another installed copy is running. Open the requested copy manually and retry with its path.';
    if (strict) return `${name} is not running. Strict background is enabled; ask the user to open it before observing.`;
    try {
      await openInBackground();
    } catch (e: any) {
      return `Could not launch ${name}: ${e?.stderr?.toString().trim() || e?.message || e}. Check the app/bundleId is installed.`;
    }
  }
  const started = Date.now();
  let captureLost = false;
  let launchSignalled = false;
  while (Date.now() - started < 12_000) {
    if (tcx.signal?.aborted) return 'ensure_app aborted.';
    if (absolute && !pathPids.length) pathPids = await macAppPathPids(app, tcx.signal);
    if (!wasRunning && !launchSignalled && tcx.runId && Date.now() - started < 2000) {
      const launched = (await apps()).find(a => mine(a) && a.isFrontmost);
      if (launched) {
        launchSignalled = await reportLaunchForeground(launched.pid);
      }
    }
    const found = !absolute || pathPids.length === 1 ? await spec_executeFind(pctx, tcx, appName, bundleId, discovery.find, pathPids[0]) : undefined;
    // 查找本身失败(helper 没应答)不说明窗口在哪,不据此升级到激活。
    if (found) {
      if (foregroundRoot) {
        const window = found.windows.find(w => w.windowRef === foregroundRoot);
        if (!window?.windowId) return 'Window unavailable. Stop the blocked step.';
        const target = { pid: window.pid, windowId: window.windowId };
        const receipt = clickReceipt(target);
        if (receipt) {
          if (!receipt.verifiedWindow) return 'Original window identity unavailable. Stop the blocked step.';
          if (receipt.phase === 'blocked' || receipt.phase === 'sent') throw recoveryExhausted('Recovery was already attempted. No further input was sent. Report the blocked step.');
          if (receipt.phase !== 'background') return 'The window is already being recovered. Inspect the latest screenshot before acting.';
          receipt.phase = 'raising';
          try {
            const raised = await discovery.activate?.({ ...target, recoverBackgroundClick: true }, tcx.signal);
            if (!raised) return 'macOS could not focus this exact window. Stop the blocked step. No click was replayed.';
            // During a Space transition AX can withdraw the old root before publishing the visible one.
            // Retry only the observation, on this pid/windowId, while the target still owns the foreground.
            const until = Date.now() + 2_000;
            do {
              tcx.signal?.throwIfAborted();
              if (!(await apps()).some(a => a.pid === target.pid && a.isFrontmost)) return 'Foreground changed during recovery. Stop the blocked step. No click was replayed.';
              try {
                const image = await discovery.observe('', { root: foregroundRoot, mode: 'pixels' }, tcx.signal, undefined, pctx);
                if (!('target' in image.details) || image.details.target.pid !== target.pid || image.details.target.windowId !== target.windowId) return 'The recovered window changed. Stop the blocked step.';
                const seen = render(image, tcx);
                if (seen.startsWith('Screenshot unavailable')) return 'Screenshot unavailable after recovery. Stop the blocked step.';
                receipt.freshCapture = image.details.capture;
                receipt.phase = 'foreground';
                return `[foreground] Mini recovery brought ${name} forward. Inspect the new image before clicking. Once the task result is visible, finish your reply. Desktop handles returning to the original chat automatically, including its Space. Do not locate or click the chat to return.\n${seen}`;
              } catch (error) {
                tcx.signal?.throwIfAborted();
                if (!/stale|no longer available|root_not_found|window_not_found/i.test(String(error))) throw error;
              }
              await sleep(120);
            } while (Date.now() < until);
            return 'The recovered window did not provide a fresh screenshot. Stop the blocked step. No click was replayed.';
          } finally { if (receipt.phase === 'raising') receipt.phase = 'blocked'; }
        }
        if (!window.isOnscreen) return 'This off-Space window must be tried in the background first.';
        const raised = await discovery.activate?.({ pid: window.pid, windowId: window.windowId }, tcx.signal);
        return raised ? `[foreground] Brought ${name} ${foregroundRoot} forward.` : 'The requested window could not be brought forward on this desktop.';
      }
      if (found.windows.length) {
        const running = await apps();
        const fm = running.find((a) => a.isFrontmost);
        // 给的名字对不上任何在跑的 App(本地化名、别名)时,退而看前台 App 是不是找到的窗口的主人。
        const front = !!fm && (running.some(mine) ? mine(fm) : found.windows.some(w => w.pid === fm.pid));
        const how = !front ? `Observed ${name} in the background; it did not take the foreground.`
          : `${name} is currently the foreground app.`;
        const roots = `${how}\n${found.text}`;
        if (mode === 'roots' || found.windows.length !== 1) return roots;
        if ('windowId' in found.windows[0] && !found.windows[0].windowId) return roots + '\nThis accessibility root has no separate screenshot. Use observe_ui with semantic mode.';
        const root = found.windows[0].windowRef;
        let image;
        try {
          image = await discovery.observe('', { root, mode }, tcx.signal, undefined, pctx);
        } catch (error) {
          const code = (error as { code?: string })?.code;
          if (!/root ref .* stale|controlled window is no longer available|window_not_found|root_not_found/i.test(String(code) + ' ' + String(error))) throw error;
          captureLost = true;
          await sleep(250);
          continue;
        }
        const summary = found.text.slice(found.text.indexOf('\n') + 1);
        const seen = render(image, tcx);
        const next = pctx.jevEnabled && !seen.startsWith('Screenshot unavailable') ? `\nNext native action: call jev_ui with root ${root} and the visible target names. Use double_click to open a list item.` : '';
        return `${how}\n${summary}\n${seen}${next}`;
      }
      if (wasRunning && Date.now() - started > 1500) {
        if (await discovery.screenLocked(tcx.signal)) return lockedMessage;
        return `${name} is running but has no observable window. Leave it in its Space. Ask the user to show a window and wait for their reply before trying again.`;
      }
    }
    await sleep(400);
  }
  if (await discovery.screenLocked(tcx.signal)) return lockedMessage;
  return `${captureLost ? 'The window changed during capture' : 'No observable window yet'} for ${name}. Retry ensure_app with the same app identity.`;
}

/** Exact app identities keep the first captured window tied to the requested application. */
async function spec_executeFind(pctx: ExtensionContext, tcx: ToolContext, app: string, bundleId: string, find: typeof executeFind, pid?: number): Promise<{ text: string; windows: { pid: number; windowRef: string; windowId?: number; isOnscreen?: boolean }[] } | undefined> {
  try {
    const params = pid ? { pid } : bundleId ? { bundleId } : { app };
    const r = await find('', params, tcx.signal, undefined, pctx);
    const windows = (r.details as { windows?: Array<{ pid: number; windowRef: string; windowId?: number; isOnscreen?: boolean }> } | undefined)?.windows ?? [];
    // 不走 render:那边会在「没有 root」时附一句「去调 ensure_app」,而这里就是 ensure_app 自己。
    return { text: r.content.map((block) => block.type === 'text' ? block.text : '').join('\n') + selfWindowNote(r.details), windows };
  } catch {
    return undefined;
  }
}

async function legacyBrowserUrl(raw: string): Promise<string> {
  if (!['1','true','yes','on'].includes((process.env.TANGU_BROWSER_ALLOW_PRIVATE_URLS ?? '').toLowerCase())) return (await assertPublicHttpUrl(raw)).href;
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP(S) URLs are allowed.');
  return url.href;
}

function bindScreenshotArgs(tool: 'act_ui' | 'observe_ui', args: Record<string, any>, owner: string, compact: boolean): Record<string, any> {
  const byView = args.view !== undefined;
  if (!compact && (byView || args.click !== undefined || args.region !== undefined)) throw new Error('Compact screenshot controls are disabled. Use stateId and actions to click.');
  if (byView && args.stateId !== undefined) throw new Error('Supply one screenshot view or stateId.');
  if (tool === 'act_ui' && !byView && args.click === undefined && args.hover === undefined) {
    if (typeof args.stateId !== 'string' || !Array.isArray(args.actions)) throw new Error('Supply a screenshot and click:[x,y], or stateId and actions.');
    return args;
  }
  const id = byView ? args.view : args.stateId;
  if (tool === 'observe_ui' && id === undefined) return args;
  const binding = typeof id === 'string' && pixelBinding(id.trim(), owner, byView);
  if (!binding) {
    if (byView || tool === 'act_ui') throw new Error('Screenshot expired or unavailable. Observe the browser again.');
    return args;
  }
  if (tool === 'act_ui') {
    const idKey = byView ? 'view' : 'stateId';
    const kind = args.hover !== undefined ? 'hover' : 'click';
    const xy = args[kind];
    if (Object.keys(args).some(key => key !== idKey && key !== kind) || !Array.isArray(xy) || xy.length !== 2
      || !xy.every(n => Number.isSafeInteger(n) && n >= 0)) {
      throw new Error(`A screenshot ${kind} takes only its view or stateId and ${kind}:[x,y] in whole pixels.`);
    }
    return { stateId: binding.stateId, actions: [{ action: kind === 'hover' ? 'moveMouse' : 'click', x: xy[0], y: xy[1] }] };
  }
  if (args.root !== undefined && args.root !== binding.root) throw new Error('Use the screenshot belonging to this browser root.');
  if (args.mode !== undefined && args.mode !== 'pixels') throw new Error('Screenshot-only state requires pixels mode.');
  if (binding.detail && (args.magnify !== undefined || args.samplePixels !== undefined)) {
    throw new Error('Magnify and samplePixels use full-image coordinates. Observe the full screenshot first.');
  }
  const { view: _view, ...rest } = args;
  return { ...rest, root: binding.root, stateId: binding.stateId, mode: 'pixels' };
}

export function buildToolProvider(store: PluginStore, validateUrl = legacyBrowserUrl): ToolProvider {
  const browserMode = () => {
    const settings = store.getScopeSettings(PLUGIN_ID, 'global');
    if (settings.browser_use === false) return 'standard';
    if (settings.browser_panel_zoom === true) return 'panels';
    return settings.compact_browser_controls === true ? 'compact' : 'standard';
  };
  const gate = (spec: ToolSpec) => (profile: AppProfile): boolean =>
    !!profile.capabilities.hostExec
    && store.isPluginEnabledSync(PLUGIN_ID)
    && isSupportedPlatform()
    && (!spec.darwinOnly || process.platform === 'darwin')
    && (!spec.jevOnly || store.getScopeSettings(PLUGIN_ID, 'global').jev_enabled === true)
    // 直接读设置,不读 vendor 的配置对象:后者要等这个进程里调过一次工具才同步,在那之前「浏览器工具」关了也照样列出来。
    && (!spec.browserOnly || store.getScopeSettings(PLUGIN_ID, 'global').browser_use !== false);

  const toTool = (spec: ToolSpec): ToolDef => ({
    name: spec.name,
    mode: 'host',
    isEnabledFor: gate(spec),
    capabilities: { sideEffect: spec.sideEffect, parallel: false, concurrencyKey: 'computer-use', defaultTimeoutMs: spec.timeoutMs, approval: spec.approval },
    definition: { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } },
    // 叠层(helper 协议 20):这次调用里发出的每条 act / actBatch 都带这一轮的 runId(AsyncLocalStorage,见 overlayState.ts);
    // 这一轮被中止时尽力发一次 overlayTurn end(工具自己超时不算;返回时摘掉监听)。工具说明和结果文字不受影响。
    execute: (args: Record<string, any>, tcx: ToolContext): Promise<string> => withOverlayRun(tcx.runId, async (): Promise<string> => {
      const unwatch = watchRunAbort(tcx.runId, tcx.signal, undefined, undefined, { timeoutMs: spec.timeoutMs });
      try { return await (async (): Promise<string> => {
      if (spec.jevOnly) {
        if (!gate(spec)({ capabilities: { hostExec: tcx.execMode !== 'sandbox' } } as AppProfile)) return 'Jev is disabled or unavailable on this platform.';
        parseJevArgs(args);
      }
      syncSettings(store);
      const pctx = makePiCtx(tcx, false);
      pctx.jevEnabled = store.getScopeSettings(PLUGIN_ID, 'global').jev_enabled === true;
      const strict = loadComputerUseConfig(pctx.cwd).config.headless;
      pctx.foregroundAllowed = !strict && spec.approval === 'command';
      const mode = browserMode();
      pctx.compactBrowserControls = mode !== 'standard';
      pctx.browserPanelZoom = mode === 'panels';
      if (args.hover !== undefined && spec.name === 'act_ui' && !pctx.browserPanelZoom) throw new Error('Screenshot hover requires browser panel zoom.');
      if (args.region !== undefined && spec.name === 'observe_ui' && !pctx.browserPanelZoom) throw new Error('Browser panel zoom is disabled.');
      if ((spec.name === 'launch_browser' || spec.name === 'navigate_browser') && typeof args.url === 'string' && args.url.trim()) {
        args = { ...args, url: await validateUrl(args.url.trim()) };
      }
      if (spec.name === 'act_ui' || spec.name === 'observe_ui') {
        args = bindScreenshotArgs(spec.name, args, pctx.browserOwner!, pctx.compactBrowserControls);
      }
      const inspectPixels = spec.name === 'observe_ui' && (args.samplePixels !== undefined || args.magnify !== undefined);
      if (spec.name === 'observe_ui' && args.region !== undefined && (!browserRegions.includes(args.region) || args.focus !== undefined)) {
        throw new Error('Choose a named region or a focus point, one at a time.');
      }
      if (spec.name === 'observe_ui' && (args.focus !== undefined || args.region !== undefined)) {
        if (typeof args.root !== 'string' || toolSurface(spec.name, args) !== 'browser' || typeof args.stateId !== 'string' || !args.stateId.trim()
          || inspectPixels || (args.mode !== undefined && args.mode !== 'pixels')) {
          throw new Error('Focus requires one browser root and its full screenshot stateId in pixels mode, without magnify or samplePixels.');
        }
        args = { ...args, mode: 'pixels' };
      }
      if (inspectPixels) {
        if (typeof args.root !== 'string' || !/^@r\d+$/.test(args.root) || (args.mode && args.mode !== 'pixels')) throw new Error('Use an exact root and pixels mode for screenshot details.');
        args = { ...args, mode: 'pixels' };
      }
      let installNote;
      if (toolSurface(spec.name, args) === "desktop") {
        installNote = await ensureHelperCurrent(tcx.signal);
        try {
          await ensureComputerUseSetup(pctx, tcx.signal);
        } catch (e: any) {
          // 权限是系统安全设置,只能用户自己拨 —— 但可以替他把 App 登记好、把面板打开。
          const guidance = await guideMissingPermissions(tcx.signal);
          // ⚠️只有「自动安装本身失败了」才该提终端命令。就绪失败的原因多得很(Linux 缺 AT-SPI、
          // 架构不符、daemon 起不来……),对这些 case 说「去跑 setup」是把模型引到错的方向上,
          // 而真正的原因反而被这句话盖住了。
          const fallback = autoInstallFailed()
            ? `Computer Use is not ready: ${e?.message || e}\nAutomatic helper installation failed — run \`tangu computer-use setup\` in a terminal to see why.`
            : `Computer Use is not ready: ${e?.message || e}`;
          return [installNote, guidance ?? fallback].filter(Boolean).join('\n');
        }
      }
      // 装/升级过就在结果里说一句 —— 用户装了什么、agent 替他做了什么,不该是暗箱。
      const prefix = installNote ? `${installNote}\n` : '';
      if (spec.run) return prefix + presentLiveViewOnce(spec.name, tcx, await spec.run(args, tcx, pctx, store));
      let result: AgentToolResult;
      try {
        result = await spec.exec!('', args, tcx.signal, undefined, pctx);
      } catch (e: any) {
        explainGone(e, args);
        throw e;
      }
      let detail: ReturnType<typeof inspectScreenshot> | undefined;
      if (inspectPixels) {
        const screen = result.content.find(block => block.type === 'image');
        if (!screen) throw new Error('The target supplied no screenshot to inspect.');
        detail = inspectScreenshot(screen, args);
      }
      let text = render(result, tcx, args);
      if (detail?.text) text += '\n' + detail.text;
      if (detail?.crop) {
        const queued = tcx.collectImage && tcx.collectImage({url:'data:image/png;base64,' + detail.crop,name:'detail-2x.png'});
        text += '\n' + (!tcx.collectImage || queued === false
          ? 'Magnified detail omitted by the image collector. Request it in a new model round.'
          : detail.detailDescription);
      }
      return prefix + presentLiveViewOnce(spec.name, tcx, text);
      })(); } finally { unwatch(); }
    }),
  });

  const specs = { standard: toolSpecs(false), compact: toolSpecs(true), panels: toolSpecs(true, true) };
  return { id: 'plugin:computer-use', tools: () => specs[browserMode()].map(toTool) };
}
