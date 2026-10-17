import type { ToolContext } from '@forsion/tangu-agent';

/** 动手类工具:第一次成功投递之后,把被操控窗口的实时画面摆上 Agent Desk。 */
const LIVE_VIEW_TOOLS = new Set(['act_ui', 'jev_ui']);
const presentedRuns: string[] = [];

/**
 * 每个 run 第一次动手成功后,由插件自己把实时画面摆上 Agent Desk(10-17 用户报「开始操作后 Desk 不显示画面」:
 * 以前写在 SKILL 里让模型自己调 desk_present,模型常常不调)。观察类工具、失败的动作不摆。
 * 用户在这次 run 里关掉 Desk 由宿主静音到下一条用户消息,这里每个 run 只摆一次,不会反复弹。
 * 不带 name:宿主用插件注册的视图标题(跟界面语言走);引擎这边不知道界面语言。
 * ponytail: run 记录只留最近 50 个;每个新 run 第一次动手都会重摆一次(画面已在 Desk 上也会重挂一下)。
 */
export function presentLiveViewOnce(tool: string, tcx: ToolContext, result: string): string {
  if (!LIVE_VIEW_TOOLS.has(tool) || !tcx.presentDesk || /^Error\b/.test(result)) return result;
  const run = tcx.runId || tcx.sessionId;
  if (!run || presentedRuns.includes(run)) return result;
  presentedRuns.push(run);
  if (presentedRuns.length > 50) presentedRuns.shift();
  try {
    tcx.presentDesk({ views: [{ type: 'view', view: 'plugin:tangu-computer-use:live' }], size: 'half' });
  } catch { /* Desk 是锦上添花,摆不上不影响动作结果 */ }
  return result;
}
