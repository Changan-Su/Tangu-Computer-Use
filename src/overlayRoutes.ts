/**
 * 引擎半身的两条路由(helper 协议 20,Forsion patch)。插件视图(main.js)经宿主的
 * `ctx.tangu.request('computer-use', path, { method: 'POST', body })` 调;宿主挂在 `/extensions/<安装目录名>/computer-use` 下,
 * 鉴权和「只收本机」由宿主管。
 *
 * - POST /overlay-style `{ fill, edge?, reducedMotion? }` → `{ ok: true }`;不合法 400。存进内存,之后每条动作带上。
 * - POST /overlay-turn `{ phase: "end", runId? }` → 转成 helper 的 overlayTurn。helper 没在跑就 `{ ok: false }`,**不为这个去启动它**。
 */
import type { ScopedPluginRouter, TanguPluginContext } from '@forsion/tangu-agent';
import { parseOverlayStyleBody, sendOverlayTurnEnd, setOverlayStyle } from './overlayState.ts';

export interface RouteReply { status: number; body: Record<string, unknown> }

export function handleOverlayStyle(body: unknown): RouteReply {
  const parsed = parseOverlayStyleBody(body);
  if (!parsed) return { status: 400, body: { ok: false, error: 'invalid_overlay_style' } };
  setOverlayStyle(parsed.style, parsed.reducedMotion);
  return { status: 200, body: { ok: true } };
}

export async function handleOverlayTurn(body: unknown, send: (runId: string | undefined) => Promise<boolean> = (runId) => sendOverlayTurnEnd(runId)): Promise<RouteReply> {
  const raw = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  if (!raw || raw.phase !== 'end' || (raw.runId !== undefined && typeof raw.runId !== 'string')) {
    return { status: 400, body: { ok: false, error: 'invalid_overlay_turn' } };
  }
  const runId = typeof raw.runId === 'string' && raw.runId ? raw.runId : undefined;
  return { status: 200, body: { ok: await send(runId) } };
}

export function mountOverlayRoutes(router: ScopedPluginRouter, deps: { send?: (runId: string | undefined) => Promise<boolean> } = {}): void {
  router.post('/overlay-style', (req, res) => {
    const reply = handleOverlayStyle(req?.body);
    res.status(reply.status).json(reply.body);
  });
  router.post('/overlay-turn', async (req, res) => {
    const reply = await handleOverlayTurn(req?.body, deps.send);
    res.status(reply.status).json(reply.body);
  });
}

/** 有 registerScopedRoutes 才挂(老引擎没有:不挂,act 不带配色,helper 用柔蓝)。返回挂没挂上。 */
export function registerOverlayRoutes(ctx: Pick<TanguPluginContext, 'registerScopedRoutes'> | Record<string, unknown>): boolean {
  const register = (ctx as { registerScopedRoutes?: unknown }).registerScopedRoutes;
  if (typeof register !== 'function') return false;
  (register as TanguPluginContext['registerScopedRoutes']).call(ctx, (router) => mountOverlayRoutes(router));
  return true;
}
