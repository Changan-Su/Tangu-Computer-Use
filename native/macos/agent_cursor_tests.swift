import AppKit
import CoreGraphics
import Foundation
import SwiftUI

/// 示意光标的生命周期(`npm run check:cursor` 跑它;以前这份测试没接进任何脚本)。
/// 画法和整轮状态机是纯函数,在 agent_overlay_render_tests 里测;这里只管窗口和计时器:
/// 淡出放完才收窗口、换代的计时器不误收、只画环的那一下放完就收、收完不留重绘。
/// 会建几扇透明、点击穿透的覆盖层窗口(一闪即收),不要任何系统授权。
@main
struct AgentCursorTests {
    @MainActor
    static func main() {
        testCanvasOrientation()
        testRendererLifecycle()
        testOverlayLifecycle()
    }

    /// 屏上的 Canvas 经 `withCGContext` 把 CGContext 交给画法;画法按「左上原点、y 向下」写(离屏测试也是这么翻的)。
    /// 这里钉住这个前提:在 (0,0) 画一块方块,它必须出现在左上角。前提不成立的话,离屏 PNG 全对、屏上全是镜像。
    @MainActor
    private static func testCanvasOrientation() {
        let view = Canvas { graphics, _ in
            graphics.withCGContext { ctx in
                ctx.setFillColor(CGColor(srgbRed: 1, green: 0, blue: 0, alpha: 1))
                ctx.fill(CGRect(x: 0, y: 0, width: 10, height: 10))
            }
        }
        .frame(width: 40, height: 40)
        let renderer = ImageRenderer(content: view)
        renderer.scale = 1
        guard let image = renderer.cgImage else { fail("ImageRenderer produced no image for the orientation probe") }
        let width = image.width, height = image.height
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { fail("could not read the orientation probe back") }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        let bytes = ctx.data!.assumingMemoryBound(to: UInt8.self)
        // 位图内存第 0 行是图的最上面一行。
        func red(_ x: Int, _ y: Int) -> Bool { bytes[y * ctx.bytesPerRow + x * 4] > 200 && bytes[y * ctx.bytesPerRow + x * 4 + 1] < 60 }
        expect(red(2, 2), "withCGContext must be top-left / y-down: the square drawn at (0,0) is missing from the top-left corner")
        expect(!red(2, height - 3), "withCGContext must be top-left / y-down: the square drawn at (0,0) landed bottom-left (mirrored)")
    }

    @MainActor
    private static func testRendererLifecycle() {
        let renderer = AgentCursorRenderer()
        expect(!renderer.isAnimating, "renderer should start idle")

        renderer.update(now: 1000) { scene in
            scene.place(CursorPose.resting(atTip: CGPoint(x: 100, y: 100)))
            scene.show(at: 1000)
            scene.fly(toTip: CGPoint(x: 500, y: 400), at: 1000)
        }
        expect(renderer.isAnimating, "renderer should animate while the cursor appears and flies")
        expect(renderer.frameInterval < 1.0 / 60.0, "transitions render at full rate")

        renderer.refresh(now: 1002)
        expect(!renderer.isAnimating, "renderer should stop once every transition has settled (no resident animation)")
        let tip = OverlayPaint.cursorTipPoint(renderer.scene.cursorFrame(at: 1002))
        expect(hypot(tip.x - 500, tip.y - 400) < 2, "the cursor arrives by time alone, without any render ticks")

        renderer.update(now: 1003) { $0.setThinking(true, at: 1003) }
        renderer.refresh(now: 1004)
        expect(renderer.isAnimating && renderer.frameInterval >= 1.0 / 30.0 - 1e-9, "thinking wobble keeps rendering, capped at 30fps")

        renderer.update(now: 1005) { $0.hide(at: 1005) }
        renderer.refresh(now: 1006)
        expect(!renderer.isAnimating, "after the fade-out nothing keeps rendering")

        renderer.reset()
        expect(!renderer.scene.placed && !renderer.isAnimating, "reset clears the scene")
    }

    @MainActor
    private static func testOverlayLifecycle() {
        let application = NSApplication.shared
        let existingWindows = Set(application.windows.map(ObjectIdentifier.init))
        let scheduler = ManualScheduler()
        let clock = FakeClock()
        let renderer = AgentCursorRenderer()
        let cursor = AgentCursor(schedule: scheduler.schedule, renderer: renderer, clock: { clock.now })
        func newVisibleWindow(excluding: [NSWindow] = []) -> NSWindow? {
            application.windows.first { window in
                !existingWindows.contains(ObjectIdentifier(window)) && window.isVisible && !excluding.contains { $0 === window }
            }
        }

        clock.now = 1000
        cursor.perform(.click(count: 1), at: CGPoint(x: 300, y: 300), above: 0)
        guard let firstWindow = newVisibleWindow() else { fail("first action should create a visible overlay") }
        expect(scheduler.count == 1 && scheduler.delays[0] == AgentCursor.idleHideSeconds, "an action schedules the 8 s idle hide")

        clock.now = 1001
        cursor.perform(.move, at: CGPoint(x: 500, y: 500), above: 0)
        expect(scheduler.count == 2, "each action should replace the idle timeout")

        scheduler.fire(0)
        expect(firstWindow.isVisible && firstWindow.contentView != nil, "a stale timeout should not hide the current overlay")

        clock.now = 1009
        scheduler.fire(1)
        expect(firstWindow.isVisible && firstWindow.contentView != nil, "the idle timeout starts a fade-out instead of a hard cut")
        expect(renderer.scene.presence.to == 0, "the cursor is fading out")
        expect(scheduler.count == 3, "the fade-out schedules the teardown")

        clock.now = 1009.1
        scheduler.fire(2)
        expect(firstWindow.isVisible, "the window stays until the fade has finished")
        expect(scheduler.count == 4, "a teardown that fires mid-fade waits again")

        clock.now = 1009.6
        scheduler.fire(3)
        expect(!firstWindow.isVisible, "the overlay is hidden once the fade is done")
        expect(firstWindow.contentView == nil, "the teardown releases the view tree")
        expect(!renderer.isAnimating && !renderer.scene.placed, "the teardown stops rendering")

        // 抢前台的点击:只画环、不画光标,环放完就收窗口。
        clock.now = 1020
        cursor.perform(.ringOnly(count: 1), at: CGPoint(x: 400, y: 300), above: 0)
        guard let ringWindow = newVisibleWindow(excluding: [firstWindow]) else { fail("a ring-only cue should show the overlay") }
        expect(!renderer.scene.placed, "a ring-only cue does not place the cursor")
        expect(scheduler.count == 5 && scheduler.delays[4] < 1, "a ring-only cue schedules the teardown right after the ring, not the 8 s idle")
        clock.now = 1020.6
        scheduler.fire(4)
        expect(!ringWindow.isVisible && ringWindow.contentView == nil, "the ring-only overlay is gone after the ring")

        // 整轮模式下没有窗口可贴的光标照旧 8 s 收(10-17:不整轮盖着用户的窗口)。
        cursor.holdForTurn = true
        clock.now = 1030
        cursor.perform(.move, at: CGPoint(x: 200, y: 200), above: 0)
        expect(scheduler.count == 6 && scheduler.delays[5] == AgentCursor.idleHideSeconds, "an unanchored cursor still idles out after 8 s in a turn")
        cursor.holdForTurn = false
        cursor.hideNow()
        expect(newVisibleWindow(excluding: [firstWindow, ringWindow]) == nil, "hideNow removes the overlay at once")
    }

    private static func expect(_ condition: @autoclosure () -> Bool, _ message: String) {
        guard condition() else { fail(message) }
    }

    private static func fail(_ message: String) -> Never {
        FileHandle.standardError.write(Data("FAIL: \(message)\n".utf8))
        exit(1)
    }
}

private final class FakeClock {
    var now: Double = 0
}

@MainActor
private final class ManualScheduler {
    private var actions: [@MainActor () -> Void] = []
    private(set) var delays: [TimeInterval] = []

    var count: Int { actions.count }

    func schedule(_ delay: TimeInterval, _ action: @escaping @MainActor () -> Void) -> Task<Void, Never> {
        delays.append(delay)
        actions.append(action)
        return Task {}
    }

    func fire(_ index: Int) {
        actions[index]()
    }
}
