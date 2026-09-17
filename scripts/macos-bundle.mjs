// A sealed helper travels as a ZIP: Electron's outer --deep signing must never
// re-sign it. Runtime operations here only verify, copy and register the app.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const appName = 'tangu-computer-use.app';
export const bundleId = 'com.forsion.tangu-computer-use';
export const sealedFiles = ['Contents/MacOS/bridge', 'Contents/Info.plist', 'Contents/_CodeSignature/CodeResources'];
export const sha256 = data => createHash('sha256').update(data).digest('hex');

export function bundledMacosApp(root, arch = process.arch) {
  for (const candidate of ['universal', arch]) {
    const dir = path.join(root, 'prebuilt/macos', candidate);
    const archive = path.join(dir, `${appName}.zip`);
    if (!existsSync(archive)) continue;
    const metadata = JSON.parse(readFileSync(path.join(dir, `${appName}.json`), 'utf8'));
    const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    if (metadata.bundleId !== bundleId || metadata.version !== version || !/^[a-f0-9]{64}$/.test(metadata.archiveSha256)
      || sealedFiles.some(file => !/^[a-f0-9]{64}$/.test(metadata.files?.[file]))) {
      throw new Error('The bundled Computer Use helper metadata is invalid. Reinstall or rebuild the plugin.');
    }
    return { archive, metadata };
  }
  throw new Error('The pre-signed Computer Use helper app is missing. Reinstall the plugin. For development, run npm run build:native on macOS.');
}

export function verifyMacosApp(app) {
  // -R pins the helper identity; signature verification never needs a private key.
  execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', `=identifier "${bundleId}"`, app],
    { stdio: 'pipe', timeout: 15_000 });
}

export function macosAppMatches(app, metadata) {
  try {
    if (sealedFiles.some(file => sha256(readFileSync(path.join(app, file))) !== metadata.files[file])) return false;
    verifyMacosApp(app);
    return true;
  } catch { return false; }
}

export function macosHelperIsCurrent(root, app) {
  return macosAppMatches(app, bundledMacosApp(root).metadata);
}

async function withInstallLock(app, work) {
  const lock = `${app}.install-lock`;
  async function abandoned() {
    const owner = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => ''));
    const age = Date.now() - (await fs.stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
    if (age <= 30_000) return false;
    if (!owner) return true;
    try { process.kill(owner, 0); return false; } catch (error) { return error.code === 'ESRCH'; }
  }
  const deadline = Date.now() + 30_000;
  while (true) {
    try { await fs.mkdir(lock); break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // A live owner, regardless of age, keeps its lock until replacement finishes.
      if (await abandoned()) {
        // Serialize stale-lock recovery and recheck inside it. Two recovering
        // installers must not delete a lock that the first has just acquired.
        const recovery = `${lock}.recovery`;
        const ownsRecovery = await fs.mkdir(recovery).then(() => true, error => { if (error.code === 'EEXIST') return false; throw error; });
        if (ownsRecovery) {
          try { if (await abandoned()) await fs.rm(lock, { recursive: true, force: true }); }
          finally { await fs.rm(recovery, { recursive: true, force: true }); }
          continue;
        }
      }
      if (Date.now() > deadline) throw new Error('Another Computer Use installation is still running. Retry when it finishes.');
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
  try { await fs.writeFile(path.join(lock, 'pid'), String(process.pid)); return await work(); }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}

export async function installMacosApp(root, app, { register = true } = {}) {
  if (!path.basename(app).endsWith('.app')) throw new Error('Helper destination must be an .app bundle.');
  const parent = path.dirname(app);
  await fs.mkdir(parent, { recursive: true });
  return withInstallLock(app, async () => {
    const { archive, metadata } = bundledMacosApp(root);
    if (sha256(await fs.readFile(archive)) !== metadata.archiveSha256) throw new Error('The bundled Computer Use helper archive is damaged. Reinstall the plugin.');
    let changed = false;
    if (!macosAppMatches(app, metadata)) {
      const staging = await fs.mkdtemp(path.join(parent, '.tangu-computer-use-install-'));
      const next = path.join(staging, appName), old = path.join(staging, 'previous.app');
      let movedOld = false;
      try {
        execFileSync('/usr/bin/ditto', ['-x', '-k', archive, staging], { stdio: 'pipe', timeout: 30_000 });
        if (!macosAppMatches(next, metadata)) throw new Error('The bundled Computer Use helper signature or contents are invalid.');
        if (existsSync(app)) { await fs.rename(app, old); movedOld = true; }
        try { await fs.rename(next, app); }
        catch (error) { if (movedOld) await fs.rename(old, app); throw error; }
        changed = true;
      } finally {
        // If rollback itself failed, preserve the previous app for recovery.
        if (!movedOld || existsSync(app)) await fs.rm(staging, { recursive: true, force: true });
      }
    }
    if (register) {
      const command = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
      try { execFileSync(command, ['-f', app], { stdio: 'pipe', timeout: 10_000 }); } catch { /* open will register it as well */ }
    }
    return changed;
  });
}
