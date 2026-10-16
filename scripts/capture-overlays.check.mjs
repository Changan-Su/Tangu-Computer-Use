#!/usr/bin/env node
// 截图叠窗(capture_overlays.swift)的单测:照 hotkey-logic 的做法,临时编一个 @main 可执行文件跑一遍。
// 不需要任何授权(不截屏):哪些窗口要一起画进截图(拿 10-16 量到的微信窗口表当夹具)、全角折半角、
// 以及 Vision 用 helper 的语言设置读一张自己画的中英文图。非 macOS 直接跳过。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('capture overlays check skipped (not macOS)');
  process.exit(0);
}

const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-capture-overlays-'));
try {
  execFileSync('xcrun', [
    'swiftc', '-target', triple, '-parse-as-library',
    '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-overlays-test-cache-${process.arch}`),
    '-framework', 'AppKit',
    '-framework', 'Vision',
    path.join(root, 'native/macos/capture_overlays.swift'),
    path.join(root, 'native/macos/capture_overlays_tests.swift'),
    '-o', path.join(temp, 'test'),
  ], { stdio: 'inherit' });
  execFileSync(path.join(temp, 'test'), [], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
