#!/usr/bin/env node
/**
 * pid-window 探针:按坐标的点击 / 滚动,投给目标进程(CGEventPostToPid)时填上目标窗口号,能不能在窗口被别的 App
 * 盖住时落下去,同时不激活 App、不提窗口、不动真鼠标。上游记的是「postToPid 对非 key 窗口会被丢掉」,没人试过填窗口号。
 *
 * 每个目标 × 每个动作 × 两种投法各跑一次:plain = 现在 pid 投递的样子(不带窗口号),window = 带上窗口号和窗口内坐标
 * (字段 51 + windowLocation,见 bridge.swift postEvent 的注释)。
 * 每次先起一个盖窗(CoverFixture,激活、盖住目标),分开记五件事:
 *   landed 事件落没落到(替身 / 网页看自己的日志,真 App 看截图前后差异)
 *   raised 目标窗口有没有跑到盖窗上面(z 序)
 *   front  前台 App 变没变
 *   active 目标 App 有没有自己激活(和 z 序分开记)
 *   mouse  真实鼠标位置变没变
 * 另记:盖窗有没有收到事件(误落)、目标窗口的 AXMain / AXFocused 前后、落点是不是瞄的那个条目。
 *
 * 用法:
 *   node scripts/pid-window.probe.mjs --socket <探针 helper 的 socket> [--shot-socket <有录屏授权的 helper 的 socket>]
 *        [--only melody,chatter,electron,chrome,textedit] [--variants plain,window] [--out <目录>]
 * 探针 helper = 开发证书签的 .dev 包(`node scripts/dev-recorder.mjs build`,辅助功能授权按设计要求认、重编不丢),
 * 用自己的 socket 起:`open -n -g build/tangu-computer-use-dev.app --args serve --socket <sock> --dev-probe`
 * (只有带 --dev-probe 才认 probeInput)。截图要录屏授权,另起一份正式证书的 helper:
 * `open -n -g /Applications/tangu-computer-use.app --args serve --socket <另一个 sock>`。
 * ⚠️会在屏幕上弹窗、盖住被测窗口几秒:跑之前占 devlock(`devlock.cjs run --vehicle=e2e -- …`)。
 * ⚠️不对用户在用的 App(微信、网易云……)发事件:那类 App 用替身 Chatter / Melody(用户 10-17 定)。
 * 文本编辑开的是自己写的临时文件(新开一个实例,跑完结束它)。
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DEFAULT_FIXTURE_DIR, buildFixture, launchFixture, quitFixture, readState, waitForState } from './vision-fixtures.mjs'

const execFileP = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : fallback }
const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean)

const socket = arg('--socket')
const shotSocket = arg('--shot-socket')
const outDir = path.resolve(arg('--out', path.join(os.tmpdir(), `pid-window-probe-${Date.now()}`)))
const only = list(arg('--only', 'melody,chatter,electron,chrome,textedit'))
const variants = list(arg('--variants', 'plain,window'))
const userPoints = JSON.parse(arg('--points', '{}'))
const electronBin = arg('--electron', path.resolve(here, '../../../Forsion-Genesis/desktop/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'))
fs.mkdirSync(outDir, { recursive: true })

function helper(sock, cmd, args = {}, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock)
    let buffer = ''
    const timer = setTimeout(() => { conn.destroy(); reject(new Error(`${cmd} timed out`)) }, timeoutMs)
    conn.setEncoding('utf8')
    conn.on('connect', () => conn.write(`${JSON.stringify({ id: `pw-${Date.now()}`, cmd, ...args })}\n`))
    conn.on('data', (chunk) => {
      buffer += chunk
      const i = buffer.indexOf('\n')
      if (i < 0) return
      clearTimeout(timer)
      conn.end()
      const reply = JSON.parse(buffer.slice(0, i))
      reply.ok ? resolve(reply.result) : reject(Object.assign(new Error(`${cmd}: ${reply.error?.message ?? JSON.stringify(reply)}`), { code: reply.error?.code }))
    })
    conn.on('error', (error) => { clearTimeout(timer); reject(error) })
  })
}

// ---- 量具(scripts/pid-window/probe-tool.swift,不要授权) ----
const toolPath = path.join(DEFAULT_FIXTURE_DIR, 'pid-window-probe-tool')
async function buildTool() {
  const source = path.join(here, 'pid-window', 'probe-tool.swift')
  if (fs.existsSync(toolPath) && fs.statSync(toolPath).mtimeMs >= fs.statSync(source).mtimeMs) return
  fs.mkdirSync(DEFAULT_FIXTURE_DIR, { recursive: true })
  await execFileP('xcrun', ['swiftc', '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`, '-O', source, '-o', toolPath], { timeout: 300_000 })
}
const sample = async (ms, pid, wid, coverWid) => JSON.parse((await execFileP(toolPath, ['sample', String(ms), String(pid), String(wid), String(coverWid)])).stdout)
const diff = async (a, b, roi = []) => JSON.parse((await execFileP(toolPath, ['diff', a, b, ...roi.map(String)])).stdout)

async function shot(windowId, file) {
  if (!shotSocket) return null
  const image = await helper(shotSocket, 'windowImage', { windowId, maxDimension: 1600 })
  const full = path.join(outDir, file)
  fs.writeFileSync(full, Buffer.from(image.jpegBase64, 'base64'))
  return { file: full, width: image.width, height: image.height }
}

/** 目标窗口在 AX 里的 main / focused(= App 内的 key 窗口)。读不到就 null,不影响别的几项。 */
async function axWindow(pid, windowId) {
  try {
    const windows = await helper(socket, 'listWindows', { pid })
    const w = windows.find((item) => item.windowId === windowId)
    return w ? { main: w.isMain, focused: w.isFocused } : null
  } catch { return null }
}

async function mainWindow(pid, predicate = () => true) {
  const windows = (await helper(socket, 'listWindows', { pid })).filter((w) => w.windowId && predicate(w))
  windows.sort((a, b) => b.framePoints.w * b.framePoints.h - a.framePoints.w * a.framePoints.h)
  return windows[0]
}

// ---- 网页靶子(Chrome 隔离实例、Electron 替身):页面把收到的事件 POST 回 /log ----
const webLog = []
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/log') {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { try { webLog.push(JSON.parse(body)) } catch {} res.end('ok') })
    return
  }
  res.setHeader('content-type', 'text/html; charset=utf-8')
  res.end(fs.readFileSync(path.join(here, 'pid-window', 'page.html')))
})
let port = 0

// ---- 盖窗 ----
let coverApp
let cover
const coverState = path.join(outDir, 'cover.json')
async function raiseCover(frame) {
  if (cover) await quitFixture(cover.pid)
  fs.rmSync(coverState, { force: true })
  // 不带 -g:让 LaunchServices 把它当用户打开的 App 激活,成为前台
  await execFileP('open', ['-n', coverApp, '--args', coverState, '--frame', [frame.x, frame.y, frame.w, frame.h].map(Math.round).join(',')])
  cover = await waitForState(coverState, (s) => s.ready && s.windowNumber > 0, { timeoutMs: 8000 })
  cover = await waitForState(coverState, (s) => s.active, { timeoutMs: 1500 }).catch(() => readState(coverState))
  return cover
}
const pad = (b, m) => ({ x: b.x - m, y: b.y - m, w: b.w + 2 * m, h: b.h + 2 * m })

// ---- 动作 ----
const ACTIONS = {
  click: { kind: 'click', clickCount: 1, point: 'click' },
  doubleClick: { kind: 'click', clickCount: 2, point: 'click' },
  rightClick: { kind: 'click', button: 'right', point: 'click' },
  scroll: { kind: 'scroll', scrollY: 240, point: 'scroll' },
}

// ---- 目标 ----
function fixtureTarget(name, clickKinds, scrollKinds) {
  let state, statePath
  const pick = (kinds) => {
    const item = state.layout.find((i) => kinds.includes(i.kind) && !i.partial && i.rect.w > 20 && i.rect.h > 10)
    if (!item) throw new Error(`${name}: no ${kinds} in layout`)
    return { item, x: state.window.x + item.rect.x + item.rect.w / 2, y: state.window.y + item.rect.y + item.rect.h / 2 }
  }
  return {
    name,
    actions: ['click', 'doubleClick', 'rightClick', 'scroll'],
    async setup() {
      statePath = path.join(outDir, `${name}.json`)
      state = await launchFixture(await buildFixture(name), statePath, { frame: { x: 160, y: 120, w: name === 'melody' ? 1000 : 900, h: name === 'melody' ? 680 : 640 } })
      return { pid: state.pid, windowId: state.windowNumber, bounds: state.window }
    },
    points() {
      state = readState(statePath)
      const click = pick(clickKinds)
      const scroll = pick(scrollKinds)
      return { click: { x: click.x, y: click.y, aim: `${click.item.kind} ${click.item.label}` }, scroll: { x: scroll.x, y: scroll.y, aim: `${scroll.item.kind} ${scroll.item.label}` } }
    },
    async landed(action, t0, _shots, before) {
      const now = readState(statePath)
      const events = now.events.filter((e) => e.t >= t0)
      const detail = events.map((e) => `${e.kind} ${e.detail}`).join(' | ')
      // 替身不处理右键:记不到不算没落下
      if (action.button === 'right') return { landed: null, detail: `n/a (fixture ignores right clicks) ${detail}` }
      // 滚轮看计数(视图收到带位移的滚轮就 +1):日志只在偏移变了才写,滚动方向被平滑滚动工具反过来时会漏判
      const counter = action.kind === 'scroll' ? 'scrolls' : 'clicks'
      return { landed: now[counter] > before[counter], detail: `${counter} ${before[counter]}→${now[counter]} ${detail}` }
    },
    snapshot() { return readState(statePath) },
    async teardown() { await quitFixture(state?.pid) },
  }
}

function webTarget(name) {
  let proc, pid, windowId, profile
  const frame = { x: 180, y: 140, w: 980, h: 640 }
  const geom = () => webLog.filter((e) => e.who === name && e.type === 'geom').at(-1)
  return {
    name,
    actions: ['click', 'doubleClick', 'rightClick', 'scroll'],
    async setup() {
      const url = `http://127.0.0.1:${port}/page.html?who=${name}`
      if (name === 'electron') {
        proc = spawn(electronBin, [path.join(here, 'pid-window', 'electron-main.cjs'), url, [frame.x, frame.y, frame.w, frame.h].join(',')], { stdio: 'ignore' })
        pid = proc.pid
      } else {
        profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-window-chrome-'))
        await execFileP('open', ['-n', '-g', '-a', 'Google Chrome', '--args', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
          `--window-position=${frame.x},${frame.y}`, `--window-size=${frame.w},${frame.h}`, '--new-window', url])
        for (let i = 0; i < 50 && !pid; i++) {
          await sleep(200)
          const { stdout } = await execFileP('pgrep', ['-f', `user-data-dir=${profile}`]).catch(() => ({ stdout: '' }))
          for (const p of stdout.split(/\s+/).filter(Boolean)) {
            const { stdout: cmd } = await execFileP('ps', ['-o', 'command=', '-p', p]).catch(() => ({ stdout: '' }))
            if (!cmd.includes('--type=')) pid = Number(p)
          }
        }
      }
      for (let i = 0; i < 60 && !geom(); i++) await sleep(200)
      if (!geom()) throw new Error(`${name}: page never reported its geometry`)
      const w = await mainWindow(pid)
      windowId = w.windowId
      return { pid, windowId, bounds: w.framePoints }
    },
    points() {
      const g = geom()
      const left = g.screenX + (g.outerWidth - g.innerWidth) / 2
      const top = g.screenY + (g.outerHeight - g.innerHeight)
      return {
        click: { x: left + g.btn.x + g.btn.width / 2, y: top + g.btn.y + g.btn.height / 2, aim: '#btn' },
        scroll: { x: left + g.list.x + g.list.width / 2, y: top + g.list.y + g.list.height / 2, aim: '#list' },
      }
    },
    async landed(action, t0) {
      const events = webLog.filter((e) => e.who === name && e.t >= t0 - 50 && e.type !== 'geom')
      const want = action.kind === 'scroll' ? ['wheel', 'scroll'] : action.button === 'right' ? ['contextmenu', 'mousedown'] : action.clickCount === 2 ? ['dblclick'] : ['click']
      const hits = events.filter((e) => want.includes(e.type))
      return { landed: hits.length > 0, detail: events.map((e) => `${e.type}${e.target ? `@${e.target}` : ''}${e.focus === false ? '(nofocus)' : ''}${e.top != null ? `:${e.top}` : ''}`).join(' ') }
    },
    async teardown() {
      if (proc) proc.kill()
      else if (pid) { try { process.kill(pid, 'SIGTERM') } catch {} }
      await sleep(500)
      if (profile) fs.rmSync(profile, { recursive: true, force: true })
    },
  }
}

/** 真 App(和文本编辑):看截图前后差异。点由 --points 给(窗口内的点),没给就只截一张图让人挑。 */
function screenTarget(name, { launch, quit, pick, actions }) {
  let pid, windowId, bounds
  return {
    name,
    actions,
    needsShot: true,
    async setup() {
      ;({ pid, windowId, bounds } = await launch())
      return { pid, windowId, bounds }
    },
    points() {
      const p = { ...pick?.(bounds), ...userPoints[name] }
      const g = (rel) => rel && { x: bounds.x + rel[0], y: bounds.y + rel[1], aim: `window+${rel.join(',')}` }
      return { click: g(p.click), scroll: g(p.scroll), reset: g(p.reset) && { ...g(p.reset), clickCount: p.resetCount ?? 1 } }
    },
    async landed(action, t0, shots) {
      if (!shots?.before || !shots?.after) return { landed: null, detail: 'no screenshots' }
      // --points 里可给 roi:{click|scroll: [x,y,w,h]}(窗口内的点),换成截图像素
      const k = shots.before.width / bounds.w
      const roi = (userPoints[name]?.roi?.[action.point] ?? []).map((v) => Math.round(v * k))
      const d = await diff(shots.before.file, shots.after.file, roi)
      // 有东西变了就算落下了;噪声(动图、新消息)要人看图,所以把框和占比都留下
      return { landed: d.changed > 50, detail: `diff ${d.changed}px (${(d.ratio * 100).toFixed(2)}%) box ${JSON.stringify(d.box)}${roi.length ? ` roi ${JSON.stringify(roi)}` : ''}`, diff: d }
    },
    async teardown() { await quit?.(pid) },
  }
}

const TARGETS = {
  melody: () => fixtureTarget('melody', ['sidebar'], ['row', 'card']),
  chatter: () => fixtureTarget('chatter', ['contact'], ['contact']),
  electron: () => webTarget('electron'),
  chrome: () => webTarget('chrome'),
  textedit: () => {
    let file
    return screenTarget('textedit', {
      actions: ['doubleClick', 'scroll'],
      async launch() {
        file = path.join(outDir, 'pid-window-probe.txt')
        fs.writeFileSync(file, Array.from({ length: 400 }, (_, i) => `line ${i + 1} alpha beta gamma delta epsilon zeta eta theta`).join('\n'))
        const before = new Set((await execFileP('pgrep', ['-x', 'TextEdit']).catch(() => ({ stdout: '' }))).stdout.split(/\s+/).filter(Boolean))
        await execFileP('open', ['-n', '-g', '-a', 'TextEdit', file])
        let pid = 0
        for (let i = 0; i < 40 && !pid; i++) {
          await sleep(200)
          const now = (await execFileP('pgrep', ['-x', 'TextEdit']).catch(() => ({ stdout: '' }))).stdout.split(/\s+/).filter(Boolean)
          pid = Number(now.find((p) => !before.has(p)) ?? 0)
        }
        let w
        for (let i = 0; i < 40 && !w; i++) { await sleep(200); w = await mainWindow(pid, (x) => x.title.includes('pid-window-probe')).catch(() => null) }
        if (!w) throw new Error('textedit: window never showed up')
        return { pid, windowId: w.windowId, bounds: w.framePoints }
      },
      pick: (b) => ({ click: [90, 120], scroll: [Math.round(b.w / 2), Math.round(b.h / 2)] }),
      async quit(pid) { try { process.kill(pid, 'SIGTERM') } catch {} },
    })
  },
}

/** 把采样里的变化逐条放回去:盖窗有没有一刻跑到目标后面、前台 / 激活 / 鼠标出现过哪些值。 */
function summarize(watch, targetPid, point) {
  let cur = { ...watch.first }
  const seen = { front: new Set([cur.front]), mouse: new Set([cur.mouse.join(',')]) }
  const above = (c) => c.coverIdx < 0 || (c.targetIdx >= 0 && c.targetIdx < c.coverIdx)
  let raised = above(cur)
  let activated = cur.targetActive
  for (const change of watch.changes) {
    cur = { ...cur, ...change }
    seen.front.add(cur.front)
    seen.mouse.add(cur.mouse.join(','))
    if (above(cur)) raised = true
    if (cur.targetActive) activated = true
  }
  return {
    raised,
    front: seen.front.size > 1 ? [...seen.front] : null,
    frontIsTarget: [...seen.front].includes(targetPid),
    activated,
    mouse: seen.mouse.size > 1 ? [...seen.mouse] : null,
    // 真鼠标有没有到过我们点的位置:用户自己挪鼠标也会让 mouse 有值,这一项才是「我们动了真鼠标」
    mouseAtTarget: [...seen.mouse].some((m) => { const [x, y] = m.split(',').map(Number); return Math.abs(x - point.x) <= 2 && Math.abs(y - point.y) <= 2 }),
  }
}

async function runTarget(target) {
  const info = await target.setup()
  console.log(`\n== ${target.name}: pid ${info.pid} window ${info.windowId} ${JSON.stringify(info.bounds)}`)
  const rows = []
  for (const actionName of target.actions) {
    for (const variant of variants) {
      const action = ACTIONS[actionName]
      const points = target.points()
      const point = points[action.point]
      if (!point) { rows.push({ target: target.name, action: actionName, variant, skipped: 'no point (pass --points)' }); continue }
      await raiseCover(pad(info.bounds, 24))
      const pre = await sample(60, info.pid, info.windowId, cover.windowNumber)
      const covered = pre.last.coverIdx >= 0 && pre.last.coverIdx < pre.last.targetIdx && pre.last.front === cover.pid
      const axBefore = await axWindow(info.pid, info.windowId)
      const tag = `${target.name}-${actionName}-${variant}`
      const before = target.needsShot ? await shot(info.windowId, `${tag}-before.jpg`) : null
      const snapshot = target.snapshot?.()
      const t0 = Date.now()
      const twoWay = target.needsShot && action.kind === 'scroll'
      const watching = sample(twoWay ? 3500 : 1500, info.pid, info.windowId, cover.windowNumber)
      await sleep(200)
      const send = (extra) => helper(socket, 'probeInput', { pid: info.pid, x: point.x, y: point.y, kind: action.kind, clickCount: action.clickCount, button: action.button, scrollY: action.scrollY, ...extra, ...(variant === 'window' ? { windowId: info.windowId } : {}) })
      let posted
      try {
        // 和产品里的 wheelAction 一样先垫一个零距离滚轮:开着 Mos 这类平滑滚动工具时,发往新窗口的第一个滚轮事件会被吞掉
        if (action.kind === 'scroll') { await send({ scrollY: 0 }); await sleep(150) }
        posted = await send({})
      } catch (error) { posted = { error: error.message } }
      await sleep(300)
      let after = target.needsShot ? await shot(info.windowId, `${tag}-after.jpg`) : null
      let result = await target.landed(action, t0, { before, after }, snapshot)
      // 真 App 的滚动:方向可能被平滑滚动工具反过来、又刚好顶到头(滚不动 = 截图不变),反方向再滚一次再看
      let direction = 1
      if (twoWay && result.landed === false) {
        await send({ scrollY: -action.scrollY }).catch(() => {})
        await sleep(400)
        after = await shot(info.windowId, `${tag}-after2.jpg`)
        result = await target.landed(action, t0, { before, after }, snapshot)
        direction = -1
      }
      const watch = await watching
      const axAfter = await axWindow(info.pid, info.windowId)
      const coverHits = readState(coverState).events.filter((e) => e.t >= t0 && /mouse|scroll/i.test(e.kind))
      const s = summarize(watch, info.pid, point)
      const row = {
        target: target.name, action: actionName, variant, aim: point.aim, covered,
        landed: result.landed, raised: s.raised, frontChanged: Boolean(s.front), activated: s.activated, mouseMoved: Boolean(s.mouse), mouseAtTarget: s.mouseAtTarget,
        coverGotEvent: coverHits.length > 0, axBefore, axAfter, detail: result.detail, fronts: s.front, mice: s.mouse,
        coverActive: cover.active, posted, shots: [before?.file, after?.file].filter(Boolean),
      }
      rows.push(row)
      console.log(`${tag.padEnd(34)} covered=${covered} landed=${row.landed} raised=${row.raised} front=${row.frontChanged} activated=${row.activated} mouse=${row.mouseAtTarget ? 'ours' : row.mouseMoved ? 'user' : false} coverHit=${row.coverGotEvent} ax=${JSON.stringify(axBefore)}→${JSON.stringify(axAfter)} | ${row.detail.slice(0, 160)}`)
      // 真 App 落下了就复原(同一种投法):点回原来的页签 / 滚回去
      if (row.landed && target.needsShot) {
        const undo = action.kind === 'scroll' ? { kind: 'scroll', ...points.scroll, scrollY: -direction * action.scrollY } : points.reset && { kind: 'click', ...points.reset }
        if (undo) await helper(socket, 'probeInput', { pid: info.pid, ...undo, ...(variant === 'window' ? { windowId: info.windowId } : {}) }).catch(() => {})
        await sleep(300)
      }
    }
  }
  return rows
}

async function main() {
  await buildTool()
  if (!socket) throw new Error('--socket <probe helper socket> is required')
  const diag = await helper(socket, 'diagnostics')
  if (!diag.accessibility) throw new Error('probe helper has no Accessibility grant')
  await helper(socket, 'probeInput', {}).catch((error) => {
    if (error.code === 'unknown_command') throw new Error('probe helper was not started with --dev-probe')
  })
  coverApp = await buildFixture('cover')
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  port = server.address().port
  const rows = []
  try {
    for (const name of only) {
      const target = TARGETS[name]()
      try { rows.push(...await runTarget(target)) }
      catch (error) { console.log(`!! ${name}: ${error.message}`); rows.push({ target: name, error: error.message }) }
      finally { await target.teardown().catch(() => {}) }
    }
  } finally {
    if (cover) await quitFixture(cover.pid)
    server.close()
    fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify({ at: new Date().toISOString(), helper: diag.executablePath, rows }, null, 2))
    console.log(`\nresults: ${path.join(outDir, 'results.json')}`)
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
