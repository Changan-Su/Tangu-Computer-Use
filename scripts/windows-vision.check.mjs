import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { build } from 'esbuild';

// This check deliberately uses foreground native input. Never run it on the
// developer's occupied desktop; a dedicated runner owns the whole desktop.
if (process.platform !== 'win32' || process.env.GITHUB_ACTIONS !== 'true') throw new Error('Windows vision input check requires a dedicated GitHub Actions Windows desktop');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'outputs/windows-vision'); fs.mkdirSync(out, { recursive: true });
const home = fs.mkdtempSync(path.join(out, 'run-'));
const stateFile = path.join(home, 'state.json'), commandFile = path.join(home, 'command');
process.env.PI_COMPUTER_USE_WINDOWS_HELPER_PATH = path.join(home, 'helper/windows-bridge.exe');
const bundle = path.join(root, 'tangu-plugins/computer-use/dist', `.windows-vision-${process.pid}.mjs`);
await build({ stdin: { contents: [
  "export { executeFind, executeObserve, executeAct } from './src/vendor/bridge.ts'",
  "export { syncSettings, render, buildToolProvider } from './src/tools.ts'",
  "export { windowsHelper } from './src/vendor/platform/windows/helper.ts'",
].join('\n'), resolveDir: root, loader: 'ts' }, bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: bundle,
  external: ['node:*'], alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
let cu; try { cu = await import(pathToFileURL(bundle).href); } finally { fs.rmSync(bundle, { force: true }); }
const quote = value => "'" + value.replaceAll("'", "''") + "'";
const script = `Add-Type -AssemblyName System.Windows.Forms; Add-Type -TypeDefinition (Get-Content -LiteralPath ${quote(path.join(root, 'scripts/vision-fixture/windows.cs'))} -Raw) -ReferencedAssemblies System.Windows.Forms,System.Drawing; [WindowsVisionFixture]::Run(${quote(stateFile)},${quote(commandFile)})`;
const fixture = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const state = () => { try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return null; } };
async function until(name, predicate, timeout = 15000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const current = state(); if (current && await predicate(current)) return current; await sleep(100); }
  throw new Error(`${name}: last state ${JSON.stringify(state())}`);
}
const checks = [];
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${detail}`); assert.ok(ok, name); };
const ctx = { cwd: root, hasUI: false, ui: { notify() {}, select: async () => undefined }, sessionManager: { getBranch: () => [] } };
let settings = { headless: false, browser_use: false, cursor_overlay: false };
const store = { getScopeSettings: () => settings, isPluginEnabledSync: () => true };
const sync = () => cu.syncSettings(store);
const collected = [];
function imageSize(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  assert.equal(bytes.readUInt16BE(0), 0xffd8, 'screenshot must be JPEG or PNG');
  let offset = 2;
  while (offset + 8 < bytes.length) {
    assert.equal(bytes[offset++], 0xff, 'JPEG marker');
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++], length = bytes.readUInt16BE(offset);
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    assert.ok(length >= 2); offset += length;
  }
  throw new Error('JPEG screenshot has no size marker');
}
const tcx = { collectImage: image => { collected.push(image); fs.writeFileSync(path.join(home, `screen-${collected.length}.jpg`), Buffer.from(image.url.split(',')[1], 'base64')); } };
const shown = (result, args) => { const before = collected.length; result.said = cu.render(result, tcx, args); if (collected.length > before) result.actualImageSize = imageSize(Buffer.from(collected.at(-1).url.split(',')[1], 'base64')); fs.writeFileSync(path.join(home, `tool-${Date.now()}.json`), JSON.stringify({ said: result.said, details: result.details, actualImageSize: result.actualImageSize }, null, 2)); return result; };
const front = async () => { const roots = await cu.windowsHelper.command('listRoots'); return (Array.isArray(roots) ? roots : roots.roots).find(row => row.isFocused); };
let rootRef;
const observe = async () => shown(await cu.executeObserve('', { root: rootRef, mode: 'visual' }, undefined, undefined, ctx), {});
const act = async (seen, actions, expect) => {
  const args = { stateId: seen.details.capture.stateId, actions, ...(expect ? { expect } : {}) };
  return shown(await cu.executeAct('', args, undefined, undefined, ctx), args);
};
const cover = async () => {
  fs.writeFileSync(commandFile, 'cover');
  let root;
  await until('native cover appears', async s => {
    const result = await cu.windowsHelper.command('listRoots');
    root = (Array.isArray(result) ? result : result.roots).find(window => window.windowId === s.cover);
    return !!root;
  });
  // WinForms Activate alone can be denied by Windows' foreground lock on CI.
  // Establish the test precondition through the real helper's focus command.
  await cu.windowsHelper.command('focusWindow', { rootRef: root.rootRef });
  await until('cover foreground', async s => (await front())?.windowId === s.cover);
};
try {
  const boot = await until('native fixture started and visible to Windows', s => s.hwnd > 0 && s.visible);
  sync();
  const provider = cu.buildToolProvider(store);
  const browserTools = () => provider.tools().filter(tool => tool.isEnabledFor({ capabilities: { hostExec: true } })).filter(tool => /_browser$/.test(tool.name));
  check('browser tools are hidden before any tool call when disabled', browserTools().length === 0);
  settings = { ...settings, browser_use: true };
  check('enabling browser tools restores their definitions', browserTools().some(tool => tool.name === 'navigate_browser'));
  settings = { ...settings, browser_use: false }; sync();
  let found;
  await until('fixture discoverable through real find_roots', async () => {
    found = await cu.executeFind('', { pid: boot.pid, text: 'Forsion CU Windows Fixture' }, undefined, undefined, ctx);
    fs.writeFileSync(path.join(home, 'find-roots.json'), JSON.stringify(found, null, 2));
    rootRef = found.details?.windows?.find(window => window.pid === boot.pid && window.windowTitle === 'Forsion CU Windows Fixture')?.windowRef;
    return !!rootRef;
  });
  check('real Windows helper finds the fixture', !!rootRef);
  let seen = await observe();
  check('visual image note uses the actual screenshot dimensions', seen.actualImageSize?.width === seen.details.capture.width && seen.actualImageSize?.height === seen.details.capture.height && seen.said.includes(`[image] The attached screenshot is ${seen.actualImageSize.width}x${seen.actualImageSize.height} px`), seen.said);
  check('Windows image note does not claim pixel scroll distances', !seen.said.includes('scrollX / scrollY distance'));
  const point = (x, y) => {
    const s = state(), scale = seen.actualImageSize.width / s.width;
    return { x: Math.round((s.clientX - s.left + x) * scale), y: Math.round((s.clientY - s.top + y) * scale) };
  };
  await cover();
  const before = state().topIndex;
  const scrolled = await act(seen, [{ action: 'scroll', ...point(120, 210), scrollY: 3 }]);
  await until('coordinate scroll changes native list position', s => s.topIndex > before);
  check('coordinate scroll uses foreground native input', scrolled.said.includes('[foreground]'), scrolled.said);
  check('Windows scroll does not show macOS scroll note', !scrolled.said.includes('[scroll]'));
  seen = await observe();
  const drags = state().drags;
  const dragged = await act(seen, [{ action: 'drag', path: [point(360, 140), point(540, 300)] }]);
  await until('coordinate drag draws a native line', s => s.drags > drags);
  check('coordinate drag uses foreground native input', dragged.said.includes('[foreground]'), dragged.said);
  seen = await observe();
  const absent = await act(seen, [{ action: 'click', ...point(80, 32) }], { text: 'IMPOSSIBLE_WINDOWS_EXPECT_MARKER', timeoutMs: 700 });
  check('unsatisfied expect is reported after a delivered action', absent.said.includes('[expect] NOT satisfied') && state().presses > 0, absent.said);
  settings = { ...settings, headless: true, cursor_overlay: true }; sync();
  await cover(); seen = await observe();
  const strictIndex = state().topIndex;
  const strict = await act(seen, [{ action: 'scroll', ...point(120, 210), scrollY: 3 }]).catch(error => {
    assert.match(error.message, /Background policy blocks global Windows coordinate\/raw input grounding/);
    return { said: error.message, blocked: true };
  });
  const strictErrors = strict.details?.execution?.steps?.map(step => step.error?.code) || [];
  check('strict background rejects coordinate input without native scrolling', (strict.blocked || strictErrors.includes('coordinate_blocked')) && state().topIndex === strictIndex, JSON.stringify(strict.details?.execution));
  check('strict background survives tool config reload', !strict.said.includes('[foreground]') && (await front())?.windowId === state().cover, strict.said);
  seen = await observe();
  const outline = seen.details.renderedOutline || '';
  const button = outline.split('\n').find(line => line.includes('Fixture button'))?.match(/@e\d+/)?.[0];
  check('native accessibility button has a reference', !!button, outline);
  const presses = state().presses;
  await act(await observe(), [{ action: 'click', ref: button }]);
  await until('strict background reference click works', s => s.presses > presses);
  check('reference click keeps the cover foreground', (await front())?.windowId === state().cover);
  seen = await observe();
  const input = seen.details.renderedOutline.split('\n').find(line => line.includes('Fixture input'))?.match(/@e\d+/)?.[0];
  check('native text input has a reference', !!input);
  await act(seen, [{ action: 'setText', ref: input, text: 'Windows background text' }]);
  await until('strict background setText changes the native input', s => s.input === 'Windows background text');
  check('setText keeps the cover foreground', (await front())?.windowId === state().cover);
  seen = await observe();
  const list = seen.details.renderedOutline.split('\n').find(line => line.includes('Native scroll list'))?.match(/@e\d+/)?.[0];
  check('native scroll list has a reference', !!list);
  const at = state().topIndex;
  const refScroll = await act(seen, [{ action: 'scroll', ref: list, scrollY: 3 }]);
  await until('reference scroll changes the native list', s => s.topIndex > at);
  check('reference scroll stays in the background', !refScroll.said.includes('[foreground]') && (await front())?.windowId === state().cover, refScroll.said);
  settings = { ...settings, headless: false, cursor_overlay: false }; sync();
  seen = await observe();
  const resumed = await act(seen, [{ action: 'scroll', ...point(120, 210), scrollY: 3 }]);
  check('disabling strict background restores foreground routing', resumed.said.includes('[foreground]'), resumed.said);
} finally {
  try { fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ checks, home }, null, 2)); }
  finally {
    try { cu.windowsHelper.dispose(); }
    finally {
      try { if (fixture.exitCode === null) { fs.writeFileSync(commandFile, 'close'); await Promise.race([new Promise(resolve => fixture.once('exit', resolve)), sleep(3000)]); } }
      finally { if (fixture.exitCode === null) fixture.kill(); }
    }
  }
}
