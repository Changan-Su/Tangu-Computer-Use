#!/usr/bin/env node
// Real install/repair checks in disposable directories. A Node preload traps all
// process launches, including absolute paths, before production modules load.
// No keychain access, LS registration, system permission prompt or user app.
import assert from 'node:assert/strict';
import { spawnSync, spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { bundledMacosApp, sha256, macosHelperIsCurrent, appName } from './macos-bundle.mjs';

if (process.platform !== 'darwin') {
  console.log('SKIP real macOS installer checks');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-keychain-free-'));
try {
  const trace = path.join(temp, 'commands.jsonl'), guard = path.join(temp, 'guard.mjs');
  await fs.writeFile(guard, `import cp from 'node:child_process';
    import fs from 'node:fs/promises';
    import {appendFileSync} from 'node:fs';
    import {syncBuiltinESMExports} from 'node:module';
    import path from 'node:path';
    for (const method of ['spawn','spawnSync','exec','execSync','execFile','execFileSync']) {
      const original = cp[method];
      cp[method] = function(command, args, ...rest) {
        const name = path.basename(command);
        appendFileSync(process.env.CU_TEST_TRACE, JSON.stringify({method,command,args})+'\\n');
        if (['security','openssl','xcrun'].includes(name) || method === 'exec' || method === 'execSync'
          || (name === 'codesign' && (!Array.isArray(args) || args[0] !== '--verify'))) {
          throw Error('Forbidden runtime signing/keychain command: '+command);
        }
        if (name === 'lsregister') return Buffer.alloc(0);
        return original.call(this, command, args, ...rest);
      };
    }
    syncBuiltinESMExports();
    if (process.env.CU_TEST_RENAME_FAIL === '1') {
      const rename = fs.rename;
      fs.rename = async (from, to) => {
        if (path.basename(from) === 'tangu-computer-use.app' && to === process.env.PI_COMPUTER_USE_HELPER_APP_PATH) {
          throw Object.assign(Error('fixture replacement failure'), {code:'EACCES'});
        }
        return rename(from, to);
      };
    }
  `);
  const installed = path.join(temp, 'Applications', appName);
  const env = { ...process.env, CU_TEST_TRACE: trace, PI_COMPUTER_USE_HELPER_APP_PATH: installed,
    // These old knobs must not opt runtime back into signing or key discovery.
    PI_COMPUTER_USE_CODESIGN_IDENTITY: 'must-never-use-user-key', PI_COMPUTER_USE_NO_SIGN: '0',
    PI_COMPUTER_USE_ALLOW_BUILD: '1' };
  function run(flags = [], source = root, extraEnv = {}) {
    const result = spawnSync(process.execPath, ['--import', pathToFileURL(guard).href, path.join(source, 'scripts/setup-helper.mjs'), ...flags],
      { env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 45_000 });
    assert.ifError(result.error);
    return result;
  }
  const install = () => { const result = run(['--runtime']); assert.equal(result.status, 0, result.stderr); };
  const check = status => { const result = run(['--check']); assert.equal(result.status, status, result.stderr); };
  const image = () => fs.readFile(path.join(installed, 'Contents/MacOS/bridge')).then(sha256);

  for (const arch of ['arm64', 'x64']) {
    const bundle = bundledMacosApp(root, arch);
    assert.equal(sha256(await fs.readFile(bundle.archive)), bundle.metadata.archiveSha256);
  }
  check(10);
  install();
  check(0);
  assert.ok(macosHelperIsCurrent(root, installed));
  const inode = (await fs.stat(installed)).ino, expected = await image();
  install();
  assert.equal((await fs.stat(installed)).ino, inode, 'current app must not be replaced');
  console.log('PASS first install / idempotent reinstall / current check');

  await fs.rm(path.join(installed, 'Contents/_CodeSignature'), { recursive: true });
  await fs.writeFile(path.join(installed, 'Contents/MacOS/bridge.cstemp'), 'interrupted old codesign');
  check(10); install(); check(0);
  assert.equal(await fs.access(path.join(installed, 'Contents/MacOS/bridge.cstemp')).then(() => true, () => false), false);
  assert.equal(await image(), expected);
  console.log('PASS rejected-keychain partial app repaired, including signature/temp residue');

  const info = path.join(installed, 'Contents/Info.plist');
  const packageVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  await fs.writeFile(info, (await fs.readFile(info, 'utf8')).replaceAll(packageVersion, '0.0.0'));
  check(10); install(); check(0);
  console.log('PASS same-protocol old app upgraded');

  await fs.appendFile(info, '<!-- old installation -->');
  const previousInfo = await fs.readFile(info, 'utf8');
  const failedReplacement = run(['--runtime'], root, { CU_TEST_RENAME_FAIL: '1' });
  assert.notEqual(failedReplacement.status, 0);
  assert.match(failedReplacement.stderr, /fixture replacement failure/);
  assert.equal(await fs.readFile(info, 'utf8'), previousInfo, 'replacement failure must restore previous app');
  install(); check(0);
  console.log('PASS atomic replacement rollback preserves previous app');

  // Bad/missing bundled assets must fail without changing an existing app and
  // without falling back to loose-binary signing, keychain discovery or downloads.
  const bad = path.join(temp, 'bad-package');
  await fs.mkdir(bad);
  for (const rel of ['scripts', 'src/vendor/platform/macos', 'prebuilt/macos', 'package.json']) {
    await fs.cp(path.join(root, rel), path.join(bad, rel), { recursive: true });
  }
  const badBundle = bundledMacosApp(bad);
  await fs.appendFile(badBundle.archive, 'corruption');
  const corrupted = run(['--runtime'], bad);
  assert.notEqual(corrupted.status, 0); assert.match(corrupted.stderr, /archive is damaged/);
  assert.equal(await image(), expected); check(0);
  await fs.rm(path.join(bad, 'prebuilt/macos'), { recursive: true });
  await fs.mkdir(path.join(bad, 'prebuilt/macos', process.arch), { recursive: true });
  await fs.copyFile(path.join(root, 'prebuilt/macos', process.arch, 'bridge'), path.join(bad, 'prebuilt/macos', process.arch, 'bridge'));
  const missing = run(['--runtime'], bad);
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /pre-signed.*missing/);
  assert.equal(await image(), expected); check(0);
  console.log('PASS corrupt/missing archives fail closed and preserve existing app');

  await fs.rm(path.join(installed, 'Contents/_CodeSignature'), { recursive: true });
  const staleLock = `${installed}.install-lock`;
  await fs.mkdir(staleLock);
  await fs.writeFile(path.join(staleLock, 'pid'), '0');
  await fs.utimes(staleLock, new Date(Date.now() - 60_000), new Date(Date.now() - 60_000));
  const concurrent = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', pathToFileURL(guard).href, path.join(root, 'scripts/setup-helper.mjs'), '--runtime'], { env, stdio: ['ignore','pipe','pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr)));
  });
  await Promise.all([concurrent(), concurrent()]);
  check(0);
  assert.deepEqual(await fs.readdir(path.dirname(installed)), [appName], 'no staging or lock residue');
  const commands = (await fs.readFile(trace, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.ok(commands.some(cmd => path.basename(cmd.command) === 'codesign'));
  assert.ok(commands.every(cmd => !['security','openssl','xcrun'].includes(path.basename(cmd.command))
    && (path.basename(cmd.command) !== 'codesign' || cmd.args[0] === '--verify')));
  console.log('PASS concurrent repair / stale-lock recovery / no runtime signing or keychain commands');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
