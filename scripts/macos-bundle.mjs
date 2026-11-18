// A sealed helper travels as a ZIP: Electron's outer --deep signing must never
// re-sign it. Runtime operations here only verify, copy and register the app.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export const appName = 'tangu-computer-use.app';
export const bundleId = 'com.forsion.tangu-computer-use';
// Release helpers are signed with the project's Developer ID Application certificate (Apple team below), with
// the hardened runtime and a secure timestamp, so they pass Apple notarization inside the Forsion Desktop app.
// macOS files the Accessibility and Screen Recording grants under the designated requirement, which for Developer
// ID code names the bundle id and the team, not one certificate: renewing the certificate keeps every grant.
// Never change the bundle id or the team. Releases up to 0.7.x used a self-signed certificate
// (legacyReleaseCertSha1); moving off it costs every macOS user one new grant, and installMacosApp clears the
// stale grant rows so macOS asks again instead of showing a switch that is on but does nothing. The private key
// lives only in the GitHub secrets DEVELOPER_ID_P12 / DEVELOPER_ID_P12_PASSWORD; the release workflow signs with
// it and scripts/verify-package.mjs refuses a helper signed by anything else.
export const releaseTeamId = 'F3DBC75233';
export const legacyReleaseCertSha1 = 'dab3a30e7568c7e2c021660b49398356a205a191';
// The requirement codesign derives for Developer ID code (verify-package compares it word for word).
export const releaseDesignatedRequirement = `identifier "${bundleId}" and anchor apple generic`
  + ' and certificate 1[field.1.2.840.113635.100.6.2.6] /* exists */'
  + ' and certificate leaf[field.1.2.840.113635.100.6.1.13] /* exists */'
  + ` and certificate leaf[subject.OU] = ${releaseTeamId}`;
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

// The grant row keeps the requirement of the binary the user approved. Installing a differently signed
// helper under the same bundle id leaves the switch on while the helper reads "not granted" until the user
// removes and re-adds it, so a real install takes only the release signature. Development builds
// (ad-hoc or a dev certificate) opt in explicitly and accept granting access again.
export const releaseRequirement = `=${releaseDesignatedRequirement}`;
export const allowUnpinnedHelper = env => env.PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE === '1';

export function isReleaseSigned(app) {
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', '-R', releaseRequirement, app], { stdio: 'pipe', timeout: 15_000 });
    return true;
  } catch { return false; }
}

// Display only (no private key): the requirement macOS filed the grants under. null when it cannot be read.
export function designatedRequirement(app) {
  try {
    const shown = execFileSync('/usr/bin/codesign', ['-d', '-r-', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000 });
    return shown.match(/^(?:# )?designated => (.*)$/m)?.[1]?.trim() ?? null;
  } catch (error) {
    const text = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    return text.match(/^(?:# )?designated => (.*)$/m)?.[1]?.trim() ?? null;
  }
}

// The grant rows of the previous helper name its requirement; the new one never matches them, and macOS shows the
// switch on while the helper reads "not granted". Clearing them makes the next request a normal prompt.
function resetStaleGrants() {
  try {
    execFileSync('/usr/bin/tccutil', ['reset', 'All', bundleId], { stdio: 'pipe', timeout: 10_000 });
    console.log('[tangu-computer-use] the helper signature changed; cleared its old privacy grants so macOS asks again');
  } catch (error) {
    console.error(`[tangu-computer-use] the helper signature changed but its old privacy grants could not be cleared: ${error.message}`);
  }
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
    let changed = false, resetGrants = false;
    if (!macosAppMatches(app, metadata)) {
      const staging = await fs.mkdtemp(path.join(parent, '.tangu-computer-use-install-'));
      const next = path.join(staging, appName), old = path.join(staging, 'previous.app');
      let movedOld = false;
      try {
        execFileSync('/usr/bin/ditto', ['-x', '-k', archive, staging], { stdio: 'pipe', timeout: 30_000 });
        if (!macosAppMatches(next, metadata)) throw new Error('The bundled Computer Use helper signature or contents are invalid.');
        // A disposable copy that LaunchServices never sees (register: false) cannot touch the grant row.
        if (register && !allowUnpinnedHelper(process.env) && !isReleaseSigned(next)) {
          throw new Error('The bundled Computer Use helper is not signed with the release certificate (Developer ID, team ' + releaseTeamId + '). Installing it would make macOS ignore the existing Accessibility and Screen Recording grants. For a development build, set PI_COMPUTER_USE_ALLOW_ADHOC_UPDATE=1 and grant access again afterwards.');
        }
        const previousRequirement = register && existsSync(app) ? designatedRequirement(app) : null;
        if (existsSync(app)) { await fs.rename(app, old); movedOld = true; }
        try { await fs.rename(next, app); }
        catch (error) { if (movedOld) await fs.rename(old, app); throw error; }
        changed = true;
        if (previousRequirement && previousRequirement !== designatedRequirement(app)) resetGrants = true;
      } finally {
        // If rollback itself failed, preserve the previous app for recovery.
        if (!movedOld || existsSync(app)) await fs.rm(staging, { recursive: true, force: true });
      }
    }
    if (register) {
      const command = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';
      try { execFileSync(command, ['-f', app], { stdio: 'pipe', timeout: 10_000 }); } catch { /* open will register it as well */ }
      if (resetGrants) resetStaleGrants();
    }
    return changed;
  });
}
