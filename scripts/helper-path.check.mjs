#!/usr/bin/env node
// mac helper 安装位置的解析规则(照搬上游 check-macos-helper-path.mjs,路径改到 vendor)。
// 为什么值得留:v0.5.0 起 helper 不再固定装 /Applications —— 已有的可写系统安装留在原地,其余一律
// 装进 ~/Applications(标准用户无需管理员)。解析错 = 装到一处、运行时连另一处,doctor 全绿但真操作必失败。
import assert from 'node:assert/strict';
import path from 'node:path';
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs';

const homeDir = path.join(path.sep, 'Users', 'standard-user');
const systemHelperAppPath = path.join(path.sep, 'Applications', 'tangu-computer-use.app');
const userHelperAppPath = path.join(homeDir, 'Applications', 'tangu-computer-use.app');

assert.equal(
  resolveMacosHelperAppPath({ env: { PI_COMPUTER_USE_HELPER_APP_PATH: '/tmp/custom-helper.app' }, homeDir }),
  '/tmp/custom-helper.app',
  '显式路径优先',
);
assert.equal(
  resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => false }),
  userHelperAppPath,
  '全新安装走 ~/Applications',
);
assert.equal(
  resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => true, directoryIsWritable: () => true }),
  systemHelperAppPath,
  '已有的可写系统安装留在原地(不迁移 = 不用重新授权 TCC)',
);
assert.equal(
  resolveMacosHelperAppPath({ env: {}, homeDir, systemHelperAppPath, fileExists: () => true, directoryIsWritable: () => false }),
  userHelperAppPath,
  '标准用户从不可写的系统安装迁走',
);

// 品牌:app 名必须是 tangu-*,否则 native/setup-helper 与运行时对不上(P0 复发防线)。
assert.ok(
  resolveMacosHelperAppPath({ env: {}, homeDir, fileExists: () => false }).endsWith('tangu-computer-use.app'),
  'helper app 名必须品牌化',
);

// ── 自装/自更新的前置条件(症状:「首次安装和更新都要去终端敲 setup」)────────────────
// 自愈只有在 bundle **自带**安装脚本 + 随包二进制时才成立。这三样任缺其一,
// onboarding.ts 的 ensureHelperCurrent 就只能退回「请开终端」—— 而那正是要消灭的体验。
// 从**构建产物**的位置往上找,而不是从本脚本找:产物挪位过一次就是 P0(见 scripts/build.mjs)。
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifact = path.join(repoRoot, 'tangu-plugins', 'computer-use', 'dist', 'index.js');
assert.ok(existsSync(artifact), `构建产物不在 ${artifact} —— 先 npm run build`);

function bundleRootFrom(startFile) {
  let dir = path.dirname(startFile);
  for (let up = 0; up < 6; up++) {
    if (existsSync(path.join(dir, 'manifest.json')) && existsSync(path.join(dir, 'scripts', 'setup-helper.mjs'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
assert.equal(bundleRootFrom(artifact), repoRoot, '从产物往上必须能找到 bundle 根(manifest.json + scripts/setup-helper.mjs)');

const arch = process.arch === 'x64' ? 'x64' : 'arm64';
assert.ok(
  existsSync(path.join(repoRoot, 'prebuilt', 'macos', arch, 'bridge'))
    || existsSync(path.join(repoRoot, 'prebuilt', 'macos', 'universal', 'tangu-computer-use.app')),
  `bundle 里必须随包带 native helper(prebuilt/macos/${arch}/bridge 或 universal 的已签名 .app)—— 否则自装要联网,离线/内网必失败`,
);

// ⚠️自装绝不能杀安装子进程:它内部 codesign helper.app,被中断会留下 *.cstemp,下次 --deep 把它封进
// CodeResources 再删掉 → 签名恒定校验失败 → TCC 认签名 → 用户看到「权限开关怎么点都没用」。
// 这条错了**不会报错**,只会静默毁掉授权,所以用文本防线钉住(2026-07-28 真踩过)。
import { readFileSync } from 'node:fs';
const onboarding = readFileSync(path.join(repoRoot, 'src', 'onboarding.ts'), 'utf8');
assert.ok(!/child\.kill\(/.test(onboarding), 'src/onboarding.ts 不得 kill 安装子进程 —— 中断 codesign 会永久毁掉签名与 TCC 授权');
assert.ok(/ELECTRON_RUN_AS_NODE/.test(onboarding), '自装必须设 ELECTRON_RUN_AS_NODE,否则在 Electron 宿主里会去开窗口而不是跑脚本');
// ⚠️裸二进制那条的新旧判定必须比 Contents/Resources/source.sha256(**签名前**的源哈希)。
// 拿随包源去比已装的可执行文件恒不相等 —— installHelperApp 是复制后在原地重签,Mach-O 必然变 ——
// 于是每个新进程都判「过期」跑一遍完整安装,还可能每次弹钥匙串。
assert.ok(/source\.sha256/.test(onboarding), 'helperNeedsUpdate 必须比 source.sha256,不能比已签名的可执行文件');
// 权限真值只能问 checkPermissions:diagnostics 的 screenRecording 只是 CGPreflight 缓存值
// (bridge.swift 自己的注释:"Permission truth comes from checkPermissions")。
assert.ok(/checkPermissions/.test(onboarding), '权限判定必须走 checkPermissions,不能用 diagnostics 的预检值');

console.log('helper path checks passed');
