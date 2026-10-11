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
 *   ③ 按坐标的 scroll / drag 是真实输入:对一个窗口的第一次滚动也得到(装着 Mos 这类平滑滚动工具时第一个
 *      滚轮事件会被吞,桥接层先垫一个零位移的)、列表真的滚了、拖拽真的到了;顺带打印「投给进程」那条旧路收到
 *      几个事件。方向不写死 —— 真实滚轮输入要过系统设置和鼠标工具(Mos 会反向并放大),结果里那行 [scroll] 说的就是这个
 *   ④ 窗口不在当前桌面:act_ui 的报错与 find_roots 的空结果都指向 ensure_app;ensure_app 后台打开不管用时
 *      改为激活,并如实说它到了前台;窗口本来就在时不抢前台
 *
 * 跑法:node scripts/vision-only.check.mjs
 * 需要:macOS、helper 已装并授权、swiftc。会打开一个叫「CU Fixture」的小窗口并**把它拿到前台约十秒**
 * (真实的点击 / 滚轮 / 拖拽),跑完关掉、把原来的前台 App 切回来。期间别碰键盘鼠标。
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
      "export { runEnsureApp } from './src/tools.ts'",
      "export { imageNote, expectNote, goneHint, noRootsHint, foregroundNote, scrollNote } from './src/foregroundNote.ts'",
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
const act = (details, actions, expect) => cu.executeAct('', { stateId: details.capture.stateId, actions, ...(expect ? { expect } : {}) }, undefined, undefined, pctx)
const failure = async (promise) => { try { await promise } catch (error) { return error.message } assert.fail('expected the call to fail') }
const frontmost = () => ask({ cmd: 'getFrontmost' })
const toFront = (bundleId) => execFileP('open', ['-b', bundleId]).catch(() => {})

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
  const observe = () => cu.executeObserve('', { root: rootRef }, undefined, undefined, pctx)

  // ── ① 坐标空间 ──
  let seen = await observe()
  let details = seen.details
  assert.ok(hasImage(seen), `① 无障碍树是空的窗口,observe_ui 应自动附截图。outline:\n${details.renderedOutline}\nimageReason=${details.imageReason}`)
  assert.ok(!/row \d/.test(details.renderedOutline), '① 替身 App 的文字是画出来的,不该出现在 outline 里(否则它就不是「只能看图」的 App)')
  const { width: W, height: H } = details.capture
  const note = cu.imageNote(details, true)
  assert.ok(note.includes(`${W}x${H} px`) && W > 0 && H > 0, `① [image] 行应报截图尺寸,实得:${note}`)
  // 窗口里的点 → 截图像素:截图是整个窗口(含标题栏)按比例缩小。
  const scale = W / boot.window.w
  const titleBar = boot.window.h - boot.content.h
  const at = (cx, cy) => ({ x: Math.round(cx * scale), y: Math.round((titleBar + cy) * scale) })
  const rail = (index) => at(32, 32 + index * boot.railWidth)
  const list = at(boot.railWidth + (boot.content.w - boot.railWidth) / 2, boot.content.h / 2)
  const firstStep = (d) => d.execution?.steps?.[0] ?? d.execution

  // ── ③a 对这个窗口的第一次滚动 ──(放在任何点击 / 滚动之前)
  // 装着平滑滚动的鼠标工具(Mos)时,对一个新目标的第一个滚轮事件到不了 App(实测 6 次里 6 次是 0 个事件),
  // 第二个才到。桥接层先发一个零位移的滚轮事件把这一下垫掉。没装这类工具的机器上这一条本来就过。
  assert.notEqual((await frontmost()).pid, boot.pid, '③a 夹具应把替身 App 开在后台')
  const cold = await act(details, [{ action: 'scroll', ...list, scrollY: 120 }])
  details = cold.details
  await sleep(1000)
  assert.equal(firstStep(details)?.delivery, 'hid', `③a 按坐标的 scroll 应是真实输入(hid),实得 ${firstStep(details)?.delivery}`)
  // ⚠️命门:看的是 App 自己数到的滚轮事件。没有这一条,「不报错」可以靠事件落到别的窗口换来。
  assert.ok(state().scrolls > 0, '③a 对这个窗口的第一次滚动一个事件都没到替身 App')
  assert.equal((await frontmost()).pid, boot.pid, '③a 真实输入之后替身 App 应在前台')
  assert.ok(cu.foregroundNote(details.execution).includes('[foreground]'), '③a 抢了前台要说')
  assert.match(cu.scrollNote([{ action: 'scroll', ...list, scrollY: 120 }], details.execution), /\[scroll\].*opposite sign/, '③a 真实滚轮输入的方向 / 距离不保证,要告诉模型')
  console.log(`  ③a 对这个窗口的第一次滚动(目标原在后台):替身 App 收到 ${state().scrolls} 个滚轮事件`)

  const outside = await failure(act(details, [{ action: 'click', x: W + 5, y: 10 }]))
  assert.ok(outside.includes(`look image bounds (${W}x${H})`), `① 越界校验用的尺寸应与 [image] 行一致,实得:${outside}`)
  details = (await observe()).details // 失败的那次 act_ui 让原状态过期
  details = (await act(details, [{ action: 'click', ...rail(2) }])).details
  await until('① 点第 3 个色块后页码变成 3', (s) => s.page === 2)
  console.log(`  ① 截图 ${W}x${H}(窗口 ${boot.window.w}x${boot.window.h} 点),按截图像素点第 3 个色块 → 第 3 页`)

  // ── ② expect 没满足要进正文 ──
  const t0 = Date.now()
  const checked = await act(details, [{ action: 'click', ...rail(1) }], { text: 'Page 2', timeoutMs: 700 })
  details = checked.details
  await until('② 点击本身照样送达', (s) => s.page === 1)
  assert.equal(details.execution?.verification?.status, 'failed', '② 画出来的字不在无障碍树里,expect 应判未满足')
  assert.ok(!text(checked).includes('NOT satisfied'), '② vendor 的正文里本来没有这句(有了就该删适配层那行,别说两遍)')
  const unmet = cu.expectNote(details)
  assert.match(unmet, /\[expect\] NOT satisfied: text "Page 2"/, `② [expect] 行应说明哪个条件没满足,实得:${unmet}`)
  assert.match(unmet, /leave expect out/, '② 这种窗口上应劝模型别再用 expect')
  console.log(`  ② expect 等了 ${Date.now() - t0}ms 没等到,正文补上:${unmet.trim().slice(0, 88)}…`)

  // ── ③b 按坐标的 scroll / drag 真的生效 ──(点色块已把列表归到顶端)
  // 先量旧路(投给进程):只打印不断言,留作「为什么不能走后台」的现场证据。
  const before0 = state()
  await ask({ cmd: 'act', lookId: details.lookId, pid: boot.pid, target: list, action: 'scroll', params: { scrollX: 0, scrollY: 120, delivery: 'pid' }, policy: 'background', cursorOverlay: false }).catch((e) => console.log(`  ③b (旧路直接报错:${e.message})`))
  await sleep(500)
  console.log(`  ③b 旧路(投给进程):替身 App 收到 ${state().scrolls - before0.scrolls} 个滚轮事件,滚动位置 ${before0.offset} → ${state().offset}`)
  details = (await observe()).details
  // 方向不写死:真实滚轮输入要过系统设置和鼠标工具(Mos 之类会反向并放大)。一正一负各发一次,
  // 从顶端出发必有一次被顶住、另一次滚动;两次方向必须相反。
  const top = state().offset
  details = (await act(details, [{ action: 'scroll', ...list, scrollY: 300 }])).details
  await sleep(900)
  const afterPlus = state().offset
  details = (await act(details, [{ action: 'scroll', ...list, scrollY: -300 }])).details
  await sleep(900)
  const afterMinus = state().offset
  assert.ok(afterPlus !== top || afterMinus !== afterPlus, `③b 一正一负两次按坐标 scroll,列表都没动(${top} → ${afterPlus} → ${afterMinus})`)
  assert.ok(!(afterPlus > top && afterMinus > afterPlus), '③b 正负两个方向不该往同一边滚')
  const reversed = afterPlus === top && afterMinus > afterPlus
  const dragsBefore = state().drags
  details = (await act(details, [{ action: 'drag', path: [list, { x: list.x, y: list.y + 80 }] }])).details
  await until('③b drag 真的拖到了', (s) => s.drags > dragsBefore)
  assert.equal(firstStep(details)?.delivery, 'hid', '③b drag 应是真实输入(hid)')
  console.log(`  ③b 新路(真实输入):scrollY +300 → ${afterPlus - top},-300 → ${afterMinus - afterPlus}${reversed ? '(这台机器上方向被系统设置或鼠标工具反转了,量也变了 —— [scroll] 那行说的就是这个)' : ''};drag 收到 ${state().drags - dragsBefore} 次拖动事件`)

  // ── ④ 窗口不在当前桌面 ──
  if (before.bundleId) await toFront(before.bundleId) // 用户切回了原来的 App
  await sleep(500)
  process.kill(boot.pid, 'SIGUSR1')
  await until('④ 替身 App 把窗口收起来', (s) => !s.visible)
  const gone = await failure(act(details, [{ action: 'click', ...rail(0) }]))
  const hinted = cu.goneHint(gone, { bundleId: BUNDLE_ID })
  assert.notEqual(hinted, gone, `④ act_ui 的报错应被认出来并补上出路,实得:${gone}`)
  assert.ok(hinted.includes(`ensure_app({ bundleId: "${BUNDLE_ID}" })`), '④ 出路是一条能照抄的 ensure_app')
  const empty = await cu.executeFind('', { pid: boot.pid }, undefined, undefined, pctx)
  assert.match(cu.noRootsHint(empty.details), /ensure_app/, `④ find_roots 按 pid 找不到时也要指向 ensure_app,实得:${text(empty)}`)
  assert.equal(state().page, 1, '④ 报错的那一次不得有点击落下')
  const tcx = { signal: undefined }
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
  console.log('✅ 只能看图的 App:坐标按截图像素、expect 没满足进正文、按坐标滚动 / 拖拽真的生效、窗口离开当前桌面时有出路')
} finally {
  await killFixture()
  if (before.bundleId) await toFront(before.bundleId)
}
