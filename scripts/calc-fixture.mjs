/**
 * 三个真机仪器共用的「干净的计算器」夹具。
 *
 * 为什么值得单独拿出来:每个仪器跑完都 `pkill -x Calculator`,下一个立刻 `open` —— 会撞上**正在退出**
 * 的旧进程,拿到一个马上就要消失的 windowId。表现是取景流绑到死窗口、整轮回同一张图,于是
 * check:liveview 在单跑时绿、串跑时随机红。薄脆的仪器比没有更坏:它会训练人忽略红灯。
 * 所以开之前先确认旧的**真的没了**,再开、再等到窗口可观察为止。
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { resolveMacosHelperAppPath } from '../src/vendor/platform/macos/helper-path.mjs'

const execFileP = promisify(execFile)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const BUNDLE_ID = 'com.apple.calculator'

export const SOCK = `${os.homedir()}/Library/Caches/tangu-computer-use/bridge.sock`
export const HELPER_APP = resolveMacosHelperAppPath()
export const HELPER_EXECUTABLE = path.join(HELPER_APP, 'Contents', 'MacOS', 'bridge')

/**
 * daemon 没在跑就拉起来。仪器要能从**冷机**跑起来 —— 刚重装完 helper、或刚 `computer-use stop` 过,
 * 否则每次都得先手动铺场,而「先手动铺场」的仪器迟早没人跑。
 *
 * ⚠️必须走 `open -n -g <APP>`(与 vendor 的 launchDaemon 一致),**不能**直接 spawn
 * Contents/MacOS/bridge:TCC 认的是 responsible process,直接 spawn 会把归因挂到调用者
 * (终端/node)身上,于是 diagnostics 报「没有辅助功能权限」—— 看起来像授权丢了,其实是启动方式错了。
 */
export async function ensureDaemon(ask) {
  for (let attempt = 0; attempt < 25; attempt++) {
    try { return await ask({ cmd: 'diagnostics' }) } catch (e) {
      if (attempt === 0 && (e.code === 'ECONNREFUSED' || e.code === 'ENOENT')) {
        fs.rmSync(SOCK, { force: true })
        await execFileP('open', ['-n', '-g', HELPER_APP, '--args', 'serve', '--socket', SOCK]).catch(() => {})
      }
      await sleep(300)
    }
  }
  throw new Error(`helper daemon 起不来(${HELPER_APP})`)
}

async function listCalculator(ask) {
  return (await ask({ cmd: 'listApps' })).find((a) => a.bundleId === BUNDLE_ID)
}

/** 结束掉当前的计算器,并等到 helper 也确认它不在了。 */
export async function killCalculator(ask, timeoutMs = 8_000) {
  await execFileP('pkill', ['-x', 'Calculator']).catch(() => {})
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!(await listCalculator(ask))) return
    await sleep(150)
  }
  // ⚠️静默放行等于把夹具要消灭的竞态原样放回来:下一步会立刻 open,撞上还没退干净的旧实例。
  // 宁可红,也别让后面那些断言在一个不确定的场子里跑。
  throw new Error('计算器在 ' + timeoutMs + 'ms 内没有退出 —— 场子不干净,拒绝继续')
}

/** 开一个全新的、后台的、已经有可观察窗口的计算器。 */
export async function freshCalculator(ask, timeoutMs = 15_000) {
  await killCalculator(ask)
  await execFileP('open', ['-g', '-a', 'Calculator'])
  const deadline = Date.now() + timeoutMs
  let last = '还没看到计算器进程'
  while (Date.now() < deadline) {
    const calc = await listCalculator(ask)
    if (calc) {
      const win = (await ask({ cmd: 'listRoots', pid: calc.pid })).roots.find((r) => r.windowId)
      if (win) return { calc, win }
      last = '进程在但还没有可见窗口'
    }
    await sleep(300)
  }
  throw new Error(`等计算器就绪超时:${last}`)
}
