import CoreGraphics
import Foundation
import ImageIO

/// 叠层画法的离屏测试(`npm run check:cursor`,Tangu,协议 20)。
///
/// 不连 helper、不建窗口、不要任何系统授权:只编 agent_overlay_model / agent_overlay_paint / agent_cursor_motion
/// 三个纯文件,在固定时刻把光标、点击环、拖动线、滚动箭头、输入框描边、边缘光画进 CGBitmapContext,
/// 三种配色 × 浅 / 深两种底各出一张 PNG(外加放大的光标),再对几处像素断言颜色。
///
/// 用法:test-binary --out <目录> --fixtures <scripts/fixtures 目录>
@main
struct AgentOverlayRenderTests {
    static var failures = 0

    static func main() {
        let args = CommandLine.arguments
        func value(_ flag: String) -> String? {
            args.firstIndex(of: flag).flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil }
        }
        testPalette()
        if let fixtures = value("--fixtures") { testFixtures(URL(fileURLWithPath: fixtures)) }
        testFlight()
        testTurnModel()
        testScene()
        let out = URL(fileURLWithPath: value("--out") ?? NSTemporaryDirectory()).appendingPathComponent("", isDirectory: true)
        try? FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
        renderGallery(into: out)
        if failures > 0 {
            FileHandle.standardError.write(Data("\(failures) overlay render check(s) failed\n".utf8))
            exit(1)
        }
        print("overlay paint: palette / flight / turn / scene / pixel checks passed; PNGs in \(out.path)")
    }

    // MARK: - 断言

    static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else {
            failures += 1
            FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
            return
        }
    }

    static func near(_ a: Double, _ b: Double, _ tolerance: Double = 1e-6) -> Bool { abs(a - b) <= tolerance }

    // MARK: - 配色

    static let palettes: [(name: String, hex: String)] = [("softblue", "#2c5f9e"), ("terracotta", "#b36c46"), ("nearwhite", "#f8f7f6")]

    static func testPalette() {
        let blue = OverlayRGB(hex: "#2c5f9e")!, terracotta = OverlayRGB(hex: "#b36c46")!, nearWhite = OverlayRGB(hex: "#f8f7f6")!
        expect(blue.relativeLuminance < 0.15, "柔蓝的相对亮度应在 0.11 左右,实际 \(blue.relativeLuminance)")
        expect(terracotta.relativeLuminance > 0.15 && terracotta.relativeLuminance < 0.28, "陶土按 WCAG 线性化后应在 0.21 左右(不是加权平均的 0.47),实际 \(terracotta.relativeLuminance)")
        expect(nearWhite.relativeLuminance > 0.85, "近白的相对亮度应在 0.93 左右,实际 \(nearWhite.relativeLuminance)")
        expect(OverlayPalette(fill: blue).edge == .white, "柔蓝配白边")
        expect(OverlayPalette(fill: terracotta).edge == .white, "陶土配白边")
        expect(OverlayPalette(fill: nearWhite).edge == OverlayRGB(hex: "#1c1b1f")!, "近白配深边 #1c1b1f")
        expect(OverlayPalette.standard.fill.hex == "#2c5f9e", "缺省填色是柔蓝,不是橙色")
        expect(OverlayRGB(hex: "#2C5F9E") == blue, "十六进制大小写都认")
        for bad in ["2c5f9e", "#2c5f9", "#2c5f9e80", "rgb(1,2,3)", "#zzzzzz", ""] {
            expect(OverlayRGB(hex: bad) == nil, "不合法的颜色 \(bad) 要读不出")
        }
        expect(OverlayPalette.parse(["fill": "#b36c46", "edge": "#000000"]) == OverlayPalette(fill: terracotta, edge: .black), "给了 edge 就用给的")
        expect(OverlayPalette.parse(["fill": "#b36c46", "edge": "nope"]) == OverlayPalette(fill: terracotta), "edge 读不出按亮度自己取")
        expect(OverlayPalette.parse(["fill": "orange"]) == nil, "fill 读不出整个不认(调用方用缺省)")
        expect(OverlayPalette.parse(nil) == nil, "没有 overlayStyle")
    }

    static func testFixtures(_ dir: URL) {
        guard let data = try? Data(contentsOf: dir.appendingPathComponent("routes.v1.json")),
            let routes = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let extras = routes["helperActExtras"] as? [String: Any],
            let turn = routes["helperOverlayTurn"] as? [String: Any]
        else {
            expect(false, "读不到 scripts/fixtures/routes.v1.json 的 helperActExtras / helperOverlayTurn")
            return
        }
        let options = OverlayActOptions.parse(extras)
        expect(options.palette == OverlayPalette(fill: .softBlue, edge: .white), "样例 overlayStyle → 柔蓝 + 白边")
        expect(options.runId == extras["runId"] as? String, "样例 runId 原样读进来")
        expect(options.reduceMotion == false && options.clickAfterArrival == true && options.enabled, "样例的 reduceMotion / clickAfterArrival / 缺省开关")
        expect(Set(extras.keys).isSubset(of: Set(OverlayActOptions.keys)), "样例 act 新增字段都在 OverlayActOptions.keys 里(actBatch 顶层回落靠它)")
        // actBatch:每一步自己的优先,没有再用顶层的。
        let merged = OverlayActOptions.parse(["cursorOverlay": true], fallback: extras)
        expect(merged.runId == options.runId && merged.palette == options.palette, "actBatch 顶层字段回落到每一步")
        let own = OverlayActOptions.parse(["runId": "run_step"], fallback: extras)
        expect(own.runId == "run_step", "每一步自己的 runId 优先")
        let legacy = OverlayActOptions.parse(["cursorOverlay": false])
        expect(legacy.runId == nil && legacy.palette == .standard && !legacy.enabled && legacy.clickAfterArrival, "旧请求:无 runId、柔蓝、开关照读")

        expect(turn["cmd"] as? String == "overlayTurn", "样例命令名")
        expect(OverlayTurnCommand.parse(turn) == OverlayTurnCommand(runId: turn["runId"] as? String), "样例 overlayTurn 解析")
        expect(OverlayTurnCommand.parse(["phase": "end"]) == OverlayTurnCommand(runId: nil), "不带 runId 的 end 也收")
        expect(OverlayTurnCommand.parse(["phase": "start", "runId": "x"]) == nil, "只收 end")
        expect(OverlayTurnCommand.parse(["phase": "end", "runId": 7]) == nil, "runId 不是字符串就不认")
    }

    // MARK: - 飞行

    static func testFlight() {
        expect(CursorFlight.duration(distance: 0) == 0, "原地不飞")
        expect(CursorFlight.duration(distance: 5.9) == 0, "不到 6pt 不飞")
        expect(near(CursorFlight.duration(distance: 100), 0.18), "近处夹到 0.18 s")
        expect(near(CursorFlight.duration(distance: 330), 0.3), "330pt = 0.3 s(1100 pt/s)")
        expect(near(CursorFlight.duration(distance: 2000), 0.45), "远处夹到 0.45 s")

        let from = CursorPose(point: CGPoint(x: 100, y: 100), heading: CursorPose.restHeading)
        let to = CursorPose.resting(atTip: CGPoint(x: 600, y: 420))
        let flight = CursorFlight(from: from, to: to, start: 10)
        expect(flight.pose(at: 9) == from, "起飞前在起点")
        expect(flight.pose(at: flight.arrival) == to, "到达时刻正好在终点")
        expect(flight.pose(at: flight.arrival + 5) == to, "到了以后不再动")
        // 纯函数:同一时刻取几次、先取后面再取前面,结果都一样(不靠重绘推进)。
        let mid = flight.arrival - flight.duration / 2
        let a = flight.pose(at: mid), b = flight.pose(at: flight.arrival - 0.01), c = flight.pose(at: mid)
        expect(a == c && a != b, "飞行位置是时间的纯函数")
        expect(hypot(a.point.x - from.point.x, a.point.y - from.point.y) > 20, "半程时已经离开起点")

        var scene = CursorScene()
        scene.place(from)
        scene.show(at: 10)
        let arrival = scene.fly(toTip: CGPoint(x: 600, y: 420), at: 10)
        expect(near(arrival, 10 + CursorFlight.duration(distance: Double(hypot(to.point.x - from.point.x, to.point.y - from.point.y)))), "fly 返回的到达时刻 = 起飞 + 按距离算的时长")
        let tip = OverlayPaint.cursorTipPoint(scene.cursorFrame(at: arrival + 1))
        expect(hypot(tip.x - 600, tip.y - 420) < 2, "停稳后箭尖对着落点(偏差 \(hypot(tip.x - 600, tip.y - 420))pt)")
        // 中途改目标:从当前位置接着飞,不跳。
        let before = scene.pose(at: 10.1)
        scene.fly(toTip: CGPoint(x: 200, y: 600), at: 10.1)
        expect(scene.pose(at: 10.1) == before, "中途改目标从当前位置起飞")

        var reduced = CursorScene()
        reduced.reduceMotion = true
        reduced.place(CursorPose.resting(atTip: CGPoint(x: 300, y: 300)))
        reduced.show(at: 20)
        let instant = reduced.fly(toTip: CGPoint(x: 700, y: 300), at: 20.5)
        expect(instant == 20.5 && reduced.pose(at: 20.5) == CursorPose.resting(atTip: CGPoint(x: 700, y: 300)), "减少动态:不飞,直接到位")
        expect(reduced.presence.value(at: 20.5) == 0 && near(reduced.presence.value(at: 20.7), 1), "减少动态:在目的地重新淡入")
        let f = reduced.cursorFrame(at: 21)
        expect(f.scale == 1 && f.blur == 0 && f.wobble == 0, "减少动态:不缩、不糊、不摆")
    }

    // MARK: - 整轮状态机

    static func testTurnModel() {
        var m = OverlayTurnModel()
        expect(m.phase(at: 0) == .idle && m.nextDeadline(after: 0) == nil, "开始时什么都没有")
        expect(m.actStarted(runId: nil, at: 1) == false, "旧调用方(无 runId)不开整轮")
        m.actEnded(at: 1.1)
        expect(m.phase(at: 2) == .idle, "旧调用方之后仍是 idle(按旧时长走)")

        expect(m.actStarted(runId: "A", at: 10), "带 runId 开一轮")
        expect(m.phase(at: 10.2) == .acting, "动作进行中")
        m.actEnded(at: 10.5)
        expect(m.phase(at: 10.79) == .acting, "动作结束 0.3 s 内仍算动手")
        expect(m.phase(at: 10.81) == .thinking, "动作结束 0.3 s 后进入在想")
        expect(near(m.nextDeadline(after: 10.5) ?? 0, 10.8, 1e-9), "下一个醒来时刻 = 转入在想")
        expect(m.requestEnd(runId: nil, at: 11) == false, "没给 runId 而这一轮有 runId:不做事")
        expect(m.requestEnd(runId: "B", at: 11) == false, "runId 对不上:不做事")
        expect(m.phase(at: 11) == .thinking, "被拒的 end 不影响这一轮")
        expect(m.requestEnd(runId: "A", at: 12), "对上的 end")
        expect(m.phase(at: 12.5) == .ending(fadeAt: 13), "结束后等 1.0 s 再淡出")
        expect(m.phase(at: 13.2) == .ending(fadeAt: 13), "淡出 0.4 s 期间")
        expect(m.phase(at: 13.41) == .idle, "淡出完归零")
        m.settle(at: 13.41)
        expect(!m.active && m.nextDeadline(after: 13.41) == nil, "一轮放完之后没有任何要等的(不留计时器)")

        // 45 s 自身超时。
        var t = OverlayTurnModel()
        t.actStarted(runId: "C", at: 100)
        t.actEnded(at: 100.2)
        expect(t.phase(at: 145.1) == .thinking, "45 s 内一直在想")
        expect(isEnding(t.phase(at: 145.2), 146.2), "45 s 没有 act:自己结束")
        t.advance(to: 145.3)
        expect(t.actStarted(runId: nil, at: 145.4) == false, "超时之后旧调用方的动作不把这一轮续上")
        t.actEnded(at: 145.5)
        expect(isEnding(t.phase(at: 146.0), 146.2), "超时结束时刻钉住")
        // 动作进行中不超时。
        var busy = OverlayTurnModel()
        busy.actStarted(runId: "D", at: 0)
        expect(busy.phase(at: 100) == .acting && busy.effectiveEnd == nil, "动作没做完不算空闲")
        // runId 变了就换一轮。
        busy.actEnded(at: 1)
        busy.requestEnd(runId: "D", at: 2)
        expect(busy.actStarted(runId: "E", at: 2.5), "新 runId 开新的一轮")
        expect(busy.runId == "E" && busy.phase(at: 2.6) == .acting, "结束中的旧一轮被新一轮接替")
    }

    static func isEnding(_ phase: OverlayTurnModel.Phase, _ fadeAt: Double) -> Bool {
        if case .ending(let at) = phase { return near(at, fadeAt, 1e-9) }
        return false
    }

    // MARK: - 场景

    static func testScene() {
        var s = CursorScene()
        s.place(CursorPose.resting(atTip: CGPoint(x: 50, y: 50)))
        s.show(at: 0)
        let arrival = s.fly(toTip: CGPoint(x: 400, y: 300), at: 0)
        s.click(at: CGPoint(x: 400, y: 300), count: 2, time: arrival, withCursor: true)
        expect(s.rings.count == 2 && near(s.rings[1].start - s.rings[0].start, 0.15), "双击两圈环,隔 0.15 s")
        expect(near(s.transientEnd(), arrival + 0.15 + 0.5), "过渡结束 = 第二圈环放完")
        expect(s.cursorFrame(at: 0.05).scale < 0.8 && s.cursorFrame(at: 0.05).blur > 2, "出现:从 0.7 放大、带一点模糊")
        expect(near(s.cursorFrame(at: 5).scale, 1) && near(s.cursorFrame(at: 5).opacity, 1), "停稳后原大、不透明")
        let pressed = s.cursorFrame(at: arrival + 0.1)
        expect(pressed.scale < 0.9, "点下去缩到约 0.86(\(pressed.scale))")
        let ring0 = s.rings[0].frame(at: s.rings[0].start)!, ringEnd = s.rings[0].frame(at: s.rings[0].end - 0.001)!
        expect(near(ring0.diameter, 12) && near(ring0.opacity, 0.95), "环从直径 12、0.95 开始")
        expect(ringEnd.diameter > 59.9 && ringEnd.opacity < 0.01, "环放大到 60 并淡完")
        expect(near(s.rings[0].frame(at: s.rings[0].start + 0.18)!.opacity, 0.7), "36% 处不透明度 0.7")
        expect(!s.wobbles, "动手时不摆")
        s.setThinking(true, at: 5)
        expect(s.wobbles, "在想时轻摆")
        let thinking = s.cursorFrame(at: 6.0) // 6.0 / 1.6 = 3.75 圈 → sin = -1
        expect(near(thinking.scale, 0.85, 1e-3) && near(thinking.opacity, 0.6, 1e-3), "在想:缩到 0.85、淡到 0.6")
        expect(near(abs(thinking.wobble), 7 * .pi / 180, 1e-3), "在想:摆幅 ±7°")
        s.hide(at: 10)
        expect(!s.wobbles, "淡出时不再摆")
        expect(s.cursorFrame(at: 10.2).scale < 0.85 * 0.95, "消失:缩向 0.82")
        expect(s.isBlank(at: 10.41) && s.transientEnd() <= 10.41, "淡出 0.4 s 后什么都不剩、没有要等的过渡")

        var reduced = CursorScene()
        reduced.reduceMotion = true
        reduced.click(at: .zero, count: 1, time: 0, withCursor: false)
        let r = reduced.rings[0]
        expect(r.frame(at: 0)!.diameter == 48 && r.frame(at: 0.45)!.diameter == 48, "减少动态:环固定直径 48,只淡出")
        expect(reduced.isBlank(at: 0.51), "只画环(抢前台的点击)时,环放完就空")

        var drag = CursorScene()
        drag.place(CursorPose.resting(atTip: CGPoint(x: 0, y: 0)))
        drag.show(at: 0)
        let release = drag.drag(tips: [CGPoint(x: 100, y: 100), CGPoint(x: 300, y: 100), CGPoint(x: 300, y: 250)], at: 0)
        let landed = drag.segments.first!.end
        expect(release > landed, "拖动:先飞到起点,再沿路径走")
        expect(drag.cursorFrame(at: (landed + release) / 2).scale < 0.9, "拖动途中保持按住(0.88)")
        expect(drag.rings.last!.start == release, "松手一圈环")
        expect(near(drag.trails[0].end, release + 0.4), "松手后线 0.4 s 淡掉")
        let tipEnd = OverlayPaint.cursorTipPoint(drag.cursorFrame(at: release + 1))
        expect(hypot(tipEnd.x - 300, tipEnd.y - 250) < 2, "拖完箭尖停在终点")

        var highlight = HighlightScene()
        highlight.level.set(1, at: 0, duration: 0.2)
        expect(near(highlight.opacity(at: 0.2), 1), "边缘光亮起 0.2 s")
        highlight.level.set(0.45, at: 1, duration: 0.4)
        expect(near(highlight.opacity(at: 1.4), 0.45), "在想 0.45")
        highlight.level.set(0.45, at: 1.2, duration: 0.4)
        expect(highlight.level.end == 1.4, "重复设同一档不拉长过渡")
    }

    // MARK: - 出图

    struct Canvas {
        let ctx: CGContext
        let scale: CGFloat
        let width: Int
        let height: Int

        init(size: CGSize, scale: CGFloat, background: OverlayRGB) {
            self.scale = scale
            width = Int(size.width * scale)
            height = Int(size.height * scale)
            ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
            ctx.setFillColor(OverlayPaint.color(background, 1))
            ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
            // 翻成和屏上 Canvas 一样的画布坐标:左上原点、y 向下、单位 pt。
            ctx.translateBy(x: 0, y: CGFloat(height))
            ctx.scaleBy(x: scale, y: -scale)
        }

        /// 画布坐标(pt)处的像素。
        func pixel(_ p: CGPoint) -> OverlayRGB {
            let x = min(width - 1, max(0, Int((p.x * scale).rounded(.down))))
            let y = min(height - 1, max(0, Int((p.y * scale).rounded(.down))))
            let base = ctx.data!.assumingMemoryBound(to: UInt8.self) + (y * ctx.bytesPerRow + x * 4)
            return OverlayRGB(r: Double(base[0]) / 255, g: Double(base[1]) / 255, b: Double(base[2]) / 255)
        }

        func write(_ url: URL) {
            guard let image = ctx.makeImage(), let dest = CGImageDestinationCreateWithURL(url as CFURL, "public.png" as CFString, 1, nil) else {
                AgentOverlayRenderTests.expect(false, "写不出 \(url.path)")
                return
            }
            CGImageDestinationAddImage(dest, image, nil)
            if !CGImageDestinationFinalize(dest) { AgentOverlayRenderTests.expect(false, "写不出 \(url.path)") }
        }
    }

    static func distance(_ a: OverlayRGB, _ b: OverlayRGB) -> Double {
        max(abs(a.r - b.r), abs(a.g - b.g), abs(a.b - b.b)) * 255
    }

    /// 测像素:形状坐标里的一点 → 画布坐标。
    static func shapePoint(_ p: CGPoint, _ frame: CursorFrame) -> CGPoint { p.applying(OverlayPaint.cursorTransform(frame)) }

    static func renderGallery(into out: URL) {
        let backgrounds: [(name: String, color: OverlayRGB, window: OverlayRGB)] = [
            ("light", OverlayRGB(hex: "#e9e8e4")!, OverlayRGB(hex: "#ffffff")!),
            ("dark", OverlayRGB(hex: "#141417")!, OverlayRGB(hex: "#26262b")!),
        ]
        for (paletteName, hex) in palettes {
            let palette = OverlayPalette(fill: OverlayRGB(hex: hex)!)
            for bg in backgrounds {
                let canvas = Canvas(size: CGSize(width: 760, height: 440), scale: 2, background: bg.color)
                let ctx = canvas.ctx
                // 一扇「被操控的窗口」+ 动手时的边缘光。
                let window = CGRect(x: 40, y: 40, width: 420, height: 300)
                ctx.setFillColor(OverlayPaint.color(bg.window, 1))
                ctx.addPath(OverlayPaint.roundedRect(window, radius: 12))
                ctx.fillPath()
                let pad: CGFloat = 12
                ctx.saveGState()
                ctx.translateBy(x: window.minX - pad, y: window.minY - pad)
                OverlayPaint.drawHighlight(ctx, size: CGSize(width: window.width + pad * 2, height: window.height + pad * 2), inset: pad, palette: palette, opacity: 1)
                ctx.restoreGState()
                // 「在想」那一档的边缘光(右下的小窗)。
                let quiet = CGRect(x: 520, y: 260, width: 200, height: 140)
                ctx.setFillColor(OverlayPaint.color(bg.window, 1))
                ctx.addPath(OverlayPaint.roundedRect(quiet, radius: 12))
                ctx.fillPath()
                ctx.saveGState()
                ctx.translateBy(x: quiet.minX - pad, y: quiet.minY - pad)
                OverlayPaint.drawHighlight(ctx, size: CGSize(width: quiet.width + pad * 2, height: quiet.height + pad * 2), inset: pad, palette: palette, opacity: HighlightScene.thinkingLevel)
                ctx.restoreGState()

                // 1. 停稳的光标(动手)。
                var resting = CursorScene()
                resting.place(CursorPose.resting(atTip: CGPoint(x: 80, y: 80)))
                resting.show(at: 0)
                resting.fly(toTip: CGPoint(x: 140, y: 110), at: 0)
                let restFrame = resting.cursorFrame(at: 2)
                OverlayPaint.drawCursorScene(ctx, scene: resting, palette: palette, at: 2)

                // 2. 单击:环正放到 36%,光标刚点完。
                var clicked = CursorScene()
                clicked.place(CursorPose.resting(atTip: CGPoint(x: 260, y: 110)))
                clicked.show(at: 0)
                clicked.click(at: CGPoint(x: 260, y: 110), count: 1, time: 1, withCursor: true)
                OverlayPaint.drawCursorScene(ctx, scene: clicked, palette: palette, at: 1.18)
                let ringFrame = clicked.rings[0].frame(at: 1.18)!

                // 3. 双击:两圈。
                var double = CursorScene()
                double.place(CursorPose.resting(atTip: CGPoint(x: 380, y: 110)))
                double.show(at: 0)
                double.click(at: CGPoint(x: 380, y: 110), count: 2, time: 1, withCursor: true)
                OverlayPaint.drawCursorScene(ctx, scene: double, palette: palette, at: 1.3)

                // 4. 打字:光标停在输入框前缘中线 + 描边。
                let field = CGRect(x: 90, y: 180, width: 220, height: 30)
                ctx.setFillColor(OverlayPaint.color(bg.color, 1))
                ctx.addPath(OverlayPaint.roundedRect(field, radius: 6))
                ctx.fillPath()
                var typing = CursorScene()
                typing.place(CursorPose.resting(atTip: CGPoint(x: field.minX, y: field.midY)))
                typing.show(at: 0)
                typing.field(field, at: 1)
                OverlayPaint.drawCursorScene(ctx, scene: typing, palette: palette, at: 1.5)

                // 5. 滚动:光标旁两个小箭头。
                var scrolling = CursorScene()
                scrolling.place(CursorPose.resting(atTip: CGPoint(x: 380, y: 190)))
                scrolling.show(at: 0)
                scrolling.scroll(at: CGPoint(x: 380, y: 190), dx: 0, dy: 3, time: 1)
                OverlayPaint.drawCursorScene(ctx, scene: scrolling, palette: palette, at: 1.22)

                // 6. 拖动途中:按住 + 身后的线。
                var dragging = CursorScene()
                dragging.place(CursorPose.resting(atTip: CGPoint(x: 90, y: 260)))
                dragging.show(at: 0)
                let release = dragging.drag(tips: [CGPoint(x: 90, y: 260), CGPoint(x: 260, y: 300), CGPoint(x: 400, y: 260)], at: 1)
                OverlayPaint.drawCursorScene(ctx, scene: dragging, palette: palette, at: 1 + (release - 1) * 0.7)

                // 7. 在想:缩小变淡、轻摆(在「在想」那扇小窗上)。
                var thinking = CursorScene()
                thinking.place(CursorPose.resting(atTip: CGPoint(x: 600, y: 320)))
                thinking.show(at: 0)
                thinking.setThinking(true, at: 1)
                OverlayPaint.drawCursorScene(ctx, scene: thinking, palette: palette, at: 2.0)

                // 8. 抢前台的点击:只有环、没有光标(右上)。
                var hid = CursorScene()
                hid.click(at: CGPoint(x: 620, y: 110), count: 1, time: 1, withCursor: false)
                OverlayPaint.drawCursorScene(ctx, scene: hid, palette: palette, at: 1.12)

                // 像素断言(画完一起看,避免后画的东西盖住)。
                let tag = "\(paletteName)/\(bg.name)"
                let body = canvas.pixel(shapePoint(CGPoint(x: 3, y: 0), restFrame))
                expect(distance(body, palette.fill) <= 8, "\(tag): 光标本体中段应是填色 \(palette.fill.hex),实际 \(body.hex)")
                let outward = CGPoint(x: 0.379, y: -0.926)
                let edgeProbe = shapePoint(CGPoint(x: 3 + outward.x * 0.5, y: -4.5 + outward.y * 0.5), restFrame)
                let edge = canvas.pixel(edgeProbe)
                expect(distance(edge, palette.edge) <= 24, "\(tag): 光标描边应是对比色 \(palette.edge.hex),实际 \(edge.hex)")
                let ringPixel = canvas.pixel(CGPoint(x: ringFrame.center.x + CGFloat(ringFrame.diameter / 2), y: ringFrame.center.y))
                let ringExpected = bg.window.mixed(with: palette.fill, ringFrame.opacity)
                expect(distance(ringPixel, ringExpected) <= 16, "\(tag): 点击环应是填色 × \(ringFrame.opacity) 叠在底色上(\(ringExpected.hex)),实际 \(ringPixel.hex)")
                let glow = canvas.pixel(CGPoint(x: window.minX + 0.8, y: window.midY))
                let glowExpected = bg.window.mixed(with: palette.fill, 0.85)
                expect(distance(glow, glowExpected) <= 16, "\(tag): 边缘光实线应是填色 0.85(\(glowExpected.hex)),实际 \(glow.hex)")
                let dim = canvas.pixel(CGPoint(x: quiet.minX + 0.8, y: quiet.midY))
                let dimExpected = bg.window.mixed(with: palette.fill, 0.85 * 0.45)
                expect(distance(dim, dimExpected) <= 16, "\(tag): 在想时边缘光 0.45(\(dimExpected.hex)),实际 \(dim.hex)")
                let hidCenter = canvas.pixel(CGPoint(x: 620 + 6, y: 110 + 6))
                expect(distance(hidCenter, bg.color) <= 2, "\(tag): 抢前台的点击不画光标(落点右下应是底色)")

                canvas.write(out.appendingPathComponent("overlay-\(paletteName)-\(bg.name).png"))

                // 放大的光标(看描边、柔光、投影)。
                let zoom = Canvas(size: CGSize(width: 120, height: 80), scale: 6, background: bg.window)
                var big = CursorScene()
                big.place(CursorPose.resting(atTip: CGPoint(x: 30, y: 24)))
                big.show(at: 0)
                OverlayPaint.drawCursorScene(zoom.ctx, scene: big, palette: palette, at: 1)
                var bigThinking = CursorScene()
                bigThinking.place(CursorPose.resting(atTip: CGPoint(x: 82, y: 24)))
                bigThinking.show(at: 0)
                bigThinking.setThinking(true, at: 0)
                OverlayPaint.drawCursorScene(zoom.ctx, scene: bigThinking, palette: palette, at: 1.0) // 1.0/1.6 → 摆到 +7°
                zoom.write(out.appendingPathComponent("cursor-zoom-\(paletteName)-\(bg.name).png"))
            }
        }
    }
}
