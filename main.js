/**
 * Computer Use —— Forsion 桌面插件(裸 setup(ctx) 体,宿主 new Function('ctx', code) 装载)。
 *
 * 只做一件事:注册 `plugin:tangu-computer-use:live` 视图 —— 显示 agent 正在操控的那个窗口的画面。
 * agent 在 Agent Desk 上摆它(desk_present {type:'view'}),就成了"演出面板里的实况转播";
 * 用户也能在命令面板里单独打开看。
 *
 * 画面从哪来:主进程 `window.tangu.computerUseLiveView()` → CU 原生 helper 的 liveView 命令
 * (ScreenCaptureKit 后台截目标窗口,不抢焦点)。三条纪律照抄主进程那层:
 *   1. **只读**:helper 没跑就如实说"没在操控",绝不因为打开了视图去把辅助 App 拉起来。
 *   2. **不伪造**:拿不到画面就摆错误说明(最常见是没给录屏权限),不留一张旧图假装实时。
 *   3. **看不见就不拉**:页面隐藏 / 视图滚出可视区就停轮询 —— 每帧都是一次真实截屏,不能白烧。
 *
 * 配色一律吃宿主 token(--bg-card/--text/--border/--accent/--on-accent…),绝不写死颜色:
 * LCL 的 --accent 在 cream 暗色是纸白,写死白字必然压成 1.02:1 全瞎(青鸟踩过)。
 */
const PLUGIN_ID = 'tangu-computer-use'
const VIEW_ID = 'live'

/**
 * 轮询间隔(毫秒)≈ 8fps。
 * helper 那边已经是**常驻 ScreenCaptureKit 取景流**(live_stream.swift),取一帧只是从缓存里拿最新
 * 那张 + JPEG 编码,不再是"每帧重新协商一次采集会话"。所以这里可以按屏幕共享的节奏拉。
 * ⚠️别再调回 1000:1fps 是幻灯片,用户实报"不是 share screen 的实时画面,是掉帧的"。
 */
const TICK_MS = 120
/** 没在操控时放慢:纯问一句状态(不带图),便宜。 */
const IDLE_TICK_MS = 2500
/**
 * 看不见时的间隔。**是"降频"不是"停"**。
 * ⚠️曾经写成"不可见就一帧都不请求",结果:隐藏页面里浏览器不给做交集计算,
 * IntersectionObserver 连首次回调都不来 → 可见性永远停在初值「不可见」→ 视图**永久静默**。
 * 而 computer use 恰恰会把被操控的 App 拉到前台、让 Forsion 失去前台 ——
 * 越是需要看画面的时候越不刷新。宁可慢,不可死。
 */
const HIDDEN_TICK_MS = 6000

// ── 文案(zh / en 成对)────────────────────────────────────────────────────────
// 有 ctx.i18n.define(2026-10-26+)就交给宿主;旧宿主按 ctx.getLocale() 查自带的这张表,缺省中文。
// ⚠️加一条就两边都加:check.mjs 钉着键集一致、英文里没有汉字、{占位符} 两边逐字一致。
const MSG = {
  zh: {
    'err.unsupported_platform': '实时画面目前只有 macOS 支持(Windows 的 helper 是子进程,桌面端够不着)。',
    'err.helper_not_running': '还没有窗口正在被操控。让 agent 用 computer use 的工具动一下,画面就会出现。',
    'err.unsupported_helper': '本机的 Computer Use helper 还是旧版,不认识实时画面(边缘光效同样不会出现——两者在同一个二进制里)。让 agent 用一次 computer use 的工具,它会自动把 helper 更新到随包的版本;更新后 macOS 可能要求重新授权「辅助功能」与「屏幕录制」。',
    'err.capture_timeout': '截取窗口画面超时了,下一帧会重试。',
    'err.client_timeout': '等本机 helper 回画面超时了,下一帧会重试。',
    'err.capture_failed': '截不到这个窗口的画面 —— 多半是没给「屏幕录制」权限(系统设置 → 隐私与安全性)。',
    'err.screen_recording_denied': '没有「屏幕录制」权限,拿不到窗口画面(系统设置 → 隐私与安全性 → 屏幕录制)。',
    'err.encode_failed': '窗口画面编码失败,下一帧会重试。',
    'err.unknown': '实时画面暂时不可用({code})。',
    'ago.now': '刚刚',
    'ago.sec': '{n} 秒前',
    'ago.min': '{n} 分钟前',
    'win.numbered': '窗口 #{id}',
    'win.unknown': '未知窗口',
    'view.title': '被操控的窗口',
    'zoom.out': '缩小',
    'zoom.reset': '恢复默认比例(整幅可见)',
    'zoom.in': '放大',
    'img.alt': '正在被操控的窗口画面',
    'msg.needDesktop': '需要 Forsion 桌面端',
    'msg.needDesktopDetail': '实时画面要通过桌面主进程访问 Computer Use 的本机 helper。',
    'msg.none': '暂无正在被操控的窗口',
    'msg.noneDetail': '让 agent 用 computer use 的工具动一下,画面就会出现。',
    'msg.noFrame': '拿不到这一帧画面',
    'st.looking': '正在查看',
    'st.ended': '已结束',
    'st.click.doing': '正在点击「{label}」',
    'st.click.done': '已点击「{label}」',
    'st.click.doing.bare': '正在点击',
    'st.click.done.bare': '已点击',
    'st.rightClick.doing': '正在右键点击「{label}」',
    'st.rightClick.done': '已右键点击「{label}」',
    'st.rightClick.doing.bare': '正在右键点击',
    'st.rightClick.done.bare': '已右键点击',
    'st.type.doing': '正在向「{label}」输入',
    'st.type.done': '已向「{label}」输入',
    'st.type.doing.bare': '正在输入',
    'st.type.done.bare': '已输入',
    'st.scroll.doing': '正在滚动「{label}」',
    'st.scroll.done': '已滚动「{label}」',
    'st.scroll.doing.bare': '正在滚动',
    'st.scroll.done.bare': '已滚动',
    'st.drag.doing': '正在拖动「{label}」',
    'st.drag.done': '已拖动「{label}」',
    'st.drag.doing.bare': '正在拖动',
    'st.drag.done.bare': '已拖动',
    'st.key.doing.bare': '正在按键',
    'st.key.done.bare': '已按键',
    'st.move.doing.bare': '正在移动指针',
    'st.move.done.bare': '已移动指针',
    'done.steps': '已完成 · {n} 步',
    'done.step1': '已完成 · 1 步',
    'done.bare': '已完成',
    'btn.stop': '停止',
    'btn.stopTip': '停止这一轮',
    'btn.pip': '移到悬浮窗',
    'btn.pipTip': '在置顶的悬浮小窗里看这个画面',
    'btn.putBack': '放回去',
    'btn.putBackTip': '关掉悬浮窗,画面回到原处',
    // 过程行的句子(ctx.registerToolLabel)。{v} 动词、{obj} 对象、{app} 应用名;中文按「中西文之间留空格」拼(见 joinZh)。
    'tl.run': '正在{v}{obj}',
    'tl.run.app': '正在{app}中{v}{obj}',
    'tl.done': '已{v}{obj}',
    'tl.done.app': '已在{app}中{v}{obj}',
    'tl.err': '没能{v}{obj}',
    'tl.err.app': '没能在{app}中{v}{obj}',
    'tl.notFound': '没有找到{obj}',
    'tl.q': '「{s}」',
    'tl.steps': '(共 {n} 步)',
    'tl.stepOf': '(第 {i} 步,共 {n} 步)',
    'tl.o.screen': '屏幕',
    'tl.o.windows': '窗口',
    'tl.o.appWindows': '{app}的窗口',
    'tl.o.element': '界面元素',
    'tl.o.text': '文字',
    'tl.o.more': '后续输出',
    'tl.o.change': '界面变化',
    'tl.o.gone': '{q}消失',
    'tl.o.browser': '浏览器',
    'tl.o.page': '网页内容',
    'tl.v.click.run': '点击', 'tl.v.click.done': '点击', 'tl.v.click.err': '点击',
    'tl.v.doubleClick.run': '双击', 'tl.v.doubleClick.done': '双击', 'tl.v.doubleClick.err': '双击',
    'tl.v.rightClick.run': '右键点击', 'tl.v.rightClick.done': '右键点击', 'tl.v.rightClick.err': '右键点击',
    'tl.v.type.run': '输入', 'tl.v.type.done': '输入', 'tl.v.type.err': '输入',
    'tl.v.clear.run': '清空', 'tl.v.clear.done': '清空', 'tl.v.clear.err': '清空',
    'tl.v.key.run': '按下', 'tl.v.key.done': '按下', 'tl.v.key.err': '按下',
    'tl.v.scroll.run': '滚动', 'tl.v.scroll.done': '滚动', 'tl.v.scroll.err': '滚动',
    'tl.v.drag.run': '拖动', 'tl.v.drag.done': '拖动', 'tl.v.drag.err': '拖动',
    'tl.v.move.run': '移动指针', 'tl.v.move.done': '移动指针', 'tl.v.move.err': '移动指针',
    'tl.v.locate.run': '定位', 'tl.v.locate.done': '定位', 'tl.v.locate.err': '定位',
    'tl.v.look.run': '查看', 'tl.v.look.done': '查看', 'tl.v.look.err': '查看',
    'tl.v.find.run': '查找', 'tl.v.find.done': '找到', 'tl.v.find.err': '找到',
    'tl.v.search.run': '查找', 'tl.v.search.done': '查找', 'tl.v.search.err': '查找',
    'tl.v.read.run': '读取', 'tl.v.read.done': '读取', 'tl.v.read.err': '读取',
    'tl.v.wait.run': '等待', 'tl.v.wait.done': '等到', 'tl.v.wait.err': '等到',
    'tl.v.open.run': '打开', 'tl.v.open.done': '打开', 'tl.v.open.err': '打开',
    'tl.v.act.run': '操作', 'tl.v.act.done': '完成这些操作', 'tl.v.act.err': '完成这些操作',
  },
  en: {
    'err.unsupported_platform': "The live view is macOS only for now (on Windows the helper is a child process the desktop app can't reach).",
    'err.helper_not_running': 'No window is being controlled yet. The picture appears once the agent uses a computer use tool.',
    'err.unsupported_helper': "The Computer Use helper on this Mac is an older version without the live view (the edge glow won't appear either, as both live in the same binary). Have the agent use a computer use tool once and it updates the helper to the bundled version; macOS may then ask you to allow Accessibility and Screen Recording again.",
    'err.capture_timeout': 'Capturing the window timed out. The next frame will retry.',
    'err.client_timeout': 'Waiting for the local helper timed out. The next frame will retry.',
    'err.capture_failed': "Couldn't capture this window. Most likely Screen Recording isn't allowed (System Settings → Privacy & Security).",
    'err.screen_recording_denied': "Screen Recording isn't allowed, so the window can't be captured (System Settings → Privacy & Security → Screen Recording).",
    'err.encode_failed': 'Encoding the window picture failed. The next frame will retry.',
    'err.unknown': 'The live view is unavailable for now ({code}).',
    'ago.now': 'just now',
    'ago.sec': '{n}s ago',
    'ago.min': '{n} min ago',
    'win.numbered': 'Window #{id}',
    'win.unknown': 'Unknown window',
    'view.title': 'Controlled window',
    'zoom.out': 'Zoom out',
    'zoom.reset': 'Reset zoom (fit the whole window)',
    'zoom.in': 'Zoom in',
    'img.alt': 'Live picture of the controlled window',
    'msg.needDesktop': 'Requires Forsion desktop',
    'msg.needDesktopDetail': 'The live view reaches the local Computer Use helper through the desktop app.',
    'msg.none': 'No window is being controlled',
    'msg.noneDetail': 'The picture appears once the agent uses a computer use tool.',
    'msg.noFrame': "Couldn't get this frame",
    'st.looking': 'Looking',
    'st.ended': 'Ended',
    'st.click.doing': 'Clicking “{label}”',
    'st.click.done': 'Clicked “{label}”',
    'st.click.doing.bare': 'Clicking',
    'st.click.done.bare': 'Clicked',
    'st.rightClick.doing': 'Right-clicking “{label}”',
    'st.rightClick.done': 'Right-clicked “{label}”',
    'st.rightClick.doing.bare': 'Right-clicking',
    'st.rightClick.done.bare': 'Right-clicked',
    'st.type.doing': 'Typing in “{label}”',
    'st.type.done': 'Typed in “{label}”',
    'st.type.doing.bare': 'Typing',
    'st.type.done.bare': 'Typed',
    'st.scroll.doing': 'Scrolling “{label}”',
    'st.scroll.done': 'Scrolled “{label}”',
    'st.scroll.doing.bare': 'Scrolling',
    'st.scroll.done.bare': 'Scrolled',
    'st.drag.doing': 'Dragging “{label}”',
    'st.drag.done': 'Dragged “{label}”',
    'st.drag.doing.bare': 'Dragging',
    'st.drag.done.bare': 'Dragged',
    'st.key.doing.bare': 'Pressing keys',
    'st.key.done.bare': 'Pressed keys',
    'st.move.doing.bare': 'Moving the pointer',
    'st.move.done.bare': 'Moved the pointer',
    'done.steps': 'Done · {n} steps',
    'done.step1': 'Done · 1 step',
    'done.bare': 'Done',
    'btn.stop': 'Stop',
    'btn.stopTip': 'Stop this run',
    'btn.pip': 'Move to floating window',
    'btn.pipTip': 'Watch this picture in a small window that stays on top',
    'btn.putBack': 'Put back',
    'btn.putBackTip': 'Close the floating window and show the picture here again',
    'tl.run': '{v} {obj}',
    'tl.run.app': '{v} {obj} in {app}',
    'tl.done': '{v} {obj}',
    'tl.done.app': '{v} {obj} in {app}',
    'tl.err': "Couldn't {v} {obj}",
    'tl.err.app': "Couldn't {v} {obj} in {app}",
    'tl.notFound': 'Found no {obj}',
    'tl.q': '“{s}”',
    'tl.steps': '({n} steps)',
    'tl.stepOf': '(step {i} of {n})',
    'tl.o.screen': 'the screen',
    'tl.o.windows': 'windows',
    'tl.o.appWindows': '{app} windows',
    'tl.o.element': 'an element',
    'tl.o.text': 'text',
    'tl.o.more': 'more of the output',
    'tl.o.change': 'a change',
    'tl.o.gone': '{q} to disappear',
    'tl.o.browser': 'the browser',
    'tl.o.page': 'the page',
    'tl.v.click.run': 'Clicking', 'tl.v.click.done': 'Clicked', 'tl.v.click.err': 'click',
    'tl.v.doubleClick.run': 'Double-clicking', 'tl.v.doubleClick.done': 'Double-clicked', 'tl.v.doubleClick.err': 'double-click',
    'tl.v.rightClick.run': 'Right-clicking', 'tl.v.rightClick.done': 'Right-clicked', 'tl.v.rightClick.err': 'right-click',
    'tl.v.type.run': 'Typing', 'tl.v.type.done': 'Typed', 'tl.v.type.err': 'type',
    'tl.v.clear.run': 'Clearing', 'tl.v.clear.done': 'Cleared', 'tl.v.clear.err': 'clear',
    'tl.v.key.run': 'Pressing', 'tl.v.key.done': 'Pressed', 'tl.v.key.err': 'press',
    'tl.v.scroll.run': 'Scrolling', 'tl.v.scroll.done': 'Scrolled', 'tl.v.scroll.err': 'scroll',
    'tl.v.drag.run': 'Dragging', 'tl.v.drag.done': 'Dragged', 'tl.v.drag.err': 'drag',
    'tl.v.move.run': 'Moving the pointer', 'tl.v.move.done': 'Moved the pointer', 'tl.v.move.err': 'move the pointer',
    'tl.v.locate.run': 'Locating', 'tl.v.locate.done': 'Located', 'tl.v.locate.err': 'locate',
    'tl.v.look.run': 'Looking at', 'tl.v.look.done': 'Looked at', 'tl.v.look.err': 'look at',
    'tl.v.find.run': 'Finding', 'tl.v.find.done': 'Found', 'tl.v.find.err': 'find',
    'tl.v.search.run': 'Searching for', 'tl.v.search.done': 'Searched for', 'tl.v.search.err': 'search for',
    'tl.v.read.run': 'Reading', 'tl.v.read.done': 'Read', 'tl.v.read.err': 'read',
    'tl.v.wait.run': 'Waiting for', 'tl.v.wait.done': 'Waited for', 'tl.v.wait.err': 'wait for',
    'tl.v.open.run': 'Opening', 'tl.v.open.done': 'Opened', 'tl.v.open.err': 'open',
    'tl.v.act.run': 'Working', 'tl.v.act.done': 'Finished the actions', 'tl.v.act.err': 'finish the actions',
  },
}

/** 纯函数版:指定语言取一条,{占位符} 代入。缺的键回落中文,再回落键名本身。 */
function fmt(locale, key, vars) {
  const table = MSG[locale] || MSG.zh
  const raw = table[key] ?? MSG.zh[key] ?? key
  if (!vars) return raw
  return raw.replace(/\{(\w+)\}/g, (m, k) => (vars[k] === undefined ? m : String(vars[k])))
}
const currentLocale = () => {
  try { return (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en' ? 'en' : 'zh' } catch { return 'zh' }
}
/** 界面里用的 t():宿主的 i18n 优先(它跟着切语言),否则按 getLocale 查自带的表。 */
let tr = (key, vars) => fmt(currentLocale(), key, vars)
try {
  if (ctx.i18n && typeof ctx.i18n.define === 'function') {
    const hostT = ctx.i18n.define(MSG)
    if (typeof hostT === 'function') tr = hostT
  }
} catch { /* 宿主的 i18n 坏了就用自带的表 */ }

/** 错误码 → 人话。未知码原样带出去,别吞掉线索。 */
function explain(code) {
  if (!code) return ''
  return MSG.zh[`err.${code}`] ? tr(`err.${code}`) : tr('err.unknown', { code })
}

// ── 取色:Agent 光标 / 点击环跟 Forsion 当前窗口正在显示的主题色 ────────────────────────
// 规则(契约 §3「拿不准以宿主代码为准」):--accent 是彩色(RGB 极差 ≥ 24)→ 用 --accent 本色;
//   近乎无彩(经典 / 墨色的主题色就是正文色,近黑白灰的自定义色)→ 用 --signal(缺省柔蓝,设置里另选了强调色就是选的)。
//   ⚠️别改回「有 --signal-skin 就用 --signal」:宿主的自定义主题色**一律**写 --signal-skin(彩色时写的是 accent-ink,
//   lovableData.ts customAccentVars),那样彩色自定义主题会拿到加深的墨色或另选的强调色,不是「主题色的本色」。
//   --signal-skin 只在 accent 读不出时当作「该用 signal」的旁证。读不到 → 不发(helper 用柔蓝)。
// ⚠️颜色一律**读像素**,不解析 getPropertyValue 的字符串:值可能是 color-mix() / oklch() / 嵌套 var()。
const ENGINE_ID = 'computer-use'
const FALLBACK_FILL = '#2c5f9e'
const ACHROMATIC_RANGE = 24
const STYLE_DEBOUNCE_MS = 250

const chroma = (rgb) => Math.max(rgb[0], rgb[1], rgb[2]) - Math.min(rgb[0], rgb[1], rgb[2])
const toHex = (rgb) => `#${rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
function hexToRgb(hex) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || ''))
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : null
}
/** WCAG 相对亮度(sRGB 线性化)。 */
function relLuminance(rgb) {
  const lin = (v) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4 }
  return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2])
}
/** 描边色(契约 §1.1):填色相对亮度 < 0.28 用白,否则用深色。 */
const edgeFor = (rgb) => (relLuminance(rgb) < 0.28 ? '#ffffff' : '#1c1b1f')

/** 取色规则本身(纯函数)。accent / signal 是读回的 [r,g,b] 或 null。返回 { source, rgb } 或 null(= 不发)。 */
function pickFill({ hasSignalSkin, accent, signal }) {
  if (accent && chroma(accent) >= ACHROMATIC_RANGE) return { source: 'accent', rgb: accent }
  // accent 无彩或读不出 → signal(单色配色本来就会标 --signal-skin;hasSignalSkin 只留作诊断,不参与判定)
  void hasSignalSkin
  if (signal) return { source: 'signal', rgb: signal }
  return null
}
/** 发给引擎 /overlay-style 的体(routes.v1.json 的形状)。pick 为空 → null,不发。 */
function styleBody(pick, reducedMotion) {
  if (!pick) return null
  return { fill: toHex(pick.rgb), edge: edgeFor(pick.rgb), reducedMotion: Boolean(reducedMotion) }
}

/** 宿主口径的「减少动态」(同 lcl/engine/spring.ts 的 reducedMotion):设置里的只淡入淡出,或系统设置。 */
function reducedMotionIn(doc) {
  try {
    const root = doc && doc.documentElement
    if (root && root.dataset && root.dataset.motionFade === 'on') return true
    const w = (doc && doc.defaultView) || globalThis
    return Boolean(w.matchMedia && w.matchMedia('(prefers-reduced-motion: reduce)').matches)
  } catch { return false }
}

/** 一个 CSS 颜色表达式(如 'var(--accent)')在这份文档里**实际画出来**是什么颜色 → [r,g,b];读不出 → null。 */
const probeCanvas = new WeakMap()
function readRgb(doc, cssValue) {
  try {
    const w = doc.defaultView || globalThis
    if (typeof w.getComputedStyle !== 'function') return null
    const probe = doc.createElement('span')
    probe.style.cssText = 'position:fixed;left:-99px;top:0;width:1px;height:1px;pointer-events:none;visibility:hidden'
    probe.style.backgroundColor = cssValue
    ;(doc.body || doc.documentElement).appendChild(probe)
    const resolved = w.getComputedStyle(probe).backgroundColor
    probe.remove()
    if (!resolved) return null
    let g = probeCanvas.get(doc)
    if (!g) {
      const c = doc.createElement('canvas')
      c.width = 1
      c.height = 1
      g = c.getContext && c.getContext('2d', { willReadFrequently: true })
      if (!g) return null
      probeCanvas.set(doc, g)
    }
    // 哨兵:canvas 不认的颜色串会被静默忽略、fillStyle 保持旧值 —— 那样读回的就是哨兵,不是主题色。
    const SENTINEL = '#010203'
    g.fillStyle = SENTINEL
    g.fillStyle = resolved
    if (String(g.fillStyle).toLowerCase() === SENTINEL) return null
    g.clearRect(0, 0, 1, 1)
    g.fillRect(0, 0, 1, 1)
    const d = g.getImageData(0, 0, 1, 1).data
    if (d[3] !== 255) return null // 半透明 / 透明(变量没定义时 background-color 落成 transparent)
    return [d[0], d[1], d[2]]
  } catch { return null }
}

/** 当前窗口的取色结果:{ pick, reducedMotion };文档不可用 → null。 */
function readTheme(doc) {
  const root = doc && doc.documentElement
  const w = (doc && doc.defaultView) || globalThis
  if (!root || typeof w.getComputedStyle !== 'function') return null
  let hasSignalSkin = false
  // 只判**有没有**,不解析它的值。
  try { hasSignalSkin = w.getComputedStyle(root).getPropertyValue('--signal-skin').trim() !== '' } catch { /* 当没有 */ }
  const pick = pickFill({ hasSignalSkin, accent: readRgb(doc, 'var(--accent)'), signal: readRgb(doc, 'var(--signal)') })
  return { pick, reducedMotion: reducedMotionIn(doc) }
}

/**
 * 盯「主题色可能变了」的一切:<html> 的 class / style / data-*(主题、明暗、Space 外观、减少动态都落在这里),
 * 以及系统明暗与减少动态的媒体查询。防抖后回调。返回拆除函数(观察器、监听、定时器一起收)。
 */
function watchTheme(doc, cb, delay = STYLE_DEBOUNCE_MS) {
  const w = (doc && doc.defaultView) || globalThis
  const root = doc && doc.documentElement
  const offs = []
  let timer = null
  const fire = () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => { timer = null; try { cb() } catch { /* 回调自己兜 */ } }, delay)
  }
  if (root && typeof w.MutationObserver === 'function') {
    const mo = new w.MutationObserver(fire)
    mo.observe(root, { attributes: true })
    offs.push(() => mo.disconnect())
  }
  if (typeof w.matchMedia === 'function') {
    for (const q of ['(prefers-color-scheme: dark)', '(prefers-reduced-motion: reduce)']) {
      try {
        const mq = w.matchMedia(q)
        if (mq && mq.addEventListener) { mq.addEventListener('change', fire); offs.push(() => mq.removeEventListener('change', fire)) }
      } catch { /* 不支持就不听 */ }
    }
  }
  return () => {
    if (timer) clearTimeout(timer)
    timer = null
    offs.forEach((f) => f())
    offs.length = 0
  }
}

/** 主窗才上报颜色(插件 setup 在每扇窗都跑,不拦的话 Mini 会和主窗抢着写)。旧宿主不写 data-window → 当主窗。 */
function isMainWindow(doc) {
  const root = doc && doc.documentElement
  const kind = root && root.dataset ? root.dataset.window : undefined
  return !kind || kind === 'main'
}
/**
 * 收尾(overlay-turn end)不只主窗发:每扇窗各管自己看得见的那几轮 —— 在 Mini 里发起的一轮,主窗的状态里没有它,
 * 只让主窗发的话这一轮只能等 helper 的 45 s 超时才熄。重复发无害(带 runId,helper 对不上就不做事)。
 * 悬浮小画面除外:它自己没有会话,状态是从别的窗口转来的,那扇窗会发。
 */
function tracksTurns(doc) {
  const root = doc && doc.documentElement
  const kind = root && root.dataset ? root.dataset.window : undefined
  return kind !== 'pip'
}

// ── 状态句 / 步数 / 补间(纯函数,check.mjs 钉着)──────────────────────────────────────
const KIND_GROUP = {
  click: 'click', doubleClick: 'click', press: 'click', rightClick: 'rightClick',
  type: 'type', setText: 'type', scroll: 'scroll', drag: 'drag', key: 'key', move: 'move',
}
const CLICK_KINDS = new Set(['click', 'doubleClick', 'rightClick', 'press'])
/** 动作发生后多久内算「正在」,之后算「已」。 */
const DOING_MS = 900
/** 上一个动作过去这么久了,还没有新动作 → 它多半又在看画面:回到「正在查看」。 */
const LOOKING_AFTER_MS = 4000

/**
 * 头部那句状态。input = { ended, lastAction }(lastAction 照回包,ageMs 是 helper 回包时刻量的)。
 * 「正在查看」→「正在点击「发送」」→「已点击「发送」」→「已结束」。读不懂的动作种类按「正在查看」。
 */
function statusText(locale, input) {
  if (input.ended) return fmt(locale, 'st.ended')
  const a = input.lastAction
  const group = a && KIND_GROUP[a.kind]
  if (!group) return fmt(locale, 'st.looking')
  const age = Number(a.ageMs)
  const ageKnown = Number.isFinite(age) && age >= 0
  if (ageKnown && age >= LOOKING_AFTER_MS) return fmt(locale, 'st.looking')
  const phase = ageKnown && age >= DOING_MS ? 'done' : 'doing'
  const label = typeof a.label === 'string' ? a.label.replace(/\s+/g, ' ').trim().slice(0, 60) : ''
  const withLabel = `st.${group}.${phase}`
  if (label && MSG.zh[withLabel]) return fmt(locale, withLabel, { label })
  return fmt(locale, `${withLabel}.bare`)
}

/** 这一轮做了几步:结束时的 actionCount − 这一轮开始前的 actionCount。基数不知道 → null(宁可不写数,也不编一个)。 */
function stepCount(base, count) {
  if (!Number.isFinite(base) || !Number.isFinite(count) || count < base) return null
  return count - base
}
function doneText(locale, steps) {
  if (steps === null || steps === undefined || !Number.isFinite(steps)) return fmt(locale, 'done.bare')
  if (steps === 1) return fmt(locale, 'done.step1')
  return fmt(locale, 'done.steps', { n: steps })
}

/** 回包里的 0..1 比例点;坏值 → null(不画)。 */
function fracPoint(p) {
  if (!p || typeof p !== 'object') return null
  const x = Number(p.x)
  const y = Number(p.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) }
}
const easeOut = (t) => 1 - (1 - Math.min(1, Math.max(0, t))) ** 3
/** 两帧之间补间:t ∈ 0..1(已含缓动前的原始进度)。 */
function tweenPoint(from, to, t) {
  const k = easeOut(t)
  return { x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k }
}
/** 画布坐标:比例点 × 画面像素 × 当前倍率 + 平移。光标本身不随倍率缩放,只有位置跟着走。 */
function overlayPx(frac, natW, natH, scale, offX, offY) {
  return { x: offX + frac.x * natW * scale, y: offY + frac.y * natH * scale }
}

// ── 过程行的句子(ctx.registerToolLabel,契约 §2.4 / §3 卡 8)──────────────────────────────
// 「正在查看 Chatter」「正在 Chatter 中点击「发送」」「已在 Chatter 中输入「明天见」」。纯函数、同步、便宜:宿主每次渲染都会调。
// 数据只有这次调用的 args / result 和同一条回答里更早的本插件调用(earlier):
//   - App 名只在结果文字里:act 的「Attempted N UI actions in <App> — <Title>.」、observe 的「Observed <mode> [@rN ]<App> — <Title>.」、
//     find_roots 的「- @rN <kind> <App> pid …」。
//   - 控件名只在**拥有那个 stateId 的**结果里:大纲行「@e12 AXButton "Send"」、搜索行同形、变化行「+ @e12 under @e3 "Send"」。
//     差量结果(Changes (n, A → B))只列变了的,沿 A 往回找;**绝不拿别的 state 里同号的 @e**(号会重发,错名比没名更糟)。
// 解析不出动作 → 返回空,宿主照旧显示。⚠️依赖的是 vendor 的结果文字格式:check.mjs 钉着这些模板片段,vendor 升级改了格式会红。
// 本插件引擎半身的全部工具(src/tools.ts 的 SPECS;check.mjs 断言两边一致)。
const CU_TOOLS = ['jev_ui', 'find_roots', 'observe_ui', 'search_ui', 'expand_ui', 'inspect_ui', 'act_ui',
  'ensure_app', 'read_text', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser']
const TL_TEXT_MAX = 24
const TL_APP_MAX = 32
const TL_CHAIN_MAX = 12
const BUNDLE_RE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,254}$/

/** 收空白、按码点截到 max(超了加省略号)。空 → ''。 */
function tlClip(s, max = TL_TEXT_MAX) {
  if (typeof s !== 'string') return ''
  const t = s.replace(/\s+/g, ' ').trim()
  const cps = Array.from(t)
  return cps.length > max ? `${cps.slice(0, max).join('')}…` : t
}
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const tlArgs = (a) => {
  if (a && typeof a === 'object' && !Array.isArray(a)) return a
  if (typeof a === 'string') {
    try { const o = JSON.parse(a); return o && typeof o === 'object' && !Array.isArray(o) ? o : null } catch { return null }
  }
  return null
}
const tlText = (r) => (typeof r === 'string' ? r : '')

const LATIN = /[A-Za-z0-9]/
const CJK = /[㐀-鿿豈-﫿]/
/** 中文拼句:中西文相邻处补一个空格(「已在 Chatter 中」「微信中」「按下 Return」),其余原样接上。 */
function joinZh(parts) {
  let s = ''
  for (const p of parts) {
    if (!p) continue
    const a = s.slice(-1)
    const b = p[0]
    if (a && ((CJK.test(a) && LATIN.test(b)) || (LATIN.test(a) && CJK.test(b)))) s += ' '
    s += p
  }
  return s
}
/** 按模板拼一句:中文走 joinZh,英文直接代入再收掉多余空格。 */
function tlFmt(locale, key, vars) {
  const table = MSG[locale] || MSG.zh
  const raw = table[key] ?? MSG.zh[key]
  if (raw === undefined) return ''
  const parts = raw.split(/(\{\w+\})/).map((seg) => {
    const m = /^\{(\w+)\}$/.exec(seg)
    return m ? (vars && vars[m[1]] !== undefined ? String(vars[m[1]]) : '') : seg
  })
  if (locale === 'en') return parts.join('').replace(/ {2,}/g, ' ').trim()
  return joinZh(parts)
}

/** 结果文字里的 App 名(act / observe 的摘要行;前面可能还有 [execution] / [policy] 行,所以按行找)。 */
function appInResult(text) {
  const m = /^Attempted \d+ UI actions? in (.+?) — /m.exec(text) || /^Observed \S+ (?:@r\d+ )?(.+?) — /m.exec(text)
  return m ? tlClip(m[1], TL_APP_MAX) : ''
}
/**
 * 这段结果是不是**产出**了这个 stateId。只认 vendor 拼的那几处**行首模板**,不在整段文字里搜「stateId X」——
 * 控件标签(大纲行、差量行)里恰好有这几个字时,会把别的 state 的 App 名 / 控件名张冠李戴(评审第 5 条):
 *   act 摘要行「Attempted … / Stopped UI action sequence … / Nothing was sent to … Returned state X.」(行尾)
 *   observe 的大纲头「Outline (N nodes, stateId X」、差量头「Changes (N, A → X):」、「Use stateId X for subsequent …」
 *   网页那条「<tool> completed for @rN "<title>". State X.」(标题是 JSON 串,按串整段跳过)
 * 大纲 / 差量里的控件行都以「@eN」「+ / - / ~ @eN」开头,标签又是 JSON 串(换行被转义),碰不到这些行首。
 */
function producesState(text, id) {
  const x = reEsc(id)
  return new RegExp([
    `^(?:Attempted \\d+ UI actions? in |Stopped UI action sequence|Nothing was sent to )[^\\n]* Returned state ${x}\\.$`,
    `^Outline \\(\\d+ nodes, stateId ${x}[,)]`,
    `^Changes \\(\\d+, \\S+ → ${x}\\):`,
    `^Use stateId ${x} for subsequent actions and queries\\.$`,
    `^\\S+ completed for @r\\d+ "(?:[^"\\\\]|\\\\.)*"\\. State ${x}\\.$`,
  ].join('|'), 'm').test(text)
}
// 会产出 state 的工具。read_text 回的是控件里的原文(可能恰好有一整行「Use stateId …」),它和其余只读工具一律不算。
const STATE_TOOLS = new Set(['act_ui', 'jev_ui', 'observe_ui', 'wait_for', 'launch_browser', 'navigate_browser', 'evaluate_browser'])
/** 产出 stateId 的那一条(从近到远)。 */
function entryForState(id, list) {
  if (!id) return null
  for (let i = list.length - 1; i >= 0; i--) {
    const e = list[i]
    const t = e && STATE_TOOLS.has(e.tool) ? tlText(e.result) : ''
    if (t && producesState(t, id)) return t
  }
  return null
}
function appForState(id, list) {
  const t = typeof id === 'string' && id ? entryForState(id, list) : null
  return t ? appInResult(t) : ''
}
/** @rN 是哪个 App:find_roots / ensure_app 的根列表行,或带着它的 observe 摘要。 */
function appForRoot(ref, list) {
  if (typeof ref !== 'string' || !/^@r\d+$/.test(ref)) return ''
  const rows = new RegExp(`^- ${reEsc(ref)} \\S+ (.+?) pid \\d+`, 'm')
  const obs = new RegExp(`^Observed \\S+ ${reEsc(ref)} (.+?) — `, 'm')
  for (let i = list.length - 1; i >= 0; i--) {
    const t = tlText(list[i] && list[i].result)
    const m = t && (rows.exec(t) || obs.exec(t))
    if (m) return tlClip(m[1], TL_APP_MAX)
  }
  return ''
}
/** 一段文字里 @eN 的可读名(JSON 串着的那段);只有角色没有名字 → ''。 */
function labelInText(text, ref) {
  // 大纲行「@e12 AXButton "Send"」、搜索行同形、inspect / expand 的首行「@e12 AXButton id="send" "Send" [press]」、变化行「+ @e12 under @e3 "Send"」
  const re = new RegExp(`^[ \\t]*(?:\\+ )?${reEsc(ref)}(?: under @e\\d+)? (?:[^\\s"]+ )?(?:id="(?:[^"\\\\]|\\\\.)*" )?("(?:[^"\\\\]|\\\\.)*")`, 'm')
  const m = re.exec(text)
  if (!m) return ''
  try { const s = JSON.parse(m[1]); return s === '(unlabeled)' ? '' : tlClip(s) } catch { return '' }
}
/**
 * 差量里「~ @eN (@e1 > @eN) key=JSON, key=JSON …」= 这个控件的字段变了(vendor view.ts 的 renderChanges)。
 * 返回:undefined = 没有这一行(照常往回找);{ name } = 改了名,用新名字;{ stop: true } = 名字可能变了但读不出新名字 → 别再往回找。
 * 规则(vendor 的标签取 title || description || value || identifier || text):
 *   title 改成非空串 → 新名字;title 改成空 / 读不出;description / identifier 改了(名字多半就是它)→ 停。
 *   只有 value / text 变了 → 照常往回找:那是内容(输入框打了字),有 title 的控件名字不变;
 *   没有 title、靠 value 起名的控件会拿到旧内容当名字 —— 认这个小代价,否则每个输入框打完字都丢名字。
 * key=JSON 从左往右逐个切(值是 JSON,里面可能恰好有「title=」),切不动就当读不出。
 */
function tildeChange(text, ref) {
  const m = new RegExp(`^~ ${reEsc(ref)} \\([^)\\n]*\\) (.*)$`, 'm').exec(text)
  if (!m) return undefined
  const fields = {}
  let rest = m[1]
  if (rest === 'changed') return {}
  const tok = /^([A-Za-z]+)=("(?:[^"\\]|\\.)*"|\[[^\]\n]*\]|\{[^}\n]*\}|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|true|false|null)(?:, |$)/
  while (rest) {
    const t = tok.exec(rest)
    if (!t) return { stop: true }
    try { fields[t[1]] = JSON.parse(t[2]) } catch { return { stop: true } }
    rest = rest.slice(t[0].length)
  }
  if ('title' in fields) {
    const s = typeof fields.title === 'string' ? tlClip(fields.title) : ''
    return s ? { name: s } : { stop: true }
  }
  if ('description' in fields || 'identifier' in fields) return { stop: true }
  return {}
}
/**
 * stateId 下 @eN 的名字:先找产出这个 state 的结果,再找对着同一个 state 的 search / expand / inspect;
 * 差量结果里没有就沿「A → B」的 A 往回(号在差量之间不变)。找不到 → ''。
 */
function labelForRef(ref, stateId, list) {
  if (typeof ref !== 'string' || !/^@e\d+$/.test(ref) || typeof stateId !== 'string' || !stateId) return ''
  const seen = new Set()
  let id = stateId
  for (let hop = 0; id && hop < TL_CHAIN_MAX && !seen.has(id); hop++) {
    seen.add(id)
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]
      const ea = e && tlArgs(e.args)
      // 只认对着同一个 state 的 search / expand / inspect(read_text 回的是控件原文,不是结构化的行)
      if (ea && ea.stateId === id && (e.tool === 'search_ui' || e.tool === 'expand_ui' || e.tool === 'inspect_ui')) {
        const l = labelInText(tlText(e.result), ref)
        if (l) return l
      }
    }
    const t = entryForState(id, list)
    if (!t) return ''
    const l = labelInText(t, ref)
    if (l) return l
    // 差量里这个控件改了名(「~ @eN (…) title="Pause"」):用新名字;读不出新名字 → 宁可不带名字,别沿链取回旧名
    const ch = tildeChange(t, ref)
    if (ch && ch.name) return ch.name
    if (ch && ch.stop) return ''
    const diff = new RegExp(`^Changes \\(\\d+, (\\S+) → ${reEsc(id)}\\)`, 'm').exec(t)
    id = diff ? diff[1] : null
  }
  return ''
}

const MODIFIERS = new Set(['cmd', 'command', 'meta', 'ctrl', 'control', 'alt', 'option', 'opt', 'shift', 'fn'])
const KEY_NAMES = { cmd: 'Cmd', command: 'Cmd', meta: 'Cmd', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Option', option: 'Option', opt: 'Option', esc: 'Esc', escape: 'Esc', pageup: 'Page Up', pagedown: 'Page Down' }
const keyName = (k) => {
  const s = String(k).trim()
  const low = s.toLowerCase()
  if (KEY_NAMES[low]) return KEY_NAMES[low]
  return s.length === 1 ? s.toUpperCase() : s.charAt(0).toUpperCase() + s.slice(1)
}
/** ["cmd","a"] → Cmd+A(除最后一个都是修饰键 = 一个组合);["return"] → Return;["cmd+a","delete"] → Cmd+A, Delete。 */
function keysText(keys) {
  if (!Array.isArray(keys)) return ''
  const ks = keys.filter((k) => typeof k === 'string' && k.trim())
  if (!ks.length) return ''
  const chord = ks.length > 1 && ks.slice(0, -1).every((k) => MODIFIERS.has(k.trim().toLowerCase()))
  const out = chord ? ks.map(keyName).join('+') : ks.map((k) => k.split('+').map(keyName).join('+')).join(', ')
  return tlClip(out)
}
function hostOf(url) {
  if (typeof url !== 'string' || !url.trim()) return ''
  try { return tlClip(new URL(url).host.replace(/^www\./, ''), TL_APP_MAX) } catch { return tlClip(url, TL_APP_MAX) }
}

/** act_ui 的一步 → { verb, label?, text?, keys? };认不出 → null。 */
function actStep(a) {
  if (!a || typeof a !== 'object') return null
  const ref = typeof a.ref === 'string' ? a.ref : ''
  switch (a.action) {
    case 'press': return { verb: 'click', ref }
    case 'click': return { verb: a.button === 'right' ? 'rightClick' : Number(a.clickCount) === 2 ? 'doubleClick' : 'click', ref }
    case 'setText': return typeof a.text === 'string' && a.text.trim() ? { verb: 'type', text: a.text } : { verb: 'clear', ref }
    case 'typeText': return { verb: 'type', text: typeof a.text === 'string' ? a.text : '' }
    case 'keypress': return { verb: 'key', keys: a.keys }
    case 'scroll': return { verb: 'scroll', ref }
    case 'drag': return { verb: 'drag' }
    case 'moveMouse': return { verb: 'move' }
    default: return null
  }
}
/** jev_ui 的一步(目标是画面上的字,直接当名字用)。 */
function jevStep(s, preview) {
  if (!s || typeof s !== 'object') return null
  const target = typeof s.target === 'string' ? s.target : ''
  if (preview) return { verb: 'locate', name: target }
  switch (s.action) {
    case 'click': return { verb: 'click', name: target }
    case 'double_click': return { verb: 'doubleClick', name: target }
    case 'fill': return typeof s.text === 'string' && s.text.trim() ? { verb: 'type', text: s.text } : { verb: 'clear', name: target }
    case 'type': return { verb: 'type', text: typeof s.text === 'string' ? s.text : '' }
    case 'key': return { verb: 'key', keys: s.keys }
    case 'scroll': return { verb: 'scroll', name: target }
    default: return null
  }
}

/**
 * 工具没跑起来、正常返回了一段指导文字(src/tools.ts 的 execute:权限没开 / helper 没就绪 / Jev 关着;src/onboarding.ts 拼的话)。
 * 调用照样是 done,但什么都没做 —— 按「没能…」说。⚠️只认**整段就是指导**:前面至多一条安装说明(装好 / 升级 / 没装成),
 * 不在正文里搜(read_text 回的是控件原文,里面可能恰好有这几个字)。
 */
const NOT_READY_RE = /^(?:(?:Installed the Computer Use desktop helper automatically\.|Updated the Computer Use desktop helper to match this plugin version\.|Could not install the Computer Use helper automatically \([\s\S]*?\)\. Run `tangu computer-use setup` in a terminal\.)\n)?(?:Computer Use is not ready: |Computer Use still needs macOS |Jev is disabled or unavailable on this platform\.)/
const notReady = (text) => NOT_READY_RE.test(text)

/**
 * act_ui 结果里的执行摘要(src/foregroundNote.ts 的 executionNote:一行「[execution] {…}」,前面可能还有一条安装说明,所以按行找)。
 * 字段以 executionSummary 为准:顶层 outcome / error / earlierPressTookEffect,steps[] 每步 outcome / error;**没有 performed 字段**。
 * 返回 { failedAt?: 第几步(0 起), failed: bool, nothingSent: bool } 或 null(没有摘要 / 解析不了)。
 * ⚠️口径:句子说的是「点了」,不是「点成了」—— 动作确实投递了、效果没确认(outcome didnt / unknown)照样说「已点击」;
 *   只有执行器报了错(顶层或某一步有 error,例如 postcondition_failed:后置条件没满足时 vendor 仍然写「Attempted N …」)才说「没能…」;
 *   earlierPressTookEffect = 这次什么都没发(上一次按下去的晚生效了)→ 既不是「已点击」也不是「没能」,交给宿主照旧显示。
 */
function execSummary(text) {
  const m = /^\[execution\] (\{.*\})$/m.exec(text)
  if (!m) return null
  let s
  try { s = JSON.parse(m[1]) } catch { return null }
  if (!s || typeof s !== 'object') return null
  if (s.earlierPressTookEffect) return { failed: false, nothingSent: true }
  const steps = Array.isArray(s.steps) ? s.steps : []
  const k = steps.findIndex((st) => st && typeof st === 'object' && st.error)
  if (k >= 0) return { failed: true, failedAt: k, nothingSent: false }
  return { failed: Boolean(s.error), nothingSent: false }
}

/** 一句话:phase × 有没有 App × 动词 × 对象,外加批量的「(共 N 步)」/「(第 i 步,共 N 步)」。 */
function tlSentence(locale, phase, verb, app, obj, suffix) {
  const ph = phase === 'running' ? 'run' : phase === 'error' ? 'err' : 'done'
  const v = (MSG[locale] || MSG.zh)[`tl.v.${verb}.${ph}`]
  if (!v) return ''
  const s = tlFmt(locale, `tl.${ph}${app ? '.app' : ''}`, { v, obj: obj || '', app: app || '' })
  return suffix ? s + (locale === 'en' ? ' ' : '') + suffix : s
}

/**
 * describe 的本体(纯函数)。iconOf(app) → bundleId | undefined(实时画面学到的对应,只在内存里)。
 * 返回 { text, icon? } 或 null(= 宿主照旧显示)。
 */
function describeCall(call, iconOf) {
  if (!call || typeof call !== 'object' || !CU_TOOLS.includes(call.tool)) return null
  const L = call.locale === 'en' ? 'en' : 'zh'
  let phase = call.phase === 'running' || call.phase === 'error' ? call.phase : 'done'
  const args = tlArgs(call.args) || {}
  const result = phase === 'running' ? '' : tlText(call.result)
  // 正常返回了「还没就绪」的指导文字 = 什么都没做,按出错说(每个工具都一样,下面不必再各自判)
  if (phase === 'done' && notReady(result)) phase = 'error'
  // 做完的句子**只在有成功证据时**说「已…」;各工具的证据见下面每一支,认不出 → 空(宿主照旧显示)
  const done = phase === 'done'
  const earlier = Array.isArray(call.earlier) ? call.earlier.slice(-40) : []
  const q = (s) => tlFmt(L, 'tl.q', { s })
  const o = (k, vars) => tlFmt(L, `tl.o.${k}`, vars)
  const out = (text, app, bundleId) => {
    if (!text) return null
    const id = bundleId || (app && iconOf ? iconOf(app) : undefined)
    return typeof id === 'string' && BUNDLE_RE.test(id) ? { text, icon: { appBundleId: id } } : { text }
  }
  // 一步(act / jev 的)→ 对象
  const stepObj = (st, stateId) => {
    if (st.text !== undefined) return st.text.trim() ? q(tlClip(st.text)) : ''
    if (st.keys !== undefined) return keysText(st.keys)
    const name = st.name !== undefined ? tlClip(st.name) : labelForRef(st.ref, stateId, earlier)
    return name ? q(name) : ''
  }

  switch (call.tool) {
    case 'act_ui':
    case 'jev_ui': {
      const jev = call.tool === 'jev_ui'
      const raw = jev ? args.steps : args.actions
      if (!Array.isArray(raw) || !raw.length) return null
      const steps = raw.map((s) => (jev ? jevStep(s, args.preview === true) : actStep(s)))
      const stateId = typeof args.stateId === 'string' ? args.stateId : ''
      const lost = /^The (?:UI action sequence stopped|action was delivered)\b.*?source root (.+?) — /m.exec(result)
      const app = (result && appInResult(result)) || (lost ? tlClip(lost[1], TL_APP_MAX) : '')
        || (jev ? appForRoot(args.root, earlier) : appForState(stateId, earlier))
      const n = steps.length
      const say = (ph, i, suffix) => {
        const st = steps[i]
        return st ? tlSentence(L, ph, st.verb, app, stepObj(st, stateId), suffix) : ''
      }
      const preview = jev && args.preview === true
      if (phase === 'running') return out(say('running', 0), app)
      // 做完:只在结果里**有做成的证据**时才说「已…」;中途停下的按出错说;认不出结果 → 空(宿主照旧显示),不替它报喜。
      //   act:「Attempted N UI actions in …」/「The action was delivered…」/ 网页那条「act_ui completed for …」= 做了;
      //        「Stopped UI action sequence at action K」= 第 K 步卡住;「The UI action sequence stopped: …」= 停了(不知道第几步)
      //   jev:首行报告的 status:completed / preview = 做了;stopped / cancelled = 停在最后一条轨迹那一步
      let failedAt = null
      let failedSomewhere = phase === 'error'
      let did = null
      if (phase === 'done') {
        if (jev) {
          let rep = null
          try { const first = result.split('\n', 1)[0].trim(); if (first.startsWith('{')) rep = JSON.parse(first) } catch { rep = null }
          if (!rep || typeof rep !== 'object') return null
          if (rep.status === 'stopped' || rep.status === 'cancelled') {
            const lastTrace = Array.isArray(rep.steps) ? rep.steps[rep.steps.length - 1] : null
            failedAt = lastTrace && Number.isInteger(lastTrace.step) && lastTrace.step >= 1 ? lastTrace.step - 1 : 0
          } else if (rep.status === 'completed' || rep.status === 'preview') {
            did = preview ? 1 : Number.isInteger(rep.requestedSteps) && rep.requestedSteps >= 1 ? rep.requestedSteps : n
          } else return null
        } else {
          // 有执行摘要先看它:执行器报了错就是没成,哪怕后面照样写着「Attempted N …」(评审第 2 条)
          const sum = execSummary(result)
          if (sum && sum.nothingSent) return null
          const stop = /^Stopped UI action sequence(?: at action (\d+))?/m.exec(result)
          const att = /^Attempted (\d+) UI actions? in /m.exec(result)
          if (stop) failedAt = stop[1] ? Number(stop[1]) - 1 : sum && sum.failedAt !== undefined ? sum.failedAt : 0
          else if (sum && sum.failed) { if (sum.failedAt !== undefined) failedAt = sum.failedAt; else failedSomewhere = true }
          else if (/^The UI action sequence stopped: /m.test(result)) failedSomewhere = true
          else if (att) did = Number(att[1])
          else if (/^The action was delivered\b/m.test(result) || /^act_ui completed for /m.test(result)) did = n
          else return null
        }
      }
      if (failedAt !== null || failedSomewhere) {
        if (failedAt === null) {
          // 宿主说出错 / 被截断,结果里看不出卡在哪一步:一步的(和只定位第一步的预览)照那一步说,多步的只说「没能完成这些操作」
          return out(n === 1 || preview ? say('error', 0) : tlSentence(L, 'error', 'act', app, ''), app)
        }
        const i = Math.min(Math.max(0, failedAt), n - 1)
        return out(say('error', i, n > 1 ? tlFmt(L, 'tl.stepOf', { i: i + 1, n }) : ''), app)
      }
      if (preview) return out(say('done', 0), app) // 预览只定位第一步,不报步数
      const count = Math.min(Math.max(1, did), n)
      return out(say('done', count - 1, count > 1 ? tlFmt(L, 'tl.steps', { n: count }) : ''), app)
    }
    case 'observe_ui': {
      // 证据:摘要行「Observed <mode> …」;网页根是「observe_ui completed for @rN …」
      if (done && !/^(?:Observed \S+ |observe_ui completed for @r\d+ )/m.test(result)) return null
      const app = (result && appInResult(result)) || appForRoot(args.root, earlier)
      return out(tlSentence(L, phase, 'look', '', app || o('screen')), app)
    }
    case 'find_roots': {
      const bundleId = typeof args.bundleId === 'string' && BUNDLE_RE.test(args.bundleId) ? args.bundleId : ''
      const name = tlClip(typeof args.app === 'string' && args.app ? args.app : typeof args.text === 'string' ? args.text : '', TL_APP_MAX)
        || bundleId
      const obj = name ? o('appWindows', { app: name }) : o('windows')
      // 证据:「Found N matching root(s); returned K.」;「No roots matched … / No roots are currently visible …」= 没找到
      if (done && /^No roots (?:matched the supplied filters|are currently visible to )/m.test(result)) return out(tlFmt(L, 'tl.notFound', { obj }), name, bundleId)
      if (done && !/^Found \d+ matching roots?; returned \d+/m.test(result)) return null
      return out(tlSentence(L, phase, 'find', '', obj), name, bundleId)
    }
    case 'ensure_app': {
      const bundleId = typeof args.bundleId === 'string' && BUNDLE_RE.test(args.bundleId) ? args.bundleId : ''
      const app = tlClip(typeof args.app === 'string' ? args.app.replace(/\/+$/, '').split('/').pop().replace(/\.app$/i, '') : '', TL_APP_MAX)
        || bundleId
      if (!app) return null
      const failed = phase === 'error' || (done && /^(?:Could not launch |ensure_app requires|ensure_app aborted|ensure_app \(background launch\) is macOS-only|.+ is running but has no window )/m.test(result))
      // 证据:回来的根列表里有窗口行(「- @rN <kind> <App> pid N …」)。「Opened X, but no window is observable yet.」不算打开好了 → 空
      if (!failed && done && !/^- @r\d+ \S+ .+? pid \d+ /m.test(result)) return null
      return out(tlSentence(L, failed ? 'error' : phase, 'open', '', app), app, bundleId)
    }
    case 'search_ui': {
      // 证据:「Found N outline match(es); returned K.」(前面可能有一段 note),或命中行「@eN <role> "<label>" [<reason>…]」
      if (done && !/^Found \d+ outline match(?:es)?; returned \d+\./m.test(result) && !/^@e\d+ \S+ "(?:[^"\\]|\\.)*" \[/m.test(result)) return null
      const app = appForState(args.stateId, earlier)
      const text = tlClip(args.text)
      return out(tlSentence(L, phase, 'search', app, text ? q(text) : o('element')), app)
    }
    case 'expand_ui':
    case 'inspect_ui': {
      // 证据:首行是控件本身「@eN <role> …」,下一行「path: …」
      if (done && !/^@e\d+ [^\n]*\npath: /m.test(result)) return null
      const app = appForState(args.stateId, earlier)
      const name = labelForRef(args.ref, args.stateId, earlier)
      return out(tlSentence(L, phase, 'look', app, name ? q(name) : o('element')), app)
    }
    case 'read_text': {
      // read_text 回的就是读到的原文,没有模板可认:成功证据只能是「不是指导文字」(上面 notReady 已改判成出错);
      // vendor 读失败是抛错(phase error),不会正常返回。
      if (typeof args.ref === 'string' && /^@o/.test(args.ref)) return out(tlSentence(L, phase, 'read', '', o('more')))
      const app = appForState(args.stateId, earlier)
      const name = labelForRef(args.ref, args.stateId, earlier)
      return out(tlSentence(L, phase, 'read', app, name ? q(name) : o('text')), app)
    }
    case 'wait_for': {
      const app = appForState(args.stateId, earlier)
      const target = tlClip(args.text) || labelForRef(args.ref, args.stateId, earlier)
      const obj = !target ? o('change') : args.until === 'absent' ? o('gone', { q: q(target) }) : q(target)
      // 证据:「Condition appeared. / Condition disappeared.」;等超时是正常返回(「Timed out after Nms …」),按没等到说
      const timedOut = done && /^Timed out after \d+ms waiting for condition\./m.test(result)
      if (done && !timedOut && !/^Condition (?:appeared|disappeared)\.$/m.test(result)) return null
      return out(tlSentence(L, timedOut ? 'error' : phase, 'wait', app, obj), app)
    }
    case 'launch_browser':
    case 'navigate_browser': {
      // 证据:「<本工具名> completed for @rN "<title>". State X.」
      if (done && !new RegExp(`^${call.tool} completed for @r\\d+ `, 'm').test(result)) return null
      const host = hostOf(args.url)
      if (call.tool === 'launch_browser') return out(tlSentence(L, phase, 'open', '', host || o('browser')))
      return host ? out(tlSentence(L, phase, 'open', '', host)) : null
    }
    case 'evaluate_browser':
      // 证据:「Evaluation value: …」
      if (done && !/^Evaluation value: /m.test(result)) return null
      return out(tlSentence(L, phase, 'read', '', o('page')))
    default:
      return null
  }
}

// 实时画面回包里学到的「App 名 → bundleId」(只在本次运行的内存里,给过程行的图标用)。
const appBundles = new Map()
let bundlesRev = 0
const APP_BUNDLES_KEEP = 64
function learnBundle(app, bundleId) {
  if (typeof app !== 'string' || !app || typeof bundleId !== 'string' || !BUNDLE_RE.test(bundleId)) return
  const key = tlClip(app, TL_APP_MAX)
  if (appBundles.get(key) === bundleId) return
  appBundles.delete(key)
  appBundles.set(key, bundleId)
  bundlesRev++ // 宿主把句子缓存着:图标表变了要让它知道(registerToolLabel 的 revision)
  while (appBundles.size > APP_BUNDLES_KEEP) appBundles.delete(appBundles.keys().next().value)
}

// 旧宿主没有 registerToolLabel → 什么都不做,过程行照旧「电脑操作 · act ui」。describe 绝不抛错。
try {
  if (typeof ctx.registerToolLabel === 'function') {
    ctx.registerToolLabel({
      tool: CU_TOOLS.slice(),
      describe(call) {
        try { return describeCall(call, (app) => appBundles.get(app)) || undefined } catch { return undefined }
      },
      // 句子本身只看 call;图标表是看到实时画面后才学到的 —— 宿主缓存句子,靠这个数知道该重算了(不认 revision 的宿主忽略它)
      revision: () => bundlesRev,
    })
  }
} catch { /* 宿主拒收就照旧显示 */ }

// ── 整轮(插件顶层,所有视图共用一份)────────────────────────────────────────────────
// 每个 runId 一条记录:基数(这一轮开始前的 actionCount)、最新计数、helper 说的进行中、宿主状态说的结束。
// 「结束」只认**看到过它在跑**的那条状态通道:旧宿主不认 { runId } 参数,会把它当会话 id、回一个 idle ——
// 那和「已结束」长得一模一样,不设这道闸就会在一轮中途发 overlay-turn end、标「已完成」。
const runs = new Map()
const RUNS_KEEP = 32
let lastCount = null      // 最近一次看到的 actionCount
let lastCountRun = null   // 那一次属于哪个 runId(没有 = null)
let mountedViews = 0      // 这扇窗里开着几个实时画面(全关了 → 基数作废)
const isAgentPhaseOver = (st) => !st || st.phase === 'idle' || st.phase === 'done' || st.phase === 'error'

function runRecord(runId) {
  let rec = runs.get(runId)
  if (!rec) {
    rec = { base: null, count: null, helperActive: null, sawRunning: false, statusEnded: false, viaRunArg: null, stopping: false, resumed: 0 }
    runs.set(runId, rec)
    while (runs.size > RUNS_KEEP) { const old = runs.keys().next().value; runs.delete(old); unwatchRun(old) }
  }
  return rec
}
/** 一轮看上去结束了吗:宿主状态说了算;状态通道没表态时,helper 说不在进行中也算。 */
function runEnded(runId) {
  const rec = runId && runs.get(runId)
  if (!rec) return false
  if (rec.statusEnded) return true
  if (rec.sawRunning) return false // 状态通道明确说还在跑(模型想得久,helper 的 45 s 先到了)
  return rec.helperActive === false
}
function runSteps(runId) {
  const rec = runId && runs.get(runId)
  return rec ? stepCount(rec.base, rec.count) : null
}

/**
 * 全插件共享的单飞:同一时刻最多一次取景请求,所有实例复用同一个 Promise。
 * 为什么必须是模块级而不是每个实例一份:每帧都是一次**真实截屏**(helper 那边最长能跑到 8 秒),
 * 而视图卸载后没法取消已经发出的 IPC —— 关掉再立刻打开,就会有两次捕获在 helper 里叠着跑。
 * 反正所有实例要的是同一帧,合并即可。
 */
let sharedFetch = null
let sharedWantsImage = null
let sharedKey = null
function fetchFrame(api, opts) {
  const wantsImage = opts.image !== false
  // 复用的前提是**要到的东西一样**。除了"要不要图",还得算上 sinceFrame:
  // 两个实例见过的帧号可能不同,共用一个回包会让其中一个收到与自己无关的 unchanged。
  const key = `${wantsImage}|${opts.sinceFrame || ''}`
  // ⚠️只在"要不要图"一致时才复用:否则慢速实例先发的 {image:false} 会被要图的实例捡走,
  // 那边看到没有 jpegBase64 就误判成"拿不到画面"——我们没要 ≠ 拿不到,这个坑换条路又冒出来过一次。
  if (!sharedFetch || sharedKey !== key) {
    sharedWantsImage = wantsImage
    sharedKey = key
    // ⚠️`finally` 里只许清**自己**那一份:另一种"要不要图"的请求可能已经把这个槽换成它的了,
    // 无条件清会让那个还在飞的请求失去单飞保护 —— 下一个实例立刻又发一次真实取景。
    const mine = Promise.resolve(api(opts)).finally(() => {
      if (sharedFetch === mine) { sharedFetch = null; sharedWantsImage = null; sharedKey = null }
    })
    sharedFetch = mine
  }
  return sharedFetch
}

/** 距上次动作多久 → "刚刚 / 3 秒前 / 2 分钟前"。 */
function ago(ms) {
  const s = Math.max(0, Math.round(Number(ms) || 0) / 1000)
  if (s < 1.5) return tr('ago.now')
  if (s < 60) return tr('ago.sec', { n: Math.round(s) })
  return tr('ago.min', { n: Math.round(s / 60) })
}

/** 标题栏文案:App 名 + 窗口标题,都没有就退回窗口号。 */
function describe(frame) {
  const app = frame.app || ''
  const title = frame.title || ''
  if (app && title) return `${app} — ${title}`
  return app || title || (frame.windowId ? tr('win.numbered', { id: frame.windowId }) : tr('win.unknown'))
}

// ── 缩放的纯几何(抽出来是为了可单测:算错只会"看着不对劲",不会报错)────────────────

/** 整幅塞进舞台(等价 object-fit:contain)。量不到尺寸时按 1 处理。 */
function fitScaleOf(natW, natH, stageW, stageH) {
  if (!(natW > 0 && natH > 0 && stageW > 0 && stageH > 0)) return 1
  return Math.min(stageW / natW, stageH / natH)
}

/**
 * 画布(.cu-live-viewport)在舞台里的实际尺寸 —— **画布的宽高比 = 窗口的宽高比**。
 * 于是画面严丝合缝地铺满画布,内部零留白;剩下的空间落在画布**之外**,是卡片底色而不是
 * 画中的黑边。这就是"根据窗口大小自适应调节"。
 *
 * 曾经的做法是画布占满整格、再用 fit/cover 启发式在"留黑边"与"裁掉一半界面"之间二选一 ——
 * 两头都不讨好(用户实报留白)。让画布自己变形就没有这个取舍了。
 */
function viewportBoxOf(natW, natH, stageW, stageH) {
  if (!(natW > 0 && natH > 0 && stageW > 0 && stageH > 0)) return { w: stageW || 0, h: stageH || 0 }
  const scale = Math.min(stageW / natW, stageH / natH)
  return { w: natW * scale, h: natH * scale }
}

/**
 * 悬浮窗里舞台的高:宽 × 窗口比例(264 宽、800×524 的窗口 ≈ 173),夹在 [96, 300] —— 竖长的窗口不把小窗撑到半屏。
 * 量不到尺寸时用 173(契约 §2.5「画面约 173」)。⚠️悬浮窗的高度随内容,舞台不能靠 flex 撑:那样量出来是 0,画面塌没。
 */
const PIP_STAGE_DEFAULT = 173
const PIP_STAGE_MIN = 96
const PIP_STAGE_MAX = 300
function pipStageHeight(natW, natH, stageW) {
  if (!(natW > 0 && natH > 0 && stageW > 0)) return PIP_STAGE_DEFAULT
  return Math.round(Math.min(PIP_STAGE_MAX, Math.max(PIP_STAGE_MIN, (stageW * natH) / natW)))
}

/**
 * 平移量夹紧:图比舞台大时不许把边拖进舞台内部(否则会拖出一片空白再也找不回图);
 * 图比舞台小时一律居中。返回的是图片左上角相对舞台左上角的偏移。
 */
function clampOffset(off, scaled, stage) {
  if (scaled <= stage) return (stage - scaled) / 2
  return Math.min(0, Math.max(stage - scaled, off))
}

/** 以 anchor(舞台坐标)为锚点缩放后的新偏移 —— 光标下的那个像素保持不动。 */
function anchoredOffset(off, anchor, oldScale, newScale) {
  return anchor - (anchor - off) * (newScale / oldScale)
}

/**
 * 缩放上限 8 倍原始像素;下限"整幅可见",再往下缩只是徒增空白。
 * ⚠️例外:小窗口塞进大面板时 fit 会 >1,此时"整幅可见"已经是放大插值,
 * 若拿它当下限,双击去 1:1 看真实像素就被夹回去、永远到不了。所以下限取 min(fit, 1)。
 */
const MAX_SCALE = 8
function clampScale(scale, fit) {
  return Math.min(MAX_SCALE, Math.max(Math.min(fit, 1), scale))
}

const CSS = `
.cu-live{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg-card,var(--bg,transparent));color:var(--text,inherit);font-size:13px}
.cu-live-head{display:flex;align-items:center;gap:8px;padding:8px 12px;border-bottom:1px solid var(--border,rgba(128,128,128,.25));flex:0 0 auto}
.cu-live-dot{width:8px;height:8px;border-radius:999px;background:var(--accent,#ff7818);flex:0 0 auto}
.cu-live-dot.idle{background:var(--text-faint,rgba(128,128,128,.6))}
.cu-live-title{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.cu-live-age{flex:0 0 auto;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)));font-variant-numeric:tabular-nums}
.cu-live-zoom{display:none;align-items:center;gap:2px;flex:0 0 auto}
.cu-live-zoom.on{display:flex}
.cu-live-zoom button{font:inherit;line-height:1;padding:3px 7px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--text-muted,var(--text-light,inherit));cursor:pointer}
.cu-live-zoom button:hover:not(:disabled){background:var(--accent-light,var(--overlay-light,rgba(128,128,128,.14)));color:var(--accent-hover,var(--accent,inherit))}
.cu-live-zoom button:disabled{opacity:.38;cursor:default}
.cu-live-pct{min-width:4.2em;text-align:center;font-variant-numeric:tabular-nums}
/* ⚠️舞台**不留 padding**:画布尺寸是拿 stage.clientWidth/Height 算的,而 client* 是**含 padding** 的,
   留了 padding 就等于把它当成可用空间,画布必然溢出(实测 382 高的舞台画布也是 382,顶穿内边距)。
   实时画面本来就该像屏幕共享那样满铺,不需要这圈缝。 */
.cu-live-stage{position:relative;flex:1 1 auto;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;touch-action:none}
/* 画布的宽高由 JS 按窗口比例算好写死(layoutViewport)。⚠️别改回 CSS aspect-ratio:
   它只推导「没被指定的那一边」,两种朝向不能同时成立 —— width:100% 时高被 max-height 夹掉、
   宽不会跟着缩(实测宽屏窗口画布停在 620x362,留白原样回来);换成 height:100% 则极宽窗口的
   宽被 max-width 夹掉,同一个病换个方向。真浏览器量出来的,别再试。 */
/* ⚠️flex:0 0 auto 不能少:画布是 flex item,默认 flex-shrink:1 会在它比舞台宽时把宽压回去,
   高却不动 —— 比例当场就错了(实测 640x150 被压成 620x150)。尺寸只许 layoutViewport 说了算。 */
.cu-live-viewport{position:relative;flex:0 0 auto;overflow:hidden;border-radius:3px;background:var(--overlay-subtle,rgba(128,128,128,.06))}
.cu-live-viewport.zoomed{cursor:grab}
.cu-live-viewport.panning{cursor:grabbing}
.cu-live-viewport img{position:absolute;top:0;left:0;transform-origin:0 0;max-width:none;max-height:none;-webkit-user-select:none;user-select:none;-webkit-user-drag:none}
.cu-live-msg{max-width:34em;text-align:center;line-height:1.6;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)))}
.cu-live-msg b{display:block;margin-bottom:6px;color:var(--text,inherit);font-weight:500}
/* ── 实时画面里的 Agent 光标 / 点击环 / 结束态 ──
   颜色:--cu-fill 由 JS 按取色规则指向 var(--signal) 或 var(--accent)(直接用宿主变量,随明暗自己跟);
   --cu-edge 是按填色亮度算好的白 / 深。光标与环**不随画面缩放**,只有位置跟着取景走。
   ⚠️类名别带 cu-live-viewport:那是画布自己的类名,check.mjs 的垫片按它认画布。 */
.cu-live-status{flex:1 1 auto;min-width:0;overflow:hidden;white-space:nowrap;color:var(--text-muted,var(--text-light,rgba(128,128,128,.9)))}
.cu-live-status:empty{display:none}
.cu-live-status span{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;vertical-align:bottom}
.cu-live-status span.roll{animation:cu-live-roll .28s cubic-bezier(.2,.8,.2,1)}
@keyframes cu-live-roll{from{transform:translateY(70%);opacity:0}to{transform:none;opacity:1}}
.cu-live-head.has-status .cu-live-title{flex:0 1 auto;max-width:42%}
.cu-live-stop{display:none;flex:0 0 auto;font:inherit;line-height:1;padding:3px 9px;border-radius:7px;border:1px solid var(--border,rgba(128,128,128,.25));background:transparent;color:var(--text,inherit);cursor:pointer}
.cu-live-stop.on{display:inline-block}
.cu-live-stop:hover:not(:disabled){border-color:var(--cu-fill,var(--accent,currentColor));color:var(--cu-fill,var(--accent,inherit))}
.cu-live-stop:disabled{opacity:.45;cursor:default}
.cu-live-ovl{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.cu-live-cur{position:absolute;left:0;top:0;width:18px;height:18px;display:none;will-change:transform;filter:drop-shadow(0 1px 1.5px rgba(0,0,0,.32))}
.cu-live-cur svg{display:block;width:18px;height:18px;overflow:visible}
.cu-live-ring{position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:999px;box-sizing:border-box;border:2.5px solid var(--cu-fill,#2c5f9e);box-shadow:0 0 0 1px var(--cu-edge-soft,rgba(255,255,255,.5)),inset 0 0 0 1px var(--cu-edge-soft,rgba(255,255,255,.5));opacity:0;animation:cu-live-ring .5s ease-out forwards}
@keyframes cu-live-ring{0%{transform:scale(.27);opacity:.95}36%{opacity:.7}100%{transform:scale(1);opacity:0}}
.cu-live-veil{position:absolute;inset:0;background:var(--bg-card,var(--bg,#fff));opacity:0;transition:opacity .4s ease}
.cu-live-veil.on{opacity:.55}
.cu-live-badge{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);display:none;align-items:center;gap:6px;padding:6px 12px;border-radius:999px;background:var(--bg-card,var(--bg,#fff));border:1px solid var(--border,rgba(128,128,128,.25));color:var(--text,inherit);font-weight:500;white-space:nowrap;box-shadow:0 2px 10px rgba(0,0,0,.12)}
.cu-live-badge.on{display:inline-flex}
.cu-live-badge i{width:8px;height:8px;border-radius:999px;background:var(--cu-fill,#2c5f9e);flex:0 0 auto}
/* 「移到悬浮窗 / 放回去」:窄的时候(.narrow,JS 按视图宽度量)只留图标,标题和状态句先让位。
   ⚠️不用 container-type:它会让 .cu-live 的宽不再由内容撑,宿主哪天把挂载点做成随内容宽,视图就塌成 0 宽。 */
.cu-live-pip{display:inline-flex;align-items:center;gap:5px;flex:0 0 auto;font:inherit;line-height:1;padding:3px 7px;border-radius:7px;border:1px solid transparent;background:transparent;color:var(--text-muted,var(--text-light,inherit));cursor:pointer;white-space:nowrap}
.cu-live-pip-ic{display:flex;flex:0 0 auto}
.cu-live-pip svg{display:block}
.cu-live-pip:hover{background:var(--accent-light,var(--overlay-light,rgba(128,128,128,.14)));color:var(--accent-hover,var(--accent,inherit))}
.cu-live.narrow .cu-live-pip-label{display:none}
/* 窄的时候(Agent Desk 的卡片就是这个宽度)而这一步有状态句:状态句是这一行里最要紧的,别的让位 ——
   标题、「刚刚」、缩放的 − / + 先收起(滚轮和双击照样能缩放,百分比那颗还在,点它复位)。没有状态句时头部照旧。 */
.cu-live.narrow .cu-live-head.has-status .cu-live-title,.cu-live.narrow .cu-live-head.has-status .cu-live-age{display:none}
.cu-live.narrow .cu-live-head.has-status .cu-live-zoom .cu-live-step{display:none}
/* 悬浮小画面(surface 'pip',264 宽,高度随内容):上面画面、下面一行状态句 + 停止(「放回去」由宿主画在窗顶的拖动条里)。
   ⚠️舞台高度由 JS 按宽 × 窗口比例写死(pipStageHeight),根不能 height:100% —— 宿主量的就是它的内容高。 */
.cu-live.is-pip{height:auto;font-size:12px}
.cu-live.is-pip .cu-live-stage{flex:0 0 auto}
.cu-live.is-pip .cu-live-head{border-bottom:0;border-top:1px solid var(--border,rgba(128,128,128,.25));height:35px;box-sizing:border-box;padding:0 6px 0 10px;gap:6px}
.cu-live.is-pip .cu-live-age,.cu-live.is-pip .cu-live-zoom,.cu-live.is-pip .cu-live-zoom.on{display:none}
.cu-live.is-pip .cu-live-title{flex:1 1 auto;max-width:none}
.cu-live.is-pip .cu-live-head.has-status .cu-live-title{display:none}
.cu-live.is-pip .cu-live-stop{padding:3px 7px}
.cu-live.is-pip .cu-live-msg{padding:0 12px;line-height:1.45}
.cu-live.is-pip .cu-live-msg b{margin-bottom:2px}
/* 减少动态:状态句直接换、环固定大小只淡出、结束态不渐变(宿主设置里的「只淡入淡出」同样算) */
@keyframes cu-live-ring-fade{0%{opacity:.95}100%{opacity:0}}
@media (prefers-reduced-motion: reduce){
  .cu-live-status span.roll{animation:none}
  .cu-live-ring{animation-name:cu-live-ring-fade;transform:none}
  .cu-live-veil{transition:none}
}
html[data-motion-fade="on"] .cu-live-status span.roll{animation:none}
html[data-motion-fade="on"] .cu-live-ring{animation-name:cu-live-ring-fade;transform:none}
html[data-motion-fade="on"] .cu-live-veil{transition:none}
`

// 光标形状:和屏上叠层同一支箭头(尖端朝左上,和 helper 停稳时的朝向一致),尖端在 18px 盒子的 (1.45,1.45)。
// 尺寸固定 18px,不跟画面缩放。
const CURSOR_SVG = '<svg viewBox="-12 -12 26 26" aria-hidden="true"><path transform="rotate(225)" d="M10.48 1.44Q14 0 10.48 -1.44L-4.48 -7.56Q-8 -9 -7.20 -7.56L-3.80 -1.44Q-3 0 -3.80 1.44L-7.20 7.56Q-8 9 -4.48 7.56Z" fill="var(--cu-fill,#2c5f9e)" stroke="var(--cu-edge,#fff)" stroke-width="2" stroke-linejoin="round"/></svg>'
const CURSOR_TIP = { x: 1.45, y: 1.45 }
const TWEEN_MS = 140
const RING_MS = 500
const DOUBLE_RING_GAP_MS = 150
/** 挂载后看到的第一个动作:只有够新才放环(否则一打开视图就对着一个早就点完的按钮放一圈)。 */
const FIRST_RING_MAX_AGE_MS = 600
const ACTION_TOOL_RE = /(?:^|[^a-z0-9])(?:act_ui|jev_ui)$/

// ── 整轮:状态通道、收尾、每轮开始重发颜色 ─────────────────────────────────────────────
const sentEnds = new Set()
const styledRuns = new Set()
const trimSet = (set) => { while (set.size > RUNS_KEEP) set.delete(set.values().next().value) }
let reporter = null // 主窗里的取色上报器(见文件末尾),没有就 null

function onTurnStart(runId) {
  if (!runId || styledRuns.has(runId)) return
  styledRuns.add(runId)
  trimSet(styledRuns)
  if (reporter) reporter.turnStart() // 引擎重启会丢颜色:每一轮开始时也发一次
}

/** 这一轮结束 → POST /overlay-turn(带 runId,同一个 runId 每扇窗只发一次;悬浮小画面不发)。 */
function endTurn(runId) {
  if (!runId || sentEnds.has(runId)) return
  sentEnds.add(runId)
  trimSet(sentEnds)
  const tg = ctx.tangu
  if (!tg || typeof tg.request !== 'function' || !tracksTurns(globalThis.document)) return
  try {
    Promise.resolve(tg.request(ENGINE_ID, '/overlay-turn', { method: 'POST', body: { phase: 'end', runId } })).catch(() => { /* 旧引擎没有这条路由:交给 helper 的超时 */ })
  } catch { /* 同上 */ }
}

/**
 * 取某个 runId 的宿主状态。新宿主(契约 §2.3)认 { runId };旧宿主把它当会话 id,回来的 sessionId 就是我们传的那个对象 ——
 * 认出来以后改走「主区会话里正跑着它 → 记下会话 id,之后按会话 id 问」。都对不上 → undefined(= 不知道)。
 */
function readRunStatus(runId) {
  const tg = ctx.tangu
  if (!tg || typeof tg.agentStatus !== 'function') return undefined
  const rec = runRecord(runId)
  try {
    if (rec.viaRunArg !== false) {
      const arg = { runId }
      const st = tg.agentStatus(arg)
      if (st && typeof st === 'object' && st.sessionId !== arg) { rec.viaRunArg = true; return st }
      rec.viaRunArg = false
    }
    if (rec.sessionId) return tg.agentStatus(rec.sessionId)
    const main = tg.agentStatus()
    if (main && main.runId === runId && typeof main.sessionId === 'string') { rec.sessionId = main.sessionId; return main }
  } catch { /* 当不知道 */ }
  return undefined
}

/**
 * 用一份状态推进某一轮:先得**看到它在跑**,之后它不在跑了才算结束。
 * ⚠️「停止中」不是结束(评审第 1 条):宿主在停止请求进行中回 { phase: 'idle', runId: 原来那个 }(agentStatus.ts 的 phaseOf,
 * stoppingBySession 那一支)。同一个 runId 的 idle 只记 stopping,不发 overlay-turn、不锁 statusEnded;
 * 停止没成、它又回到在跑 → stopping 清掉、resumed 加一(视图据此把停止按钮还给用户)。
 * 真结束 = runId 没了 / 换成别的 / 同一个 runId 明确 done·error(按会话取时 done / error 也带着原来的 runId)。
 * 拿不到状态(null / 不是对象)= 不知道,不据此收尾。
 */
function applyRunStatus(runId, st) {
  const rec = runs.get(runId)
  if (!rec || !st || typeof st !== 'object' || rec.statusEnded) return
  if (st.runId === runId) {
    if (st.phase === 'done' || st.phase === 'error') { if (rec.sawRunning) finishRun(runId, rec); return }
    rec.sawRunning = true
    if (st.phase === 'idle') { rec.stopping = true; syncStopPoll(); return }
    if (rec.stopping) { rec.stopping = false; rec.resumed++; syncStopPoll() }
    return
  }
  if (rec.sawRunning) finishRun(runId, rec)
}
function finishRun(runId, rec) {
  rec.statusEnded = true
  rec.stopping = false
  endTurn(runId)
  unwatchRun(runId)
  syncStopPoll()
}
/**
 * 停止中的那几轮要再轮询着问:宿主的订阅只在 statusKey(phase / tool / toolStage / waitingFor / sessionId / agentSlug)变了才回调,
 * **不含 runId** —— 按会话订阅时「停止中」(idle,runId 还在)和停完(idle,runId 没了)键一模一样,真结束时一声不响。
 * 只在有停止中的轮次时开着,都收尾了就关。
 */
const STOP_POLL_MS = 1000
let stopPoll = null
function syncStopPoll() {
  let any = false
  for (const r of runs.values()) if (r.stopping && !r.statusEnded) { any = true; break }
  if (any && !stopPoll) {
    stopPoll = setInterval(() => {
      for (const [id, r] of [...runs]) if (r.stopping && !r.statusEnded) pollRunStatus(id)
      syncStopPoll()
    }, STOP_POLL_MS)
  } else if (!any && stopPoll) { clearInterval(stopPoll); stopPoll = null }
}
const pollRunStatus = (runId) => applyRunStatus(runId, readRunStatus(runId))

// 每一轮单独订阅一路状态 —— 视图看不见(6 s 慢速)、或根本没有视图、主区切去了别的会话时也能及时收尾(评审第 6 条)。
// 新宿主按 { runId };旧宿主不认 { runId }(会把它当会话 id、回 idle,和结束长得一样),只按已知的会话 id 订。
// 同时在跑的不止一轮时各盯各的;结束、被挤出记录、停用插件时退订。悬浮小画面不订。
const watches = new Map() // runId → 退订函数
function unwatchRun(runId) {
  const ids = runId === undefined ? [...watches.keys()] : [runId]
  for (const id of ids) {
    const off = watches.get(id)
    watches.delete(id)
    if (typeof off === 'function') { try { off() } catch { /* 宿主会统一收 */ } }
  }
}
function watchRun(runId) {
  const tg = ctx.tangu
  const rec = runs.get(runId)
  if (!rec || rec.statusEnded || watches.has(runId)) return
  if (!tg || typeof tg.subscribeAgentStatus !== 'function' || !tracksTurns(globalThis.document)) return
  let arg
  if (rec.viaRunArg === true) arg = { runId }
  else if (rec.viaRunArg === false && typeof rec.sessionId === 'string' && rec.sessionId) arg = rec.sessionId
  else return
  watches.set(runId, null)
  try {
    const off = tg.subscribeAgentStatus((st) => applyRunStatus(runId, st), arg)
    if (watches.has(runId)) watches.set(runId, off)
    else if (typeof off === 'function') off() // 订阅回调里当场就收尾了
  } catch { watches.delete(runId) }
}

/** 每个视图拿到的每一帧(含 unchanged / 不带图的)都过一遍这里:记基数、计数、helper 的进行中,顺手问一次状态。 */
function noteFrame(frame) {
  const count = Number.isFinite(frame.actionCount) ? frame.actionCount : null
  const runId = typeof frame.runId === 'string' && frame.runId ? frame.runId : null
  if (runId) {
    const rec = runRecord(runId)
    if (!rec.seenFrame) {
      rec.seenFrame = true
      // 基数只认「这一轮之前看到过的计数」;第一眼就已经在这一轮里 → 不知道,结束时只写「已完成」不写步数。
      rec.base = lastCount !== null && lastCountRun !== runId ? lastCount : null
      if (frame.turnActive !== false) onTurnStart(runId) // 已经收了的上一轮不必重发颜色
    }
    if (count !== null) rec.count = count
    if (typeof frame.turnActive === 'boolean') rec.helperActive = frame.turnActive
    pollRunStatus(runId)
    watchRun(runId)
  }
  if (count !== null) { lastCount = count; lastCountRun = runId }
}

ctx.registerView({
  id: VIEW_ID,
  // Agent Desk 卡片标题也用它(插件第一次动手时自己摆上 Desk,不带名字)。
  // ponytail: 装载时按语言取一次;切换界面语言后要重载插件才跟上(老宿主的视图标题只认字符串)。
  title: (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en' ? 'Controlled window' : '被操控的窗口',
  mount(el, view) {
    const doc = el.ownerDocument || document
    // 悬浮小画面(契约 §2.5):宿主在那扇 264 宽的置顶窗里挂这个视图,surface === 'pip' → 紧凑卡。
    // 别处有 window.tangu.computerUsePip(只有 Electron 桌面)→ 头部给「移到悬浮窗」;网页 / 手机没有这个桥就不画。
    const inPip = Boolean(view && typeof view === 'object' && view.surface === 'pip')
    const pipBridge = () => {
      const p = globalThis.window && window.tangu && window.tangu.computerUsePip
      return p && typeof p.open === 'function' && typeof p.close === 'function' ? p : null
    }
    let style = doc.getElementById('cu-live-style')
    if (!style) {
      style = doc.createElement('style')
      style.id = 'cu-live-style'
      doc.head.appendChild(style)
    }
    // ⚠️插件在开着的窗口里升级 / 重载时,旧版留下的同名 <style> 还在:不换掉的话新节点全没样式(光标 SVG 撑满、停止常显)。
    if (style.textContent !== CSS) style.textContent = CSS
    mountedViews++

    const root = doc.createElement('div')
    root.className = inPip ? 'cu-live is-pip' : 'cu-live'
    const head = doc.createElement('div')
    head.className = 'cu-live-head'
    const dot = doc.createElement('span')
    dot.className = 'cu-live-dot idle'
    const title = doc.createElement('span')
    title.className = 'cu-live-title'
    title.textContent = tr('view.title')
    // 这一步在做什么(「正在点击「发送」」…)。旧回包没有动作字段 → 空着,头部照旧。
    const status = doc.createElement('span')
    status.className = 'cu-live-status'
    const age = doc.createElement('span')
    age.className = 'cu-live-age'
    const zoomBar = doc.createElement('span')
    zoomBar.className = 'cu-live-zoom'
    const mkBtn = (label, tip) => {
      const b = doc.createElement('button')
      b.textContent = label
      b.title = tip
      return b
    }
    const btnOut = mkBtn('−', tr('zoom.out'))
    const btnPct = mkBtn('100%', tr('zoom.reset'))
    btnPct.className = 'cu-live-pct'
    const btnIn = mkBtn('+', tr('zoom.in'))
    btnOut.className = 'cu-live-step'
    btnIn.className = 'cu-live-step'
    zoomBar.append(btnOut, btnPct, btnIn)
    // 停止:宿主给了 ctx.tangu.stop(契约 §2.2)且知道这一轮的 runId 才露出来。
    const btnStop = mkBtn(tr('btn.stop'), tr('btn.stopTip'))
    btnStop.className = 'cu-live-stop'
    head.append(dot, title, status, age, zoomBar, btnStop)
    // 「移到悬浮窗」↔「放回去」(悬浮窗开着时同一个按钮把它收回)。悬浮窗里不再画「放回去」:
    // 宿主在那扇窗顶上的拖动条里画了(视图坏了也关得掉),这里再画一个就重复了。
    let btnPip = null
    let pipOpen = false
    let pipCheckedAt = 0
    if (!inPip && pipBridge()) {
      btnPip = doc.createElement('button')
      btnPip.className = 'cu-live-pip'
      head.append(btnPip)
    }
    const stage = doc.createElement('div')
    stage.className = 'cu-live-stage'
    // 悬浮窗的高度随内容(宿主量根节点的高):画面放在上面,高度由宽 × 窗口比例算出来;说明一行在下面。
    if (inPip) { stage.style.height = `${PIP_STAGE_DEFAULT}px`; root.append(stage, head) } else root.append(head, stage)
    el.appendChild(root)

    // 画布:宽高比跟着被操控窗口走(见 CSS 里的 --cu-ar)。缩放/平移的取景框就是它,不是整个舞台。
    const viewport = doc.createElement('div')
    viewport.className = 'cu-live-viewport'
    const img = doc.createElement('img')
    img.alt = tr('img.alt')
    viewport.appendChild(img)
    // 叠层:光标、点击环、结束时的那层底色与「已完成 · N 步」。都是 div(舞台上只许有一张 img),
    // 都在画布里 —— 画面被错误说明顶掉时它们跟着一起走,不会悬在说明上。
    const ovl = doc.createElement('div')
    ovl.className = 'cu-live-ovl'
    const cursorEl = doc.createElement('div')
    cursorEl.className = 'cu-live-cur'
    cursorEl.innerHTML = CURSOR_SVG
    const veil = doc.createElement('div')
    veil.className = 'cu-live-veil'
    const badge = doc.createElement('div')
    badge.className = 'cu-live-badge'
    ovl.append(cursorEl, veil, badge)
    viewport.appendChild(ovl)
    const msg = doc.createElement('div')
    msg.className = 'cu-live-msg'

    // 颜色:同一条取色规则,但界面里直接引用宿主变量(明暗切换时自己跟上);描边按读回的填色亮度定。
    const applyColors = () => {
      const th = readTheme(doc)
      const pick = th && th.pick
      const edge = pick ? edgeFor(pick.rgb) : '#ffffff'
      root.style.setProperty('--cu-fill', pick ? `var(--${pick.source})` : FALLBACK_FILL)
      root.style.setProperty('--cu-edge', edge)
      root.style.setProperty('--cu-edge-soft', edge === '#ffffff' ? 'rgba(255,255,255,.5)' : 'rgba(28,27,31,.5)')
    }
    applyColors()
    const unwatchColors = watchTheme(doc, applyColors)

    // ── 缩放/平移状态 ────────────────────────────────────────────────
    // natW/natH = 这一帧画面的像素尺寸;scale = 相对原始像素的倍率(100% = 1:1);
    // atFit = 还停在默认比例(未被用户缩放过)——**新帧到来时只有 atFit 才重新贴合**,
    // 否则用户刚放大到某个按钮上,下一秒的帧就把他弹回全景了。
    let natW = 0
    let natH = 0
    let scale = 1
    let atFit = true
    let offX = 0
    let offY = 0
    let shownWindowId = null
    // 上一帧的序号。带回给 helper,画面没变它就只回一句 unchanged —— 静止的窗口占绝大多数,
    // 不带这个的话同一张图会被每秒重编 8 次 JPEG + base64 + 过 IPC + 换一次 <img src>,纯白烧。
    let shownFrameSeq = null

    /** 把画布变形成这一帧窗口的形状。几何全从它量,所以任何改变 natW/natH 或舞台尺寸的事之后都得先调它。 */
    const layoutViewport = () => {
      if (inPip) {
        const want = `${pipStageHeight(natW, natH, stage.clientWidth || 0)}px`
        if (stage.style.height !== want) stage.style.height = want
      }
      const box = viewportBoxOf(natW, natH, stage.clientWidth || 0, stage.clientHeight || 0)
      viewport.style.width = `${box.w}px`
      viewport.style.height = `${box.h}px`
      return box
    }
    /** 取景框 = 画布(已按窗口比例变形),不是舞台 —— 舞台里画布之外那圈是卡片留白,不参与取景。 */
    const stageBox = () => ({
      w: viewport.clientWidth || 0,
      h: viewport.clientHeight || 0,
    })
    /**
     * 缩放下限 = 整幅可见。画布与画面同比例,所以这同时就是"恰好铺满画布"——
     * fit 与 cover 在这里是同一个值,不再需要在留黑边和裁画面之间做取舍。
     */
    const fitScale = () => {
      const { w, h } = stageBox()
      return fitScaleOf(natW, natH, w, h)
    }
    const defaultScale = fitScale

    const paintZoom = () => {
      const fit = fitScale()
      const zoomed = scale > fit * 1.001
      img.style.width = `${natW}px`
      img.style.height = `${natH}px`
      img.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`
      // 放大到超过原始像素时关掉平滑,让人看清真实像素(这正是"查看细节"要的)
      img.style.imageRendering = scale > 1.5 ? 'pixelated' : 'auto'
      btnPct.textContent = `${Math.round(scale * 100)}%`
      btnOut.disabled = !zoomed
      btnIn.disabled = scale >= MAX_SCALE - 1e-6
      viewport.className = `cu-live-viewport${zoomed ? ' zoomed' : ''}`
      placeOverlay()
    }

    /** 回到默认比例(恰好铺满画布),居中。 */
    const resetZoom = () => {
      scale = defaultScale()
      atFit = true
      const { w, h } = stageBox()
      // ⚠️传居中值而不是 0:亚像素误差会让画面比画布大上零点几个像素,0 在合法区间内 →
      // 贴左上角对齐,于是那零点几像素全被切在右/下边。居中才是"取中间那块"。
      offX = clampOffset((w - natW * scale) / 2, natW * scale, w)
      offY = clampOffset((h - natH * scale) / 2, natH * scale, h)
      paintZoom()
    }

    /** 以舞台坐标 (ax, ay) 为锚点缩放到 next。 */
    const zoomTo = (next, ax, ay) => {
      const fit = fitScale()
      const target = clampScale(next, fit)
      if (Math.abs(target - scale) < 1e-6) return
      const { w, h } = stageBox()
      offX = anchoredOffset(offX, ax, scale, target)
      offY = anchoredOffset(offY, ay, scale, target)
      scale = target
      // 只有回到默认比例才算"没自己缩放过";落在默认与 fit 之间也算用户在取景。
      atFit = Math.abs(scale - defaultScale()) < 1e-3
      offX = clampOffset(offX, natW * scale, w)
      offY = clampOffset(offY, natH * scale, h)
      paintZoom()
    }
    const zoomByStep = (factor) => {
      const { w, h } = stageBox()
      zoomTo(scale * factor, w / 2, h / 2)
    }

    /** 画布形状可能变了(换窗口 / 窗口改尺寸 / 面板被拖动)→ 重新变形,再收拾取景。
     *  还停在默认比例就整个复位;用户正放大着就守住倍率,但**必须把平移夹回新边界** ——
     *  paintZoom 只画不夹,旧偏移相对新画布可能已经越界,画面会整块滑出去。 */
    const reflow = (prevNatW) => {
      if (!natW) return
      layoutViewport()
      if (atFit) return resetZoom()
      // ⚠️同一个窗口换了**编码分辨率**(取景放大时我们主动要更高清的原图,maxDimension 800→1600):
      // scale 是"相对原始像素"的倍率,像素翻倍而 scale 不动,画面就凭空放大一倍、锚点也跟着跳。
      // 按像素比反向补偿,保住用户看到的大小。窗口真的变大时这样做同样对 —— 视觉尺寸不该因此突变。
      if (prevNatW > 0 && prevNatW !== natW) scale *= prevNatW / natW
      const { w, h } = stageBox()
      scale = clampScale(scale, fitScale())
      offX = clampOffset(offX, natW * scale, w)
      offY = clampOffset(offY, natH * scale, h)
      paintZoom()
    }

    /** 画布正挂在舞台上(而不是被错误说明顶掉了)—— 所有交互的前提。 */
    const showingImage = () => viewport.parentNode === stage

    /** 只换文本,不重建节点 —— 每秒重建几次 DOM 没必要,也会让选中/滚动位置抖。 */
    const showMessage = (headline, detail) => {
      if (msg.parentNode !== stage) stage.replaceChildren(msg)
      zoomBar.className = 'cu-live-zoom'
      msg.replaceChildren()
      const b = doc.createElement('b')
      b.textContent = headline
      msg.append(b, doc.createTextNode(detail || ''))
    }
    const showImage = (dataUrl, w, h, forceReset) => {
      const resized = w !== natW || h !== natH
      const prevNatW = natW
      natW = w || natW
      natH = h || natH
      img.src = dataUrl
      if (!showingImage()) stage.replaceChildren(viewport)
      zoomBar.className = 'cu-live-zoom on'
      // 换了窗口一律复位:尺寸恰好相同时 resized=false,不强制的话新窗口会套用上一个窗口的取景框。
      if (forceReset) { layoutViewport(); return resetZoom() }
      if (resized) return reflow(prevNatW)
      paintZoom()
    }

    // ── 交互:滚轮/触控板缩放、拖拽平移、按钮、键盘 ──────────────────────
    const offs = []
    const on = (target, type, fn, opts) => {
      if (!target.addEventListener) return
      target.addEventListener(type, fn, opts)
      offs.push(() => target.removeEventListener(type, fn, opts))
    }
    /** 事件坐标 → **画布**坐标(offX/offY 就是相对画布左上角量的,拿舞台去减会整体错位)。 */
    const localPoint = (e) => {
      const r = viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : { left: 0, top: 0 }
      return { x: e.clientX - r.left, y: e.clientY - r.top }
    }

    on(btnIn, 'click', () => zoomByStep(1.4))
    on(btnOut, 'click', () => zoomByStep(1 / 1.4))
    on(btnPct, 'click', () => resetZoom())

    // ── 叠层:光标 / 点击环 / 状态句 / 结束态 / 停止 ─────────────────────────────────
    // 位置一律存成 0..1 比例,由 placeOverlay 按当前取景换算 —— 缩放、平移时它们跟着画面走,自己的大小不变。
    const win = doc.defaultView || globalThis
    const raf = typeof win.requestAnimationFrame === 'function' ? (f) => win.requestAnimationFrame(f) : null
    const caf = typeof win.cancelAnimationFrame === 'function' ? (id) => win.cancelAnimationFrame(id) : () => {}
    const nowMs = () => (win.performance && typeof win.performance.now === 'function' ? win.performance.now() : Date.now())
    let curPt = null        // 光标此刻画在哪(补间进行中就是中间点)
    let tween = null        // { from, to, t0 }
    let rafId = null
    const rings = []        // { el, pt }
    const overlayTimers = new Set()
    let lastSeq = null
    let shownStatus = ''
    let shownDone = ''
    let stopRun = null
    let stoppingRun = null
    let stopResumedAt = 0   // 点停止那一刻这一轮的 resumed;之后它变大 = 停止没成、又回到在跑 → 按钮还给用户

    function placeOverlay() {
      if (!natW || !natH) return
      if (curPt) {
        const p = overlayPx(curPt, natW, natH, scale, offX, offY)
        const r2 = (v) => Math.round(v * 100) / 100 // 尖端偏移是小数,别把浮点尾巴写进样式
        cursorEl.style.transform = `translate(${r2(p.x - CURSOR_TIP.x)}px, ${r2(p.y - CURSOR_TIP.y)}px)`
      }
      for (const r of rings) {
        const p = overlayPx(r.pt, natW, natH, scale, offX, offY)
        r.el.style.left = `${p.x}px`
        r.el.style.top = `${p.y}px`
      }
    }
    const stepTween = () => {
      rafId = null
      if (!tween || stopped) return
      const t = (nowMs() - tween.t0) / TWEEN_MS
      curPt = tweenPoint(tween.from, tween.to, t)
      placeOverlay()
      if (t < 1) rafId = raf(stepTween)
      else tween = null
    }
    /** 光标去 pt(比例点;null = 不画)。两帧之间补着走;减少动态 / 看不见(rAF 不来)/ 第一次出现 → 直接到位。 */
    const setCursor = (pt) => {
      if (!pt) {
        curPt = null
        tween = null
        cursorEl.style.display = 'none'
        return
      }
      cursorEl.style.display = 'block'
      if (!curPt || !raf || reducedMotionIn(doc) || unseen()) {
        tween = null
        curPt = pt
        placeOverlay()
        return
      }
      const goal = tween ? tween.to : curPt
      if (goal.x === pt.x && goal.y === pt.y) return
      tween = { from: curPt, to: pt, t0: nowMs() }
      if (rafId === null) rafId = raf(stepTween)
    }
    const later = (fn, ms) => {
      const id = setTimeout(() => { overlayTimers.delete(id); if (!stopped) fn() }, ms)
      overlayTimers.add(id)
    }
    const spawnRing = (pt) => {
      const ringEl = doc.createElement('div')
      ringEl.className = 'cu-live-ring'
      const r = { el: ringEl, pt }
      rings.push(r)
      ovl.appendChild(ringEl)
      placeOverlay()
      later(() => {
        const i = rings.indexOf(r)
        if (i >= 0) rings.splice(i, 1)
        if (ringEl.remove) ringEl.remove()
      }, RING_MS + 120)
    }
    /** 点击类动作放一次环,双击两圈(间隔 0.15 s)。落点优先用动作自己的坐标,没有就用光标。 */
    const playRings = (a, fallback) => {
      const pt = fracPoint({ x: a.x, y: a.y }) || fallback
      if (!pt) return
      spawnRing(pt)
      if (a.kind === 'doubleClick') later(() => spawnRing(pt), DOUBLE_RING_GAP_MS)
    }
    /** 状态句:变了才换,换的时候滚一下(减少动态时 CSS 不滚)。 */
    const setStatus = (text) => {
      if (text === shownStatus) return
      shownStatus = text
      head.className = text ? 'cu-live-head has-status' : 'cu-live-head'
      if (!text) { status.replaceChildren(); return }
      const s = doc.createElement('span')
      s.className = 'roll'
      s.textContent = text
      s.title = text
      status.replaceChildren(s)
    }
    /** 这一轮结束:最后一帧盖一层卡片底色(0.55),正中「已完成 · N 步」。 */
    const setDone = (text) => {
      if (text === shownDone) return
      shownDone = text
      veil.className = text ? 'cu-live-veil on' : 'cu-live-veil'
      badge.className = text ? 'cu-live-badge on' : 'cu-live-badge'
      badge.replaceChildren()
      if (text) badge.append(doc.createElement('i'), doc.createTextNode(text))
    }
    const setStop = (runId) => {
      const can = Boolean(runId) && Boolean(ctx.tangu && typeof ctx.tangu.stop === 'function')
      stopRun = can ? runId : null
      btnStop.className = can ? 'cu-live-stop on' : 'cu-live-stop'
      // 停止中(本视图刚点过,或宿主状态已经是「停止中」——别处叫停的也算)→ 按钮留着但禁用,等这一轮真的结束
      const rec = can ? runs.get(runId) : null
      btnStop.disabled = can && (stoppingRun === runId || Boolean(rec && rec.stopping))
    }
    on(btnStop, 'click', () => {
      const runId = stopRun
      if (!runId || stoppingRun === runId) return
      stoppingRun = runId
      const rec = runs.get(runId)
      stopResumedAt = rec ? rec.resumed : 0
      btnStop.disabled = true
      let p
      try { p = Promise.resolve(ctx.tangu.stop({ runId })) } catch { p = Promise.resolve(false) }
      p.catch(() => false).then((ok) => {
        // 没停成(找不到这一轮)→ 还给用户再按一次;停成了就等这一轮真的结束,按钮跟着收起。
        if (!ok && stoppingRun === runId) { stoppingRun = null; if (!stopped && stopRun === runId) btnStop.disabled = false }
      })
    })
    // ── 悬浮窗的入口 / 放回去 ──
    const PIP_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="8" y="8" width="5" height="4" rx="1" fill="currentColor"/></svg>'
    const paintPip = () => {
      if (!btnPip) return
      const text = tr(pipOpen ? 'btn.putBack' : 'btn.pip')
      const tip = tr(pipOpen ? 'btn.putBackTip' : 'btn.pipTip')
      const icon = doc.createElement('span')
      icon.className = 'cu-live-pip-ic'
      icon.innerHTML = PIP_ICON
      const label = doc.createElement('span')
      label.className = 'cu-live-pip-label'
      label.textContent = text
      btnPip.replaceChildren(icon, label)
      btnPip.title = tip
      btnPip.setAttribute('aria-label', text)
    }
    /** 悬浮窗开着没有(用户可能在悬浮窗上点了关闭):挂载时、点完后、之后每 3 s 至多问一次。 */
    const refreshPip = () => {
      const api = pipBridge()
      pipCheckedAt = Date.now()
      if (!btnPip || !api || typeof api.isOpen !== 'function') return
      let p
      try { p = Promise.resolve(api.isOpen()) } catch { return }
      p.then((v) => { if (stopped) return; const next = v === true; if (next !== pipOpen) { pipOpen = next; paintPip() } }, () => {})
    }
    if (btnPip) {
      paintPip()
      refreshPip()
      on(btnPip, 'click', () => {
        const api = pipBridge()
        if (!api) return
        let p
        try { p = Promise.resolve(pipOpen ? api.close() : api.open()) } catch (e) { p = Promise.reject(e) }
        p.catch(() => {}).then(() => { if (!stopped) refreshPip() })
      })
    }
    const clearOverlay = () => {
      setCursor(null)
      setStatus('')
      setDone('')
      setStop(null)
    }
    /** 一帧(活跃的)到手后更新叠层。旧回包(没有协议 20 的字段)→ 全部收起,头部照现在的样子。 */
    const updateOverlay = (frame) => {
      const fresh = frame.lastAction !== undefined || frame.cursor !== undefined || frame.runId !== undefined
        || frame.turnActive !== undefined || frame.actionCount !== undefined
      // 没有协议 20 的字段:**带图**的回包才说明是旧 helper → 收起叠层;unchanged / 我们没要图的回包里
      // helper 可能本来就不带这些字段,不能因此让光标和状态句每个静止帧闪没一次。
      if (!fresh) { if (frame.jpegBase64) clearOverlay(); return }
      noteFrame(frame)
      const runId = typeof frame.runId === 'string' && frame.runId ? frame.runId : null
      const ended = runId ? runEnded(runId) : frame.turnActive === false
      const a = frame.lastAction && typeof frame.lastAction === 'object' ? frame.lastAction : null
      const cur = fracPoint(frame.cursor)
      setCursor(cur)
      if (a && Number.isFinite(a.seq)) {
        const isNew = lastSeq !== null ? a.seq !== lastSeq : Number(a.ageMs) < FIRST_RING_MAX_AGE_MS
        if (isNew && !ended && CLICK_KINDS.has(a.kind)) playRings(a, cur)
        lastSeq = a.seq
      }
      const locale = currentLocale()
      setStatus(statusText(locale, { ended, lastAction: a }))
      setDone(ended ? doneText(locale, runId ? runSteps(runId) : null) : '')
      const rec = runId ? runs.get(runId) : null
      if (stoppingRun && stoppingRun === runId && rec && rec.resumed > stopResumedAt) stoppingRun = null // 停止没成,又在跑了
      setStop(ended ? null : runId)
    }

    // 触控板捏合在 macOS 上就是 ctrlKey 的 wheel;普通滚轮这里也当缩放(它是个看图器)。
    // passive:false + preventDefault:否则滚轮会冒泡去滚外层面板。
    // 悬浮窗只是瞄一眼:不缩放(没有缩放条,滚轮也不该被它吃掉)。
    on(viewport, 'wheel', (e) => {
      if (!showingImage() || inPip) return
      e.preventDefault()
      const p = localPoint(e)
      const factor = Math.exp(-(e.deltaY || 0) * (e.ctrlKey ? 0.01 : 0.0022))
      zoomTo(scale * factor, p.x, p.y)
    }, { passive: false })

    // 双击:默认比例 ↔ 1:1 原始像素,在光标处切换
    on(viewport, 'dblclick', (e) => {
      if (!showingImage() || inPip) return
      const p = localPoint(e)
      if (atFit) zoomTo(1, p.x, p.y)
      else resetZoom()
    })

    let drag = null
    on(viewport, 'pointerdown', (e) => {
      if (!showingImage() || scale <= fitScale() * 1.001) return
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
      if (viewport.setPointerCapture) viewport.setPointerCapture(e.pointerId)
      viewport.className = 'cu-live-viewport zoomed panning'
    })
    on(viewport, 'pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return
      const { w, h } = stageBox()
      offX = clampOffset(offX + (e.clientX - drag.x), natW * scale, w)
      offY = clampOffset(offY + (e.clientY - drag.y), natH * scale, h)
      drag.x = e.clientX
      drag.y = e.clientY
      img.style.transform = `translate(${offX}px, ${offY}px) scale(${scale})`
      placeOverlay()
    })
    const endDrag = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return
      drag = null
      paintZoom()
    }
    on(viewport, 'pointerup', endDrag)
    on(viewport, 'pointercancel', endDrag)
    on(viewport, 'lostpointercapture', endDrag)
    // ⚠️兜底:setPointerCapture 失败/不支持时,指针移出舞台再松手,pointerup 落在别处 →
    // drag 永远清不掉,之后鼠标一动画面就跟着跑。切到别的 App 松手同理(渲染进程收不到 up)。
    // 无参调用 endDrag 会无条件收场(它只在传了不匹配的 pointerId 时才拒绝)。
    const forceEndDrag = () => endDrag()
    on(doc, 'pointerup', forceEndDrag)
    on(doc, 'pointercancel', forceEndDrag)
    if (globalThis.window) on(window, 'blur', forceEndDrag)

    // 键盘:+ / - / 0(0 = 恢复默认比例)
    stage.setAttribute('tabindex', '0')
    on(stage, 'keydown', (e) => {
      if (!showingImage() || inPip) return
      if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomByStep(1.4) }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomByStep(1 / 1.4) }
      else if (e.key === '0') { e.preventDefault(); resetZoom() }
    })

    // 面板被拖宽/收窄 → 画布要重新变形。⚠️观察的是**舞台**不是画布:画布的尺寸是我们自己写进去的,
    // 观察它就会被自己的写入再次唤醒 → 死循环。
    const NARROW_BELOW = 560
    const rootClass = inPip ? 'cu-live is-pip' : 'cu-live'
    const updateNarrow = () => {
      const w = root.clientWidth || 0
      const next = w > 0 && w < NARROW_BELOW ? `${rootClass} narrow` : rootClass
      if (root.className !== next) root.className = next
    }
    updateNarrow()
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { updateNarrow(); reflow() }) : null
    if (resizeObserver) resizeObserver.observe(stage)

    let timer = null
    let stopped = false
    let inFlight = false

    const schedule = (ms) => {
      if (stopped) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(tick, ms)
    }

    // 可见性是**节奏**,不是开关。三态:null=还没人告诉我(当可见处理),true/false=IO 的判断。
    // ⚠️绝不能因为"不可见"就完全停:隐藏页面里浏览器不做交集计算,IO 连首次回调都不来,
    // 初值若是 false 就永远翻不了身(实测 ioHits=0,视图一帧都不请求)。
    const hasObserver = typeof IntersectionObserver === 'function'
    let onScreen = null
    const observer = hasObserver
      ? new IntersectionObserver((entries) => {
          const now = entries.some((e) => e.isIntersecting)
          const appeared = now && onScreen === false
          onScreen = now
          // 刚露出来就立刻补一帧,别让用户对着慢速间隔干等。
          if (appeared && !stopped && !inFlight) schedule(0)
        }, { threshold: 0.01 })
      : null
    if (observer) observer.observe(root)
    /** 明确不可见(IO 说的,或页面整个隐藏)→ 降到慢速;其余按正常节奏。 */
    const unseen = () => onScreen === false || doc.hidden === true

    async function tick() {
      timer = null
      if (stopped) return
      if (inFlight) return schedule(TICK_MS)
      if (btnPip && Date.now() - pipCheckedAt > 3000) refreshPip()
      const api = globalThis.window && window.tangu && window.tangu.computerUseLiveView
      if (!api) {
        showMessage(tr('msg.needDesktop'), tr('msg.needDesktopDetail'))
        dot.className = 'cu-live-dot idle'
        age.textContent = ''
        return // 不再重排:这个环境永远不会有
      }
      inFlight = true
      // 慢速期主动不要图(省掉真正贵的那一步:一次窗口截屏)。记下来 —— 下面判断
      // "没图" 是我们没要,还是真的拿不到,两者的处理完全不同。
      const wantedImage = !unseen()
      let frame
      try {
        // 放大了就要更高分辨率的原图,否则"查看细节"看到的只是被放大的马赛克。
        // 2560 是主进程那边的上限,再高会被夹回去。
        frame = await fetchFrame(api, wantedImage
          ? { maxDimension: atFit ? 800 : 1600, quality: atFit ? 0.55 : 0.8, sinceFrame: shownFrameSeq || '' }
          : { image: false })
      } catch (e) {
        frame = { active: false, error: String((e && e.message) || e) }
      } finally {
        inFlight = false
      }
      if (stopped) return

      if (!frame.active) {
        dot.className = 'cu-live-dot idle'
        title.textContent = tr('view.title')
        age.textContent = ''
        clearOverlay()
        showMessage(tr('msg.none'), explain(frame.error) || tr('msg.noneDetail'))
        return schedule(unseen() ? HIDDEN_TICK_MS : IDLE_TICK_MS)
      }

      dot.className = 'cu-live-dot'
      learnBundle(frame.app, frame.bundleId)
      const label = describe(frame)
      title.textContent = label
      title.title = label
      age.textContent = ago(frame.ageMs)
      // 光标 / 环 / 状态句 / 结束态:unchanged 与不带图的回包里也有这些字段,每帧都过。
      updateOverlay(frame)
      // 换了个窗口就回到默认比例:上一个窗口的取景框套在新窗口上毫无意义(还可能停在一片空白上)
      const switchedWindow = Boolean(frame.windowId) && frame.windowId !== shownWindowId
      if (switchedWindow) { shownWindowId = frame.windowId; shownFrameSeq = null }
      if (frame.jpegBase64) {
        shownFrameSeq = frame.frameSeq || null
        showImage(`data:image/jpeg;base64,${frame.jpegBase64}`, frame.width, frame.height, switchedWindow)
      }
      // helper 说"和你上次看到的那一帧一样":静止的窗口本来就该长这样,保留现有画面,只刷标题与时间。
      else if (frame.unchanged) { /* 画面没变 */ }
      // 慢速期是**我们自己没要图**(image:false),不是拿不到 —— 保留正在显示的那一帧,
      // 别把画面换成"拿不到这一帧画面"。真拿不到(该给图却没给)才报。
      else if (!wantedImage) { /* 保留现有画面,只刷新标题与时间 */ }
      else showMessage(tr('msg.noFrame'), explain(frame.error))
      schedule(unseen() ? HIDDEN_TICK_MS : TICK_MS)
    }

    void tick()

    return () => {
      stopped = true
      if (timer) clearTimeout(timer)
      if (observer) observer.disconnect()
      if (resizeObserver) resizeObserver.disconnect()
      if (rafId !== null) caf(rafId)
      rafId = null
      overlayTimers.forEach((id) => clearTimeout(id))
      overlayTimers.clear()
      unwatchColors()
      // 最后一个视图关了:之后的动作没人看着,计数基数作废 —— 否则下次打开会把这段空白期的动作算进下一轮的步数。
      if (--mountedViews <= 0) { mountedViews = 0; lastCount = null; lastCountRun = null }
      offs.forEach((f) => f())
      offs.length = 0
      img.src = ''
      el.replaceChildren()
    }
  },
})

// ── 侧边拼接:把一扇对话面板贴在某个 App 窗口旁边,拖动 / 移动 / 缩放都像一个窗口 ──────────────
// 面板、跟随、读划线都在宿主(electron/appDock.ts,经本包 helper 的 dockProbe / selection 命令);这里只是入口。
// 面板打开后先列出屏上的窗口让用户挑,所以命令本身不带目标。老宿主没有这条 IPC、或不是 macOS(跟随靠 helper 的
// CGWindowList / AX,宿主那边直接回 unsupported_platform)→ 不注册,免得给出一个点了没反应的命令。
const dockOpen = globalThis.window && window.tangu && window.tangu.platform === 'darwin' && window.tangu.appDockOpen
if (dockOpen) {
  const en = () => (ctx.getLocale ? ctx.getLocale() : 'zh') === 'en'
  ctx.registerCommand({
    id: 'dock-chat',
    title: () => (en() ? 'Dock a chat beside an app' : '把对话贴到应用旁边'),
    keywords: 'side panel dock attach app window chat 侧边 贴边 拼接 应用 窗口 对话 tiebian pinjie',
    run: () => { void dockOpen() },
  })
}

// ── 取色上报(插件顶层,只在主窗)────────────────────────────────────────────────────
// 经 ctx.tangu.request 交给自家引擎半身的 /overlay-style(契约 §1.6),引擎塞进之后每条 act。
// 旧宿主没有 ctx.tangu.request → 什么都不做(helper 用柔蓝)。内容没变不重发;每一轮开始时强制重发一次。
const teardown = []
{
  const doc = globalThis.document
  const tg = ctx.tangu
  if (tg && typeof tg.request === 'function' && doc && doc.documentElement && isMainWindow(doc)) {
    let lastKey = null
    let dead = false
    const send = (force) => {
      if (dead) return
      const th = readTheme(doc)
      const body = th && styleBody(th.pick, th.reducedMotion)
      if (!body) return // 读不出就不发
      const key = JSON.stringify(body)
      if (!force && key === lastKey) return
      lastKey = key
      let p
      try { p = Promise.resolve(tg.request(ENGINE_ID, '/overlay-style', { method: 'POST', body })) } catch (e) { p = Promise.reject(e) }
      // 失败(旧引擎没这条路由 / 引擎没起来)不刷屏;清掉记号,下次变化或下一轮再试。
      p.catch(() => { if (lastKey === key) lastKey = null })
    }
    const unwatch = watchTheme(doc, () => send(false))
    reporter = { turnStart: () => send(true) }
    send(false)
    teardown.push(() => { dead = true; unwatch(); reporter = null })
  }
}

// ── 本窗会话的整轮(插件顶层;主窗、Mini、独立窗各管各的,悬浮小画面不管)──────────────────
// 没有视图开着时也要收尾:本窗当前会话里跑过 act_ui / jev_ui 的那一轮,不跑了就发 overlay-turn end。
// 这里拿到的 runId 是宿主的;引擎把同一个 id 交给工具(tcx.runId)—— 对不上时 helper 照契约不做事,无害。
{
  const tg = ctx.tangu
  if (tg && typeof tg.subscribeAgentStatus === 'function' && tracksTurns(globalThis.document)) {
    let lastMainRun = null
    const onStatus = (st) => {
      if (!st || typeof st !== 'object') return
      const runId = typeof st.runId === 'string' && st.runId ? st.runId : null
      if (runId && runId !== lastMainRun) { lastMainRun = runId; onTurnStart(runId) }
      if (runId && !isAgentPhaseOver(st) && typeof st.tool === 'string' && ACTION_TOOL_RE.test(st.tool)) {
        const rec = runRecord(runId)
        rec.sawRunning = true
        if (typeof st.sessionId === 'string') rec.sessionId = st.sessionId
      }
      // 每次主区状态变了,把还没收尾的几轮都问一遍(它们各自按会话 id / runId 问,不会被主区切会话骗),
      // 问过以后知道走哪条通道了,就对每一轮建定向订阅:之后主区切去别的会话,那一轮结束也会自己报上来。
      for (const [id, rec] of [...runs]) if (rec.sawRunning && !rec.statusEnded) { pollRunStatus(id); watchRun(id) }
    }
    let off = null
    try { off = tg.subscribeAgentStatus(onStatus) } catch { off = null }
    try { if (typeof tg.agentStatus === 'function') onStatus(tg.agentStatus()) } catch { /* 拿不到初值就等回调 */ }
    teardown.push(() => { if (typeof off === 'function') { try { off() } catch { /* 宿主会统一收 */ } } })
  }
}
teardown.push(() => { unwatchRun(); if (stopPoll) { clearInterval(stopPoll); stopPoll = null } })

// 纯函数暴露给 check.mjs(宿主装载时 ctx 存在,check 里只取这个挂点)。
globalThis.__CU_LIVE_TEST__ = {
  explain, ago, describe, PLUGIN_ID, VIEW_ID, TICK_MS, IDLE_TICK_MS,
  fitScaleOf, viewportBoxOf, fetchFrame, clampOffset, anchoredOffset, clampScale, MAX_SCALE, HIDDEN_TICK_MS,
  MSG, fmt, chroma, toHex, hexToRgb, relLuminance, edgeFor, pickFill, styleBody, statusText, stepCount, doneText,
  fracPoint, easeOut, tweenPoint, overlayPx, isMainWindow, tracksTurns, reducedMotionIn, ENGINE_ID, FALLBACK_FILL,
  DOING_MS, LOOKING_AFTER_MS, TWEEN_MS,
  CU_TOOLS, describeCall, tlClip, joinZh, keysText, labelForRef, appForState, appForRoot, appInResult, appBundles, learnBundle,
  pipStageHeight, PIP_STAGE_DEFAULT, STOP_POLL_MS,
}

// 停用 / 重载插件:拆掉顶层的观察器、订阅、定时器(视图实例各自的清理在 mount 返回的函数里)。
return () => {
  while (teardown.length) { try { teardown.pop()() } catch { /* 继续拆别的 */ } }
}
