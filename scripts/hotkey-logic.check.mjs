#!/usr/bin/env node
// 全局手势订阅(hotkey_monitor.swift)的单测:照 recorder-logic 的做法,临时编一个 @main 可执行文件跑一遍。
// 不需要任何授权;非 macOS 直接跳过。纯逻辑(左右 ⌘ 状态机、从 flagsChanged 的标志算左右、窗口对齐、事件形状)之外,
// 订阅流那一组走真实订阅路径 —— 会装上 NSEvent 全局监听(没有辅助功能授权时收不到按键),按键由测试直接喂给
// 监听入口,不往系统里发任何事件;前台用假的,不读真实前台。断言最后一个订阅者走后监听全部拆掉。
// 与 activity_recorder.swift 一起编:订阅连接的写队列(RecorderSubscriber)是复用它的。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('hotkey logic check skipped (not macOS)');
  process.exit(0);
}

const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
const temp = mkdtempSync(path.join(os.tmpdir(), 'cu-hotkey-logic-'));
try {
  execFileSync('xcrun', [
    'swiftc', '-target', triple, '-parse-as-library',
    '-module-cache-path', path.join(os.tmpdir(), `tangu-cu-hotkey-test-cache-${process.arch}`),
    '-framework', 'AppKit',
    '-framework', 'ApplicationServices',
    path.join(root, 'native/macos/activity_recorder.swift'),
    path.join(root, 'native/macos/hotkey_monitor.swift'),
    path.join(root, 'native/macos/hotkey_monitor_tests.swift'),
    '-o', path.join(temp, 'test'),
  ], { stdio: 'inherit' });
  execFileSync(path.join(temp, 'test'), [], { stdio: 'inherit' });
} finally {
  rmSync(temp, { recursive: true, force: true });
}
