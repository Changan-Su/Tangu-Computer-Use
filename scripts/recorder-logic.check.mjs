#!/usr/bin/env node
// 电脑历史采集器(activity_recorder.swift)的单测:照 highlight / mini-foreground 的做法,临时编一个 @main 可执行文件跑一遍。
// 不需要任何授权;非 macOS 直接跳过。大部分是纯逻辑;订阅流那一组走真实订阅路径 —— 会装上 NSWorkspace 观察者与
// NSEvent 全局监听、对前台 App 发 AX 读取(没有辅助功能授权时读取失败、键盘监听收不到东西),
// 并断言最后一个订阅者走后这些全部拆掉。只断言形状,不打印事件内容。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('recorder logic check skipped (not macOS)');
  process.exit(0);
}

const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-recorder-logic-'));
try {
  execFileSync('xcrun', [
    'swiftc', '-target', triple, '-parse-as-library',
    '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-recorder-test-cache-${process.arch}`),
    '-framework', 'AppKit',
    '-framework', 'ApplicationServices',
    path.join(root, 'native/macos/activity_recorder.swift'),
    path.join(root, 'native/macos/activity_recorder_tests.swift'),
    '-o', path.join(temp, 'test'),
  ], { stdio: 'inherit' });
  execFileSync(path.join(temp, 'test'), [], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
