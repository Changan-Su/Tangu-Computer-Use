// `tangu computer-use setup|doctor` must let the process exit by itself. On Windows and Linux the helper is a
// stdio child whose open pipes keep the event loop alive, and the host deliberately never force-exits after a
// plugin command (long-running commands such as `tangu worker` live on their open handles). Runs the real cliMain
// in its own process with a helper of that shape and asserts the process ends within the deadline, with the
// command's exit code.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-cli-exit-'));
try {
  await build({ entryPoints: [path.resolve('src/setup.ts')], outfile: path.join(temp, 'cli.mjs'), bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'stdio-helper', setup(b) {
      b.onResolve({ filter: /\/vendor\/bridge\.ts$|\/helperState\.ts$/ }, (args) => ({ path: args.path, namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, (args) => ({ contents: args.path.endsWith('helperState.ts')
        ? `export const helperInstalled = () => !process.env.CU_FIXTURE_NO_HELPER; export const helperExecutablePath = () => 'fixture-helper';`
        : `import { spawn } from 'node:child_process';
           let child;
           export async function ensureComputerUseSetup() {
             child = spawn(process.execPath, ['-e', 'process.stdin.resume()'], { stdio: 'pipe' }); // same shape as the Windows/Linux helper
             if (process.env.CU_FIXTURE_FAIL) throw new Error('fixture helper is not ready');
           }
           export async function shutdownComputerUseSession() {
             if (!child) return;
             child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.kill();
             child = undefined;
           }` }));
    } }], logLevel: 'silent' });
  const runner = path.join(temp, 'run.mjs');
  // Mirrors the host: the returned code becomes the exit code, nothing forces the process to exit.
  writeFileSync(runner, `import { cliMain } from './cli.mjs';\nprocess.exitCode = await cliMain(process.argv.slice(2));\n`);
  for (const [name, args, env, code] of [
    ['setup succeeds', ['setup'], {}, 0],
    ['doctor succeeds', ['doctor'], {}, 0],
    ['setup fails after starting the helper', ['setup'], { CU_FIXTURE_FAIL: '1' }, 1],
    ['doctor fails after starting the helper', ['doctor'], { CU_FIXTURE_FAIL: '1' }, 1],
    ['doctor without an installed helper', ['doctor'], { CU_FIXTURE_NO_HELPER: '1' }, 1],
  ]) {
    const r = spawnSync(process.execPath, [runner, ...args], { env: { ...process.env, ...env }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(r.error?.code, undefined, `${name}: the process did not exit on its own (${r.error?.code})`);
    assert.equal(r.status, code, `${name}: exit code\n${r.stdout}${r.stderr}`);
    console.log(`PASS ${name}`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
