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

console.log('helper path checks passed');
