/**
 * 屏上叠层(示意光标、点击环、边缘光)随每条 act / actBatch 带给 helper 的可选字段(helper 协议 20,Forsion patch)。
 * 字段的意思见 native/macos/agent_overlay_model.swift 的 OverlayActOptions;老 helper 不认识的字段一律忽略。
 *
 * - 配色 / 减少动态:插件视图经引擎路由 POST /overlay-style 交过来(见 overlayRoutes.ts),存在这个进程的内存里,
 *   之后每条动作都带上。没交过就不带,helper 用缺省柔蓝。
 * - runId:按工具调用的异步上下文取(AsyncLocalStorage,tools.ts 在每次 execute 外面包一层)。两个会话同时在动手时
 *   各带各的,不会串;Jev 和 vendor 里转几道手的调用也在同一个上下文里。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { macosHelper } from './vendor/platform/macos/helper.ts';

export interface OverlayStyle { fill: string; edge?: string }

const HEX = /^#[0-9a-f]{6}$/i;
let cachedStyle: OverlayStyle | undefined;
let cachedReducedMotion: boolean | undefined;

/** PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL=0:点击照旧立刻投递、不等示意光标飞到(「先到再点」的负对照,
 *  照 PI_COMPUTER_USE_WEB_FLUSH 的先例;也是哪天等待惹出问题时的退路)。缺省 true。 */
export function clickAfterArrival(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.PI_COMPUTER_USE_CLICK_AFTER_ARRIVAL !== '0';
}

/** POST /overlay-style 的体:`{ fill: "#rrggbb", edge?: "#rrggbb", reducedMotion?: boolean }`。不合法 = undefined(路由回 400)。
 *  edge 只在给了时转发,没给由 helper 按 fill 的相对亮度自己取(规则只在 helper 那一份)。 */
export function parseOverlayStyleBody(body: unknown): { style: OverlayStyle; reducedMotion?: boolean } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const { fill, edge, reducedMotion } = body as Record<string, unknown>;
  if (typeof fill !== 'string' || !HEX.test(fill)) return undefined;
  if (edge !== undefined && (typeof edge !== 'string' || !HEX.test(edge))) return undefined;
  if (reducedMotion !== undefined && typeof reducedMotion !== 'boolean') return undefined;
  const style: OverlayStyle = { fill: fill.toLowerCase(), ...(typeof edge === 'string' ? { edge: edge.toLowerCase() } : {}) };
  return { style, ...(typeof reducedMotion === 'boolean' ? { reducedMotion } : {}) };
}

/** 存下配色(之后每条动作带上)。reducedMotion 没给就保留上一次的。 */
export function setOverlayStyle(style: OverlayStyle, reducedMotion?: boolean): void {
  cachedStyle = { ...style };
  if (typeof reducedMotion === 'boolean') cachedReducedMotion = reducedMotion;
}

/** 测试用:回到「没交过配色」。 */
export function resetOverlayStyle(): void {
  cachedStyle = undefined;
  cachedReducedMotion = undefined;
}

const runScope = new AsyncLocalStorage<{ runId?: string }>();

/** 在这一轮(runId)的上下文里跑 fn:里面发出去的每条 act / actBatch 都带这个 runId。 */
export function withOverlayRun<T>(runId: string | undefined, fn: () => T): T {
  return runScope.run({ runId: typeof runId === 'string' && runId ? runId : undefined }, fn);
}

export function currentOverlayRunId(): string | undefined {
  return runScope.getStore()?.runId;
}

/** 每条 act(actBatch 是每一步)要并进请求的字段。 */
export function overlayActExtras(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
  const runId = currentOverlayRunId();
  return {
    ...(cachedStyle ? { overlayStyle: { ...cachedStyle } } : {}),
    ...(typeof cachedReducedMotion === 'boolean' ? { reduceMotion: cachedReducedMotion } : {}),
    ...(runId ? { runId } : {}),
    clickAfterArrival: clickAfterArrival(env),
  };
}

/** 把一条 overlayTurn 发给 helper。只连已经在跑的 helper(daemonCommand 不会拉起它);连不上就是失败。 */
export type OverlayTurnTransport = (args: Record<string, unknown>) => Promise<unknown>;
const helperTransport: OverlayTurnTransport = (args) => macosHelper.daemonCommand('overlayTurn', args, 1_500);

/** 发 `overlayTurn end`。helper 没在跑、是老 helper(19 回 unknown_command)、不是 macOS:一律 false,不抛。 */
export async function sendOverlayTurnEnd(runId: string | undefined, transport: OverlayTurnTransport = helperTransport, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (platform !== 'darwin') return false;
  try {
    await transport({ phase: 'end', ...(runId ? { runId } : {}) });
    return true;
  } catch {
    return false;
  }
}

/** 这一轮被中止时尽力发一次 overlayTurn end(带这一轮的 runId)。每个 run 只挂一个监听;最多记 16 个 run,
 *  挤出去的那个顺手摘掉监听 —— 不会越挂越多。 */
const watchedRuns = new Map<string, { signal: AbortSignal; onAbort: () => void }>();
const MAX_WATCHED_RUNS = 16;

export function watchRunAbort(runId: string | undefined, signal: AbortSignal | undefined, send: (runId: string) => unknown = (id) => sendOverlayTurnEnd(id), platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'darwin' || !runId || !signal || signal.aborted) return;
  const seen = watchedRuns.get(runId);
  if (seen?.signal === signal) return;
  if (seen) seen.signal.removeEventListener('abort', seen.onAbort);
  const onAbort = () => {
    if (watchedRuns.get(runId)?.signal === signal) watchedRuns.delete(runId);
    void Promise.resolve().then(() => send(runId)).catch(() => undefined);
  };
  signal.addEventListener('abort', onAbort, { once: true });
  watchedRuns.set(runId, { signal, onAbort });
  while (watchedRuns.size > MAX_WATCHED_RUNS) {
    const [oldest, entry] = watchedRuns.entries().next().value!;
    entry.signal.removeEventListener('abort', entry.onAbort);
    watchedRuns.delete(oldest);
  }
}

/** 测试用:现在挂着几个 run 的中止监听。 */
export function watchedRunCount(): number {
  return watchedRuns.size;
}
