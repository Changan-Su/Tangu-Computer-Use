/**
 * 第一次读 Chromium 系 App 时等网页内容进无障碍树(macOS)。
 *
 * 无障碍客户端第一次碰到这类 App 后,网页内容要约 2 秒才出现:实测 Electron 40、Chrome for Testing 149
 * 2.06–2.17 秒,VS Code 1.8–2.4 秒,在那之前窗口里根本没有 AXWebArea(VS Code 13 个节点 → 303 个)。
 * helper 只给浏览器等 0.35 秒,Electron 不等,这时读到的是一个空壳,模型会以为界面上什么都没有。
 *
 * 读到空壳时等到第一次接触后 2.5 秒,再读一次。每个进程只判一回,所以非 Chromium App、已经激活过的
 * App 都不多等。只读 App 包里的 Frameworks 目录判断,认不出来就是不等,和原来一样。
 *
 * ponytail: 只再读一次;比 2.5 秒还慢的 App 第一次仍会读到空壳,要改成轮询再加。
 * 根治是 helper 读回激活状态、等到完成,要改原生、升协议号。
 */
import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

export const WEB_CONTENT_SETTLE_MS = 2500;
const CHROMIUM_FRAMEWORK = /\b(Electron|Chromium|Chrome|Edge|Brave|Vivaldi|Opera|Helium)\b.*Framework\.framework$|^ArcCore\.framework$/;

const firstContact = new Map<number, number>();
const decided = new Set<number>();

/** 只取最外层的 .app:Helper 进程的路径里还嵌着一层。 */
export function appBundleOf(executable: string): string | undefined {
  const end = executable.indexOf('.app/');
  return end < 0 ? undefined : executable.slice(0, end + 4);
}

export const hasChromiumFramework = (frameworks: readonly string[]): boolean =>
  frameworks.some((name) => CHROMIUM_FRAMEWORK.test(name));

export function hasWebArea(node: { role: string; children?: readonly any[] }): boolean {
  return node.role === 'AXWebArea' || (node.children ?? []).some(hasWebArea);
}

async function isChromiumProcess(pid: number): Promise<boolean> {
  try {
    const { stdout } = await execFileP('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { timeout: 2000 });
    const bundle = appBundleOf(stdout.trim());
    return bundle ? hasChromiumFramework(await readdir(path.join(bundle, 'Contents', 'Frameworks'))) : false;
  } catch {
    return false;
  }
}

/** helper 的 listWindows 第一次碰到 pid 就打开无障碍,find_roots 也算接触。 */
export function noteContact(pid: number, now = Date.now()): void {
  if (!firstContact.has(pid)) firstContact.set(pid, now);
}

/** 这次观察之后还要等多少毫秒再读一次;0 = 这次读到的就算数。 */
export async function webContentWait(pid: number, outline: { role: string; children?: readonly any[] }, isChromium = isChromiumProcess): Promise<number> {
  noteContact(pid);
  if (decided.has(pid)) return 0;
  const wait = hasWebArea(outline) || !(await isChromium(pid)) ? 0 : Math.max(0, firstContact.get(pid)! + WEB_CONTENT_SETTLE_MS - Date.now());
  // 要等的时候不算判完:等待被取消的话,下一次观察还要接着等。等够了时钟已过,下次自然是 0
  if (wait === 0) decided.add(pid);
  return wait;
}
