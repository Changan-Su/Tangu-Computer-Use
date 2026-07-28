/**
 * `tangu computer-use <setup|doctor|stop>`。复用 vendor 的 ensureComputerUseSetup —— 给它一个 readline 版
 * ExtensionContext(hasUI=true),vendor 的 ensurePermissions 交互式引导就跑在 CLI 上。doctor 用 hasUI=false
 * 走非交互检查(权限缺 → vendor 抛指导文本)。
 */
import { createInterface } from 'node:readline/promises';
import { ensureComputerUseSetup, shutdownComputerUseSession } from './vendor/bridge.ts';
import { helperInstalled, helperExecutablePath } from './helperState.ts';
import type { ExtensionContext } from './pi-compat.ts';

function cliCtx(hasUI: boolean): ExtensionContext {
  return {
    cwd: process.cwd(),
    hasUI,
    ui: {
      notify: (msg, level) => console.log(`[${level || 'info'}] ${msg}`),
      select: async (prompt, options) => {
        console.log(prompt);
        options.forEach((o, i) => console.log(`  ${i + 1}. ${o}`));
        const rl = createInterface({ input: process.stdin, output: process.stdout });
        try {
          const a = (await rl.question('> ')).trim();
          const n = Number.parseInt(a, 10);
          return Number.isFinite(n) && n >= 1 && n <= options.length ? options[n - 1] : a;
        } finally {
          rl.close();
        }
      },
    },
    sessionManager: { getBranch: () => [] },
  };
}

export async function cliMain(argv: string[]): Promise<number> {
  const sub = argv[0];
  if (sub === 'setup') {
    try {
      await ensureComputerUseSetup(cliCtx(true));
      console.log('✓ Computer Use is ready.');
      return 0;
    } catch (e: any) {
      console.error(`✗ ${e?.message || e}`);
      return 1;
    }
  }
  if (sub === 'doctor') {
    if (!helperInstalled()) {
      console.log(`✗ native helper not installed (expected at ${helperExecutablePath()}).`);
      console.log('  Fix: run `tangu computer-use setup`.');
      return 1;
    }
    try {
      await ensureComputerUseSetup(cliCtx(false)); // helper 已装,这里只查权限;缺 → 抛指导文本
      console.log('✓ helper installed, permissions granted, backend ready.');
      return 0;
    } catch (e: any) {
      const msg = String(e?.message || e);
      console.log(`✗ not ready: ${msg}`);
      // 协议不匹配 = 装着的 helper 二进制比宿主老(新命令/新原生功能它都没有)。
      // 重装会换二进制,macOS 因此可能重置辅助功能/录屏授权,setup 默认会拒绝 ad-hoc 覆盖 —— 明说怎么绕。
      if (/protocol/i.test(msg)) {
        console.log('  The installed helper binary is older than this plugin.');
        console.log('  Fix: PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 tangu computer-use setup');
        console.log('       then `tangu computer-use stop` so the new binary takes over.');
        console.log('       macOS will ask you to re-grant Accessibility + Screen Recording.');
      } else {
        console.log('  Fix: run `tangu computer-use setup`.');
      }
      return 1;
    }
  }
  if (sub === 'stop') {
    await shutdownComputerUseSession();
    // mac 的 helper 是常驻 daemon,vendor 的 session shutdown 故意不杀它(TCC 身份稳定、下次秒连)。
    // 但用户敲 stop 的预期就是「别再碰我屏幕」→ 真杀;杀进程不影响 TCC 授权,下次使用会自动重启。
    if (process.platform === 'darwin') {
      const { execFile } = await import('node:child_process');
      await new Promise<void>((res) => execFile('pkill', ['-f', helperExecutablePath()], () => res()));
    }
    console.log('✓ helper stopped.');
    return 0;
  }
  console.log('usage: tangu computer-use <setup|doctor|stop>');
  return sub ? 1 : 0;
}
