/**
 * 首次安装 / 插件更新后的自愈与引导。
 *
 * 用户报的症状:「首次安装和更新都需要重新运行 tangu computer-use setup,很糟糕,agent 应当引导用户」。
 * 查下来两半都是可修的,而且都不在 vendor:
 *
 *   ① **首次安装**:vendor 的 `ensureInstalled()` 本来就会自动跑 scripts/setup-helper.mjs
 *      (还正确地用 ELECTRON_RUN_AS_NODE 重入 Electron)。是我们自己在 tools.ts 里加的
 *      「helperInstalled() 就直接返回指导文本」抢在它前面 return 了 —— 把上游的自动安装堵死。
 *   ② **更新**:`ensureInstalled()` 只判断可执行文件**存不存在**,不判断新旧。插件升级后老二进制
 *      还在原地 → 早退 → 协议不匹配 → 报错让用户去终端。所以这里补一个「装着的是不是 bundle
 *      自带那份」的比对,过期就重装。
 *
 * 权限那一步**故意**仍然要人:授予辅助功能/屏幕录制是系统安全设置,只能用户自己拨。我们能做的是
 * 把 App 预登记进隐私面板(registerPermissions)+ 直接把面板打开(openPermissionPane),让用户
 * 只需拨一下开关,而不是自己去找。
 */
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { helperInstalled, helperExecutablePath, isSupportedPlatform } from './helperState.ts';

const SETUP_TIMEOUT_MS = 180_000;

/**
 * bundle 根 = 从产物往上找到第一个同时有 manifest.json 与 scripts/setup-helper.mjs 的目录。
 *
 * 故意**不写死层级**:vendor 用 `..`×3 硬跳(见 scripts/build.mjs 的长注释),产物挪一次位置就会
 * 静默失配 —— 那正是曾经的 P0。向上搜索没有这个不变量要守。
 */
export function bundleRoot(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let up = 0; up < 6; up++) {
    if (existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'scripts', 'setup-helper.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

const sha256 = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

/**
 * bundle 自带的 native helper —— 必须和 setup-helper.mjs 的**选择顺序一致**:
 * 预签名的 universal .app 优先,其次 per-arch .app,最后才是裸二进制(本地开发那条)。
 * 顺序错了会出现「安装用的是 A、判新旧看的是 B」,于是要么永远不更新、要么每次都更新。
 */
function bundledHelper(): { source: string; signed: boolean } | undefined {
  const root = bundleRoot();
  if (!root || process.platform !== 'darwin') return undefined;
  const arch = process.arch === 'x64' ? 'x64' : 'arm64';
  for (const dir of ['universal', arch]) {
    const app = path.join(root, 'prebuilt', 'macos', dir, 'tangu-computer-use.app', 'Contents', 'MacOS', 'bridge');
    if (existsSync(app)) return { source: app, signed: true };
  }
  const loose = path.join(root, 'prebuilt', 'macos', arch, 'bridge');
  return existsSync(loose) ? { source: loose, signed: false } : undefined;
}

let staleCache: boolean | undefined;

/**
 * 已装的 helper 是不是 bundle 自带的那份(= 插件更新了但 helper 没跟上)。
 * 每进程只算一次:两个 ~700KB 文件的哈希,放在工具热路径上算不值当。
 *
 * ⚠️**裸二进制那条绝不能拿源文件去比已装的可执行文件**:`installHelperApp()` 是复制之后
 * **在原地重签**,Mach-O 字节必然不同 → 恒判「过期」→ 每个新进程都跑一遍完整安装,
 * 还可能每次弹钥匙串。它专门写了 `Contents/Resources/source.sha256` 记录**签名前**的源哈希,
 * 就是给这一步用的。预签名 .app 那条走的是 `installPrebuiltHelperApp()`,不重签,可以直接比字节。
 */
export function helperNeedsUpdate(): boolean {
  if (staleCache !== undefined) return staleCache;
  staleCache = (() => {
    const bundled = bundledHelper();
    if (!bundled || !helperInstalled()) return false; // 没有随包件就没得比;没装是另一条路
    try {
      const want = sha256(bundled.source);
      if (bundled.signed) return want !== sha256(helperExecutablePath());
      const stamp = path.join(path.dirname(path.dirname(helperExecutablePath())), 'Resources', 'source.sha256');
      return existsSync(stamp) ? readFileSync(stamp, 'utf8').trim() !== want : false;
    } catch {
      return false; // 读不到就别乱报过期,让 vendor 的协议校验去兜
    }
  })();
  return staleCache;
}

/**
 * 跑安装脚本。
 *
 * ⚠️**任何情况下都不杀这个子进程** —— 它内部会 `codesign` helper.app,而被中断的 codesign 会留下
 * `*.cstemp`,下一次 `--deep` 会把它封进 CodeResources 再删掉,签名从此**恒定**校验失败;TCC 认签名,
 * 用户看到的就是「权限开关怎么点都没用」。2026-07-28 真踩过,排查了很久。超时/取消只是**停止等待**,
 * 让它自己跑完(setup-helper.mjs 里另有 removeSigningTempFiles 兜底,但别再制造需要兜底的场面)。
 */
function runSetup(): Promise<void> {
  const root = bundleRoot();
  if (!root) return Promise.reject(new Error('could not locate the plugin bundle root'));
  const script = path.join(root, 'scripts', 'setup-helper.mjs');
  return new Promise<void>((resolve, reject) => {
    // ⚠️宿主可能是 Electron:process.execPath 是 Electron 二进制,不设 ELECTRON_RUN_AS_NODE
    // 它会去开窗口而不是跑脚本。与 vendor 的 ensureInstalled 同款处理。
    const child = spawn(process.execPath, [script, '--runtime'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', BUN_BE_BUN: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true, // 脱离进程组:宿主收 SIGINT 时不连带打断签名
    });
    child.unref();
    let output = '';
    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });
    // ⚠️这个 Promise **只跟子进程的生死绑定**,不跟任何一次调用的 signal/timeout 绑定。
    // 早settle 会让「安装还在跑」但共享 Promise 已 settle,后来的调用于是以为可以往下走
    // (去启动一个装了一半的 helper,或再起一个安装)。要限时的是**等待**,见 ensureHelperCurrent。
    child.on('error', reject);
    child.on('close', (code) => (code === 0
      ? resolve()
      : reject(new Error(output.trim().split('\n').slice(-4).join('\n') || `setup exited with ${code}`))));
  });
}

/** 只限制**本次等待**,不动底下那个安装进程。 */
function waitFor<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const settle = (fn: () => void): void => { if (!done) { done = true; clearTimeout(timer); signal?.removeEventListener('abort', onAbort); fn(); } };
    const stop = (why: string) => (): void => settle(() => reject(new Error(`${why}; the installer may still finish in the background`)));
    const timer = setTimeout(stop('helper setup is taking longer than expected'), SETUP_TIMEOUT_MS);
    const onAbort = stop('helper setup wait was interrupted');
    signal?.addEventListener('abort', onAbort, { once: true });
    work.then((v) => settle(() => resolve(v)), (e: unknown) => settle(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });
}

let install: Promise<string | undefined> | undefined;
let noteDelivered = false;
let installFailed = false;

/** 自动安装是否试过并失败了 —— 只有这种情况才该让用户去开终端(见 tools.ts 的兜底文案)。 */
export function autoInstallFailed(): boolean {
  return installFailed;
}

/**
 * 保证装着的 helper 就是 bundle 自带的那份。缺失或过期 → 就地安装,不要求用户开终端。
 * 返回给模型的一行说明(装了什么/没装成什么),没做任何事就返回 undefined。
 *
 * **每进程只装一次**,两个理由都必须成立:
 *   ① 工具是可以并发进来的(不同会话),两个安装同时往 /Applications 写会互相踩;
 *   ② 装失败通常需要人介入(钥匙串授权框、目录不可写),每次工具调用都重跑一遍
 *      三分钟的安装只会把 agent 拖死 —— 失败后交给 ensureComputerUseSetup 去报真正的原因。
 */
export async function ensureHelperCurrent(signal?: AbortSignal): Promise<string | undefined> {
  if (!isSupportedPlatform()) return undefined;
  const missing = !helperInstalled();
  if (!missing && !helperNeedsUpdate()) return undefined;
  install ??= runSetup().then(
    async () => {
      // The daemon survives binary replacement. Its protocol/path can still match while
      // executing the previous image, so a successful upgrade must explicitly restart it.
      if (!missing && process.platform === 'darwin') {
        const { macosHelper } = await import('./vendor/platform/macos/helper.ts');
        await macosHelper.restart();
      }
      staleCache = undefined; // 重新比对,别让旧结论粘住
      return missing
        ? 'Installed the Computer Use desktop helper automatically.'
        : 'Updated the Computer Use desktop helper to match this plugin version.';
    },
  ).catch((error: unknown) => {
    installFailed = true;
    const detail = error instanceof Error ? error.message : String(error);
    return `Could not install the Computer Use helper automatically (${detail}). Run \`tangu computer-use setup\` in a terminal.`;
  });
  const note = await waitFor(install, signal).catch((error: unknown) => String((error as Error).message));
  if (!note || noteDelivered) return undefined; // 这句话只说一次,别给之后每个工具结果都加个帽子
  noteDelivered = true;
  return note;
}

const PANE_LABEL = { accessibility: 'Accessibility', screenRecording: 'Screen Recording' } as const;
type PaneKind = keyof typeof PANE_LABEL;
const panesOpened = new Set<PaneKind>();
let registered = false;

/**
 * 缺权限时:把 App 预登记进隐私面板、打开**一个**面板,再返回给模型一段可以照着念的指引。
 *
 * ⚠️权限真值只能问 `checkPermissions`,**不能问 `diagnostics`** —— 后者为了当 1s 的存活探针用,
 * 屏幕录制那项只做 `CGPreflightScreenCaptureAccess()` 这种缓存预检(bridge.swift 里那段注释自己
 * 就写着 "Permission truth comes from checkPermissions")。预检说有、实际截不到时,我们会判定
 * 「没有缺失的权限」,于是既不开面板也不给指引,白白退回「去开终端」。
 *
 * ⚠️一次只开一个面板:系统设置是单窗口,连开两个后一个会顶掉前一个,而两个 key 都被记成"开过了",
 * 于是第一个面板再也不会被打开。剩下的留给下一次重试。
 */
export async function guideMissingPermissions(signal?: AbortSignal): Promise<string | undefined> {
  if (process.platform !== 'darwin') return undefined;
  try {
    const { macosHelper } = await import('./vendor/platform/macos/helper.ts');
    const status = await macosHelper.command<{ accessibility?: boolean; screenRecording?: boolean; screenRecordingCapturable?: boolean }>(
      'checkPermissions', {}, { signal, timeoutMs: 15_000 },
    );
    const granted: Record<PaneKind, boolean> = {
      accessibility: status?.accessibility === true,
      screenRecording: (status?.screenRecordingCapturable ?? status?.screenRecording) === true,
    };
    const missing = (Object.keys(PANE_LABEL) as PaneKind[]).filter((key) => !granted[key]);
    if (missing.length === 0) return undefined;

    if (!registered) {
      // 预登记:让 App 直接出现在隐私列表里,用户只需拨开关,不必自己「+」着去找。
      registered = true;
      await macosHelper.command('registerPermissions', {}, { signal, timeoutMs: 15_000 }).catch(() => { registered = false; });
    }
    const next = missing.find((key) => !panesOpened.has(key));
    let opened: PaneKind | undefined;
    if (next) {
      // 只有真的开成功了才记 —— 失败还记上的话这个面板就永远不会再被打开。
      opened = await macosHelper.command('openPermissionPane', { kind: next }, { signal, timeoutMs: 10_000 })
        .then(() => { panesOpened.add(next); return next; }, () => undefined);
    }
    const names = missing.map((key) => PANE_LABEL[key]).join(' and ');
    const where = opened
      ? `System Settings has been opened at the ${PANE_LABEL[opened]} pane.`
      : 'Open System Settings → Privacy & Security.';
    return `Computer Use still needs macOS ${names} for "tangu-computer-use". ${where} Ask the user to turn the switch on for tangu-computer-use, then retry — this is a system security setting, only the user can grant it.`;
  } catch {
    return undefined;
  }
}
