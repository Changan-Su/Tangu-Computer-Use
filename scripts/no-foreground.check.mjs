#!/usr/bin/env node
/**
 * 前台行为的回归仪器。两部分:
 *   1) 默认:foregroundNote 判据的纯单测(免 TCC/免真机,CI 可跑)。钉住「什么算夺取前台」的定义,
 *      防上游同步或重构悄悄让透明化提示失效。需先 `npm run build`(读 dist/foregroundNote.js)。
 *   2) --live:ensure_app 的「后台启动不抢前台」不变量——open -g 一个临时文件到 TextEdit,断言终端仍是
 *      前台(TextEdit 没跳到前台)。需 macOS。这是我新增行为(ensure_app/透明化)的真机绿灯,不重复测 vendor。
 *
 * 用法: node scripts/no-foreground.check.mjs [--live]
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));

async function unitTests() {
  const { foregroundNote } = await import(path.join(here, '..', 'tangu-plugins', 'computer-use', 'dist', 'foregroundNote.js'));
  const has = (s) => s.includes('[foreground]');

  // 无信号 → 空串
  assert.equal(foregroundNote(undefined), '', 'undefined → empty');
  assert.equal(foregroundNote(null), '', 'null → empty');
  assert.equal(foregroundNote({}), '', 'no signals → empty');
  assert.equal(foregroundNote({ delivery: 'ax', deliveryPolicy: 'background' }), '', 'pure background → empty');
  assert.equal(foregroundNote({ steps: [{ delivery: 'ax' }, { delivery: 'pid', deliveryPolicy: 'background' }] }), '', 'all-background steps → empty');

  // 各前台信号 → 提示
  assert.ok(has(foregroundNote({ escalatedToForeground: true })), 'escalated → note');
  assert.ok(has(foregroundNote({ delivery: 'hid' })), 'hid delivery → note');
  assert.ok(has(foregroundNote({ deliveryPolicy: 'foreground' })), 'foreground policy → note');

  // ⚠️坐标点击在 TS 层恒被判 needsForeground → policy 恒为 foreground;helper 却可能用 AX 命中测试
  // 在后台完成它。这时报「抢了前台」是**反的**,比不报更坏。
  assert.equal(foregroundNote({ delivery: 'ax', deliveryPolicy: 'foreground' }), '', 'ax delivery under a foreground policy → no note');
  assert.ok(has(foregroundNote({ delivery: 'ax', deliveryPolicy: 'foreground', escalatedToForeground: true })), 'ax + escalated → still a note');
  assert.ok(has(foregroundNote({ steps: [{ delivery: 'ax', deliveryPolicy: 'foreground' }, { delivery: 'hid' }] })), 'any hid step → note');
  assert.ok(has(foregroundNote({ steps: [{ delivery: 'ax' }, { escalatedToForeground: true }] })), 'any escalated step → note');

  // 升级原因透传
  const withReason = foregroundNote({ escalatedToForeground: true, escalationReason: 'foreground_required' });
  assert.ok(withReason.includes('foreground_required'), 'reason surfaced');

  console.log('✓ unit: foregroundNote 判据 9 项全过');
}

async function frontmostBundleId() {
  const { stdout } = await execFileP('osascript', ['-e',
    'tell application "System Events" to get bundle identifier of first application process whose frontmost is true']);
  return stdout.trim();
}

async function liveTest() {
  if (process.platform !== 'darwin') { console.log('· live: 跳过(非 macOS)'); return; }
  const before = await frontmostBundleId();
  const dir = mkdtempSync(path.join(tmpdir(), 'cu-nofg-'));
  const file = path.join(dir, 'cu-no-foreground-probe.txt');
  writeFileSync(file, 'probe\n');
  try {
    // -g:后台打开(TextEdit 承接 .txt),不应置前台。
    await execFileP('open', ['-g', '-e', file], { timeout: 8_000 });
    await new Promise((r) => setTimeout(r, 1500));
    const after = await frontmostBundleId();
    assert.equal(after, before, `frontmost changed: ${before} → ${after}(后台启动却抢了前台)`);
    assert.notEqual(after, 'com.apple.TextEdit', 'TextEdit 跳到了前台');
    console.log(`✓ live: 后台启动 TextEdit,前台仍是 ${after}(未被抢)`);
  } finally {
    await execFileP('osascript', ['-e', 'tell application "TextEdit" to close (every document whose path is "' + file + '")']).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

const live = process.argv.includes('--live');
await unitTests();
if (live) await liveTest();
console.log(`\n✅ no-foreground check 通过${live ? '(含 --live)' : ''}`);
