// Exercise the production onboarding flow with isolated installer/daemon boundaries.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-refresh-'));
try {
  for (const scenario of ['stale', 'missing', 'current', 'install-failure', 'restart-failure']) {
    const root = path.join(temp, scenario), events = path.join(root, 'events');
    const executable = path.join(root, 'installed/Contents/MacOS/bridge');
    const stamp = path.join(root, 'installed/Contents/Resources/source.sha256');
    const bundled = path.join(root, `prebuilt/macos/${process.arch}/bridge`);
    const output = path.join(root, 'tangu-plugins/computer-use/dist/probe.mjs');
    for (const file of [executable, stamp, bundled, output, path.join(root, 'scripts/setup-helper.mjs')]) mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), '{}');
    writeFileSync(bundled, 'new helper image');
    if (scenario !== 'missing') writeFileSync(executable, 'locally signed image');
    writeFileSync(stamp, scenario === 'current' ? createHash('sha256').update(readFileSync(bundled)).digest('hex') : 'old image');
    writeFileSync(path.join(root, 'scripts/setup-helper.mjs'), `import {appendFileSync} from 'node:fs';
      appendFileSync(${JSON.stringify(events)}, 'install\\n');
      ${scenario === 'install-failure' ? "console.error('fixture install failure'); process.exitCode = 1;" : ''}`);
    await build({ entryPoints: [path.resolve('src/onboarding.ts')], outfile: output, bundle: true, platform: 'node', format: 'esm',
      define: { 'process.platform': '"darwin"' },
      plugins: [{ name: 'isolated-helper', setup(b) {
        b.onResolve({ filter: /\/helperState\.ts$|\/vendor\/platform\/macos\/helper\.ts$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
        b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: args.path.endsWith('helperState.ts')
          ? `import {existsSync} from 'node:fs'; export const helperInstalled = () => existsSync(${JSON.stringify(executable)}); export const helperExecutablePath = () => ${JSON.stringify(executable)}; export const isSupportedPlatform = () => true;`
          : `import {appendFileSync,readFileSync} from 'node:fs'; export const macosHelper = {restart: async () => {
              if(readFileSync(${JSON.stringify(events)}, 'utf8') !== 'install\\n') throw Error('restarted before installer finished');
              appendFileSync(${JSON.stringify(events)}, 'restart\\n');
              ${scenario === 'restart-failure' ? "throw Error('fixture restart failure');" : ''}
            }};` }));
      } }], logLevel: 'silent' });
    const mod = await import(pathToFileURL(output).href);
    const [note, duplicate] = await Promise.all([mod.ensureHelperCurrent(), mod.ensureHelperCurrent()]);
    const lines = existsSync(events) ? readFileSync(events, 'utf8').trim().split('\n') : [];
    assert.deepEqual(lines, scenario === 'current' ? [] : ['install', ...(['stale', 'restart-failure'].includes(scenario) ? ['restart'] : [])], scenario);
    assert.equal(duplicate, undefined, 'concurrent callers share one installation and one notification');
    assert.equal(mod.autoInstallFailed(), scenario.endsWith('failure'));
    if (scenario.endsWith('failure')) assert.match(note, /Could not install.*fixture (install|restart) failure/);
    else if (scenario === 'stale') assert.match(note, /^Updated/);
    else if (scenario === 'missing') assert.match(note, /^Installed/);
    else assert.equal(note, undefined);
    console.log(`PASS ${scenario}`);
  }
} finally { rmSync(temp, { recursive: true, force: true }); }
