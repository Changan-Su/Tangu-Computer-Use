import AppKit
import Observation
import SwiftUI

/// Visual-only cursor; native action delivery remains authoritative.
///
/// Tangu(协议 20):光标、点击环、拖动线、滚动箭头、输入框描边都画在这一张全屏画布上;画法是
/// (CursorScene, 配色, 时刻) 的纯函数(agent_overlay_paint.swift),这里只管窗口和计时器。
/// 出现 / 消失一律淡入淡出,放完就收窗口、停重绘 —— 不留常驻动画。
@MainActor
final class AgentCursor {
    typealias Scheduler = @MainActor (_ delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> Task<Void, Never>

    /// 屏上画什么。坐标一律是全局 CG 点 / 矩形(左上原点)。
    enum Cue: Equatable {
        case click(count: Int)
        case move
        case scroll(dx: Int, dy: Int)
        case drag(points: [CGPoint])
        /// 打字 / setText:光标停到输入框前缘中线 + 描边。
        case field(rect: CGRect)
        /// 抢前台(HID)的点击:不画光标(07-29 定的),只在落点画环。
        case ringOnly(count: Int)
        /// 抢前台的打字:不画光标,只描输入框。
        case fieldOnly(rect: CGRect)

        var drawsCursor: Bool {
            switch self {
            case .ringOnly, .fieldOnly: return false
            default: return true
            }
        }
    }

    static let shared = AgentCursor(schedule: scheduleDefault)
    /// 光标空闲多久收起(旧调用方、以及没有窗口可贴的光标;10-17 定的:不整轮盖着用户的窗口)。
    static let idleHideSeconds: TimeInterval = 8

    private var overlay: AgentCursorOverlayWindow?
    private var idleTask: Task<Void, Never>?
    private var idleGeneration: UInt = 0
    private var teardownTask: Task<Void, Never>?
    private var teardownGeneration: UInt = 0
    /// 光标钉着的那扇窗口(可能是目标弹出的下拉 / 菜单)和目标窗口本身;跟随 timer 用。
    private var anchorId: UInt32 = 0
    private var targetId: UInt32 = 0
    private var repinTimer: Timer?
    private let schedule: Scheduler
    /// 叠层时钟(缺省 OverlayClock;测试注入假时钟)。
    private let clock: () -> Double
    let renderer: AgentCursorRenderer

    /// 整轮模式(AgentOverlayTurn 设):光标钉着窗口时不按 8 s 收,等这一轮结束和边缘光一起淡出。
    /// 没有窗口可贴(anchorId == 0)时照旧 8 s 收。
    var holdForTurn = false {
        didSet { if holdForTurn, anchorId != 0 { cancelIdle() } }
    }

    init(schedule: @escaping Scheduler, renderer: AgentCursorRenderer? = nil, clock: @escaping () -> Double = OverlayClock.now) {
        self.schedule = schedule
        self.renderer = renderer ?? .shared
        self.clock = clock
    }

    var hasOverlay: Bool { overlay != nil }

    func animate(to point: CGPoint, above windowId: UInt32, layer: Int? = nil, target: UInt32 = 0) {
        perform(.move, at: point, above: windowId, layer: layer, target: target)
    }

    /// above:点下去那一点上接住事件的窗口(目标本身,或它弹出的下拉 / 菜单),layer 是它的 window level。
    /// 光标钉在它正上方一层(pinOverlay):盖着它的窗口照样盖住光标,目标被挡住的地方用户看不到光标(10-17 用户定)。
    /// above = 0(没有锚点)才退回老办法:popUpMenu+1 压在一切之上。
    func perform(_ cue: Cue, at point: CGPoint, above windowId: UInt32, layer: Int? = nil, target: UInt32 = 0, reduceMotion: Bool = false, now explicitNow: Double? = nil) {
        let now = explicitNow ?? clock()
        teardownGeneration &+= 1
        teardownTask?.cancel()
        teardownTask = nil

        let window = ensureWindow()
        // Tangu 补丁:覆盖层必须横跨**所有**屏幕,并且每次都重新对齐 —— 显示器可能中途插拔/改摆位。
        // 上游只开主屏那么大(见 ensureWindow),于是副屏上的点击把光标画到了覆盖层之外 = 用户看不见,
        // 报上来就是"辅助鼠标还是没有出现"。渲染器吃的是画布局部坐标,所以点也要跟着换算。
        let bounds = Self.overlayBounds()
        if window.frame != bounds.union { window.setFrame(bounds.union, display: false) }
        anchorId = windowId
        targetId = target != 0 ? target : windowId
        if windowId != 0 {
            pinOverlay(window, above: windowId, layer: layer)
            startRepinning()
        } else {
            stopRepinning()
            window.level = AgentCursorOverlayWindow.unanchoredLevel
            if !window.isVisible { window.orderFrontRegardless() }
        }

        func local(_ p: CGPoint) -> CGPoint {
            OverlayGeometry.canvasPoint(p, union: bounds.union, primaryHeight: bounds.primaryHeight)
        }
        func localRect(_ r: CGRect) -> CGRect { CGRect(origin: local(r.origin), size: r.size) }
        let tip = local(point)
        let canvas = CGRect(origin: .zero, size: bounds.union.size)

        renderer.update(now: now) { scene in
            scene.reduceMotion = reduceMotion
            switch cue {
            case .ringOnly(let count):
                scene.click(at: tip, count: count, time: now, withCursor: false)
                return
            case .fieldOnly(let rect):
                scene.field(localRect(rect), at: now)
                return
            default:
                break
            }
            if !scene.placed || (scene.presence.to == 0 && scene.presence.value(at: now) <= 0.001) {
                // 第一次出现:从落点左上 140pt 飞进来(和以前一样);减少动态时直接在目的地淡入。
                let start = reduceMotion ? tip : CGPoint(
                    x: min(max(tip.x - 140, canvas.minX + 2), canvas.maxX - 2),
                    y: min(max(tip.y - 140, canvas.minY + 2), canvas.maxY - 2)
                )
                scene.place(CursorPose.resting(atTip: start))
            }
            scene.show(at: now)
            switch cue {
            case .click(let count):
                let arrival = scene.fly(toTip: tip, at: now)
                scene.click(at: tip, count: count, time: arrival, withCursor: true)
            case .move:
                scene.fly(toTip: tip, at: now)
            case .scroll(let dx, let dy):
                let arrival = scene.fly(toTip: tip, at: now)
                scene.scroll(at: tip, dx: dx, dy: dy, time: arrival)
            case .drag(let points):
                scene.drag(tips: points.map(local), at: now)
            case .field(let rect):
                let box = localRect(rect)
                scene.fly(toTip: CGPoint(x: box.minX, y: box.midY), at: now)
                scene.field(box, at: now)
            case .ringOnly, .fieldOnly:
                break
            }
        }

        if cue.drawsCursor {
            rescheduleIdle()
        } else if renderer.scene.presence.to == 0 {
            // 只画了环 / 描边、没有光标:放完就收窗口。
            scheduleTeardownWhenBlank(now: now)
        }
    }

    /// 在想:光标缩到 0.85、淡到 0.6、轻摆;动手时恢复。
    func setThinking(_ on: Bool, now explicitNow: Double? = nil) {
        let now = explicitNow ?? clock()
        guard overlay != nil else { return }
        renderer.update(now: now) { $0.setThinking(on, at: now) }
    }

    /// 淡出(0.4 s)后收窗口、停重绘。
    func fadeOut(now explicitNow: Double? = nil) {
        let now = explicitNow ?? clock()
        cancelIdle()
        guard overlay != nil else { return }
        renderer.update(now: now) { $0.hide(at: now) }
        scheduleTeardownWhenBlank(now: now)
    }

    /// 立刻收(「操作可视化」关了)。
    func hideNow() {
        teardown()
    }

    private func cancelIdle() {
        idleGeneration &+= 1
        idleTask?.cancel()
        idleTask = nil
    }

    private func rescheduleIdle() {
        cancelIdle()
        if holdForTurn && anchorId != 0 { return }
        let generation = idleGeneration
        idleTask = schedule(Self.idleHideSeconds) { [weak self] in
            guard let self, generation == self.idleGeneration, self.overlay != nil else { return }
            self.idleTask = nil
            self.fadeOut()
        }
    }

    private func scheduleTeardownWhenBlank(now: Double) {
        teardownGeneration &+= 1
        teardownTask?.cancel()
        let generation = teardownGeneration
        let delay = max(0, renderer.scene.transientEnd() - now) + 0.05
        teardownTask = schedule(delay) { [weak self] in
            guard let self, generation == self.teardownGeneration, self.overlay != nil else { return }
            self.teardownTask = nil
            let current = self.clock()
            // 光标又被叫出来了(presence 往 1 走)就不收;还有效果没放完就再等一轮。
            guard self.renderer.scene.presence.to == 0 else { return }
            if self.renderer.scene.isBlank(at: current) {
                self.teardown()
            } else {
                self.scheduleTeardownWhenBlank(now: current)
            }
        }
    }

    private func teardown() {
        cancelIdle()
        teardownGeneration &+= 1
        teardownTask?.cancel()
        teardownTask = nil
        renderer.reset()
        stopRepinning()
        guard let window = overlay else { return }
        window.orderOut(nil)
        window.contentView = nil
        window.close()
        overlay = nil
    }

    /// 光标停留期间(旧调用方 8 秒;整轮模式到这一轮结束)每 250ms 重钉一次(Codex 评审):目标被用户切到前台会压过光标;钉着的下拉 / 菜单关了,
    /// 光标还在 101 层就会盖住用户的前台窗口 —— 那时退回钉在目标上,目标也不在屏上了就先收起来。
    private func startRepinning() {
        guard repinTimer == nil else { return }
        let timer = Timer(timeInterval: 0.25, repeats: true) { _ in
            Task { @MainActor in AgentCursor.shared.repinTick() }
        }
        RunLoop.main.add(timer, forMode: .common)
        repinTimer = timer
    }

    private func stopRepinning() {
        repinTimer?.invalidate()
        repinTimer = nil
    }

    private func repinTick() {
        guard let window = overlay, anchorId != 0 else { return stopRepinning() }
        if cgWindowBounds(windowId: anchorId) == nil, anchorId != targetId { anchorId = targetId }
        if cgWindowBounds(windowId: anchorId) != nil {
            pinOverlay(window, above: anchorId)
        } else if window.isVisible {
            window.orderOut(nil)
        }
    }

    private static func scheduleDefault(_ delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(delay))
            guard !Task.isCancelled else { return }
            action()
        }
    }

    /// 所有屏幕的并集 + 主屏高度(全局 CG 坐标换算要用)。没有屏幕时退化成零矩形。
    static func overlayBounds() -> (union: CGRect, primaryHeight: CGFloat) {
        let frames = NSScreen.screens.map(\.frame)
        let union = OverlayGeometry.union(of: frames)
        // ⚠️主屏 = frame 原点在 (0,0) 的那块(全局 CG 坐标的原点就定在它的左上角),**不是** NSScreen.main
        // (那是"当前有 key window 的那块",会跟着焦点跑)、也不保证是 screens.first。
        let primary = NSScreen.screens.first { $0.frame.origin == .zero } ?? NSScreen.screens.first
        return (union.isNull ? .zero : union, primary?.frame.height ?? union.height)
    }

    private func ensureWindow() -> AgentCursorOverlayWindow {
        if let overlay { return overlay }
        let window = AgentCursorOverlayWindow(
            contentRect: Self.overlayBounds().union,
            styleMask: .borderless,
            backing: .buffered,
            defer: false
        )
        window.contentView = NSHostingView(rootView: AgentCursorView(renderer: renderer))
        overlay = window
        return window
    }
}

/// Click-through overlay spanning every display; can never take focus.
private final class AgentCursorOverlayWindow: NSWindow {
    /// 没有锚点窗口时:比目标 App 自己弹的菜单(.popUpMenu=101)高一档。
    /// ⚠️别调到 .screenSaver(1000):那会连屏保、系统警告一起盖住,而光标最长要停留 8 秒。
    static let unanchoredLevel = NSWindow.Level(rawValue: NSWindow.Level.popUpMenu.rawValue + 1)

    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }

    override init(contentRect: NSRect, styleMask: NSWindow.StyleMask, backing: NSWindow.BackingStoreType, defer flag: Bool) {
        super.init(contentRect: contentRect, styleMask: styleMask, backing: backing, defer: flag)
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        // 有锚点时 level 由 pinOverlay 按接住事件的那扇窗口现定;这里只是没锚点时的缺省。
        level = Self.unanchoredLevel
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
    }
}

/// 光标画布的状态(主线程)。只存场景和配色;位置等一切都按时刻现算,重绘只是取样。
/// isAnimating:还有没放完的过渡(或在想时的轻摆)才让 TimelineView 跑,放完就停 —— 结束后不留常驻重绘。
@Observable
@MainActor
final class AgentCursorRenderer {
    static let shared = AgentCursorRenderer()

    private(set) var scene = CursorScene()
    var palette = OverlayPalette.standard
    private(set) var isAnimating = false
    /// 过渡期间 120fps;只剩在想时的轻摆就压到 30fps。
    private(set) var frameInterval: Double = 1.0 / 120.0

    @ObservationIgnored private var settleTask: Task<Void, Never>?
    @ObservationIgnored private var settleGeneration: UInt = 0

    init() {}

    func update(now: Double = OverlayClock.now(), _ change: (inout CursorScene) -> Void) {
        var next = scene
        change(&next)
        next.prune(at: now)
        scene = next
        refresh(now: now)
    }

    /// 重新算要不要继续重绘;过渡放完的那一刻再来一次(由计时器,不靠重绘回调)。
    func refresh(now: Double = OverlayClock.now()) {
        let end = scene.transientEnd()
        let transient = end > now
        let animating = transient || scene.wobbles
        if isAnimating != animating { isAnimating = animating }
        let interval = transient ? 1.0 / 120.0 : 1.0 / 30.0
        if frameInterval != interval { frameInterval = interval }
        settleGeneration &+= 1
        settleTask?.cancel()
        settleTask = nil
        guard transient else { return }
        let generation = settleGeneration
        settleTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(end - now + 0.02))
            guard !Task.isCancelled, let self, generation == self.settleGeneration else { return }
            self.refresh()
        }
    }

    func reset() {
        settleGeneration &+= 1
        settleTask?.cancel()
        settleTask = nil
        scene = CursorScene()
        isAnimating = false
    }
}

@MainActor
private struct AgentCursorView: View {
    let renderer: AgentCursorRenderer

    var body: some View {
        let scene = renderer.scene
        let palette = renderer.palette
        TimelineView(.animation(minimumInterval: renderer.frameInterval, paused: !renderer.isAnimating)) { _ in
            Canvas { graphics, _ in
                graphics.withCGContext { ctx in
                    OverlayPaint.drawCursorScene(ctx, scene: scene, palette: palette, at: OverlayClock.now())
                }
            }
            .ignoresSafeArea()
            .allowsHitTesting(false)
        }
    }
}
