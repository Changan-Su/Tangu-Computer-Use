/**
 * 「只能看截图」的两个自绘替身 App(Melody = 网易云音乐那类 CEF 播放器、Chatter = 微信那类聊天软件)的
 * 编译 / 启动 / 读状态 / 退出。源码在 scripts/vision-fixture/{melody,chatter}.swift,用法见各自文件头。
 *
 * 判定只看替身自己写的状态文件(每次变化原子写入),不信 agent 的自述。状态里:
 *   pid / windowNumber(= CGWindowID)/ window {x,y,w,h}(全局点、左上角原点)/ content {w,h}
 *   layout [{kind, label, rect, partial?}] —— 当前画面上看得见的条目,窗口坐标(左上角原点、点),直接对应整窗截图
 *   events [{t, kind, detail}] —— 过程记录;catalog(Melody)/ contacts(Chatter)—— 答案表
 *
 * ⚠️安全:只用 `open -g -n` 后台启动(不抢前台),只按状态文件里的 pid 结束自己起的进程,绝不 pkill。
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileP = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export const FIXTURES = {
  melody: { source: 'scripts/vision-fixture/melody.swift', name: 'MelodyFixture', bundleId: 'com.forsion.cu-fixture.melody', size: { w: 1000, h: 680 } },
  chatter: { source: 'scripts/vision-fixture/chatter.swift', name: 'ChatterFixture', bundleId: 'com.forsion.cu-fixture.chatter', size: { w: 900, h: 640 } },
  // pid-window 探针的盖窗(scripts/pid-window.probe.mjs):不是被测对象,盖在被测窗口上面、记下误落到自己身上的事件
  cover: { source: 'scripts/vision-fixture/cover.swift', name: 'CoverFixture', bundleId: 'com.forsion.cu-fixture.cover', size: { w: 600, h: 400 } },
}

/**
 * 缺省编译目录按检出分开、对同一检出固定:
 * - 同机几个 worktree 共用一个目录的话,「可执行文件比源码新就不重编」会让这个检出跑别的检出编出来的二进制;
 * - 固定:LaunchServices 按路径登记 App,每次换一个临时目录会攒下一堆指向已删路径的登记。
 */
export const DEFAULT_FIXTURE_DIR = path.join(os.tmpdir(), `cu-vision-fixtures-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`)

function spec(name) {
  const s = FIXTURES[name]
  if (!s) throw new Error(`unknown vision fixture "${name}" (expected ${Object.keys(FIXTURES).join(' | ')})`)
  return s
}

/** .app 里的可执行文件路径(selftest 直接跑它,拿 stdout)。 */
export function fixtureExecutable(app) {
  return path.join(app, 'Contents', 'MacOS', path.basename(app, '.app'))
}

/**
 * 编译成 <outDir>/<Name>Fixture.app;可执行文件比 .swift 新就不重编(swiftc -O 约半分钟)。
 * 先编到临时文件再改名:编译失败不会毁掉旧的,正在启动的实例也不会读到半个文件。
 */
export async function buildFixture(name, outDir = DEFAULT_FIXTURE_DIR) {
  const s = spec(name)
  const source = path.join(root, s.source)
  const app = path.join(outDir, `${s.name}.app`)
  const exe = fixtureExecutable(app)
  const plist = path.join(app, 'Contents', 'Info.plist')
  if (fs.existsSync(exe) && fs.existsSync(plist) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) return app
  fs.mkdirSync(path.dirname(exe), { recursive: true })
  fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${s.bundleId}</string>
<key>CFBundleName</key><string>${s.name}</string>
<key>CFBundleExecutable</key><string>${s.name}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1.0</string>
<key>LSMinimumSystemVersion</key><string>14.0</string>
<key>NSHighResolutionCapable</key><true/>
<key>NSAppSleepDisabled</key><true/>
<key>NSQuitAlwaysKeepsWindows</key><false/>
</dict></plist>
`)
  // 必须钉 -target:不钉的话 swiftc 取工具链自己的缺省最低系统版本,可能比本机还新,LaunchServices 直接拒开(-10825)。
  const triple = `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macosx14.0`
  const tmp = `${exe}.build-${process.pid}`
  try {
    await execFileP('xcrun', ['swiftc', '-target', triple, '-O', source, '-o', tmp], { timeout: 300_000 })
    fs.renameSync(tmp, exe)
  } finally {
    fs.rmSync(tmp, { force: true })
  }
  return app
}

export function readState(statePath) {
  return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

/** 轮询状态文件直到 predicate 成立;超时抛错并带上最后一次读到的状态。 */
export async function waitForState(statePath, predicate = () => true, { timeoutMs = 10_000, intervalMs = 100 } = {}) {
  const deadline = Date.now() + timeoutMs
  let last
  while (Date.now() < deadline) {
    try {
      last = readState(statePath)
      if (await predicate(last)) return last
    } catch { /* 还没写出来 / 正在换文件 */ }
    await sleep(intervalMs)
  }
  const brief = last && JSON.stringify({ ...last, events: last.events?.slice(-5), catalog: undefined, layout: last.layout?.length })
  throw new Error(`vision fixture state timeout (${statePath}); last state: ${brief ?? 'none'}`)
}

/**
 * 后台启动(`open -g -n`,不抢前台),等到第一帧画完(state.ready)再返回那时的状态。
 * frame: {x,y,w,h} 或 [x,y,w,h],全局屏幕点、左上角原点(与 CGWindowList bounds 同一约定),指整个窗口。
 * page / play(Melody)/ sent(Chatter)只给截图校准用;behind = 窗口放到所有窗口后面(截图不受遮挡,不挡用户的屏幕)。
 */
export async function launchFixture(app, statePath, { frame, page, play, sent, behind = false, args = [], timeoutMs = 10_000 } = {}) {
  // 先删旧状态:否则上一个(可能已经死了的)实例留下的文件会被当成这次的,windowNumber 指向不存在的窗口
  fs.rmSync(statePath, { force: true })
  fs.mkdirSync(path.dirname(statePath), { recursive: true })
  const argv = [statePath]
  if (frame) argv.push('--frame', (Array.isArray(frame) ? frame : [frame.x, frame.y, frame.w, frame.h]).join(','))
  if (page) argv.push('--page', page)
  if (play != null) argv.push('--play', String(play))
  if (sent != null) argv.push('--sent', String(sent))
  if (behind) argv.push('--behind')
  argv.push(...args)
  await execFileP('open', ['-g', '-n', app, '--args', ...argv])
  try {
    return await waitForState(statePath, (s) => s.ready && s.windowNumber > 0 && alive(s.pid), { timeoutMs })
  } catch (e) {
    // open 已经起了进程、首帧没等到:按这次独有的 statePath 找到它结束掉(quitFixture 只认 *Fixture.app),别留孤儿
    const { stdout } = await execFileP('pgrep', ['-f', statePath]).catch(() => ({ stdout: '' }))
    for (const pid of stdout.split(/\s+/).filter(Boolean)) await quitFixture(Number(pid)).catch(() => {})
    throw e
  }
}

/** 按状态里的 pid 结束替身:先 SIGTERM,2 秒后还在就 SIGKILL。只认 *Fixture.app 里的进程,pid 被复用了也不会误杀。 */
export async function quitFixture(stateOrPid) {
  const pid = typeof stateOrPid === 'number' ? stateOrPid : stateOrPid?.pid
  if (!pid || !alive(pid)) return false
  const { stdout } = await execFileP('ps', ['-o', 'command=', '-p', String(pid)]).catch(() => ({ stdout: '' }))
  if (!/Fixture\.app\/Contents\/MacOS\//.test(stdout)) return false
  try { process.kill(pid, 'SIGTERM') } catch { return false }
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    if (!alive(pid)) return true
    await sleep(50)
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* 刚好自己退了 */ }
  return true
}

/**
 * 进程内自检:直接跑可执行文件 `--selftest`(不显示窗口、不经系统、不发任何真实输入),
 * 把各个输入处理函数按流程调一遍。返回 {pass, failures, ...}。
 */
export async function selfTestFixture(app, statePath, { timeoutMs = 60_000, args = [] } = {}) {
  fs.rmSync(statePath, { force: true })
  const result = await execFileP(fixtureExecutable(app), [statePath, '--selftest', ...args], { timeout: timeoutMs })
    .then(({ stdout }) => ({ stdout, code: 0 }), (error) => ({ stdout: error.stdout ?? '', code: error.code ?? 1, error }))
  const line = result.stdout.trim().split('\n').filter(Boolean).pop()
  let report
  try { report = JSON.parse(line) } catch { report = { pass: false, failures: [`no selftest report (exit ${result.code}): ${result.error?.message ?? line}`] } }
  return { ...report, exitCode: result.code }
}
