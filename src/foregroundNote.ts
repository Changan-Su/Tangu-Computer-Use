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
 * 不否决的话,每一次成功的后台盲点都会倒过来跟用户说"我抢了你的前台"。但 rootDelta 里实际聚焦的证据优先于送达方式。
 */

interface ExecStep {
  escalatedToForeground?: boolean;
  escalationReason?: string;
  delivery?: string;
  deliveryPolicy?: string;
  steps?: ExecStep[];
  rootDelta?: Array<{ change?: string }>;
}

function tookForeground(step: ExecStep | undefined): boolean {
  if (!step) return false;
  if (step.escalatedToForeground === true) return true;
  // AX 没有全局输入;窗口仍可能被它自己的无障碍提供方激活,由 rootDelta 单独报告。
  if (step.delivery === 'ax') return false;
  return step.delivery === 'hid' || step.deliveryPolicy === 'foreground';
}

/** 传入 AgentToolResult.details.execution(或 undefined),返回一行提示或空串。 */
export function foregroundNote(execution: unknown): string {
  const exec = execution as ExecStep | undefined;
  if (!exec || typeof exec !== 'object') return '';
  const steps: ExecStep[] = Array.isArray(exec.steps) && exec.steps.length ? exec.steps : [exec];
  if ([exec, ...steps].some(s => Array.isArray(s?.rootDelta) && s.rootDelta.some(d => d?.change === 'focused'))) {
    return '\n[foreground] The target window became foreground during this action, even if delivery used accessibility input. The target app may have activated itself.';
  }
  if (!steps.some(tookForeground)) return '';
  const why = steps.map((s) => s?.escalationReason).find(Boolean);
  return `\n[foreground] This action took the foreground (focus/pointer was moved to the target)${why ? ` — ${why}` : ''}. Use the plugin's "strict background" setting to block actions that require foreground access (act_ui no longer takes a headless parameter).`;
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

/**
 * 截图的坐标空间:这张图多大、act_ui 的 x / y 按什么算。只在这次结果真的附了截图时说(模型手里有图才量得出坐标)。
 * Forsion 反馈 55b984eb(微信,无障碍树是空的):截图最长边缩到 900,坐标按这张图的像素算,但结果正文、工具描述、
 * 参数说明里都没写 —— 模型先后猜了 2438 / 1000 / 2000 / 1050 / 1800 宽,把第一次点对的坐标换算成了错的。
 * 读的是 details.capture.width / height(= look 图的像素尺寸,越界校验用的就是它);形状变了就静默返回空串。
 */
export function imageNote(details: unknown, attached: boolean, platform: string = process.platform): string {
  const capture = (details as { capture?: { width?: unknown; height?: unknown } } | null | undefined)?.capture;
  const w = Number(capture?.width), h = Number(capture?.height);
  if (!attached || !(w > 0) || !(h > 0)) return '';
  // 滚动距离只在 macOS 上折算成截图像素(别的平台的滚轮单位不是像素,vendor 原样传),所以那半句只在 macOS 说。
  const distance = platform === 'darwin' ? '; the scrollX / scrollY distance of a coordinate scroll is in the same pixels' : '';
  return `\n[image] The attached screenshot is ${w}x${h} px and shows only the target window. x / y for act_ui (click, moveMouse, scroll, drag) are pixels in this screenshot, origin top-left: x 0-${w - 1}, y 0-${h - 1}${distance}. Read positions straight off it; do not convert to screen points or to the window frame size.`;
}

interface Verification { status?: string; text?: string; role?: string; value?: string; gone?: boolean; timeoutMs?: number }

/**
 * expect 的结果进正文。vendor 把没满足的后置条件只记进 details.execution(verification.status / error),
 * 正文照样是「Executed N checked UI action」—— 模型分不清「等到了」和「等满超时」。
 * 无障碍树几乎没有文字的窗口(微信)上文字条件基本满足不了:多说一句,别让每次点击都白等一个超时。
 * 「几乎没有文字」取自 vendor 决定要不要附截图的那个启发式,不是证明,所以措辞是「很少能 / 建议」而不是「不可能」。
 */
export function expectNote(details: unknown): string {
  const d = details as { execution?: { verification?: Verification }; imageReason?: string } | null | undefined;
  const v = d?.execution?.verification;
  if (!v || typeof v !== 'object') return '';
  const what = [v.text ? `text ${JSON.stringify(v.text)}` : '', v.role ? `role ${v.role}` : '', v.value ? `value ${JSON.stringify(v.value)}` : ''].filter(Boolean).join(', ') || 'the condition';
  if (v.status === 'preexisting') {
    return `\n[expect] ${what} was already ${v.gone ? 'absent' : 'present'} before the action, so this check says nothing about whether the action worked. Judge from the new state.`;
  }
  if (v.status !== 'failed') return '';
  const blind = d?.imageReason === 'unlabeled_ax_targets' || d?.imageReason === 'sparse_ax_targets';
  const tail = blind
    ? ' This window exposes little or no accessibility text, so expect will rarely match here and costs the wait each time: prefer leaving expect out for this window and judging from the attached screenshot.'
    : ' Look at the new state before retrying.';
  return `\n[expect] NOT satisfied: ${what} did not ${v.gone ? 'disappear from' : 'appear in'} the accessibility tree within ${v.timeoutMs ?? '?'}ms. The action itself was delivered. expect reads accessibility text only, never the pixels.${tail}`;
}

/**
 * 走真实输入的滚动(按坐标的,或 ref 落成坐标的)会过鼠标工具:量不保证,个别工具还会把方向翻过来。
 * 装着 Mos 的机器上方向和倍数由 src/wheel.ts 抵掉了(不抵的话 scrollY -300 滚 +867 像素),所以这里只陈述约定、
 * 提醒看图,不再劝模型「不对就换符号」—— 方向本来是对的时候,那句话反而让模型自己把符号翻了(真模型实测一次)。
 * 按「这一步实际怎么送达」判:execution.steps 与 actions 逐项对应(失败后面的没执行、没有对应项)。
 * 走无障碍动作的 scroll 不说;按 ref 给、但 ref 是只有坐标的节点(pictureOnly)而走了真实输入的照样说。
 */
export function scrollNote(actions: unknown, execution: unknown, platform: string = process.platform): string {
  if (platform !== 'darwin') return ''; // 说的是 macOS 上真实滚轮输入的事
  const list = Array.isArray(actions) ? actions as Array<{ action?: string }> : [];
  const exec = execution as ExecStep | undefined;
  const steps = exec && Array.isArray(exec.steps) && exec.steps.length ? exec.steps : undefined;
  if (!list.some((a, i) => a?.action === 'scroll' && tookForeground(steps ? steps[i] : exec))) return '';
  return '\n[scroll] This scroll went out as real wheel input: positive scrollY scrolls down. The distance is approximate, and a mouse utility on this Mac may change the distance or the direction, so read where the view ended up off the screenshot before scrolling again.';
}

const TARGET_GONE = 'The current controlled window is no longer available';

/**
 * 「窗口不在了」的报错补一句原因和出路。helper 列不出不在当前桌面的窗口(在别的桌面,或被收起来不显示;
 * 最小化的窗口列得出来、带 minimized 标记,不属于这一类),
 * vendor 一律报成窗口没了。反馈 55b984eb:用户切回 Forsion 所在的桌面,微信的窗口就「消失」了,
 * 模型连试两次 find_roots 才想到 ensure_app。不是这条报错就原样返回。
 */
export function goneHint(message: string, target?: { app?: string; bundleId?: string }): string {
  if (!message.includes(TARGET_GONE)) return message;
  const call = target?.bundleId ? `ensure_app({ bundleId: ${JSON.stringify(target.bundleId)} })` : target?.app ? `ensure_app({ app: ${JSON.stringify(target.app)} })` : 'ensure_app';
  return `${message} This is also what a window that left the current desktop looks like: it is on another desktop (Space) or hidden — such windows cannot be listed, observed or clicked. If the app is still running, ${call} brings its window back; then observe_ui again before acting.`;
}

/** find_roots 按 App 找却一个 root 都没有:同一个原因,同一条出路(只在 macOS 说,ensure_app 只有那边有)。 */
export function noRootsHint(details: unknown, platform: string = process.platform): string {
  const d = details as { tool?: string; windows?: unknown[]; query?: { app?: string; bundleId?: string; pid?: number } } | null | undefined;
  if (platform !== 'darwin' || d?.tool !== 'find_roots' || !Array.isArray(d.windows) || d.windows.length > 0) return '';
  if (!d.query?.app && !d.query?.bundleId && !d.query?.pid) return '';
  return '\n[hint] A running app has no roots here while all its windows are on another desktop (Space) or hidden. ensure_app (by bundleId or app name) starts the app or brings its window back to the current desktop.';
}
