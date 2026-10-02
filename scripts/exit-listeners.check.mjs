#!/usr/bin/env node
// 插件热插拔下的进程退出监听。宿主停用插件时调 deactivate(),再启用会在**同一个模块对象**上再调 activate(ctx);
// 同 id 升级则 import 一份新模块(新一代)。钉住 src/index.ts 挂的 exit / SIGTERM / SIGINT 监听:
//   同一模块连续 activate 每个事件只多 1 个;deactivate 回到基线(照旧收口一次);再启用又是 1 个;
//   新一代自带一份,旧一代 deactivate 只摘自己的。
// 照 cli-exit.check.mjs 的办法从源码现打一份 bundle,tools / setup / vendor/bridge 换成桩:
// 只测 activate / deactivate 的接线,不起 helper、不装任何东西。
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EVENTS = ['exit', 'SIGTERM', 'SIGINT'];
const FIXTURES = {
  './tools.ts': `export const PLUGIN_ID = 'computer-use'; export const buildToolProvider = () => ({ tools: () => [] });`,
  './setup.ts': `export async function cliMain() { return 0; }`,
  './vendor/bridge.ts': `export async function shutdownComputerUseSession() { globalThis.__cuShutdowns = (globalThis.__cuShutdowns ?? 0) + 1; }`,
};

const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-exit-listeners-'));
try {
  const bundle = path.join(temp, 'plugin.mjs');
  await build({ entryPoints: [path.join(root, 'src/index.ts')], outfile: bundle, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'lifecycle-fixture', setup(b) {
      b.onResolve({ filter: /^\.\/(tools|setup|vendor\/bridge)\.ts$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: FIXTURES[args.path] }));
    } }], logLevel: 'silent' });

  const base = Object.fromEntries(EVENTS.map((ev) => [ev, process.listenerCount(ev)]));
  const expectListeners = (extra, label) => {
    for (const ev of EVENTS) assert.equal(process.listenerCount(ev), base[ev] + extra, `${label}: '${ev}' listeners`);
    console.log(`PASS ${label}`);
  };
  const ctx = { registerPlugin() {}, registerCommand() {}, log() {}, sdk: { pluginStore: {} } };
  // 带不同 query 再 import 一次 = 一份全新的模块对象,模拟同 id 升级换代。
  const load = async (generation) => (await import(`${pathToFileURL(bundle).href}?generation=${generation}`)).default;

  const gen1 = await load(1);
  gen1.activate(ctx);
  gen1.activate(ctx);
  expectListeners(1, 'activating the same module twice leaves one listener per event');
  gen1.deactivate();
  expectListeners(0, 'deactivate removes them');
  assert.equal(globalThis.__cuShutdowns, 1, 'deactivate still shuts the session down once');
  gen1.activate(ctx);
  expectListeners(1, 're-enabling after deactivate registers them again');

  const gen2 = await load(2);
  assert.notEqual(gen2, gen1, 'the second import must be a fresh module object');
  gen2.activate(ctx);
  expectListeners(2, 'a new generation registers its own listeners');
  gen1.deactivate();
  expectListeners(1, "the old generation's deactivate leaves the new generation's listeners");
  gen2.deactivate();
  expectListeners(0, 'the new generation deactivates back to the baseline');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
