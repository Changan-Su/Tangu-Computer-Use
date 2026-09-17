#!/usr/bin/env node
// Run against the actual distributed package, including after Electron signing.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appName, bundledMacosApp, macosAppMatches, sha256 } from './macos-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const arch of ['arm64', 'x64']) {
  const { archive, metadata } = bundledMacosApp(root, arch);
  assert.equal(sha256(await fs.readFile(archive)), metadata.archiveSha256, `${arch}: archive checksum mismatch`);
  if (process.platform === 'darwin') {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-verify-bundle-'));
    try {
      execFileSync('/usr/bin/ditto', ['-x', '-k', archive, temp]);
      const app = path.join(temp, appName);
      assert.ok(macosAppMatches(app, metadata), `${arch}: sealed app contents/signature/identity mismatch`);
      execFileSync('/usr/bin/lipo', [path.join(app, 'Contents/MacOS/bridge'), '-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64']);
    } finally { await fs.rm(temp, { recursive: true, force: true }); }
  }
  console.log(`PASS sealed macOS ${arch} helper ${metadata.version}`);
}
