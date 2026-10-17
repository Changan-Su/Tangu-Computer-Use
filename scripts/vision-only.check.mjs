#!/usr/bin/env node
/**
 * 「只能看截图、按坐标操作」的真机仪器 —— 走真 helper、真 bridge.ts,目标是一个无障碍树是空的自绘 App
 * (scripts/vision-fixture,微信那一类的替身;App 自己把页码 / 滚动位置 / 点击次数写进一个状态文件,断言读它)。
 *
 * 为什么要有它:现有真机仪器用的是计算器,有无障碍引用、能走 AXPress,下面这些它一条都碰不到。
 * Forsion 反馈 55b984eb(微信,25 轮 9 分钟没做成)栽的正是这四处:
 *
 *   ① 坐标空间:结果里那行 [image] 报的尺寸 = 越界校验用的尺寸;照这张图的像素点色块,页码真的变了
 *   ② expect 没满足要进正文:文字条件在这种窗口上永远等不到,[expect] 那行要说出来并劝模型别再用
 *   ③ 按坐标的点击 / scroll 投给后台(pid + 窗口号,helper 协议 17),替身被别的 App 的窗口盖着也落得下、
 *      不抢前台、不动真鼠标;对一个窗口的第一次滚动也得到(装着 Mos 这类平滑滚动工具时第一个滚轮事件会被吞,
 *      桥接层先垫一个零位移的)、列表真的滚了;drag 仍是真实输入、真的拖到了。方向不写死 —— 滚轮事件要过
 *      系统设置和鼠标工具(Mos 会反向并放大),结果里那行 [scroll] 说的就是这个
 *   ④ 窗口不在当前桌面:act_ui 的报错与 find_roots 的空结果都指向 ensure_app;ensure_app 后台打开不管用时
 *      改为激活,并如实说它到了前台;窗口本来就在时不抢前台
 *
 * 跑法:node scripts/vision-only.check.mjs
 * 需要:macOS、helper 已装并授权、swiftc。会打开一个叫「CU Fixture」的小窗口、用一个「Probe cover」窗口盖住它
 * 几秒(点击 / 滚轮都在后台落下),拖拽那一下会把替身拿到前台;跑完关掉、把原来的前台 App 切回来。期间别碰键盘鼠标。
 * 拿签名包在私有 socket 上测:带 PI_COMPUTER_USE_HELPER_APP_PATH + PI_CU_SOCKET_PATH(配方见 UPSTREAM.md)。
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { connect } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { build } from 'esbuild'
import { SOCK, ensureDaemon } from './calc-fixture.mjs'
import { buildFixture as buildNamedFixture, waitForState, quitFixture } from './vision-fixtures.mjs'

if (process.platform !== 'darwin') {
  console.log('vision-only check skipped (not macOS)')
  process.exit(0)
}

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BUNDLE_ID = 'com.forsion.cu-vision-fixture'
// 固定位置:LaunchServices 按路径登记 App,每次换一个临时目录会攒下一堆指向已删路径的登记。
const APP = path.join(os.tmpdir(), 'cu-vision-fixture', 'CUFixture.app')
const STATE = path.join(os.tmpdir(), 'cu-vision-fixture', 'state.json')

let seq = 0
function ask(payload) {
  return new Promise((resolve, reject) => {
    const sock = connect(SOCK)
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`timeout: ${payload.cmd}`)) }, 20_000)
    sock.on('error', (e) => { clearTimeout(timer); reject(e) })
    sock.on('data', (d) => {
      buf += d
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      sock.end()
      const msg = JSON.parse(buf.slice(0, nl))
      if (!msg.ok) return reject(Object.assign(new Error(msg.error?.message || 'helper error'), { code: msg.error?.code }))
      resolve(msg.result)
    })
    sock.write(`${JSON.stringify({ id: `vo_${++seq}`, ...payload })}\n`)
  })
}

/** 替身 App:源码没变就不重编(swiftc 约 4 秒)。 */
async function buildFixture() {
  const source = path.join(root, 'scripts/vision-fixture/main.swift')
  const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex')
  const stamp = path.join(APP, 'Contents', 'Resources', 'source.sha256')
  if (fs.existsSync(stamp) && fs.readFileSync(stamp, 'utf8') === hash) return
  fs.rmSync(APP, { recursive: true, force: true })
  fs.mkdirSync(path.join(APP, 'Contents', 'MacOS'), { recursive: true })
  fs.mkdirSync(path.join(APP, 'Contents', 'Resources'), { recursive: true })
  fs.writeFileSync(path.join(APP, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${BUNDLE_ID}</string>
<key>CFBundleName</key><string>CUFixture</string>
<key>CFBundleExecutable</key><string>CUFixture</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`)
  // 必须钉 -target:不钉的话 swiftc 取工具链自己的缺省最低系统版本,可能比本机还新,LaunchServices 直接拒开(-10825)。
  const triple = process.arch === 'x64' ? 'x86_64-apple-macosx14.0' : 'arm64-apple-macosx14.0'
  await execFileP('xcrun', ['swiftc', '-target', triple, '-O', source, '-o', path.join(APP, 'Contents', 'MacOS', 'CUFixture')], { timeout: 180_000 })
  fs.writeFileSync(stamp, hash)
}

const killFixture = () => execFileP('pkill', ['-f', path.join(APP, 'Contents', 'MacOS', 'CUFixture')]).catch(() => {})
const state = () => JSON.parse(fs.readFileSync(STATE, 'utf8'))
async function until(what, pred, timeoutMs = 6_000) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try { last = state(); if (pred(last)) return last } catch { /* 文件还没写出来 */ }
    await sleep(100)
  }
  assert.fail(`等不到:${what}(最后的状态 ${JSON.stringify(last)})`)
}

// 真 bridge.ts + 适配层现编成**一个**包(executeFind 与 runEnsureApp 得共用同一份 bridge 状态)。
// ⚠️产物必须落在 tangu-plugins/computer-use/dist/ 里,原因见 untargeted-input.check.mjs。
const outfile = path.join(root, 'tangu-plugins/computer-use/dist', `.vision-only-check-${process.pid}.mjs`)
await build({
  stdin: {
    contents: [
      "export { executeFind, executeObserve, executeAct, ensureComputerUseSetup } from './src/vendor/bridge.ts'",
      "export { runEnsureApp, render, explainGone, syncSettings } from './src/tools.ts'",
    ].join('\n'),
    resolveDir: root, loader: 'ts',
  },
  bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile, logLevel: 'silent',
  external: ['node:*'],
  alias: { '@earendil-works/pi-coding-agent': path.join(root, 'src/pi-compat.ts') },
  banner: { js: "import { createRequire as __createRequire } from 'node:module';\nconst require = __createRequire(import.meta.url);" },
})
let cu
try { cu = await import(pathToFileURL(outfile).href) } finally { fs.rmSync(outfile, { force: true }) }

const pctx = { cwd: root, hasUI: false, ui: { notify: () => {}, select: async () => undefined }, sessionManager: { getBranch: () => [] } }
const text = (result) => result.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n')
const hasImage = (result) => result.content.some((b) => b.type === 'image')
// 断言对着模型真正读到的那段文字(适配层 render 的返回值)。只验各条 note 函数的话,render 里漏接哪一条都还是绿的。
// ⚠️不走工具的 execute:那条路会先做 helper 的自动更新检查,开发检出里的 helper 和装着的签名不同,会把装着的换掉。
const images = []
const tcx = { signal: undefined, collectImage: (image) => images.push(image) }
const shown = (result, args) => { const had = images.length; result.said = cu.render(result, tcx, args); result.attached = images.length > had; return result }
const act = async (details, actions, expect) => {
  const args = { stateId: details.capture.stateId, actions, ...(expect ? { expect } : {}) }
  return shown(await cu.executeAct('', args, undefined, undefined, pctx), args)
}
const failure = (promise) => promise.then(() => assert.fail('expected the call to fail'), (error) => error)
const line = (said, tag) => said.split('\n').find((l) => l.startsWith(tag)) ?? ''
const frontmost = () => ask({ cmd: 'getFrontmost' })
const toFront = (bundleId) => execFileP('open', ['-b', bundleId]).catch(() => {})
const waitForStateNow = (file) => JSON.parse(fs.readFileSync(file, 'utf8'))
let cover

await buildFixture()
await ensureDaemon(ask)
const before = await frontmost()
try {
  await killFixture()
  fs.rmSync(STATE, { force: true })
  await execFileP('open', ['-g', '-n', APP, '--args', STATE])
  const boot = await until('替身 App 起来并显示窗口', (s) => s.visible)
  await cu.ensureComputerUseSetup(pctx)

  let rootRef
  for (let attempt = 0; attempt < 20 && !rootRef; attempt++) {
    rootRef = text(await cu.executeFind('', { bundleId: BUNDLE_ID }, undefined, undefined, pctx)).match(/@r\d+/)?.[0]
    if (!rootRef) await sleep(300)
  }
  assert.ok(rootRef, 'find_roots 没给出替身 App 的 @r')
  const observe = async () => shown(await cu.executeObserve('', { root: rootRef }, undefined, undefined, pctx))

  // ── ① 坐标空间 ──
  // 点名要图(mode: 'visual')时给的是另一张更大的图,坐标就按那一张算:[image] 行报的必须是它自己的尺寸。
  // 真模型实测(gpt-6-luna,10-11):照着这行,对 1520x1144 和 899x677 两种图点出来的坐标都落在色块正中。
  const big = shown(await cu.executeObserve('', { root: rootRef, mode: 'visual' }, undefined, undefined, pctx))
  assert.ok(big.attached && line(big.said, '[image]').includes(`${big.details.capture.width}x${big.details.capture.height} px`), `① 点名要图时 [image] 行报的应是那张图自己的尺寸,实得:${big.said}`)
  let seen = await observe()
  let details = seen.details
  assert.ok(hasImage(seen) && seen.attached, `① 无障碍树是空的窗口,observe_ui 应自动附截图。outline:\n${details.renderedOutline}\nimageReason=${details.imageReason}`)
  assert.ok(!/row \d/.test(details.renderedOutline), '① 替身 App 的文字是画出来的,不该出现在 outline 里(否则它就不是「只能看图」的 App)')
  const { width: W, height: H } = details.capture
  const note = line(seen.said, '[image]')
  assert.ok(note.includes(`${W}x${H} px`) && W > 0 && H > 0, `① [image] 行应报截图尺寸,实得:${seen.said}`)
  // 窗口里的点 → 截图像素:截图是整个窗口(含标题栏)按比例缩小。
  const scale = W / boot.window.w
  const titleBar = boot.window.h - boot.content.h
  const at = (cx, cy) => ({ x: Math.round(cx * scale), y: Math.round((titleBar + cy) * scale) })
  const rail = (index) => at(32, 32 + index * boot.railWidth)
  const list = at(boot.railWidth + (boot.content.w - boot.railWidth) / 2, boot.content.h / 2)
  const firstStep = (d) => d.execution?.steps?.[0] ?? d.execution

  // ── 盖住替身:盖窗(另一个 App)激活、盖在替身窗口上面,③ 的点击 / 滚动都得在它下面落下 ──
  const frame = (await ask({ cmd: 'listWindows', pid: boot.pid })).find((w) => w.windowId)?.framePoints
  assert.ok(frame, '替身窗口的位置拿不到')
  const coverState = path.join(os.tmpdir(), 'cu-vision-fixture', 'cover.json')
  fs.rmSync(coverState, { force: true })
  await execFileP('open', ['-n', await buildNamedFixture('cover'), '--args', coverState, '--frame', [frame.x - 20, frame.y - 20, frame.w + 40, frame.h + 40].map(Math.round).join(',')])
  cover = await waitForState(coverState, (s) => s.ready, { timeoutMs: 8000 })
  const global = (p) => ({ x: frame.x + p.x / scale, y: frame.y + p.y / scale })
  const mouseAt = async (p) => { const m = await ask({ cmd: 'getMousePosition' }); const g = global(p); return Math.abs(m.x - g.x) < 2 && Math.abs(m.y - g.y) < 2 }
  const stillCovered = async (what) => {
    assert.ok(!waitForStateNow(coverState).events.some((e) => e.kind === 'appActivated' && Number(e.detail) === boot.pid), `${what}:替身被激活了(抢了前台)`)
    assert.equal(waitForStateNow(coverState).events.filter((e) => /mouse|scroll|cursor/i.test(e.kind)).length, 0, `${what}:事件落到了盖窗上,或真鼠标动了`)
  }

  // ── ③a 对这个窗口的第一次滚动 ──(放在任何点击 / 滚动之前)
  // 装着平滑滚动的鼠标工具(Mos)时,对一个新目标的第一个滚轮事件到不了 App(实测 6 次里 6 次是 0 个事件),
  // 第二个才到。桥接层先发一个零位移的滚轮事件把这一下垫掉。没装这类工具的机器上这一条本来就过。
  const cold = await act(details, [{ action: 'scroll', ...list, scrollY: 120 }])
  details = cold.details
  await sleep(1000)
  assert.equal(firstStep(details)?.delivery, 'pid', `③a 按坐标的 scroll 应投给后台(pid),实得 ${firstStep(details)?.delivery}`)
  // ⚠️命门:看的是 App 自己数到的滚轮事件。没有这一条,「不报错」可以靠事件落到别的窗口换来。
  assert.ok(state().scrolls > 0, '③a 对这个窗口的第一次滚动,带位移的滚轮事件一个都没到替身 App')
  await stillCovered('③a')
  assert.ok(!line(cold.said, '[foreground]'), `③a 没抢前台就不该说抢了,实得:${cold.said}`)
  assert.match(line(cold.said, '[scroll]'), /off the screenshot/, '③a 滚轮事件的距离不保证,要提醒模型看图')
  console.log(`  ③a 对被盖住的窗口的第一次滚动:替身 App 收到 ${state().scrolls} 个滚轮事件,前台仍是盖窗`)

  const outside = (await failure(act(details, [{ action: 'click', x: W + 5, y: 10 }]))).message
  assert.ok(outside.includes(`look image bounds (${W}x${H})`), `① 越界校验用的尺寸应与 [image] 行一致,实得:${outside}`)
  details = (await observe()).details // 失败的那次 act_ui 让原状态过期
  details = (await act(details, [{ action: 'click', ...rail(2) }])).details
  await until('① 点第 3 个色块后页码变成 3', (s) => s.page === 2)
  assert.equal(firstStep(details)?.delivery, 'pid', `③ 按坐标的左键点击应投给后台(pid),实得 ${firstStep(details)?.delivery}`)
  assert.equal(firstStep(details)?.outcome, 'worked', `③ 画面变了,helper 应判 worked,实得 ${firstStep(details)?.outcome}`)
  assert.ok(!(await mouseAt(rail(2))), '③ 后台点击不该把真鼠标挪到点击位置')
  await stillCovered('③ 点击')
  console.log(`  ① 截图 ${W}x${H}(点名要图时 ${big.details.capture.width}x${big.details.capture.height};窗口 ${boot.window.w}x${boot.window.h} 点),按截图像素点第 3 个色块 → 第 3 页`)

  // ── ② expect 没满足要进正文 ──
  const t0 = Date.now()
  const checked = await act(details, [{ action: 'click', ...rail(1) }], { text: 'Page 2', timeoutMs: 700 })
  details = checked.details
  await until('② 点击本身照样送达', (s) => s.page === 1)
  assert.equal(details.execution?.verification?.status, 'failed', '② 画出来的字不在无障碍树里,expect 应判未满足')
  assert.ok(!text(checked).includes('NOT satisfied'), '② vendor 的正文里本来没有这句(有了就该删适配层那行,别说两遍)')
  const unmet = line(checked.said, '[expect]')
  assert.match(unmet, /\[expect\] NOT satisfied: text "Page 2"/, `② [expect] 行应说明哪个条件没满足,实得:${checked.said}`)
  assert.match(unmet, /prefer leaving expect out/, '② 这种窗口上应劝模型别再用 expect')
  console.log(`  ② expect 等了 ${Date.now() - t0}ms 没等到,正文补上:${unmet.trim().slice(0, 88)}…`)

  // ── ③b 按坐标的 scroll / drag 真的生效 ──(点色块已把列表归到顶端;scroll 在盖窗下面,drag 走前台)
  details = (await observe()).details
  // 正值 = 往下,量大致对得上。真实滚轮输入要过鼠标工具:Mos 的反向和放大由 src/wheel.ts 抵掉(这台机器上不抵的话
  // +300 一动不动、-300 滚 867)。别的改滚轮的工具它不认识,这里会红 —— 那是真的发现,不是检查坏了。
  const top = state().offset
  details = (await act(details, [{ action: 'scroll', ...list, scrollY: 300 }])).details
  await sleep(1500)
  const down = state().offset - top
  details = (await act(details, [{ action: 'scroll', ...list, scrollY: -150 }])).details
  await sleep(1500)
  const up = state().offset - top - down
  // 滚动量和 x / y 一个单位:截图里的像素。App 那边记的是屏幕上的点,所以期望值要按截图的缩放折算。
  const want = (px, width) => px * boot.window.w / width
  const near = (got, expected) => Math.sign(got) === Math.sign(expected) && Math.abs(got) > Math.abs(expected) * 0.65 && Math.abs(got) < Math.abs(expected) * 1.35
  assert.ok(near(down, want(300, W)), `③b scrollY +300(截图像素)应往下滚约 ${Math.round(want(300, W))} 点,实得 ${down}(方向反了或量差太多 = 有改滚轮的工具而 src/wheel.ts 没抵掉)`)
  assert.ok(near(up, want(-150, W)), `③b scrollY -150 应往回滚约 ${Math.round(-want(150, W))} 点,实得 ${up}`)
  // 换一张缩放不同的截图(点名要的大图),同样的「截图像素」要折成不同的点数 —— 真模型对着 2 倍的大图要 1800,以前滚了两倍远。
  const wide = shown(await cu.executeObserve('', { root: rootRef, mode: 'visual' }, undefined, undefined, pctx))
  const k = wide.details.capture.width / boot.window.w
  const here = state().offset
  details = (await act(wide.details, [{ action: 'scroll', x: Math.round(list.x / scale * k), y: Math.round(list.y / scale * k), scrollY: 600 }])).details
  await sleep(1500)
  const far = state().offset - here
  assert.ok(near(far, want(600, wide.details.capture.width)), `③b 对着 ${wide.details.capture.width} 宽的大图 scrollY +600 应滚约 ${Math.round(want(600, wide.details.capture.width))} 点,实得 ${far}(滚动量没按截图的缩放折算)`)
  await stillCovered('③b 滚动')
  const dragsBefore = state().drags
  details = (await act(details, [{ action: 'drag', path: [list, { x: list.x, y: list.y + 80 }] }])).details
  await until('③b drag 真的拖到了', (s) => s.drags > dragsBefore)
  assert.equal(firstStep(details)?.delivery, 'hid', '③b drag 应是真实输入(hid)')
  await quitFixture(cover.pid)
  cover = undefined
  console.log(`  ③b 后台滚轮(盖窗下):对着 ${W} 宽的截图 scrollY +300 → 往下 ${down} 点(应约 ${Math.round(want(300, W))}),-150 → ${up};对着 ${wide.details.capture.width} 宽的大图 +600 → ${far} 点(应约 ${Math.round(want(600, wide.details.capture.width))});drag 收到 ${state().drags - dragsBefore} 次拖动事件`)

  // ── ④ 窗口不在当前桌面 ──
  if (before.bundleId) await toFront(before.bundleId) // 用户切回了原来的 App
  await sleep(500)
  process.kill(boot.pid, 'SIGUSR1')
  await until('④ 替身 App 把窗口收起来', (s) => !s.visible)
  const goneError = await failure(act(details, [{ action: 'click', ...rail(0) }]))
  const gone = goneError.message
  cu.explainGone(goneError, { stateId: details.capture.stateId })
  assert.notEqual(goneError.message, gone, `④ act_ui 的报错应被认出来并补上出路,实得:${gone}`)
  assert.ok(goneError.message.includes(`ensure_app({ bundleId: "${BUNDLE_ID}" })`), `④ 出路是一条能照抄的 ensure_app,实得:${goneError.message}`)
  // 目标按 state 记:换一个没见过的 state,不该把别的 App 的 bundleId 填进去。
  const stranger = new Error(gone)
  cu.explainGone(stranger, { stateId: 'never-seen' })
  assert.ok(stranger.message.includes('ensure_app') && !stranger.message.includes(BUNDLE_ID), '④ 不认识的 state 只说工具名,不猜是哪个 App')
  const empty = shown(await cu.executeFind('', { pid: boot.pid }, undefined, undefined, pctx))
  assert.match(line(empty.said, '[hint]'), /ensure_app/, `④ find_roots 按 pid 找不到时也要指向 ensure_app,实得:${empty.said}`)
  assert.equal(state().page, 1, '④ 报错的那一次不得有点击落下')
  // 开着「严格后台」:不激活,说明原因,窗口和前台都不动。
  // 走真的设置入口:只改内存里的配置对象会被 vendor 下一次重新加载冲掉(这个开关以前因此从未生效)。
  const strict = (headless) => cu.syncSettings({ getScopeSettings: () => ({ headless }) })
  strict(true)
  const refused = await cu.runEnsureApp({ app: APP }, tcx, pctx).finally(() => strict(false))
  assert.match(refused, /strict background setting forbids/, `④ 严格后台下 ensure_app 不该激活,实得:${refused}`)
  assert.ok(!state().visible && (await frontmost()).pid !== boot.pid, '④ 严格后台下窗口不该回来、前台不该变')
  // 按路径给(临时目录里的 App 没在 LaunchServices 登记,open -b 找不到它);ensure_app 按名字那一段认出它已经在跑。
  const back = await cu.runEnsureApp({ app: APP }, tcx, pctx)
  assert.match(back, /@r\d/, `④ ensure_app 应把窗口带回来,实得:${back}`)
  assert.match(back, /brought to the foreground/, `④ 后台打开不管用时应激活并如实说,实得:${back}`)
  assert.ok(state().visible, '④ 窗口真的回来了')
  assert.equal((await frontmost()).pid, boot.pid, '④ 说它到了前台,它就得真的在前台')
  console.log(`  ④ 窗口收起后:${gone.slice(0, 60)}… → 补上 ensure_app → ${back.split('\n')[0].slice(0, 80)}…`)
  // 窗口本来就在、App 又不会自己往前跳:ensure_app 不抢前台,也不说自己抢了
  if (before.bundleId) {
    await toFront(before.bundleId)
    await sleep(600)
    const quiet = await cu.runEnsureApp({ app: APP }, tcx, pctx)
    assert.match(quiet, /did not take the foreground/, `④ 窗口在场时应留在后台,实得:${quiet}`)
    assert.equal((await frontmost()).pid, before.pid, '④ 说没抢前台,前台就得还是原来那个 App')
  }
  console.log('✅ 只能看图的 App:坐标按截图像素、expect 没满足进正文、被盖住时按坐标点击 / 滚动在后台落下、拖拽真的生效、窗口离开当前桌面时有出路')
} finally {
  if (cover) await quitFixture(cover.pid)
  await killFixture()
  if (before.bundleId) await toFront(before.bundleId)
}
