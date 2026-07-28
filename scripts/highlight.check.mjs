#!/usr/bin/env node
// 边缘光效的几何单测(照上游 INV-17 跑 agent_cursor_tests 的做法:临时编一个 @main 可执行文件跑一遍)。
// 非 macOS 直接跳过 —— 光效本来就只有 mac 有。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('highlight check skipped (not macOS)');
  process.exit(0);
}

const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
const binary = path.join(os.tmpdir(), `tangu-cu-highlight-tests-${process.pid}`);
try {
  execFileSync('xcrun', [
    'swiftc', '-target', triple, '-parse-as-library',
    '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-highlight-test-cache-${process.arch}`),
    '-framework', 'AppKit',
    '-framework', 'SwiftUI',
    'native/macos/agent_highlight.swift',
    'native/macos/agent_highlight_tests.swift',
    '-o', binary,
  ], { cwd: root, stdio: 'inherit' });
  execFileSync(binary, [], { cwd: root, stdio: 'inherit' });
} finally {
  fs.rmSync(binary, { force: true });
}
