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
