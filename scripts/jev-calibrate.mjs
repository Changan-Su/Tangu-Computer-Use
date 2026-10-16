/** Jev 阈值标定:真 Jev API × 真截图 × 自绘替身 App(Melody / Chatter),**不发任何输入**。
 *
 * 两组数据,真值都来自替身 App 自己写的 layout(画在哪里)和启动参数(画面处于什么状态),不靠人判:
 *  - 定位:每个场景若干「真有的目标」(含近似干扰项:Saku / Sakura、序号、按歌名)和「根本没有的目标」,
 *    记 Jev 的 visibility / box confidence,再看框中心落没落在真目标的矩形里;
 *  - 确认(expect):前后两帧 + 一句 expect,真值是「这一帧到底满不满足」,记 Noul。
 * 汇总按插件现行的规则(src/jev.ts:可见性 ≥ 阈值、框 ≥ BOX_FLOOR、确认 ≥ max(阈值, VERIFY_FLOOR))在 0.50…0.95 每档算:
 * 会点错几次(接受了但点的不是它 / 接受了根本不存在的目标)、会白停几次(该点的被拒),旁边并列旧规则(框也按阈值)的白停数。
 *
 * Run(macOS,装过并授权的 helper;只读本机 Jev 设置,密钥只留在内存):
 *   JEV_SETTINGS_FILE=~/.forsion-dev/config.json node scripts/jev-calibrate.mjs <输出目录> [--repeat 2]
 *   node scripts/jev-calibrate.mjs <输出目录> --from a/calibration.json [--from b/calibration.json]   # 不跑,按现行规则重算汇总(可合并几次的数据)
 * 产物:<输出目录>/calibration.json(逐条)+ summary.md;TANGU_JEV_EVIDENCE_DIR 指同一目录时每次请求的图和回答也留下。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs';
import { buildFixture, launchFixture, readState, quitFixture } from './vision-fixtures.mjs';

const exec = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = process.argv[2] && !process.argv[2].startsWith('--') ? path.resolve(process.argv[2]) : await fs.mkdtemp(path.join(os.tmpdir(), 'jev-calibrate-'));
const repeat = Number(process.argv.includes('--repeat') ? process.argv[process.argv.indexOf('--repeat') + 1] : 1);
const froms = process.argv.flatMap((a, i) => (a === '--from' ? [path.resolve(process.argv[i + 1])] : []));
assert(process.platform === 'darwin', 'macOS only');
assert(froms.length || process.env.JEV_SETTINGS_FILE, 'JEV_SETTINGS_FILE must point to a Forsion config.json with Computer Use Jev settings');
const settings = froms.length ? null : JSON.parse(await fs.readFile(process.env.JEV_SETTINGS_FILE.replace(/^~/, os.homedir()), 'utf8')).plugins.global['computer-use'];
await fs.mkdir(out, { recursive: true });
const socket = path.join(os.homedir(), 'Library/Caches', `forsion-jev-calibrate-${process.pid}.sock`);
process.env.PI_CU_SOCKET_PATH = socket;
process.env.PI_COMPUTER_USE_HEADLESS = 'false';

// ── scenes:启动参数决定画面;targets 的 expect = layout 里真目标的匹配条件(null = 画面上没有) ──
const daily3 = (s) => s.catalog.daily[2];
const SCENES = [
  { app: 'melody', page: 'home', targets: [
    { text: '首页推荐区第一张卡片「每日推荐」(封面上有日期数字)', hit: (l) => l.kind === 'card' && l.label.includes('每日推荐') },
    { text: 'The "私人漫游" card in the recommendation row', hit: (l) => l.kind === 'card' && l.label.includes('私人漫游') },
    { text: '「热门歌单」那一排的第二张卡片', hit: (l) => l.kind === 'card' && l.label === '每日新歌速递', ordinal: true }, // 近似干扰:名字里也带「每日」
    { text: '左侧边栏的「最近播放」', hit: (l) => l.kind === 'sidebar' && l.label.includes('最近播放') },
    { text: '「我的收藏」按钮', hit: null },
    { text: '歌曲列表的第 3 行(编号 03)', hit: null }, // 首页没有歌曲列表:长得像的东西(卡片排)在,目标不在
    { text: '歌单卡片「周末公路旅行」', hit: null },
  ] },
  { app: 'melody', page: 'daily', targets: [
    { text: '歌曲列表的第 3 行(编号 03)', hit: (l) => l.kind === 'row' && l.label.startsWith('03 '), ordinal: true },
    { text: (s) => `歌曲《${daily3(s).title}》那一行`, hit: (l, s) => l.kind === 'row' && l.label.includes(daily3(s).title) },
    { text: '「▶ 播放全部」按钮', hit: (l) => l.kind === 'button' && l.label.includes('播放全部') },
    { text: '歌曲列表的第 25 行(编号 25)', hit: (l) => l.kind === 'row' && l.label.startsWith('25 '), ordinal: true }, // 要滚才看得见:layout 里没有 = 画面上没有,应被拒
    { text: '歌曲《不存在的歌名 Zyxw》那一行', hit: null },
    { text: '首页推荐区第一张卡片「每日推荐」(封面上有日期数字)', hit: (l) => l.kind === 'card' && l.label === '每日推荐' }, // 列表页抬头的日期封面很像那张卡,卡本身不在
  ] },
  { app: 'melody', page: 'comments:3', targets: [
    { text: '「精彩评论」里点赞数最多的那一条评论', hit: (l, s) => l.kind === 'comment' && !!s.comments?.hottest?.text?.startsWith(l.label) },
    { text: '左上角的返回箭头', hit: (l) => l.kind === 'button' && l.label === '‹' },
    { text: '「写评论」输入框', hit: null },
  ] },
  { app: 'chatter', page: 'list', targets: [
    { text: '联系人列表里的「Sakura」(不是 Saku,也不是 Sakura 樱花)', hit: (l) => l.kind === 'contact' && l.label === 'Sakura' },
    { text: '联系人「Saku」', hit: (l) => l.kind === 'contact' && l.label === 'Saku' },
    { text: '联系人「Sakura 樱花」', hit: (l) => l.kind === 'contact' && l.label === 'Sakura 樱花' },
    { text: '左上角的搜索框', hit: (l) => l.kind === 'field' && l.label === '搜索' },
    { text: '联系人「Tom Hanks」', hit: null },
  ] },
  { app: 'chatter', page: 'chat:Saku', targets: [
    { text: '聊天窗口顶部的标题「Sakura」', hit: (l) => l.kind === 'text' && l.label === 'Sakura' }, // 标题是 Saku:差两个字母
    { text: '聊天窗口顶部的标题「Saku」', hit: (l) => l.kind === 'text' && l.label === 'Saku' },
  ] },
  { app: 'chatter', page: 'chat:Sakura', targets: [
    { text: '底部的消息输入框', hit: (l) => l.kind === 'field' && l.label === '输入' },
    // 输入框空着时「发送(S)」是灰的:visible 问的是「看得见、唯一、而且能点」,所以真值按「不能点」算,应被拒
    { text: '「发送(S)」按钮', hit: (l) => l.kind === 'button' && l.label === '发送(S)' && l.enabled === true },
    { text: 'Sakura 发来的「周末一起去看展吗?」那条消息', hit: (l) => l.kind === 'bubble' && !l.mine && l.label.startsWith('周末一起去看展') },
    { text: '「转账」按钮', hit: null },
  ] },
];
// 确认:before → after 两帧 + expect;truth = after 是否真的满足
const VERIFY = [
  { before: ['melody', 'home'], after: ['melody', 'daily'], expect: '「每日推荐」歌曲列表页已经打开', truth: true },
  { before: ['melody', 'home'], after: ['melody', 'home'], expect: '「每日推荐」歌曲列表页已经打开', truth: false },
  { before: ['melody', 'daily'], after: ['melody', 'daily', ['--play', '3']], expect: '第 3 首歌(编号 03)正在播放:那一行显示播放图标,底部播放栏是这首歌', truth: true },
  { before: ['melody', 'daily'], after: ['melody', 'daily', ['--play', '6']], expect: '第 3 首歌(编号 03)正在播放:那一行显示播放图标,底部播放栏是这首歌', truth: false },
  { before: ['melody', 'daily'], after: ['melody', 'daily', ['--play', '4']], expect: '第 3 首歌(编号 03)正在播放:那一行显示播放图标,底部播放栏是这首歌', truth: false }, // 差一行:最常见的点偏
  { before: ['melody', 'daily', ['--play', '3']], after: ['melody', 'comments:3', ['--play', '3']], expect: '这首歌的评论页已打开,能看到「精彩评论」', truth: true },
  { before: ['chatter', 'list'], after: ['chatter', 'chat:Sakura'], expect: '和 Sakura 的聊天窗口已打开(顶部标题是 Sakura)', truth: true },
  { before: ['chatter', 'list'], after: ['chatter', 'chat:Saku'], expect: '和 Sakura 的聊天窗口已打开(顶部标题是 Sakura)', truth: false },
  { before: ['chatter', 'list'], after: ['chatter', 'chat:Sakura 樱花'], expect: '和 Sakura 的聊天窗口已打开(顶部标题是 Sakura)', truth: false }, // 已知会误放行(0.96–0.99):写得松的 expect 认名字的前缀
  // 同样三对,expect 写成「恰好是…不是…」(SKILL.md 教主模型的写法):10-16 探针 该过 0.98 / 不该过 0.01
  ...['chat:Sakura', 'chat:Sakura 樱花', 'chat:Saku'].map((page) => ({ before: ['chatter', 'list'], after: ['chatter', page], expect: '聊天窗口顶部的标题恰好是「Sakura」(不是 Saku,也不是 Sakura 樱花)', truth: page === 'chat:Sakura' })),
  { before: ['chatter', 'chat:Sakura'], after: ['chatter', 'chat:Sakura', ['--sent', '这首歌的副歌一出来我就哭了']], expect: '刚发出的消息「这首歌的副歌一出来我就哭了」出现在聊天记录里(右侧绿色气泡)', truth: true },
  { before: ['chatter', 'chat:Sakura'], after: ['chatter', 'chat:Sakura'], expect: '刚发出的消息「这首歌的副歌一出来我就哭了」出现在聊天记录里(右侧绿色气泡)', truth: false },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bundle = path.join(root, `tangu-plugins/computer-use/dist/jev-calibrate-${process.pid}.mjs`);
let helperStarted = false;
const fixtures = new Map(); // key → {state, statePath}
const rows = [], verifies = [];
await build({ stdin: { contents: 'export * from "./src/jevRun.ts"; export * from "./src/jev.ts"; export {executeFind,ensureComputerUseSetup,shutdownComputerUseSession} from "./src/vendor/bridge.ts";', resolveDir: root }, outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node20', alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') }, banner: { js: 'import {createRequire} from "node:module";const require=createRequire(import.meta.url);' } });
const cu = await import(pathToFileURL(bundle));
await fs.rm(bundle, { force: true });
for (const f of froms) { const d = JSON.parse(await fs.readFile(f, 'utf8')); rows.push(...d.rows); verifies.push(...d.verifies); }
if (!froms.length) try {
  await exec('open', ['-n', '-g', resolveMacosHelperAppPath(), '--args', 'serve', '--socket', socket]); helperStarted = true;
  const ctx = { cwd: root, hasUI: false, ui: { notify() {} }, sessionManager: { getBranch: () => [] } };
  await cu.ensureComputerUseSetup(ctx);
  const connection = cu.readJevConnection(settings);
  const apps = { melody: await buildFixture('melody'), chatter: await buildFixture('chatter') };
  const bundleIds = { melody: 'com.forsion.cu-fixture.melody', chatter: 'com.forsion.cu-fixture.chatter' };
  /** 起一个处于指定画面的替身 App(同一时刻只开一个,免得 find_roots 撞名),返回 root + state。 */
  const open = async (app, page, extra = []) => {
    for (const f of fixtures.values()) await quitFixture(f.state).catch(() => {});
    fixtures.clear();
    const statePath = path.join(out, `${app}-${page.replace(/[^a-z0-9]+/gi, '_')}-${Date.now()}.json`);
    // behind:放到所有窗口后面截图(不挡用户的屏幕;desktopIndependentWindow 截得到被挡住的窗口)
    const state = await launchFixture(apps[app], statePath, { frame: { x: 60, y: 80, w: app === 'melody' ? 1000 : 900, h: app === 'melody' ? 680 : 640 }, page, args: extra, behind: true });
    fixtures.set(app, { state, statePath });
    await sleep(400);
    const found = await cu.executeFind('', { bundleId: bundleIds[app] }, undefined, undefined, ctx);
    const ref = found.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').match(/@r\d+/)?.[0];
    assert(ref, `find_roots found no root for ${app}`);
    return { ref, state: await readState(statePath) };
  };
  const capture = async (ref) => {
    const obs = await cu.jevRuntime.observe(ref, true, ctx, AbortSignal.timeout(20000));
    const image = obs.content.find((c) => c.type === 'image');
    assert(image, 'visual observation has no image');
    return cu.jevRuntime.prepare({ ...image, width: obs.details.capture.width, height: obs.details.capture.height });
  };
  for (let round = 1; round <= repeat; round++) {
    for (const scene of SCENES) {
      const { ref, state } = await open(scene.app, scene.page);
      const image = await capture(ref);
      // capture px → window points(capture 就是整扇窗,含标题栏;layout 也按整扇窗记)
      const sx = state.window.w / image.sourceWidth, sy = state.window.h / image.sourceHeight;
      for (const target of scene.targets) {
        const text = typeof target.text === 'function' ? target.text(state) : target.text;
        const truth = target.hit ? state.layout.find((l) => target.hit(l, state)) : null;
        const started = Date.now();
        const answer = await cu.requestJev(connection, cu.visionRequest(image, { action: 'click', target: text }));
        const v = answer.answers?.visible?.noul, c = answer.answers?.target?.confidence, b = answer.answers?.target?.box;
        const cx = ((b.left + b.right) / 2 * image.width - image.left) * image.sourceWidth / image.contentWidth * sx;
        const cy = ((b.top + b.bottom) / 2 * image.height - image.top) * image.sourceHeight / image.contentHeight * sy;
        const inside = truth ? cx >= truth.rect.x && cx <= truth.rect.x + truth.rect.w && cy >= truth.rect.y && cy <= truth.rect.y + truth.rect.h : false;
        // 「要滚才看得见」的目标在 layout 里不在 → 当作画面上没有
        rows.push({ round, scene: `${scene.app}/${scene.page}`, target: text, present: !!truth, ordinal: !!target.ordinal, visibility: v, confidence: c, hit: inside, point: { x: Math.round(cx), y: Math.round(cy) }, truthRect: truth?.rect, ms: Date.now() - started });
        console.log(`${scene.app}/${scene.page} | ${text.slice(0, 40)} | present=${!!truth} v=${v?.toFixed(2)} c=${c?.toFixed(2)} hit=${inside}`);
      }
    }
    for (const pair of VERIFY) {
      const [ba, bp, bx = []] = pair.before, [aa, ap, ax = []] = pair.after;
      const before = await capture((await open(ba, bp, bx)).ref);
      const after = await capture((await open(aa, ap, ax)).ref);
      const started = Date.now();
      const answer = await cu.requestJev(connection, cu.verifyRequest(after, { action: 'click', target: '(calibration)', expect: pair.expect }, before));
      const noul = cu.verifyAnswer(answer);
      verifies.push({ round, before: pair.before.flat().join(' '), after: pair.after.flat().join(' '), expect: pair.expect, truth: pair.truth, noul, ms: Date.now() - started });
      console.log(`verify | ${pair.after.flat().join(' ')} | truth=${pair.truth} noul=${noul.toFixed(2)}`);
    }
  }
} finally {
  for (const f of fixtures.values()) await quitFixture(f.state).catch(() => {});
  await fs.writeFile(path.join(out, 'calibration.json'), JSON.stringify({ at: new Date().toISOString(), model: 'jev-1.14.0', rows, verifies }, null, 2));
  if (helperStarted) {
    const { stdout } = await exec('pgrep', ['-f', socket]).catch(() => ({ stdout: '' }));
    for (const pid of stdout.split(/\s+/).filter(Boolean)) { try { process.kill(Number(pid)); } catch { /* gone */ } }
  }
  await fs.rm(socket, { force: true });
}

// ── 汇总:按插件现行规则,每档阈值下会点错 / 白停几次 ──
const P = rows.filter((r) => r.present), A = rows.filter((r) => !r.present), T = verifies.filter((v) => v.truth), F = verifies.filter((v) => !v.truth);
const range = (xs, k) => xs.length ? `${Math.min(...xs.map((x) => x[k])).toFixed(2)}–${Math.max(...xs.map((x) => x[k])).toFixed(2)}` : '—';
const top = (xs, k) => xs.length ? xs.reduce((a, b) => (b[k] > a[k] ? b : a)) : null;
const lines = ['# Jev 阈值标定', '',
  `定位 ${rows.length} 条(真有的 ${P.length},没有的 ${A.length});确认 ${verifies.length} 对(该过 ${T.length},不该过 ${F.length})。规则 = 插件现行:可见性 ≥ 阈值、框 ≥ ${cu.BOX_FLOOR}、确认 ≥ max(阈值, ${cu.VERIFY_FLOOR});缺省阈值 ${cu.DEFAULT_THRESHOLD}。`, '',
  `- 真有的目标:可见性 ${range(P, 'visibility')},框 ${range(P, 'confidence')};框心落在真目标里 ${P.filter((r) => r.hit).length}/${P.length}`,
  `- 不在的目标:可见性 ${range(A, 'visibility')}(最高:${top(A, 'visibility')?.scene}「${top(A, 'visibility')?.target}」),框 ${range(A, 'confidence')}`,
  `- 确认:该过的 ${range(T, 'noul')},不该过的 ${range(F, 'noul')}(最高:${top(F, 'noul')?.after} 对「${top(F, 'noul')?.expect}」)`, '',
  '| 阈值 | 点对 | 点错(接受了但不是它) | 点了不存在的 | 白停(该点被拒) | 确认:误放行 | 确认:白等 | 旧规则(框也按阈值)白停 |', '|---|---|---|---|---|---|---|---|'];
for (let t = 0.5; t <= 0.951; t += 0.05) {
  const ok = (r) => r.visibility >= t && r.confidence >= cu.BOX_FLOOR, vmin = Math.max(t, cu.VERIFY_FLOOR);
  const good = P.filter((r) => ok(r) && r.hit).length, wrong = P.filter((r) => ok(r) && !r.hit).length;
  const ghost = A.filter(ok).length, stall = P.filter((r) => !ok(r)).length, oldStall = P.filter((r) => !(r.visibility >= t && r.confidence >= t)).length;
  lines.push(`| ${t.toFixed(2)} | ${good} | ${wrong} | ${ghost} | ${stall} | ${F.filter((v) => v.noul >= vmin).length} | ${T.filter((v) => v.noul < vmin).length} | ${oldStall} |`);
}
lines.push('', '逐条见 calibration.json。「点错」「点了不存在的」「误放行」是要压到 0 的;「白停」「白等」只是让主模型多接一次手。');
await fs.writeFile(path.join(out, 'summary.md'), lines.join('\n') + '\n');
console.log(lines.join('\n'));
