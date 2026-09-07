import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-mini-signal-'));
try {
  execFileSync('xcrun', ['swiftc', '-module-cache-path', path.join(temp, 'cache'), '-parse-as-library',
    path.join(root, 'native/macos/foreground_activity.swift'), path.join(root, 'native/macos/foreground_activity_tests.swift'), '-o', path.join(temp, 'test')], { stdio: 'inherit' });
  execFileSync(path.join(temp, 'test'), [], { stdio: 'inherit' });
} finally { rmSync(temp, { recursive: true, force: true }); }
