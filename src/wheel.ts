/**
 * 抵掉 Mos 对合成滚轮事件的改写(macOS)。
 *
 * Mos 是常见的鼠标平滑滚动工具。它把 helper 发的滚轮事件当成鼠标滚轮来处理:开着「反向」就把方向翻过来,
 * 开着「平滑」就按 speed 放大。实测(reverse=1 / smooth=1 / speed=3,2026-10-11):scrollY -35 / -105 / -300 / -700
 * 分别滚了 84 / 287 / 867 / 2067 像素,方向全反,量 ≈ 3 × |d| − 33。
 * 模型发「往下滚 500」,在列表顶端什么都不动;换个符号又一下滚到底 —— 真模型 12 次里有 4 次因此没滚到要的位置就停了。
 *
 * 照 Mos 自己的规则分应用算:它的清单里的 App 勾了「继承」用全局设置、没勾用那个 App 自己的;开着「白名单」时清单外的
 * App 它一律不碰。每次滚动现读一遍(三四个小命令,几十毫秒),不留缓存 —— 用户中途退出 Mos 或改设置,下一次滚动就得跟上。
 *
 * ponytail: 只认 Mos;关着平滑只开反向的那一档没实测,只翻方向。
 * 根治是 helper 发带阶段标记的滚轮事件(这类工具对触控板事件一律放行),要改原生、升协议号 —— 那样就不用认具体哪个工具了。
 */
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const run = async (cmd: string, args: string[]) => (await execFileP(cmd, args, { timeout: 2_000 })).stdout;

export interface WheelFix { sign: 1 | -1; gain: number }
const NONE: WheelFix = { sign: 1, gain: 1 };

interface MosScroll { reverse: boolean; smooth: boolean; speed: number }
export interface MosPrefs extends MosScroll { allowlist: boolean; apps: Array<MosScroll & { path: string; inherit: boolean }> }

/** `defaults read com.caldis.Mos` 的输出 + 它的分应用清单(JSON 文本)→ 设置。读不出来的项按「没开」算。 */
export function parseMos(globalText: string, appsJson = '[]'): MosPrefs {
  const num = (key: string) => {
    const m = globalText.match(new RegExp(`\\b${key} = "?([\\d.]+)"?;`));
    return m ? Number(m[1]) : undefined;
  };
  let apps: MosPrefs['apps'] = [];
  try {
    apps = (JSON.parse(appsJson) as any[]).map((a) => ({
      path: String(a?.path ?? ''), inherit: a?.inherit !== false,
      reverse: a?.scrollBasic?.reverse === true, smooth: a?.scrollBasic?.smooth === true, speed: Number(a?.scrollAdvanced?.speed) || 1,
    })).filter((a) => a.path);
  } catch { /* 清单读不出来 = 没有例外 */ }
  return { reverse: num('reverse') === 1, smooth: num('smooth') === 1, speed: num('speed') || 1, allowlist: num('whitelist') === 1, apps };
}

/** 对这个 App(按可执行文件的路径认)该怎么抵。 */
export function wheelFixFor(prefs: MosPrefs, executable?: string): WheelFix {
  const app = executable ? prefs.apps.find((a) => a.path === executable) : undefined;
  if (!app && prefs.allowlist) return NONE;
  const use: MosScroll = app && !app.inherit ? app : prefs;
  return { sign: use.reverse ? -1 : 1, gain: use.smooth && use.speed > 0 ? use.speed : 1 };
}

/** 模型要的滚动量 → 实际发给 helper 的量。非零的量不会被除成零。 */
export function applyWheelFix(amount: number, fix: WheelFix): number {
  if (!amount || (fix.sign === 1 && fix.gain === 1)) return amount;
  return Math.round(fix.sign * amount / fix.gain) || fix.sign * Math.sign(amount);
}

/** 现在往这个进程的窗口里滚,该怎么抵。Mos 没装 / 没在跑 / 读不出来 → 不动。 */
export async function wheelFix(pid?: number): Promise<WheelFix> {
  if (process.platform !== 'darwin') return NONE;
  try {
    await run('pgrep', ['-x', 'Mos']); // 没在跑 → 退出码 1 → 抛
    const [globalText, appsJson, executable] = await Promise.all([
      run('defaults', ['read', 'com.caldis.Mos']),
      run('plutil', ['-extract', 'applications', 'raw', '-o', '-', path.join(os.homedir(), 'Library/Preferences/com.caldis.Mos.plist')])
        .then((b64) => Buffer.from(b64.trim(), 'base64').toString('utf8'), () => '[]'),
      pid ? run('ps', ['-p', String(pid), '-o', 'comm=']).then((out) => out.trim(), () => undefined) : undefined,
    ]);
    return wheelFixFor(parseMos(globalText, appsJson), executable);
  } catch {
    return NONE;
  }
}
