// Exercise a window that is replaced between enumeration and capture.
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
if (process.platform !== 'darwin') process.exit(0);
const dir = mkdtempSync(path.join(tmpdir(), 'cu-native-discovery-'));
try {
  const file = path.join(dir, 'discovery.mjs');
  await build({ stdin: { contents: "export {runEnsureApp} from './src/tools.ts'; export {withOverlayRun} from './src/overlayState.ts'; export {rememberClick, clickReceipt} from './src/backgroundRecovery.ts'", resolveDir: process.cwd() }, outfile: file, platform: 'node', bundle: true, format: 'esm',
    alias: { '@earendil-works/pi-coding-agent': path.resolve('src/pi-compat.ts') },
    banner: {js:"import { createRequire } from 'node:module';const require = createRequire(import.meta.url);"} });
  const { runEnsureApp, withOverlayRun, rememberClick, clickReceipt } = await import(pathToFileURL(file).href);
  for (const code of ['window_not_found', 'root_not_found']) {
    for (const deliver of [true, false]) {
      const roots = [], captures = [];
      const backend = {
        screenLocked: async () => { throw new Error('A capturable window needs no lock probe'); },
        listApps: async () => [{ pid: 19, bundleId: 'test.local', appName: 'Fixture' }],
        async find(_id, query) {
          assert.equal(query.bundleId, 'test.local');
          const ref = '@r' + (roots.length + 1);
          roots.push(ref);
          return { content: [{ type: 'text', text: 'Window\n' + ref + ' Fixture' }],
            details: { windows: [{ pid: 19, windowRef: ref }] } };
        },
        async observe(_id, {root}) {
          captures.push(root);
          if (root === '@r1') throw Object.assign(new Error('capture failed'), {code});
          return {content: [{type: 'text', text: 'Use image coordinates for ' + root}, {type: 'image', data: 'Zg=='}],
            details: {tool:'observe_ui', pixelsOnly:true, root:{ref:root}}};
        }
      };
      const result = await runEnsureApp({ bundleId: 'test.local', mode: 'pixels' },
        {collectImage: () => deliver}, { cwd: dir }, backend);
      assert.deepEqual(captures, ['@r1','@r2']);
      assert.ok(!result.includes('@r1'));
      assert.equal(result.includes('Use image coordinates'), deliver);
      assert.equal(result.includes('Screenshot unavailable for @r2'), !deliver);
    }
  }
  const raised = [];
  const window = { pid: 19, windowId: 572, windowRef: '@r2', isOnscreen: true };
  const backend = {
    listApps: async () => [{ pid: 19, bundleId: 'test.local', appName: 'Fixture' }],
    find: async () => ({ content: [], details: { windows: [window] } }),
    getFrontmost: async (_signal, requireExact) => { assert.strictEqual(requireExact, true); return window; },
    activate: async target => { raised.push(target); return true; }
  };
  const request = (foregroundRoot, allowed = true) => runEnsureApp({ bundleId: 'test.local', mode: 'roots', foregroundRoot },
    { runId: 'local-run' }, { cwd: dir, foregroundAllowed: allowed }, backend);
  await request(undefined);
  await assert.rejects(request('@r1'), /Window unavailable/);
  await assert.rejects(request('@r2', false), /Foreground access is unavailable/);
  window.isOnscreen = false;
  await assert.rejects(request('@r2'), /background first/);
  assert.deepEqual(raised, []);
  window.isOnscreen = true;
  assert.match(await request('@r2'), /Brought test.local @r2 forward/);
  assert.deepEqual(raised, [{ pid: 19, windowId: 572 }]);
  const exact = { pid: window.pid, windowId: window.windowId };
  const capture = { stateId: 'new-frame', timestamp: Date.now() };
  for (const outcome of ['lost-focus', 'not-raised', 'wrong-window', 'sibling-focused', 'no-image', 'no-capture', 'full-queue', 'root_not_found', 'window_not_found', 'capture_failed', 'focus-pending', 'success']) {
    await withOverlayRun('recovery-' + outcome, async () => {
      rememberClick(exact, { x: 0.5, y: 0.5 }, undefined, true);
      let activations = 0, observations = 0;
      const recovery = {
        ...backend,
        getFrontmost: async () => outcome === 'focus-pending' && observations === 1 ? {pid: exact.pid} : outcome === 'sibling-focused' ? { ...exact, windowId: 999 } : exact,
        listApps: async () => [{ pid: exact.pid, bundleId: 'test.local', appName: 'Fixture', isFrontmost: outcome !== 'lost-focus' }],
        activate: async () => { activations++; return outcome !== 'not-raised'; },
        observe: async () => {
          observations++;
          if (observations === 1 && ['root_not_found', 'window_not_found', 'capture_failed'].includes(outcome)) {
            throw Object.assign(new Error('temporary capture failure'), { code: outcome });
          }
          return {
            content: outcome === 'no-image' ? [] : [{ type: 'image', data: 'Zg==', mimeType: 'image/png' }],
            details: { tool: 'observe_ui', pixelsOnly: true, root: { ref: '@r2' },
              capture: outcome === 'no-capture' ? undefined : capture,
              target: outcome === 'wrong-window' ? { ...exact, windowId: 999 } : exact }
          };
        }
      };
      const attempt = () => runEnsureApp({ bundleId: 'test.local', foregroundRoot: '@r2' },
        { runId: 'local-run', collectImage: () => outcome !== 'full-queue' }, { cwd: dir, foregroundAllowed: true }, recovery);
      if (outcome === 'full-queue') {
        await assert.rejects(attempt(), error => error.code === 'image_queue_full' && /image queue is full/.test(error.message));
        assert.equal(clickReceipt(exact).phase, 'foreground');
        await assert.rejects(attempt(), /already/);
      } else if (['success', 'root_not_found', 'window_not_found', 'capture_failed', 'focus-pending'].includes(outcome)) {
        assert.match(await attempt(), /Mini recovery brought/);
        assert.deepEqual(clickReceipt(exact).freshCapture, capture);
        assert.equal(observations, outcome === 'success' ? 1 : 2);
      } else {
        await assert.rejects(attempt(), { code: 'computer_use_recovery_exhausted' });
        assert.equal(clickReceipt(exact).phase, 'blocked');
        await assert.rejects(attempt(), { code: 'computer_use_recovery_exhausted' });
      }
      assert.equal(activations, 1);
    });
  }
  for (const running of [false, true]) {
    const backend = {
      screenLocked: async () => true,
      listApps: async () => running ? [{ pid: 19, bundleId: 'test.local', appName: 'Fixture' }] : [],
      async find() {
        assert.ok(running, 'a cold launch must stop before window enumeration');
        return { content: [], details: { windows: [] } };
      },
      observe: async () => assert.fail('no target to capture')
    };
    const result = await runEnsureApp({ bundleId: 'test.local' }, {}, { cwd: dir }, backend);
    assert.match(result, /screen_locked.*test\.local.*unlock their Mac/);
  }
  console.log('PASS unavailable targets on a locked desktop end with a request to unlock');
  console.log('PASS fresh window and image delivery for both native capture errors');
} finally { rmSync(dir, { recursive: true, force:true }); }
