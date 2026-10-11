/**
 * 上游 pi 的 11 个 defineTool + 自研 ensure_app → Tangu 的 12 个 ToolDef。翻译要点:
 *   - parameters:上游 typebox schema 手翻成纯 JSON Schema 字面量(零依赖,不引 typebox)。
 *   - execute 签名:pi 的 (toolCallId, params, signal, onUpdate, ctx) → Tangu 的 (args, ctx)。
 *   - 结果:AgentToolResult.content 的 text block 拼成返回 string;image block(observe 截图)→ ctx.collectImage(回灌模型)。
 *   - 门禁:host + hostExec + 插件启用 + macOS(stickers 同款);浏览器三工具再叠 browser_use 设置。
 *   - 审批:动作类(act_ui/launch/navigate/evaluate_browser)声明 approval:'command'(与 run_bash 同档);观察类免审。
 *   - setup:每次工具执行前惰性 ensureComputerUseSetup(hasUI=false)→ 权限缺时 vendor 抛 nonInteractiveError,
 *     被 catch 成指导文本返回给模型(提示跑 `tangu computer-use setup`)。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ToolDef, ToolProvider, ToolContext, AppProfile, PluginStore } from '@forsion/tangu-agent';
import type { ExtensionContext, AgentToolResult } from './pi-compat.ts';
import {
  executeFind, executeObserve, executeSearchUi, executeExpandUi, executeInspectUi,
  executeAct, executeReadText, executeWaitFor, executeLaunchBrowser, executeNavigateBrowser,
  executeEvaluateBrowser, ensureComputerUseSetup,
} from './vendor/bridge.ts';
import { getComputerUseConfig } from './vendor/config.ts';
import { currentPlatformBackend } from './vendor/platform/index.ts';
import { isSupportedPlatform } from './helperState.ts';
import { autoInstallFailed, ensureHelperCurrent, guideMissingPermissions } from './onboarding.ts';
import { expectNote, foregroundNote, goneHint, imageNote, noRootsHint, scrollNote, selfWindowNote } from './foregroundNote.ts';

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
  x: N('Pixels from the left edge of the latest screenshot of this state (its size is on the [image] line of the result that attached it), not screen or window-frame coordinates'),
  y: N('Pixels from the top edge of that same screenshot'),
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
  run?: (args: Record<string, any>, tcx: ToolContext, pctx: ExtensionContext) => Promise<string>;
  sideEffect: 'read' | 'system' | 'browser';
  approval?: 'command';
  browserOnly?: boolean;
  darwinOnly?: boolean;
  timeoutMs: number;
}

const SPECS: ToolSpec[] = [
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
    description: 'Capture the current/frontmost root or one exact @r root and return a bounded UI outline. Use mode=semantic to skip OCR and images, visual to force them, fused for automatic selection. Primary UI observation tool; follow with search_ui/expand_ui/inspect_ui/act_ui. Use @e outline refs from observe_ui/search_ui for act_ui; pictureOnly refs are coordinate-only.',
    parameters: obj({
      root: S('Exact @r ref issued by find_roots'),
      mode: { type: 'string', enum: ['semantic', 'visual', 'fused'], description: 'Observation mode, default fused' },
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
    description: 'Perform one or more precisely targeted checked actions and return the successor state. Pass dependent click/type steps together and use expect for observable completion instead of a separate observe_ui call. expect reads accessibility text only, never the pixels: on a window whose outline has almost no text it will rarely match, so prefer leaving it out there and judging from the attached screenshot. Coordinates (x / y, drag path) are pixels in the latest attached screenshot, whose size the result states on an [image] line. After clicking an editable region in the same call, omit ref from typeText/keypress so input follows that focus; a later call can omit ref only while the target window is still frontmost, otherwise click again first. To fill a text field prefer a single setText action — it writes the value in the background without taking focus; only click the field first (which takes the foreground) if setText reports it did not take, as happens on some web/Electron inputs. When any action takes the foreground the result says so on a [foreground] line. For strict background-only runs, turn on the plugin\'s "strict background" setting.',
    parameters: obj({
      stateId,
      expect: obj(conditionProps),
      actions: { type: 'array', items: uiAction, minItems: 1, maxItems: 20 },
    }, ['stateId', 'actions']),
  },
  {
    name: 'ensure_app', run: runEnsureApp, sideEffect: 'system', darwinOnly: true, timeoutMs: 25_000,
    description: 'Make sure a desktop app is running and observable, then return its UI roots. Use this before observe_ui when the target app may not be running yet (observe_ui only sees already-running apps), and to bring back a window that find_roots / act_ui can no longer see because it is on another desktop (Space) or hidden. Opens by bundleId (preferred) or app name in the background first; the app is brought to the foreground only when it is already running and none of its windows is on the current desktop (never under the strict background setting). The result says whether the app ended up in the foreground. macOS only.',
    parameters: obj({
      app: S('App name, e.g. "TextEdit"'),
      bundleId: S('Bundle id, e.g. "com.apple.TextEdit" (preferred — unambiguous)'),
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
    description: 'Launch the configured Tangu-managed CDP browser and return an observed browser-page state. Use for browser work that needs a managed CDP context. Prefer curl through bash when the page is directly fetchable. Which browser starts is a plugin setting, not a parameter.',
    parameters: obj({ url: S('Initial URL', 8192) }),
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
      tcx.collectImage({ url: `data:${block.mimeType || 'image/jpeg'};base64,${block.data}`, name: 'screen.jpg' });
      attached = true;
    }
  }
  const body = parts.join('\n') || '(no output)';
  const details = (result as { details?: { execution?: unknown; target?: { app?: string; bundleId?: string }; capture?: { stateId?: string } } }).details;
  const stateId = details?.capture?.stateId;
  if (stateId && (details?.target?.app || details?.target?.bundleId)) {
    targets.set(stateId, { app: details.target.app, bundleId: details.target.bundleId });
    if (targets.size > 64) targets.delete(targets.keys().next().value!);
  }
  return body + imageNote(details, attached) + expectNote(details) + scrollNote(args?.actions, details?.execution) + foregroundNote(details?.execution) + selfWindowNote(details) + noRootsHint(details);
}

/** ensure_app:后台启动目标 app(open -g)+ 轮询 find_roots 直到有可观察窗口,回其 roots。
 *  已经在跑却列不出窗口(窗口在别的桌面,或被收起来不显示)时后台那一下不管用,只能激活它 —— 屏幕会切到它那个桌面。
 *  结果里如实说它最后在不在前台:微信这类 App 收到重新打开事件会自己跳到前台,「后台启动」对它不成立(反馈 55b984eb)。
 *  严格后台模式下不激活,改为说明原因。
 *  导出(连同 render / explainGone)只为真机仪器 scripts/vision-only.check.mjs 能直接调:走 execute 会顺带触发
 *  helper 的自动更新检查,开发检出里那份 helper 和装着的不是同一个签名,会把用户授过权的 helper 换掉。 */
export async function runEnsureApp(args: Record<string, any>, tcx: ToolContext, pctx: ExtensionContext): Promise<string> {
  if (process.platform !== 'darwin') {
    return 'ensure_app (background launch) is macOS-only. On other platforms, launch the app yourself, then use observe_ui.';
  }
  const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : '';
  const app = typeof args.app === 'string' ? args.app.trim() : '';
  if (!bundleId && !app) return 'ensure_app requires "app" or "bundleId".';
  const name = bundleId || app;
  // app 可以是名字,也可以是「WeChat.app」或一条路径(open -a 都认),比对时只取名字那一段。
  const appName = app.replace(/\/+$/, '').split('/').pop()!.replace(/\.app$/i, '');
  const mine = (a: { appName: string; bundleId?: string }) => bundleId ? a.bundleId === bundleId : a.appName.toLowerCase() === appName.toLowerCase();
  const apps = () => currentPlatformBackend.listApps(tcx.signal).catch(() => []);
  const wasRunning = (await apps()).some(mine);
  // -g:启动但不置前台。execFile 传 argv(非 shell),bundleId/app 作单参无注入。
  const open = (background: boolean) => execFileP('open', [...(background ? ['-g'] : []), ...(bundleId ? ['-b', bundleId] : ['-a', app])], { timeout: 8_000 });
  const strict = getComputerUseConfig().headless === true;
  // 严格后台下不去「重新打开」一个已经在跑的 App:微信这类收到这个事件会自己跳到前台。只找它现有的窗口。
  if (!(strict && wasRunning)) {
    try {
      await open(true);
    } catch (e: any) {
      // 已经在跑的 App 按这个名字打不开(从没登记过的位置启动的)不要紧:接着找它的窗口就是了。
      if (!wasRunning) return `Could not launch ${name}: ${e?.stderr?.toString().trim() || e?.message || e}. Check the app/bundleId is installed.`;
    }
  }
  const started = Date.now();
  let activated = false;
  let triedActivating = false;
  let last = '';
  while (Date.now() - started < 12_000) {
    if (tcx.signal?.aborted) return 'ensure_app aborted.';
    const found = await spec_executeFind(pctx, tcx, appName, bundleId);
    // 查找本身失败(helper 没应答)不说明窗口在哪,不据此升级到激活。
    if (found) {
      last = found.text;
      if (/@r\d/.test(found.text)) {
        const running = await apps();
        const fm = running.find((a) => a.isFrontmost);
        // 给的名字对不上任何在跑的 App(本地化名、别名)时,退而看前台 App 是不是找到的窗口的主人。
        const front = !!fm && (running.some(mine) ? mine(fm) : found.pids.includes(fm.pid));
        const how = !front ? `Opened ${name} in the background; it did not take the foreground.`
          : activated ? `${name} was running with no window on the current desktop (on another desktop, or hidden), so it was brought to the foreground; the screen may have switched to its desktop.`
          : `Opened ${name}; it is now the foreground app (some apps come forward on their own even when opened in the background).`;
        return `${how}\n${found.text}`;
      }
      // ponytail:只对「本来就在跑」的 App 升级到激活;冷启动的窗口晚几秒才出来是常事,不该因此抢前台。
      // 「本来就在跑」按名字 / bundleId 认,名字对不上(本地化名、别名)就不升级,退回原来的「等满 12 秒」。
      if (wasRunning && !triedActivating && Date.now() - started > (strict ? 0 : 1_500)) {
        if (strict) {
          return `${name} is running but has no window on the current desktop (it is on another desktop, or hidden). Bringing it back means taking the foreground, which the strict background setting forbids. Ask the user to switch to ${name} themselves, or to turn strict background off.`;
        }
        if (tcx.signal?.aborted) return 'ensure_app aborted.';
        triedActivating = true;
        activated = await open(false).then(() => true, () => false);
      }
    }
    await sleep(400);
  }
  const took = activated ? ' It was activated (the foreground was taken and the screen may have switched to its desktop), and it still shows no window.' : '';
  return `Opened ${name}, but no window is observable yet.${took} Give it a moment and call observe_ui.\n${last}`;
}

/** 内部:调 vendor executeFind 并渲染(供 ensure_app 轮询)。
 *  bundleId 是精确匹配,有就用它;只有 app 名时走 **text**(排序匹配)而不是 `app` ——
 *  v0.5.0 起 `app` 是「精确的规范化 app 名」,用户随口给的 "TextEdit" 未必对得上,
 *  精确匹配落空会让 ensure_app 白等满 12 秒再报「没有可观察窗口」。 */
async function spec_executeFind(pctx: ExtensionContext, tcx: ToolContext, app: string, bundleId: string): Promise<{ text: string; pids: number[] } | undefined> {
  try {
    const params = bundleId ? { bundleId } : { text: app };
    const r = await executeFind('', params, tcx.signal, undefined, pctx);
    const windows = (r.details as { windows?: Array<{ pid?: number }> } | undefined)?.windows ?? [];
    // 不走 render:那边会在「没有 root」时附一句「去调 ensure_app」,而这里就是 ensure_app 自己。
    return { text: r.content.map((block) => block.type === 'text' ? block.text : '').join('\n') + selfWindowNote(r.details), pids: windows.map((w) => Number(w.pid)) };
  } catch {
    return undefined;
  }
}

export function buildToolProvider(store: PluginStore): ToolProvider {
  const gate = (spec: ToolSpec) => (profile: AppProfile): boolean =>
    !!profile.capabilities.hostExec
    && store.isPluginEnabledSync(PLUGIN_ID)
    && isSupportedPlatform()
    && (!spec.darwinOnly || process.platform === 'darwin')
    && (!spec.browserOnly || getComputerUseConfig().browser_use !== false);

  const toTool = (spec: ToolSpec): ToolDef => ({
    name: spec.name,
    mode: 'host',
    isEnabledFor: gate(spec),
    capabilities: { sideEffect: spec.sideEffect, parallel: false, concurrencyKey: 'computer-use', defaultTimeoutMs: spec.timeoutMs, approval: spec.approval },
    definition: { type: 'function', function: { name: spec.name, description: spec.description, parameters: spec.parameters } },
    execute: async (args: Record<string, any>, tcx: ToolContext): Promise<string> => {
      syncSettings(store);
      // ⚠️这里**绝不能**再加「没装就 return 指导文本」的早退:vendor 的 ensureInstalled() 本来就会
      // 自动跑 setup-helper.mjs,早退等于把上游的自动安装堵死(用户报的「首次安装还要敲命令」就是它)。
      // 我们只补上游缺的那半:装着的二进制比 bundle 老时也要重装。
      const installNote = await ensureHelperCurrent(tcx.signal);
      const pctx = makePiCtx(tcx, false);
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
      // 装/升级过就在结果里说一句 —— 用户装了什么、agent 替他做了什么,不该是暗箱。
      const prefix = installNote ? `${installNote}\n` : '';
      if (spec.run) return prefix + await spec.run(args, tcx, pctx);
      let result: AgentToolResult;
      try {
        result = await spec.exec!('', args, tcx.signal, undefined, pctx);
      } catch (e: any) {
        explainGone(e, args);
        throw e;
      }
      return prefix + render(result, tcx, args);
    },
  });

  return { id: 'plugin:computer-use', tools: () => SPECS.map(toTool) };
}
