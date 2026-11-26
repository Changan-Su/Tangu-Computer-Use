// Each conversation owns its browser profile and debugging endpoint. A launch in another
// conversation must never replace this browser or inherit its cookies and page state.
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const browserConversation = new AsyncLocalStorage<string>();
export const browserOwner = () => browserConversation.getStore() ?? 'standalone';
type ManagedBrowser = Awaited<ReturnType<typeof startBrowser>>;
const sessions = new Map<string, ManagedBrowser>();

export const managedPixelsOnly = () => sessions.get(browserOwner())?.pixelsOnly === true;

export function browserPort(): string | undefined {
  const browser = sessions.get(browserOwner());
  browser?.touch();
  return browser?.port ?? process.env.PI_COMPUTER_USE_CDP_PORT;
}

async function startBrowser(executable: string, visible: boolean, pixelsOnly: boolean, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const profile = await mkdtemp(path.join(tmpdir(), 'tangu-browser-'));
  const child = spawn(executable, [
    '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    ...(visible ? [] : ['--headless=new', '--window-size=1280,900']),
    'about:blank',
  ], { stdio: 'ignore', windowsHide: !visible });
  const kill = () => { child.kill(); };
  const onExit = () => {
    child.kill('SIGKILL');
    try { rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* best effort during forced host exit */ }
  };
  process.once('exit', onExit);
  let failure: Error | undefined;
  let idle: NodeJS.Timeout | undefined;
  child.once('error', error => { failure = error; });
  const closed = new Promise<void>(resolve => child.once('close', () => {
    clearTimeout(idle);
    process.removeListener('exit', onExit);
    void rm(profile, { recursive: true, force: true, maxRetries: 4 }).catch(() => {}).finally(resolve);
  }));
  const stop = async () => {
    clearTimeout(idle);
    kill();
    const force = setTimeout(() => child.kill('SIGKILL'), 2_000).unref();
    try { await closed; } finally { clearTimeout(force); }
  };
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => void stop(), 30 * 60_000).unref();
  };
  try {
    const deadline = Date.now() + 15_000;
    do {
      signal?.throwIfAborted();
      if (failure) throw failure;
      if (child.exitCode !== null || child.signalCode) throw new Error('Managed browser exited during launch.');
      const portFile = await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, socket] = portFile.trim().split(/\r?\n/);
      if (/^\d+$/.test(port) && socket?.startsWith('/devtools/browser/')) {
        touch();
        return { port, pid: child.pid, pixelsOnly, touch, stop, closed };
      }
      await delay(40, undefined, { signal });
    } while (Date.now() < deadline);
    throw new Error('Managed browser did not expose its debugging endpoint within 15 seconds.');
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function launchManagedBrowser<T>(executable: string, visible: boolean, signal: AbortSignal | undefined, observe: (pid?: number) => Promise<T>, pixelsOnly = false): Promise<T> {
  const owner = browserOwner();
  const previous = sessions.get(owner);
  const next = await startBrowser(executable, visible, pixelsOnly, signal);
  sessions.set(owner, next);
  void next.closed.then(() => { if (sessions.get(owner) === next) sessions.delete(owner); });
  try {
    const result = await observe(next.pid);
    await previous?.stop();
    return result;
  } catch (error) {
    if (previous && sessions.get(owner) === next) sessions.set(owner, previous);
    await next.stop();
    throw error;
  }
}

export async function closeManagedBrowsers(): Promise<void> {
  await Promise.all([...sessions.values()].map(browser => browser.stop()));
  sessions.clear();
}
