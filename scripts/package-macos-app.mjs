// Build-time only. All private-key signing is opt-in here, never in setup-helper.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { appName, bundleId, sealedFiles, sha256, verifyMacosApp } from './macos-bundle.mjs';

export async function packageMacosApp(binary, outputDir, version, signArgs) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'cu-package-'));
  try {
    const app = path.join(temp, appName);
    await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
    await fs.copyFile(binary, path.join(app, 'Contents/MacOS/bridge'));
    await fs.chmod(path.join(app, 'Contents/MacOS/bridge'), 0o755);
    await fs.writeFile(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>tangu-computer-use</string>
<key>CFBundleDisplayName</key><string>tangu-computer-use</string>
<key>CFBundleExecutable</key><string>bridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleVersion</key><string>${version}</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>LSUIElement</key><true/>
</dict></plist>\n`);
    execFileSync('/usr/bin/codesign', [...signArgs, app], { stdio: 'inherit' });
    verifyMacosApp(app);
    const archive = path.join(temp, `${appName}.zip`);
    execFileSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, archive], { stdio: 'inherit' });
    const files = Object.fromEntries(await Promise.all(sealedFiles.map(async file => [file, sha256(await fs.readFile(path.join(app, file)))])));
    const metadata = { bundleId, version, archiveSha256: sha256(await fs.readFile(archive)), files };
    await fs.mkdir(outputDir, { recursive: true });
    await fs.copyFile(archive, path.join(outputDir, `${appName}.zip`));
    await fs.writeFile(path.join(outputDir, `${appName}.json`), JSON.stringify(metadata, null, 2) + '\n');
    console.log(`Packaged sealed helper app at ${outputDir}`);
  } finally { await fs.rm(temp, { recursive: true, force: true }); }
}
