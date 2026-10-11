/**
 * 抵掉 Mos 对合成滚轮事件的改写(macOS)。
 *
 * Mos 是常见的鼠标平滑滚动工具。它把 helper 发的滚轮事件当成鼠标滚轮来处理:开着「反向」就把方向翻过来,
 * 开着「平滑」就按 speed 放大。实测(reverse=1 / smooth=1 / speed=3,2026-10-11):scrollY -35 / -105 / -300 / -700
 * 分别滚了 84 / 287 / 867 / 2067 像素,方向全反,量 ≈ 3 × |d| − 33。
 * 模型发「往下滚 500」,在列表顶端什么都不动;换个符号又一下滚到底 —— 真模型 12 次里有 4 次因此没滚到要的位置就停了。
 *
 * ponytail: 只认 Mos、只读它的全局设置(不看它的分应用例外);关着平滑只开反向的那一档没实测,只翻方向。
 * 根治是 helper 发带阶段标记的滚轮事件(这类工具对触控板事件一律放行),要改原生、升协议号 —— 那样就不用认具体哪个工具了。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export interface WheelFix { sign: 1 | -1; gain: number }
const NONE: WheelFix = { sign: 1, gain: 1 };

/** `defaults read com.caldis.Mos` 的输出 → 该怎么抵。读不出来的项按「没开」算。 */
export function wheelFixFromMos(prefs: string): WheelFix {
  const num = (key: string) => {
    const m = prefs.match(new RegExp(`\\b${key} = "?([\\d.]+)"?;`));
    return m ? Number(m[1]) : undefined;
  };
  const speed = num('speed');
  return { sign: num('reverse') === 1 ? -1 : 1, gain: num('smooth') === 1 && speed && speed > 0 ? speed : 1 };
}

/** 模型要的滚动量 → 实际发给 helper 的量。非零的量不会被除成零。 */
export function applyWheelFix(amount: number, fix: WheelFix): number {
  if (!amount || (fix.sign === 1 && fix.gain === 1)) return amount;
  return Math.round(fix.sign * amount / fix.gain) || fix.sign * Math.sign(amount);
}

let cached: { at: number; fix: WheelFix } | undefined;

/** 现在该怎么抵。Mos 没装 / 没在跑 → 不动。结果留 30 秒(用户可能中途开关它)。 */
export async function wheelFix(): Promise<WheelFix> {
  if (process.platform !== 'darwin') return NONE;
  if (cached && Date.now() - cached.at < 30_000) return cached.fix;
  let fix = NONE;
  try {
    await execFileP('pgrep', ['-x', 'Mos'], { timeout: 2_000 }); // 没在跑 → 退出码 1 → 抛
    fix = wheelFixFromMos((await execFileP('defaults', ['read', 'com.caldis.Mos'], { timeout: 2_000 })).stdout);
  } catch { /* 没装或没在跑 */ }
  cached = { at: Date.now(), fix };
  return fix;
}
