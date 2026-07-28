/**
 * 上游 pi 的 11 个 defineTool → Tangu 的 ToolDef[]。翻译要点:
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
import { helperInstalled, isSupportedPlatform } from './helperState.ts';
import { foregroundNote } from './foregroundNote.ts';

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
const point = { x: { type: 'number' }, y: { type: 'number' } };

// act_ui 的 actions:上游 uiAction union(8 变体)→ anyOf
const uiAction = {
  anyOf: [
    obj({ action: { const: 'press' }, ref: S('Actionable outline ref') }, ['action', 'ref']),
    obj({ action: { const: 'click' }, ref: S('Actionable outline ref'), button: mouseButton, clickCount }, ['action', 'ref']),
    obj({ action: { const: 'click' }, ...point, button: mouseButton, clickCount }, ['action', 'x', 'y']),
    obj({ action: { const: 'setText' }, ref: S('Editable outline ref'), text: { type: 'string' } }, ['action', 'ref', 'text']),
    obj({ action: { const: 'typeText' }, ref: S('Omit after a click to type into the focus established by that click'), text: { type: 'string' } }, ['action', 'text']),
    obj({ action: { const: 'keypress' }, ref: S('Omit to send keys to the focused control'), keys: { type: 'array', items: { type: 'string' }, minItems: 1 } }, ['action', 'keys']),
    obj({ action: { const: 'scroll' }, ref: S('Outline ref to scroll'), scrollX: { type: 'number' }, scrollY: { type: 'number' } }, ['action']),
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
    description: 'Perform one or more precisely targeted checked actions and return the successor state. Pass dependent click/type steps together and use expect for observable completion instead of a separate observe_ui call. After clicking an editable region, omit ref from typeText/keypress so input follows the established focus. To fill a text field prefer a single setText action — it writes the value in the background without taking focus; only click the field first (which takes the foreground) if setText reports it did not take, as happens on some web/Electron inputs. When any action takes the foreground the result says so on a [foreground] line. For strict background-only runs, turn on the plugin\'s "strict background" setting.',
    parameters: obj({
      stateId,
      expect: obj(conditionProps),
      actions: { type: 'array', items: uiAction, minItems: 1, maxItems: 20 },
    }, ['stateId', 'actions']),
  },
  {
    name: 'ensure_app', run: runEnsureApp, sideEffect: 'system', darwinOnly: true, timeoutMs: 25_000,
    description: 'Make sure a desktop app is running and observable WITHOUT bringing it to the foreground, then return its UI roots. Use this before observe_ui when the target app may not be running yet (observe_ui only sees already-running apps). Background-launches by bundleId (preferred) or app name and waits until a window is observable. macOS only.',
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

/** 把 pluginStore 的设置就地注入 vendor 的 activeConfig(getComputerUseConfig 返回其引用)。 */
export function syncSettings(store: PluginStore): void {
  const s = store.getScopeSettings(PLUGIN_ID, 'global');
  const cfg = getComputerUseConfig();
  if (typeof s.browser_use === 'boolean') cfg.browser_use = s.browser_use;
  if (typeof s.headless === 'boolean') cfg.headless = s.headless;
  if (typeof s.cursor_overlay === 'boolean') cfg.cursor_overlay = s.cursor_overlay;
  if (s.managed_browser === 'chrome' || s.managed_browser === 'helium') cfg.managed_browser = s.managed_browser;
}

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

/** AgentToolResult → 返回给模型的 string;image block(截图)经 collectImage 回灌;末尾附前台透明化提示。 */
function render(result: AgentToolResult, tcx: ToolContext): string {
  const parts: string[] = [];
  for (const block of result.content) {
    if (block.type === 'text') parts.push(block.text);
    else if (block.type === 'image' && tcx.collectImage) {
      tcx.collectImage({ url: `data:${block.mimeType || 'image/jpeg'};base64,${block.data}`, name: 'screen.jpg' });
    }
  }
  const body = parts.join('\n') || '(no output)';
  return body + foregroundNote((result as { details?: { execution?: unknown } }).details?.execution);
}

/** ensure_app:后台启动目标 app(open -g,不抢前台)+ 轮询 find_roots 直到有可观察窗口,回其 roots。 */
async function runEnsureApp(args: Record<string, any>, tcx: ToolContext, pctx: ExtensionContext): Promise<string> {
  if (process.platform !== 'darwin') {
    return 'ensure_app (background launch) is macOS-only. On other platforms, launch the app yourself, then use observe_ui.';
  }
  const bundleId = typeof args.bundleId === 'string' ? args.bundleId.trim() : '';
  const app = typeof args.app === 'string' ? args.app.trim() : '';
  if (!bundleId && !app) return 'ensure_app requires "app" or "bundleId".';
  // -g:启动但不置前台。execFile 传 argv(非 shell),bundleId/app 作单参无注入。
  const openArgs = ['-g', ...(bundleId ? ['-b', bundleId] : ['-a', app])];
  try {
    await execFileP('open', openArgs, { timeout: 8_000 });
  } catch (e: any) {
    return `Could not launch ${bundleId || app}: ${e?.stderr?.toString().trim() || e?.message || e}. Check the app/bundleId is installed.`;
  }
  const deadline = Date.now() + 12_000;
  let last = '';
  while (Date.now() < deadline) {
    if (tcx.signal?.aborted) return 'ensure_app aborted.';
    const found = await spec_executeFind(pctx, tcx, app, bundleId);
    last = found;
    if (/@r\d/.test(found)) return `Launched ${bundleId || app} in the background (no foreground focus).\n${found}`;
    await sleep(400);
  }
  return `Launched ${bundleId || app} in the background, but no window is observable yet. Give it a moment and call observe_ui.\n${last}`;
}

/** 内部:调 vendor executeFind 并渲染(供 ensure_app 轮询)。
 *  bundleId 是精确匹配,有就用它;只有 app 名时走 **text**(排序匹配)而不是 `app` ——
 *  v0.5.0 起 `app` 是「精确的规范化 app 名」,用户随口给的 "TextEdit" 未必对得上,
 *  精确匹配落空会让 ensure_app 白等满 12 秒再报「没有可观察窗口」。 */
async function spec_executeFind(pctx: ExtensionContext, tcx: ToolContext, app: string, bundleId: string): Promise<string> {
  try {
    const params = bundleId ? { bundleId } : { text: app };
    const r = await executeFind('', params, tcx.signal, undefined, pctx);
    return render(r, tcx);
  } catch {
    return '';
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
      if (!helperInstalled()) {
        return 'Computer Use helper is not installed yet. Run `tangu computer-use setup` to install the desktop helper (on macOS it also guides you through granting Accessibility + Screen Recording).';
      }
      const pctx = makePiCtx(tcx, false);
      try {
        await ensureComputerUseSetup(pctx, tcx.signal);
      } catch (e: any) {
        return `Computer Use is not ready: ${e?.message || e}\nRun \`tangu computer-use setup\` (grant Accessibility + Screen Recording to "Tangu Computer Use" in System Settings → Privacy & Security).`;
      }
      if (spec.run) return spec.run(args, tcx, pctx);
      const result = await spec.exec!('', args, tcx.signal, undefined, pctx);
      return render(result, tcx);
    },
  });

  return { id: 'plugin:computer-use', tools: () => SPECS.map(toTool) };
}
