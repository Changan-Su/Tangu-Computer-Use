import AppKit
import Vision

@main struct CaptureOverlaysTests {
	static func main() throws {
		func check(_ yes: Bool, _ name: String) { precondition(yes, name); print("PASS \(name)") }
		func win(_ id: UInt32, _ layer: Int, _ on: Bool, _ x: Double, _ y: Double, _ w: Double, _ h: Double, pid: Int32 = 6769) -> OverlayCandidate {
			OverlayCandidate(id: id, pid: pid, layer: layer, frame: CGRect(x: x, y: y, width: w, height: h), onScreen: on)
		}
		// 10-16 量到的微信窗口(反馈 69651ff8 那台机器),外加结果下拉:@r31 的 frame 48,79 368x282,配对分 -31 = 不在 0 层
		let main = win(994, 0, true, 0, 33, 1512, 949)
		let popup = win(8084, 3, true, 48, 79, 368, 282)
		let recorded = [
			win(77360, 0, true, 460, 147, 590, 720), // 「Chat history」:同层的兄弟窗口,整个落在主窗口里
			win(30066, 3, false, 481, 139, 550, 719), win(23511, 3, false, 481, 139, 550, 719),
			win(77369, 21, false, 705, 492, 100, 30), win(9965, 103, false, 600, 607, 158, 21),
			win(73662, 0, false, 0, 0, 1512, 33), win(35958, 0, false, 576, 350, 360, 288),
			main,
		]
		check(overlayWindowIds(target: main, candidates: recorded).isEmpty, "no popup open: the recorded WeChat windows add nothing (off screen, or the same layer)")
		check(overlayWindowIds(target: main, candidates: [popup] + recorded) == [8084], "the search popup above the main window is drawn into it")
		check(overlayWindowIds(target: win(77360, 0, true, 460, 147, 590, 720), candidates: [popup] + recorded).isEmpty, "a popup that does not overlap the window is left out")
		check(overlayWindowIds(target: main, candidates: [win(5, 3, true, 100, 100, 300, 300, pid: 99)]).isEmpty, "another app's floating window is left out")
		check(overlayWindowIds(target: main, candidates: [win(6, 3, true, -1600, 100, 300, 300)]).isEmpty, "a window of the app on another display is left out")
		check(overlayWindowIds(target: popup, candidates: [main, popup]).isEmpty, "a window under the target is never drawn over it")
		check(overlayWindowIds(target: main, candidates: [win(7, 3, true, 40, 40, 1, 400)]).isEmpty, "a sliver window is left out")
		check(overlayWindowIds(target: main, candidates: (1...12).map { win(UInt32(100 + $0), 3, true, 10, 40, 50, 50) }).count == 8, "at most eight windows are drawn in")

		// 投给后台进程的点击要带上窗口号:点在 App 自己的弹出层里就投给弹出层,其余投给目标窗口;别人的窗口永远不选
		check(pointerWindowId(target: main, candidates: [popup] + recorded, at: CGPoint(x: 100, y: 100)) == 8084, "a click inside the app's popup goes to the popup")
		check(pointerWindowId(target: main, candidates: [popup] + recorded, at: CGPoint(x: 800, y: 600)) == 994, "a click outside the popup goes to the target window")
		check(pointerWindowId(target: main, candidates: [win(5, 3, true, 0, 0, 1512, 982, pid: 99), main], at: CGPoint(x: 100, y: 100)) == 994, "another app's window covering the point is never picked")

		let flat = render(["Play all (30)"]), same = render(["Play all (30)"]), other = render(["Paused"])
		check(changedPixels(flat, same) == 0, "the same picture changes no pixels")
		check(changedPixels(flat, other) > 12, "different text changes more pixels than the verdict threshold")
		check(changedPixels(flat, render(["Play all (30)", "x"])) == Int.max, "a resized window counts as fully changed")
		// 投之前就在变的那块(播放进度在走)整格不算:App 没收到点击、只有它在动,不能当成落下了
		let ticking = [render(["Play all (30)", "01:23"]), render(["Play all (30)", "01:24"]), render(["Play all (30)", "01:25"])]
		check(changedPixels(ticking[1], ticking[2]) > 12, "without the earlier shot the ticking clock looks like a change")
		check(changedPixels(ticking[1], ticking[2], quiet: ticking[0]) <= 12, "with it, the cells that were already changing are left out")
		check(changedPixels(ticking[1], render(["Paused", "01:25"]), quiet: ticking[0]) > 12, "a change outside those cells still counts")
		// 点在正在动的那块旁边:有没有落下看不出来(点视频暂停这种),给 -2,不能拿来升前台重放
		let clock = CGPoint(x: 90, y: Double(ticking[0].height) - 50) // 「01:2x」的最后一位
		check(changedPixels(ticking[1], ticking[2], quiet: ticking[0], focus: clock) == -2, "a click next to cells that were already changing cannot be judged")
		check(changedPixels(ticking[1], ticking[2], quiet: ticking[0], focus: CGPoint(x: 600, y: 20)) <= 12, "a click away from them still is")

		// 物理点击落在这一点最上面那扇窗口上:别的 App 挡着就不是目标;helper 自己的光标窗口、菜单栏那几层不算
		let cover = win(9, 0, true, 0, 0, 1512, 982, pid: 77), mine = win(10, 0, true, 0, 0, 1512, 982, pid: 55)
		check(topWindowPid(at: CGPoint(x: 100, y: 100), candidates: [cover, main], helperPid: 55) == 77, "another app's window on top owns the click")
		check(topWindowPid(at: CGPoint(x: 100, y: 100), candidates: [mine, main], helperPid: 55) == 6769, "the helper's own overlay is skipped")
		check(topWindowPid(at: CGPoint(x: 100, y: 40), candidates: [win(11, 25, true, 0, 0, 1512, 60, pid: 88), main], helperPid: 55) == 6769, "the menu bar layer is skipped")
		check(topWindowPid(at: CGPoint(x: 100, y: 960), candidates: [win(12, 20, true, 0, 940, 1512, 42, pid: 99), main], helperPid: 55) == 99, "the Dock covering the window counts")
		// 10-17 量到的:Dock 自动隐藏时它那扇 20 层窗口铺满整块屏(0,0 1512x982,alpha 1),点击穿透
		let screen = CGRect(x: 0, y: 0, width: 1512, height: 982), backdrop = win(13, 20, true, 0, 0, 1512, 982, pid: 99)
		let hidden = DisplayArea(frame: screen, visible: CGRect(x: 0, y: 33, width: 1512, height: 949))
		let pinned = DisplayArea(frame: screen, visible: CGRect(x: 0, y: 33, width: 1512, height: 880))
		check(topWindowPid(at: CGPoint(x: 1167, y: 825), candidates: [backdrop, main], helperPid: 55, displays: [hidden], dockPid: 99) == 6769, "the Dock's full-screen backdrop does not cover the window")
		check(topWindowPid(at: CGPoint(x: 1167, y: 950), candidates: [backdrop, main], helperPid: 55, displays: [pinned], dockPid: 99) == 99, "a pinned Dock strip below the visible frame does")
		check(topWindowPid(at: CGPoint(x: 1167, y: 825), candidates: [backdrop, main], helperPid: 55, displays: [pinned], dockPid: 99) == 6769, "above the strip it does not")
		check(topWindowPid(at: CGPoint(x: 1167, y: 825), candidates: [backdrop, main], helperPid: 55, displays: [hidden], dockPid: 98) == 99, "another app's full-screen window at the Dock level still covers (Codex review)")
		check(foldFullwidthASCII("Did you push the fix？") == "Did you push the fix?", "full-width question mark folds")
		check(foldFullwidthASCII("Play all （30）　Ａ１") == "Play all (30) A1", "full-width brackets, letters, digits and space fold")
		check(foldFullwidthASCII("周末一起去看展吗？好，见") == "周末一起去看展吗?好,见", "CJK text keeps its characters, punctuation folds")
		check(foldFullwidthASCII("Sakura 樱花「」。") == "Sakura 樱花「」。", "CJK brackets and the full stop are not ASCII forms and stay")

		// Vision 用 helper 的语言设置读一张自己画的图(不要授权):中文不再是乱码,英文折完和原文一样
		let zh = ocr(render(["Sakura 粉丝群", "联系人", "佐藤樱", "文件传输助手"]))
		check(zh.contains("粉丝群") && zh.contains("佐藤樱") && zh.contains("联系人"), "Chinese is read with the helper's languages: \(zh)")
		let en = ocr(render(["Did you push the fix?", "Play all (30)"]))
		check(en == "Did you push the fix? | Play all (30)", "English reads the same after folding: \(en)")
	}

	static func render(_ lines: [String]) -> CGImage {
		let w = 360.0, h = Double(lines.count) * 30 + 20
		let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(w * 2), pixelsHigh: Int(h * 2), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
		rep.size = NSSize(width: w, height: h)
		NSGraphicsContext.saveGraphicsState()
		NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
		NSColor(white: 0.96, alpha: 1).setFill()
		NSRect(x: 0, y: 0, width: w, height: h).fill()
		for (i, s) in lines.enumerated() {
			(s as NSString).draw(at: NSPoint(x: 16, y: h - 30 - Double(i) * 30), withAttributes: [.font: NSFont.systemFont(ofSize: 13), .foregroundColor: NSColor(white: 0.1, alpha: 1)])
		}
		NSGraphicsContext.restoreGraphicsState()
		return rep.cgImage!
	}

	static func ocr(_ image: CGImage) -> String {
		let request = VNRecognizeTextRequest()
		request.recognitionLevel = .accurate
		request.usesLanguageCorrection = false
		request.recognitionLanguages = ocrRecognitionLanguages
		try? VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
		return (request.results ?? []).compactMap { $0.topCandidates(1).first.map { foldFullwidthASCII($0.string) } }.joined(separator: " | ")
	}
}
