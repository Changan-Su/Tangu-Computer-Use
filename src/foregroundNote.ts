/**
 * 前台透明化:从 act 结果的 details.execution 里判断「这次动作是否夺取了前台焦点」,给模型一句明示。
 *
 * 背景:vendor 把 escalation/delivery 只写进结构化 details.execution(bridge.ts buildToolResult),
 * **不进模型读到的 text**。于是文本框点击悄悄升级到前台 HID、抢焦点,模型/用户都看不见。这里在适配层
 * 从 execution 里还原该事实,附一行提示——不动 vendor。best-effort:execution 形状变了就静默返回空串
 * (提示消失,不报错),故留了 no-foreground.check.mjs 单测钉住这套判据。
 *
 * 判据(满足其一即「用了前台」):
 *   - escalatedToForeground===true(后台先试、被 foreground_required 顶到前台)
 *   - delivery==='hid'(真实物理输入)
 *   - deliveryPolicy==='foreground'(直奔前台,如 needsForeground 路径不置 escalated 标记)
 *
 * ⚠️但 delivery==='ax' 一票否决 policy:坐标点击在 TS 层**永远**被判 needsForeground(actions.ts),
 * 于是 policy 恒为 foreground;而 helper 现在会先做 AX 命中测试、命中就在后台按下去,压根没动焦点。
 * 不否决的话,每一次成功的后台盲点都会倒过来跟用户说"我抢了你的前台" —— 比不提示更坏。
 */

interface ExecStep {
  escalatedToForeground?: boolean;
  escalationReason?: string;
  delivery?: string;
  deliveryPolicy?: string;
  steps?: ExecStep[];
}

function tookForeground(step: ExecStep | undefined): boolean {
  if (!step) return false;
  if (step.escalatedToForeground === true) return true;
  // AX 送达 = 没发过物理事件、没激活过任何 App,无论名义 policy 是什么
  if (step.delivery === 'ax') return false;
  return step.delivery === 'hid' || step.deliveryPolicy === 'foreground';
}

/** 传入 AgentToolResult.details.execution(或 undefined),返回一行提示或空串。 */
export function foregroundNote(execution: unknown): string {
  const exec = execution as ExecStep | undefined;
  if (!exec || typeof exec !== 'object') return '';
  const steps: ExecStep[] = Array.isArray(exec.steps) && exec.steps.length ? exec.steps : [exec];
  if (!steps.some(tookForeground)) return '';
  const why = steps.map((s) => s?.escalationReason).find(Boolean);
  return `\n[foreground] This action took the foreground (focus/pointer was moved to the target)${why ? ` — ${why}` : ''}. To keep actions in the background, prefer setText to fill fields; strict background-only is the plugin's "strict background" setting (act_ui no longer takes a headless parameter).`;
}

/**
 * 自家窗口提示:目标窗口属于拉起本引擎的那个桌面应用(= Forsion 自己;托管引擎是它的直接子进程)时,
 * 明说一句「改用界面命令」。Forsion 反馈 6a239e58:agent 用 Computer Use 去点 Forsion 自己的设置窗口,
 * 界面一重渲染元素引用就失效(一轮里 3 次 stale ref + 1 次 stale state),而同一件事 run_ui_command 一次就办完。
 * 只提示不拦:没有对应界面命令的地方(插件自绘页)仍只能这样操作。
 * TUI / 独立运行时父进程是 shell(没有窗口)、父进程已死时 ppid=1,都不会命中。
 * 读的是 details.target.pid(observe / act / wait)与 details.windows[].pid(find_roots);形状变了就静默返回空串。
 */
export function selfWindowNote(details: unknown, hostPid: number = process.ppid): string {
  const d = details as { target?: { pid?: unknown }; windows?: Array<{ pid?: unknown }> } | null | undefined;
  if (!d || typeof d !== 'object' || !(hostPid > 1)) return '';
  const own = d.target?.pid === hostPid || (Array.isArray(d.windows) && d.windows.some((w) => w?.pid === hostPid));
  if (!own) return '';
  return `\n[forsion] pid ${hostPid} is Forsion itself, the app you are running in. Operate Forsion through its own UI tools (list_ui_commands, then run_ui_command / set_ui_setting): they act directly and report the outcome. Computer Use on Forsion's own windows is unreliable because the UI re-renders under you and element refs go stale; keep it for controls that have no UI command.`;
}
