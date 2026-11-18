#!/usr/bin/env node
// 屏上叠层(示意光标、点击环、边缘光)的离线检查(协议 20)。照 check:highlight 的做法临时编 @main 可执行文件跑,
// 不连 helper、不装任何东西、不要系统授权:
//   1. helper 全部源码 `swiftc -typecheck`(不出二进制、不签名;build:native 会重签并可能覆盖已装的 helper,这里不碰)。
//   2. agent_overlay_render_tests:画法是 (状态, 配色, 时刻) 的纯函数,在固定时刻画成 PNG —— 三种配色 × 浅 / 深底 ——
//      并断言几处像素颜色;另测整轮状态机、按时间算的飞行、样例字段的解析。
//   3. agent_cursor_tests(上游 INV-17 那份,以前没人跑):光标窗口的生命周期(淡出后才收窗口、换代的计时器不误收)。
//      会建几扇透明、点击穿透的覆盖层窗口,一闪即收。
// 用法:npm run check:cursor [-- --out <目录>](PNG 缺省写到临时目录,路径打印出来)。非 macOS 直接跳过。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.platform !== 'darwin') {
  console.log('cursor check skipped (not macOS)');
  process.exit(0);
}

const outFlag = process.argv.indexOf('--out');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'cu-cursor-check-'));
const out = outFlag >= 0 && process.argv[outFlag + 1] ? path.resolve(process.argv[outFlag + 1]) : path.join(temp, 'shots');
const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0';
const cache = path.join(os.tmpdir(), `tangu-cu-cursor-test-cache-${process.arch}`);
const src = (file) => path.join(root, 'native/macos', file);

// helper 的源码清单只有 build-native.mjs 那一份(真相源),从它读,别在这里再抄一遍。
const buildScript = fs.readFileSync(path.join(root, 'scripts/build-native.mjs'), 'utf8');
const listed = /const macosSourcePaths = \[([\s\S]*?)\]/.exec(buildScript);
if (!listed) throw new Error('scripts/build-native.mjs 里找不到 macosSourcePaths —— 写法变了,同步改 scripts/cursor.check.mjs');
const helperSources = [...listed[1].matchAll(/"([^"]+\.swift)"/g)].map((m) => src(m[1]));
for (const file of ['agent_overlay_model.swift', 'agent_overlay_paint.swift', 'agent_overlay_turn.swift']) {
  if (!helperSources.includes(src(file))) throw new Error(`${file} 不在 build-native.mjs 的 macosSourcePaths 里:helper 会编不进它`);
}

const swiftc = (args) => execFileSync('xcrun', ['swiftc', '-target', triple, '-module-cache-path', cache, ...args], { cwd: root, stdio: 'inherit' });

try {
  swiftc(['-typecheck', ...['ApplicationServices', 'AppKit', 'ScreenCaptureKit', 'Foundation', 'SwiftUI'].flatMap((f) => ['-framework', f]), ...helperSources]);
  console.log(`helper sources typecheck (${helperSources.length} files)`);

  const render = path.join(temp, 'render');
  swiftc(['-parse-as-library', '-framework', 'ImageIO',
    src('agent_cursor_motion.swift'), src('agent_overlay_model.swift'), src('agent_overlay_paint.swift'), src('agent_overlay_render_tests.swift'),
    '-o', render]);
  execFileSync(render, ['--out', out, '--fixtures', path.join(root, 'scripts/fixtures')], { stdio: 'inherit' });

  const lifecycle = path.join(temp, 'lifecycle');
  swiftc(['-parse-as-library', '-framework', 'AppKit', '-framework', 'SwiftUI',
    src('agent_cursor_motion.swift'), src('agent_overlay_model.swift'), src('agent_overlay_paint.swift'), src('agent_highlight.swift'),
    src('agent_cursor.swift'), src('agent_overlay_turn.swift'), src('agent_cursor_tests.swift'),
    '-o', lifecycle]);
  execFileSync(lifecycle, [], { stdio: 'inherit' });
  console.log('agent cursor lifecycle tests passed');
} finally {
  for (const name of ['render', 'lifecycle']) fs.rmSync(path.join(temp, name), { force: true });
  if (outFlag < 0) console.log(`(PNGs kept in ${out})`);
}
