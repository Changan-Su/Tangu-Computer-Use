// esbuild bundle:src/index.ts → tangu-plugins/computer-use/dist/index.js(单文件 ESM,运行时零 node_modules)。
// pi 依赖靠 alias 指到 pi-compat;node 内置 external;banner 注入 __dirname/__filename/require(vendor 可能用)。
//
// 产物为什么放这么深:本仓已升级为 **Forsion 捆绑包** —— 仓根就是 bundle 根(manifest.json + main.js +
// skills/),引擎侧内容按 bundles.ts 的约定住在 tangu-plugins/<pid>/。
import { build } from 'esbuild';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'tangu-plugins/computer-use/dist');

// vendor 三个 helper(macos/windows/linux)用 import.meta.url 往上 3 级找包根,再拼 scripts/setup-helper.mjs
// 去装 native helper。源码树里 src/vendor/platform/<os>/ → 包根,对;打成单文件后就看产物放哪:
//   放 <root>/dist/index.js       → 上跳 3 级冲出仓外,spawn 必失败(曾是 P0,靠构建期改写补救)
//   放 <root>/tangu-plugins/computer-use/dist/index.js → 上跳 3 级正好是 <root> ✔
// 所以捆绑包化之后**不再需要改写 vendor**,只需守住这个不变量。两道守卫:
//   ① 每个平台文件里那行还在(上游改写法就炸,别静默失配)
//   ② 构建完按产物位置实算一遍,3 级上跳必须落在含 scripts/setup-helper.mjs 的目录
const PLATFORMS = ['macos', 'windows', 'linux'];
const PKG_ROOT_NEEDLE = 'path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..")';
const seen = new Set();
const checkPackageRoot = {
  name: 'check-vendor-package-root',
  setup(b) {
    b.onLoad({ filter: new RegExp(`vendor[\\\\/]platform[\\\\/](${PLATFORMS.join('|')})[\\\\/]helper\\.ts$`) }, async (args) => {
      const src = await readFile(args.path, 'utf8');
      if (!src.includes(PKG_ROOT_NEEDLE)) {
        throw new Error(`PACKAGE_ROOT pattern not found in ${args.path} — 上游改了写法,重新核对 build.mjs 里的产物层级`);
      }
      seen.add(path.basename(path.dirname(args.path)));
      return { contents: src, loader: 'ts' };
    });
  },
};

await build({
  entryPoints: [path.join(root, 'src/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(outDir, 'index.js'),
  external: ['node:*'],
  alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  plugins: [checkPackageRoot],
  banner: {
    js: [
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      'const require = __createRequire(import.meta.url);',
      'const __filename = __fileURLToPath(import.meta.url);',
      'const __dirname = __pathDirname(__filename);',
    ].join('\n'),
  },
  logLevel: 'info',
});

const missed = PLATFORMS.filter((p) => !seen.has(p));
if (missed.length) {
  throw new Error(`${missed.join('/')} 后端没进 bundle —— 上游改了目录布局,或 platform/index.ts 不再引它`);
}

const resolvedPackageRoot = path.resolve(outDir, '..', '..', '..');
await access(path.join(resolvedPackageRoot, 'scripts', 'setup-helper.mjs')).catch(() => {
  throw new Error(
    `PACKAGE_ROOT 不变量破了:产物在 ${outDir},vendor 上跳 3 级得到 ${resolvedPackageRoot},那里没有 scripts/setup-helper.mjs。` +
      '改产物位置就必须同步核对这条(装 native helper 全靠它)。',
  );
});

// 纯前台透明化模块单独产一份,给 scripts/no-foreground.check.mjs 免依赖 import(node 跑不了 .ts)。
await build({
  entryPoints: [path.join(root, 'src/foregroundNote.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: path.join(outDir, 'foregroundNote.js'),
});

console.log('✓ built tangu-plugins/computer-use/dist/index.js');
