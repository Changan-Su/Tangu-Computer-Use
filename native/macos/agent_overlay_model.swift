import CoreGraphics
import Foundation

// 屏上叠层(示意光标、点击环、边缘光)的纯数据模型(Tangu,协议 20,非上游)。
//
// 这里只有值类型和纯函数:配色、渐变量(ramp)、光标场景、整轮状态机。窗口、计时器、重绘都在
// agent_cursor.swift / agent_highlight.swift / agent_overlay_turn.swift;画法在 agent_overlay_paint.swift。
// 拆成纯函数是为了能离线测:`npm run check:cursor` 不连 helper、不要任何授权,就在固定时刻把画面画成 PNG。

/// 叠层用的单调时钟(秒)。不用 TimelineView 的 context.date:墙钟会被校时拨动,飞行的到达时刻要算得准。
enum OverlayClock {
    static func now() -> Double { ProcessInfo.processInfo.systemUptime }
}

// MARK: - 配色

struct OverlayRGB: Equatable {
    var r: Double
    var g: Double
    var b: Double

    init(r: Double, g: Double, b: Double) {
        self.r = r
        self.g = g
        self.b = b
    }

    /// 只认 `#rrggbb`(大小写都行)。别的写法(`#rgb`、`rgb()`、带透明度)一律当读不出。
    init?(hex raw: String) {
        let text = raw.trimmingCharacters(in: .whitespaces)
        guard text.count == 7, text.first == "#", let value = UInt32(text.dropFirst(), radix: 16) else { return nil }
        r = Double((value >> 16) & 0xFF) / 255
        g = Double((value >> 8) & 0xFF) / 255
        b = Double(value & 0xFF) / 255
    }

    var hex: String {
        let c = [r, g, b].map { Int(($0 * 255).rounded()) }
        return String(format: "#%02x%02x%02x", c[0], c[1], c[2])
    }

    /// 按比例混向另一种颜色(amount 0 = 自己,1 = other)。
    func mixed(with other: OverlayRGB, _ amount: Double) -> OverlayRGB {
        let k = max(0, min(1, amount))
        return OverlayRGB(r: r + (other.r - r) * k, g: g + (other.g - g) * k, b: b + (other.b - b) * k)
    }

    /// WCAG 2 相对亮度(sRGB 先线性化)。⚠️别换成三个通道直接加权平均:陶土 #b36c46 那样算出来 ~0.47,
    /// 会被判成浅色配上深边;线性化之后是 ~0.21,配白边才对。视图那半边算 edge 用的也是这一条。
    var relativeLuminance: Double {
        func linear(_ c: Double) -> Double { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
        return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
    }

    static let white = OverlayRGB(r: 1, g: 1, b: 1)
    static let black = OverlayRGB(r: 0, g: 0, b: 0)
    /// 浅色填色配的深边。
    static let ink = OverlayRGB(hex: "#1c1b1f")!
    /// 缺省填色:柔蓝(经典 / 墨色主题的强调色;读不到主题色时也用它,不再回到橙色)。
    static let softBlue = OverlayRGB(hex: "#2c5f9e")!
}

struct OverlayPalette: Equatable {
    var fill: OverlayRGB
    var edge: OverlayRGB

    /// 相对亮度低于它的填色配白边,否则配深边。
    static let edgeLuminanceThreshold = 0.28

    static func autoEdge(for fill: OverlayRGB) -> OverlayRGB {
        fill.relativeLuminance < edgeLuminanceThreshold ? .white : .ink
    }

    init(fill: OverlayRGB, edge: OverlayRGB? = nil) {
        self.fill = fill
        self.edge = edge ?? Self.autoEdge(for: fill)
    }

    static let standard = OverlayPalette(fill: .softBlue)

    /// act 请求里的 `overlayStyle`:`{ fill: "#rrggbb", edge?: "#rrggbb" }`。fill 读不出 → nil(调用方用缺省);
    /// edge 读不出 → 按 fill 的亮度自己取。
    static func parse(_ raw: Any?) -> OverlayPalette? {
        guard let object = raw as? [String: Any], let fillText = object["fill"] as? String, let fill = OverlayRGB(hex: fillText) else {
            return nil
        }
        let edge = (object["edge"] as? String).flatMap { OverlayRGB(hex: $0) }
        return OverlayPalette(fill: fill, edge: edge)
    }
}

/// act / actBatch 请求里和叠层有关的可选字段(协议 20)。actBatch 先读每一步自己的,没有再用整批顶层的。
struct OverlayActOptions: Equatable {
    var enabled: Bool
    var palette: OverlayPalette
    /// 宿主说的「减少动态」。helper 另外自己读系统设置,两者任一为真就按减少动态处理(见 AgentCursor)。
    var reduceMotion: Bool
    var runId: String?
    /// 缺省 true:点击类动作等光标飞到再投递(ArrivalWait)。false = 照旧立刻投递(负对照)。
    var clickAfterArrival: Bool

    static let keys = ["cursorOverlay", "overlayStyle", "reduceMotion", "runId", "clickAfterArrival"]

    static func parse(_ request: [String: Any], fallback: [String: Any] = [:]) -> OverlayActOptions {
        func value(_ key: String) -> Any? { request[key] ?? fallback[key] }
        let runId = (value("runId") as? String).map { String($0.prefix(128)) }.flatMap { $0.isEmpty ? nil : $0 }
        return OverlayActOptions(
            enabled: value("cursorOverlay") as? Bool ?? true,
            palette: OverlayPalette.parse(value("overlayStyle")) ?? .standard,
            reduceMotion: value("reduceMotion") as? Bool ?? false,
            runId: runId,
            clickAfterArrival: value("clickAfterArrival") as? Bool ?? true
        )
    }
}

/// `{ cmd: "overlayTurn", phase: "end", runId?: string }`。只收 end;别的 phase 返回 nil(调用方回 invalid_args)。
struct OverlayTurnCommand: Equatable {
    var runId: String?

    static func parse(_ request: [String: Any]) -> OverlayTurnCommand? {
        guard (request["phase"] as? String) == "end" else { return nil }
        if let raw = request["runId"], !(raw is String) { return nil }
        let runId = (request["runId"] as? String).flatMap { $0.isEmpty ? nil : String($0.prefix(128)) }
        return OverlayTurnCommand(runId: runId)
    }
}

// MARK: - 渐变量

/// 一个随时间线性过渡(带 smoothstep)的量:from → to,在 [start, start+duration] 里走完。纯值,按时刻取值。
struct OverlayRamp: Equatable {
    var from: Double
    var to: Double
    var start: Double
    var duration: Double

    init(value: Double) {
        from = value
        to = value
        start = 0
        duration = 0
    }

    init(from: Double, to: Double, start: Double, duration: Double) {
        self.from = from
        self.to = to
        self.start = start
        self.duration = duration
    }

    var end: Double { start + max(0, duration) }

    func value(at t: Double) -> Double {
        if t >= end { return to }
        if t <= start { return from }
        return from + (to - from) * smooth((t - start) / duration)
    }

    /// 从 t 时刻的当前值出发,过渡到 target。已经在往同一个目标走(或早已到了)就不动 —— 重复调用不会把过渡拉长。
    mutating func set(_ target: Double, at t: Double, duration d: Double) {
        if target == to { return }
        from = value(at: t)
        to = target
        start = t
        duration = max(0, d)
    }
}

// MARK: - 光标场景

/// 落点散开的一圈环(单击一圈;双击两圈,隔 0.15 s;右键同一种)。
struct RingEffect: Equatable {
    var center: CGPoint
    var start: Double
    var reduceMotion: Bool
    static let duration = 0.5
    var end: Double { start + Self.duration }
}

/// 拖动:身后一条线,走到哪画到哪;松手后 0.4 s 淡掉。points 是箭尖经过的点(画布坐标)。
struct TrailEffect: Equatable {
    var points: [CGPoint]
    var start: Double
    var travel: Double
    var release: Double { start + travel }
    static let fade = 0.4
    var end: Double { release + Self.fade }
}

/// 滚动:光标旁两个小箭头顺方向滑 10 pt,各 0.5 s,错开 0.1 s。
struct ArrowEffect: Equatable {
    var origin: CGPoint
    /// 单位向量(画布坐标,y 向下 = 往下滚)。
    var direction: CGVector
    var start: Double
    var reduceMotion: Bool
    static let each = 0.5
    static let stagger = 0.1
    var end: Double { start + Self.stagger + Self.each }
}

/// 打字 / setText:输入框描边,停 0.9 s 后 0.4 s 淡掉。
struct FieldEffect: Equatable {
    var rect: CGRect
    var start: Double
    static let hold = 0.9
    static let fade = 0.4
    var end: Double { start + Self.hold + Self.fade }
}

/// 一段「按住」(拖动时光标缩到 0.88)。
struct HoldEffect: Equatable {
    var start: Double
    var end: Double
}

/// 光标在某一时刻要画成什么样(画法只吃这个)。
struct CursorFrame: Equatable {
    var visible: Bool
    var pose: CursorPose
    var scale: Double
    var opacity: Double
    /// 出现时的一点模糊(pt)。
    var blur: Double
    /// 在想时绕箭尖的摆角(弧度)。
    var wobble: Double
}

/// 示意光标那块全屏画布上的一切:光标本身 + 点击环 / 拖动线 / 滚动箭头 / 输入框描边。纯值。
struct CursorScene: Equatable {
    static let appearDuration = 0.2
    static let disappearDuration = 0.4
    static let thinkingDuration = 0.4
    static let pressDuration = 0.2
    static let doubleClickGap = 0.15
    static let wobbleAmplitude = 7.0 * Double.pi / 180
    static let wobblePeriod = 1.6

    /// 光标有没有位置(第一次出现之前没有)。
    var placed = false
    var rest = CursorPose(point: .zero, heading: CursorPose.restHeading)
    var segments: [CursorMotionSegment] = []
    var presence = OverlayRamp(value: 0)
    var thinking = OverlayRamp(value: 0)
    var presses: [Double] = []
    var holds: [HoldEffect] = []
    var rings: [RingEffect] = []
    var trails: [TrailEffect] = []
    var arrows: [ArrowEffect] = []
    var fields: [FieldEffect] = []
    var reduceMotion = false

    func pose(at t: Double) -> CursorPose {
        guard let current = segments.last(where: { $0.start <= t }) else { return segments.first?.pose(at: t) ?? rest }
        return current.pose(at: t)
    }

    /// 光标(还)没出现时放到一个起点上:第一下从落点左上 140pt 飞进来(和以前一样),减少动态时直接放在落点。
    mutating func place(_ pose: CursorPose) {
        placed = true
        rest = pose
        segments = []
    }

    /// 出现(0.2 s 淡入)。已经在显示 / 正在出现就不动。
    mutating func show(at t: Double) {
        presence.set(1, at: t, duration: Self.appearDuration)
    }

    /// 消失(0.4 s 淡出)。
    mutating func hide(at t: Double) {
        presence.set(0, at: t, duration: Self.disappearDuration)
    }

    var isAppearing: Bool { presence.to >= presence.from }

    /// 飞到 tip(箭尖对准的点)。返回到达时刻。减少动态:不飞,直接在目的地淡入。
    @discardableResult
    mutating func fly(toTip tip: CGPoint, at t: Double) -> Double {
        let target = CursorPose.resting(atTip: tip)
        if reduceMotion {
            let moved = hypot(target.point.x - pose(at: t).point.x, target.point.y - pose(at: t).point.y) >= 6
            rest = target
            segments = []
            if moved, presence.value(at: t) > 0 {
                presence = OverlayRamp(from: 0, to: 1, start: t, duration: Self.appearDuration)
            }
            return t
        }
        // 先到再点:投递前已经让光标起飞去这一点了(bridge 的 approach),到了投递那一下再叫一次同一个落点 ——
        // 还在路上就别重新规划(半空中换一条路会抖一下),到达时刻照旧;已经到了,下面算出来的距离 < 6 pt,d = 0。
        if placed, case .flight(let current)? = segments.last, current.to == target, current.arrival > t {
            return current.arrival
        }
        let flight = CursorFlight(from: pose(at: t), to: target, start: t)
        rest = target
        segments = [.flight(flight)]
        return flight.arrival
    }

    /// 拖动:飞到起点 → 按住 → 沿路径走 → 松手一圈环。返回松手时刻。
    @discardableResult
    mutating func drag(tips: [CGPoint], at t: Double) -> Double {
        guard let first = tips.first else { return t }
        let arrival = fly(toTip: first, at: t)
        guard tips.count > 1 else { return arrival }
        let positions = tips.map { CursorPose.resting(atTip: $0).point }
        let travel = reduceMotion ? 0 : CursorPolyline.duration(points: positions)
        let release = arrival + travel
        if reduceMotion {
            rest = CursorPose.resting(atTip: tips[tips.count - 1])
            segments = []
        } else {
            segments.append(.polyline(CursorPolyline(points: positions, start: arrival, duration: travel)))
            rest = CursorPose(point: positions[positions.count - 1], heading: CursorPose.restHeading)
            holds.append(HoldEffect(start: arrival, end: release))
        }
        trails.append(TrailEffect(points: tips, start: arrival, travel: travel))
        rings.append(RingEffect(center: tips[tips.count - 1], start: release, reduceMotion: reduceMotion))
        return release
    }

    /// 点下去:光标缩到 0.86 再弹回(0.2 s)+ 落点散开环(count 圈,隔 0.15 s)。
    mutating func click(at tip: CGPoint, count: Int, time t: Double, withCursor: Bool) {
        for index in 0..<max(1, min(3, count)) {
            let start = t + Double(index) * Self.doubleClickGap
            if withCursor { presses.append(start) }
            rings.append(RingEffect(center: tip, start: start, reduceMotion: reduceMotion))
        }
    }

    mutating func scroll(at tip: CGPoint, dx: Int, dy: Int, time t: Double) {
        let vx = Double(dx.signum()), vy = Double(dy.signum())
        guard vx != 0 || vy != 0 else { return }
        let length = hypot(vx, vy)
        let direction = CGVector(dx: vx / length, dy: vy / length)
        // 摆在光标右侧(竖着滚)或下方(横着滚),不压在箭头上。
        let origin = vy != 0 ? CGPoint(x: tip.x + 30, y: tip.y + 4) : CGPoint(x: tip.x + 6, y: tip.y + 32)
        arrows.append(ArrowEffect(origin: origin, direction: direction, start: t, reduceMotion: reduceMotion))
    }

    mutating func field(_ rect: CGRect, at t: Double) {
        fields.append(FieldEffect(rect: rect, start: t))
    }

    mutating func setThinking(_ on: Bool, at t: Double) {
        thinking.set(on ? 1 : 0, at: t, duration: Self.thinkingDuration)
    }

    /// 丢掉已经放完的效果(每次改动时调,数组不会越积越长)。
    mutating func prune(at t: Double) {
        presses.removeAll { $0 + Self.pressDuration < t }
        holds.removeAll { $0.end < t }
        rings.removeAll { $0.end < t }
        trails.removeAll { $0.end < t }
        arrows.removeAll { $0.end < t }
        fields.removeAll { $0.end < t }
        if let last = segments.last, last.end < t {
            rest = last.pose(at: last.end)
            segments = []
        }
    }

    /// 所有「会结束的」过渡在什么时刻全部放完(不含在想时的轻摆,那个只要还在想就一直摆)。
    func transientEnd() -> Double {
        var end = max(presence.end, thinking.end)
        if let last = segments.last { end = max(end, last.end) }
        end = presses.reduce(end) { max($0, $1 + Self.pressDuration) }
        end = holds.reduce(end) { max($0, $1.end) }
        end = rings.reduce(end) { max($0, $1.end) }
        end = trails.reduce(end) { max($0, $1.end) }
        end = arrows.reduce(end) { max($0, $1.end) }
        end = fields.reduce(end) { max($0, $1.end) }
        return end
    }

    /// 在想、光标在显示、没开减少动态 → 轻摆(要持续重绘,帧率压到 30)。
    var wobbles: Bool { placed && thinking.to > 0 && presence.to > 0 && !reduceMotion }

    /// 光标本体之外还有没放完的效果(决定窗口能不能收)。
    func hasEffects(at t: Double) -> Bool {
        rings.contains { $0.end > t } || trails.contains { $0.end > t } || arrows.contains { $0.end > t } || fields.contains { $0.end > t }
    }

    /// 什么都看不见了:光标淡完(或从没出现)且效果放完。
    func isBlank(at t: Double) -> Bool {
        presence.to == 0 && presence.value(at: t) <= 0.001 && !hasEffects(at: t)
    }

    func cursorFrame(at t: Double) -> CursorFrame {
        let pose = pose(at: t)
        let p = presence.value(at: t)
        guard placed, p > 0.001 else {
            return CursorFrame(visible: false, pose: pose, scale: 1, opacity: 0, blur: 0, wobble: 0)
        }
        var scale: Double
        var blur = 0.0
        if reduceMotion {
            scale = 1
        } else if isAppearing {
            scale = 0.7 + 0.3 * p
            blur = (1 - p) * 3
        } else {
            scale = 0.82 + 0.18 * p
        }
        let th = thinking.value(at: t)
        var opacity = p * (1 - 0.4 * th)
        var wobble = 0.0
        if !reduceMotion {
            scale *= 1 - 0.15 * th
            for press in presses where t >= press && t < press + Self.pressDuration {
                scale *= 1 - 0.14 * sin(.pi * (t - press) / Self.pressDuration)
            }
            for hold in holds where t >= hold.start - 0.08 && t <= hold.end + 0.08 {
                let into = smooth((t - (hold.start - 0.08)) / 0.08)
                let out = smooth(((hold.end + 0.08) - t) / 0.08)
                scale *= 1 - 0.12 * min(into, out)
            }
            wobble = th * Self.wobbleAmplitude * sin(2 * .pi * t / Self.wobblePeriod)
        }
        opacity = max(0, min(1, opacity))
        return CursorFrame(visible: true, pose: pose, scale: scale, opacity: opacity, blur: blur, wobble: wobble)
    }
}

// MARK: - 效果在某一时刻的样子(画法和测试共用)

struct RingFrame: Equatable {
    var center: CGPoint
    var diameter: Double
    var opacity: Double
}

extension RingEffect {
    /// 直径 12 → 60(0.5 s),不透明度 0.95 → 0.7(36% 处)→ 0。减少动态:固定直径 48,只淡出。
    func frame(at t: Double) -> RingFrame? {
        guard t >= start, t < end else { return nil }
        let u = (t - start) / Self.duration
        if reduceMotion {
            return RingFrame(center: center, diameter: 48, opacity: 0.95 * (1 - u))
        }
        let opacity = u < 0.36 ? 0.95 + (0.7 - 0.95) * (u / 0.36) : 0.7 * (1 - (u - 0.36) / 0.64)
        return RingFrame(center: center, diameter: 12 + 48 * easeOut(u), opacity: max(0, opacity))
    }
}

extension TrailEffect {
    /// (画到哪,不透明度)。
    func frame(at t: Double) -> (points: [CGPoint], opacity: Double)? {
        guard t >= start, t < end, points.count > 1 else { return nil }
        let fraction = travel > 0 ? (t - start) / travel : 1
        let opacity = t <= release ? 0.4 : 0.4 * (1 - (t - release) / Self.fade)
        return (polylinePrefix(points, fraction: fraction), max(0, opacity))
    }
}

extension ArrowEffect {
    /// 两个箭头各自的(中心,不透明度)。
    func frames(at t: Double) -> [(center: CGPoint, opacity: Double)] {
        (0..<2).compactMap { index in
            let begin = start + Double(index) * Self.stagger
            guard t >= begin, t < begin + Self.each else { return nil }
            let u = (t - begin) / Self.each
            let slide = reduceMotion ? 0 : 10 * easeOut(u)
            let base = CGPoint(x: origin.x - direction.dx * 5, y: origin.y - direction.dy * 5)
            let center = CGPoint(x: base.x + direction.dx * CGFloat(slide), y: base.y + direction.dy * CGFloat(slide))
            return (center, 0.95 * sin(.pi * u))
        }
    }
}

extension FieldEffect {
    func opacity(at t: Double) -> Double? {
        guard t >= start, t < end else { return nil }
        let u = t - start
        if u < 0.12 { return u / 0.12 }
        if u < Self.hold { return 1 }
        return max(0, 1 - (u - Self.hold) / Self.fade)
    }
}

// MARK: - 先到再点

/// 「先到再点」的纯判定(协议 20,非上游)。bridge 在取按前证据之前先让光标起飞,只等还没飞完的那一段,
/// 再照旧取证、投递。这里只有判定和算术;起飞、等待、取证在 bridge.swift 的 act 里。
enum ArrivalWait {
    /// 最长的一段飞行(CursorFlight.duration 的上限)。到达时刻算出来再远也只等这么多。
    static let maxFlight = 0.45
    /// 等主线程把到达时刻报回来最多等这么久(主线程忙就不等光标,照旧投递)。
    static let replyTimeout = 0.2
    /// 一批(actBatch)为等光标最多多花的时间;单条 act 也按这个上限算(一条最多等 maxFlight,碰不到它)。
    static let batchBudget = 2.0
    /// 会画光标的动作(点击、移动、滚动、拖动)。打字 / 按键 / setText 不等。
    static let pointerActions: Set<String> = ["press", "click", "moveMouse", "scroll", "drag"]

    enum Skip: String, Equatable {
        /// 不是指针动作。
        case notPointer
        /// 「操作可视化」关着(或不是常驻 helper,不画光标)。
        case overlayOff
        /// clickAfterArrival == false(负对照)。
        case optedOut
        /// 减少动态:光标不飞,没什么可等。
        case reduceMotion
        /// 抢前台(HID)的物理事件:本来就不画光标(07-29)。
        case foreground
        /// 这条路不画光标(ax_only 下的物理事件、注定被拒的网页按压)。
        case noCursor
    }

    enum Plan: Equatable {
        /// 起飞并等到达;viaAx = 这一下会用 AX 完成(不发物理事件),光标照画。
        case approach(viaAx: Bool)
        case skip(Skip)
    }

    /// 这一条 act 会不会画光标、要不要等。照着 act() 里各条路的分支和 cue() 的守卫写,两边改一边要同步改。
    /// - viaElement:按 ref 找到了元素(否则是 x/y 坐标)。
    /// - elementPressable:元素支持 AXPress。elementNeedsPointer:元素在网页里或是文本框(AXPress 打不动,要真实指针)。
    ///   两个都是闭包,只在真要分类时才调(每次是一到几十次同步 AX 往返):不是指针动作、叠层关着、clickAfterArrival
    ///   = false、减少动态、不是按 ref 的按压这几种,一次都不调;elementPressable 只在 elementNeedsPointer 没把路定死时才调。
    ///   bridge 那边两个闭包背后是同一份按需缓存,act 后面真去按的那条分支读同一份结果,不查第二遍。
    /// - leftSingleClick:左键单击(坐标点击只有这种会先试后台 AXPress)。
    static func plan(
        action: String, viaElement: Bool, elementPressable: () -> Bool, elementNeedsPointer: () -> Bool,
        delivery: String, policy: String, leftSingleClick: Bool,
        cursorEnabled: Bool, clickAfterArrival: Bool, reduceMotion: Bool
    ) -> Plan {
        guard pointerActions.contains(action) else { return .skip(.notPointer) }
        guard cursorEnabled else { return .skip(.overlayOff) }
        guard clickAfterArrival else { return .skip(.optedOut) }
        guard !reduceMotion else { return .skip(.reduceMotion) }
        let isPress = action == "press" || action == "click"
        if viaElement && isPress {
            if policy != "ax_only" && elementNeedsPointer() {
                // 前台策略走坐标物理点击;别的策略直接抛 foreground_required。
                return policy == "foreground" ? coordinates(isPress: true, viaElement: true, delivery: delivery, policy: policy, leftSingleClick: leftSingleClick) : .skip(.noCursor)
            }
            if elementPressable() { return .approach(viaAx: true) }
        }
        // 按 ref 的滚动先试 AX 滚动(不发物理事件)。
        if viaElement && action == "scroll" { return .approach(viaAx: true) }
        return coordinates(isPress: isPress, viaElement: viaElement, delivery: delivery, policy: policy, leftSingleClick: leftSingleClick)
    }

    /// executeCoordinates 那条路:抢前台不画;ax_only 只有坐标左键单击(先试后台 AXPress)画;其余(pid 投递)画。
    private static func coordinates(isPress: Bool, viaElement: Bool, delivery: String, policy: String, leftSingleClick: Bool) -> Plan {
        if delivery == "hid" { return .skip(.foreground) }
        if policy == "ax_only" {
            return isPress && !viaElement && leftSingleClick ? .approach(viaAx: true) : .skip(.noCursor)
        }
        return .approach(viaAx: false)
    }

    /// 还要等多久:max(0, 到达 − 现在),不超过一段飞行;算不出来(NaN / ∞)就不等。
    static func remaining(arrival: Double, now: Double) -> Double {
        let left = arrival - now
        guard left.isFinite, left > 0 else { return 0 }
        return min(maxFlight, left)
    }

    /// 叠层此刻在不在屏上。窗口刚在这一下被拿到前面时 occlusionState 还没来得及更新(系统异步通知),
    /// 那时不按它判 —— 否则最显眼的第一次飞入永远不等。
    static func overlayOnScreen(isVisible: Bool, wasVisibleBefore: Bool, occlusionVisible: Bool) -> Bool {
        guard isVisible else { return false }
        return wasVisibleBefore ? occlusionVisible : true
    }
}

/// 一批(或一条)act 为等光标还能花多少时间。只增不减地扣;用完后面的步骤不再等(光标照旧边飞边点)。
struct ArrivalBudget: Equatable {
    private(set) var remaining: Double

    init(seconds: Double = ArrivalWait.batchBudget) { remaining = max(0, seconds) }

    /// 想等 wanted 秒,能给多少(不扣)。
    func grant(_ wanted: Double) -> Double {
        guard wanted.isFinite, wanted > 0 else { return 0 }
        return min(wanted, remaining)
    }

    /// 实际花掉 spent 秒(含等主线程回话的时间)。
    mutating func spend(_ spent: Double) {
        guard spent.isFinite, spent > 0 else { return }
        remaining = max(0, remaining - spent)
    }
}

// MARK: - 实时画面回包里的光标与最近动作

/// 一帧 / 一个动作归谁:哪扇窗口、哪个进程、哪一轮(runId;旧调用方是 nil)。liveView 拿这一帧的归属和最近动作的
/// 归属比,对不上就不把那个动作拼进这一帧的回包。
struct LiveFrameOwner: Equatable {
    var windowId: UInt32
    var pid: Int32
    var runId: String?

    /// 同一扇窗口、同一轮(nil 和 nil 也算同一轮)。pid 只记不比:look() 登记窗口时 pid 取 CG 的窗口归属,act 的 pid
    /// 来自请求,两者对同一扇窗口本应一致,但不为它冒「每帧都丢最近动作」的险 —— 窗口号本身全局唯一。
    func owns(_ other: LiveFrameOwner) -> Bool {
        windowId == other.windowId && runId == other.runId
    }
}

/// helper 记下的最近一次动作(liveView 回包用)。坐标一律是全局 CG 点(左上原点)。
struct LiveActionRecord: Equatable {
    var kind: String
    var seq: Int
    /// OverlayClock 时刻。
    var at: Double
    /// 落点(点击 / 滚动的那一点;拖动是松手的那一点)。
    var point: CGPoint?
    /// 示意光标停的那一点(画了光标才有;打字时是输入框前缘)。没有就用 point。
    var cursor: CGPoint?
    var label: String?
    /// 这个动作是哪条 act 做的(从那条 act 自己的参数取,不读共享状态)。
    var owner: LiveFrameOwner
}

/// liveView 回包的五个新字段(协议 20,契约 §1.4):cursor / lastAction / actionCount / runId / turnActive。
/// 只在按窗口截图的那条路上给;坐标换算成这一帧里的比例(0…1,左上原点),落在窗口外就不给。
enum LiveViewExtras {
    static let fieldNames = ["cursor", "lastAction", "actionCount", "runId", "turnActive"]
    static let labelLimit = 60

    /// act 的 action(+ 按键 / 次数)→ 回包里的 kind;不认识的(wait 等)不记。
    static func kind(action: String, button: String?, clickCount: Int?) -> String? {
        switch action {
        case "click":
            if button == "right" { return "rightClick" }
            return (clickCount ?? 1) >= 2 ? "doubleClick" : "click"
        case "press": return "press"
        case "moveMouse": return "move"
        case "scroll": return "scroll"
        case "drag": return "drag"
        case "typeText": return "type"
        case "keypress": return "key"
        case "setText": return "setText"
        default: return nil
        }
    }

    /// 被操作元素的可读名:AX 标题,没有就用描述。空白压成一个空格、去头尾,最长 60 字;读不到就是 nil。
    static func label(title: String?, description: String?) -> String? {
        for raw in [title, description] {
            guard let raw else { continue }
            let collapsed = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
            if !collapsed.isEmpty { return String(collapsed.prefix(labelLimit)) }
        }
        return nil
    }

    /// 全局点 → 这一帧里的比例(窗口 bounds 就是帧的范围)。落在窗口外、bounds 退化就是 nil。保留 4 位小数。
    static func fraction(_ point: CGPoint, in bounds: CGRect) -> (x: Double, y: Double)? {
        guard bounds.width > 0, bounds.height > 0, point.x.isFinite, point.y.isFinite else { return nil }
        let x = Double((point.x - bounds.minX) / bounds.width), y = Double((point.y - bounds.minY) / bounds.height)
        guard (0...1).contains(x), (0...1).contains(y) else { return nil }
        func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }
        return (round4(x), round4(y))
    }

    /// frame:这一帧画面是谁的(和截图用的同一份快照)。最近动作的归属和它对不上(别的窗口 / 一轮)就不带
    /// cursor / lastAction —— 否则会把 B 的画面配上迟到的 A 的动作;actionCount / turnActive / runId 照给。
    static func fields(last: LiveActionRecord?, actionCount: Int, runId: String?, turnActive: Bool, frame: LiveFrameOwner, windowBounds: CGRect?, now: Double) -> [String: Any] {
        var out: [String: Any] = ["actionCount": actionCount, "turnActive": turnActive]
        if let runId { out["runId"] = runId }
        guard let last, frame.owns(last.owner) else { return out }
        var action: [String: Any] = ["kind": last.kind, "seq": last.seq, "ageMs": max(0, Int(((now - last.at) * 1000).rounded()))]
        if let point = last.point, let bounds = windowBounds, let f = fraction(point, in: bounds) {
            action["x"] = f.x
            action["y"] = f.y
        }
        if let label = last.label { action["label"] = label }
        out["lastAction"] = action
        if let cursor = last.cursor ?? last.point, let bounds = windowBounds, let f = fraction(cursor, in: bounds) {
            out["cursor"] = ["x": f.x, "y": f.y]
        }
        return out
    }
}

// MARK: - 整轮状态机

/// 一轮(同一个 runId)里叠层该处在哪一档。纯状态机:事件(act 开始 / 结束、overlayTurn end)+ 时刻 → 档位和下一个
/// 要醒来的时刻。窗口和计时器只执行它的输出(AgentOverlayTurn)。
///
/// - 带 runId 的 act → 进行中(runId 变了就换一轮)。
/// - 最后一个动作结束 0.3 s 后 → 在想。
/// - overlayTurn end(runId 对得上),或 45 s 没有任何 act → 结束:再等 1.0 s,光标和边缘光一起淡出 0.4 s,然后归零。
/// - 没有 runId 的 act(旧调用方)不开新的一轮;正好有一轮在进行时算作这一轮的活动。
/// - 显式结束(overlayTurn end)过的 runId 记进一张小的最近表:之后再带着它来的动作(批量里 end 之后还没停下的那几步)
///   一律按没有 runId 的旧调用方处理,不复活、也不抢走别的一轮。45 s 空闲超时那种结束不进表:同一个 runId 再动手照样恢复。
struct OverlayTurnModel: Equatable {
    static let thinkingDelay = 0.3
    static let idleTimeout = 45.0
    static let endHold = 1.0
    static let fadeDuration = 0.4
    /// 显式结束过的 runId 最多记这么多个(runId 每轮都是新的,够挡住迟到的动作就行)。
    static let endedMemory = 16

    enum Phase: Equatable {
        case idle
        case acting
        case thinking
        /// 已经结束,fadeAt 起开始淡出。
        case ending(fadeAt: Double)
    }

    private(set) var runId: String?
    private(set) var active = false
    private(set) var depth = 0
    private(set) var lastActivity = 0.0
    private(set) var endAt: Double?
    /// 显式结束过的 runId(最老的在前)。
    private(set) var explicitlyEnded: [String] = []

    /// 返回这一下是否属于一轮(带 runId 的整轮模式,且这一轮还没结束)。
    @discardableResult
    mutating func actStarted(runId requested: String?, at t: Double) -> Bool {
        advance(to: t)
        // 显式结束过的 runId 带来的迟到动作:当成旧调用方(没有 runId)。
        let runId = requested.flatMap { explicitlyEnded.contains($0) ? nil : $0 }
        if let runId, !active || endAt != nil || runId != self.runId {
            self.runId = runId
            active = true
            endAt = nil
        }
        depth += 1
        lastActivity = t
        return active && endAt == nil
    }

    mutating func actEnded(at t: Double) {
        advance(to: t)
        depth = max(0, depth - 1)
        lastActivity = max(lastActivity, t)
    }

    /// overlayTurn end。runId 给了且对不上 → 不做事;没给 runId 而这一轮有 runId → 也不做事(别的会话收尾不能熄掉这一轮)。
    @discardableResult
    mutating func requestEnd(runId: String?, at t: Double) -> Bool {
        advance(to: t)
        // 不管对不对得上当前这一轮、这一轮是不是已经超时收尾:带 runId 的 end 说明那一轮真的结束了,先记下。
        if let runId, !explicitlyEnded.contains(runId) {
            explicitlyEnded.append(runId)
            if explicitlyEnded.count > Self.endedMemory { explicitlyEnded.removeFirst(explicitlyEnded.count - Self.endedMemory) }
        }
        guard active, endAt == nil else { return false }
        guard let runId, runId == self.runId else { return false }
        endAt = t
        return true
    }

    /// 这一轮(会在)什么时刻结束:显式的 end,或者没有动作在跑时最后一次活动 + 45 s。
    var effectiveEnd: Double? {
        guard active else { return nil }
        if let endAt { return endAt }
        return depth == 0 ? lastActivity + Self.idleTimeout : nil
    }

    func phase(at t: Double) -> Phase {
        guard active else { return .idle }
        if let end = effectiveEnd, t >= end {
            let fadeAt = end + Self.endHold
            return t >= fadeAt + Self.fadeDuration ? .idle : .ending(fadeAt: fadeAt)
        }
        if depth > 0 || t < lastActivity + Self.thinkingDelay { return .acting }
        return .thinking
    }

    /// 下一个档位可能变化的时刻(> t)。nil = 再没有要等的(包括一轮彻底结束之后)。
    func nextDeadline(after t: Double) -> Double? {
        guard active else { return nil }
        var candidates: [Double] = []
        if depth == 0 && endAt == nil { candidates.append(lastActivity + Self.thinkingDelay) }
        if let end = effectiveEnd {
            candidates += [end, end + Self.endHold, end + Self.endHold + Self.fadeDuration]
        }
        return candidates.filter { $0 > t }.min()
    }

    /// 45 s 超时一到就把结束时刻钉住:之后再来的旧调用方动作(没有 runId)不会把已经在收尾的这一轮续上。
    mutating func advance(to t: Double) {
        guard active, endAt == nil, depth == 0, t >= lastActivity + Self.idleTimeout else { return }
        endAt = lastActivity + Self.idleTimeout
    }

    /// 整个清零(「操作可视化」关掉时),只留显式结束过的 runId:开关再打开后迟到的动作照样不复活。
    mutating func reset() {
        let ended = explicitlyEnded
        self = OverlayTurnModel()
        explicitlyEnded = ended
    }

    /// 一轮彻底放完后归零(phase 已是 idle 时调)。
    mutating func settle(at t: Double) {
        guard active, phase(at: t) == .idle else { return }
        active = false
        endAt = nil
        depth = 0
    }
}

/// 边缘光的不透明度:动手 1.0(亮起 0.2 s),在想 0.45(0.4 s 过渡),结束淡出 0.4 s。画在内容上,不动窗口的 alpha
/// (check:overlay 只把 alpha > 0.5 的窗口算可见)。
struct HighlightScene: Equatable {
    static let actingLevel = 1.0
    static let thinkingLevel = 0.45
    static let riseDuration = 0.2
    static let dimDuration = 0.4
    static let fadeDuration = 0.4

    var level = OverlayRamp(value: 0)

    func opacity(at t: Double) -> Double { max(0, min(1, level.value(at: t))) }
}
