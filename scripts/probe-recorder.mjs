#!/usr/bin/env node
// Computer History step-0 probe (macOS). Builds scripts/probe-recorder/probe.swift into a tiny
// LSUIElement app with its own bundle id, so its Accessibility grant is separate from the helper's and
// it holds NO Screen Recording grant — the point is to prove what Accessibility alone can read.
//   node scripts/probe-recorder.mjs build            -> build/ch-probe.app (Apple Development identity if present, else ad-hoc)
//   node scripts/probe-recorder.mjs run [seconds]    -> launches it, waits, prints the JSON report path
// Grant once: System Settings > Privacy & Security > Accessibility > ch-probe. A stable signing identity
// keeps that grant across rebuilds; an ad-hoc build needs re-granting after every rebuild.
// Private-window detection (Safari is recorded as untitled switches only until this is settled): put a private
// window in front of the browser, `run 5`; then a normal window, `run 5`; compare the rows' `privateSignals`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const app = path.join(root, 'build/ch-probe.app');
const [cmd = 'build', seconds = '90'] = process.argv.slice(2);

if (cmd === 'build') {
	rmSync(app, { recursive: true, force: true });
	mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
	execFileSync('swiftc', ['-O', path.join(root, 'scripts/probe-recorder/probe.swift'), '-o', path.join(app, 'Contents/MacOS/probe')], { stdio: 'inherit' });
	writeFileSync(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.forsion.ch-probe</string>
<key>CFBundleName</key><string>ch-probe</string>
<key>CFBundleExecutable</key><string>probe</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`);
	const ids = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
	const identity = ids.match(/"(Apple Development:[^"]+)"/)?.[1] ?? '-';
	execFileSync('codesign', ['--force', '--sign', identity, app], { stdio: 'inherit', timeout: 30_000 });
	console.log(`built ${app} (signed: ${identity === '-' ? 'ad-hoc' : identity})`);
} else if (cmd === 'run') {
	if (!existsSync(app)) throw new Error('run `node scripts/probe-recorder.mjs build` first');
	const out = path.join(os.tmpdir(), `ch-probe-${process.pid}.json`);
	rmSync(out, { force: true });
	execFileSync('open', ['-n', '-g', app, '--args', out, seconds]);
	const deadline = Date.now() + (Number(seconds) + 30) * 1000;
	while (!existsSync(out) && Date.now() < deadline) execFileSync('sleep', ['1']);
	console.log(existsSync(out) ? out : 'probe produced no report (not granted? crashed?)');
} else {
	throw new Error(`unknown command ${cmd}`);
}
