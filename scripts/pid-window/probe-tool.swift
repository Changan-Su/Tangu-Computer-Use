// pid-window 探针的量具,不要任何系统授权(不读窗口标题、不发事件)。用法见 scripts/pid-window.probe.mjs。
//   sample <ms> <targetPid> <targetWid> <coverWid>
//       每 ~3ms 采一次:前台 App 的 pid、目标 App 是否 active、真实鼠标位置、目标窗口 / 盖窗在屏幕窗口表里的次序
//       (0 = 最前)。输出一行 JSON:第一次、最后一次,和中途每一次变化(只列变了的那几项)。
//   diff <a.jpg> <b.jpg> [x y w h]
//       两张同尺寸截图逐像素比(可只比一块):变化像素数、占比、外接框(像素)。尺寸不同直接报 sizeChanged。
import AppKit

func emit(_ object: Any) {
	let data = try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
	print(String(data: data, encoding: .utf8)!)
}

func sample(ms: Int, targetPid: Int32, targetWid: Int, coverWid: Int) {
	let target = NSRunningApplication(processIdentifier: targetPid)
	func one() -> [String: Any] {
		// frontmostApplication / isActive 是 AppKit 按通知更新的缓存:每次采样前转一下主 run loop 让通知进来
		RunLoop.main.run(mode: .default, before: Date())
		let windows = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
		let ids = windows.map { ($0[kCGWindowNumber as String] as? Int) ?? 0 }
		let mouse = CGEvent(source: nil)?.location ?? .zero
		return [
			"front": Int(NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1),
			"targetActive": target?.isActive ?? false,
			"mouse": [Int(mouse.x.rounded()), Int(mouse.y.rounded())],
			"targetIdx": ids.firstIndex(of: targetWid) ?? -1,
			"coverIdx": ids.firstIndex(of: coverWid) ?? -1,
		]
	}
	let start = Date()
	let first = one()
	var previous = first
	var changes: [[String: Any]] = []
	var count = 1
	while Date().timeIntervalSince(start) * 1000 < Double(ms) {
		RunLoop.main.run(mode: .default, before: Date(timeIntervalSinceNow: 0.003))
		let now = one()
		count += 1
		var delta: [String: Any] = [:]
		for (key, value) in now where !(previous[key] as AnyObject).isEqual(value) { delta[key] = value }
		if !delta.isEmpty {
			delta["t"] = Int(Date().timeIntervalSince(start) * 1000)
			changes.append(delta)
		}
		previous = now
	}
	emit(["n": count, "first": first, "last": previous, "changes": Array(changes.prefix(200))])
}

func pixels(_ path: String) -> (Int, Int, [UInt8])? {
	guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
		let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
	else { return nil }
	let w = image.width, h = image.height
	var buffer = [UInt8](repeating: 0, count: w * h * 4)
	let drawn = buffer.withUnsafeMutableBytes { raw -> Bool in
		guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
		context.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		return true
	}
	return drawn ? (w, h, buffer) : nil
}

/// roi:只比这块(图片像素,左上角原点)—— 真 App 窗口里有动图、新消息,整窗比会误判
func diff(_ a: String, _ b: String, roi: [Int] = []) {
	guard let (w, h, pa) = pixels(a), let (w2, h2, pb) = pixels(b) else { emit(["error": "unreadable"]); return }
	guard w == w2, h == h2 else { emit(["sizeChanged": true, "a": [w, h], "b": [w2, h2]]); return }
	var changed = 0, minX = w, minY = h, maxX = -1, maxY = -1
	let (x0, y0) = roi.count == 4 ? (max(0, roi[0]), max(0, roi[1])) : (0, 0)
	let (x1, y1) = roi.count == 4 ? (min(w, roi[0] + roi[2]), min(h, roi[1] + roi[3])) : (w, h)
	for y in y0..<y1 {
		for x in x0..<x1 {
			let i = (y * w + x) * 4
			// JPEG 噪声在 ±10 上下;24 以上才算这个像素真的变了
			if max(abs(Int(pa[i]) - Int(pb[i])), abs(Int(pa[i + 1]) - Int(pb[i + 1])), abs(Int(pa[i + 2]) - Int(pb[i + 2]))) > 24 {
				changed += 1
				minX = min(minX, x); minY = min(minY, y); maxX = max(maxX, x); maxY = max(maxY, y)
			}
		}
	}
	// 位图内存第 0 行就是图片最上面一行:外接框直接是图片坐标(左上角原点)
	let box: [Int] = changed > 0 ? [minX, minY, maxX - minX + 1, maxY - minY + 1] : []
	emit(["size": [w, h], "changed": changed, "ratio": Double(changed) / Double(max(1, (x1 - x0) * (y1 - y0))), "box": box])
}

let args = CommandLine.arguments
switch args.count > 1 ? args[1] : "" {
case "sample" where args.count == 6:
	sample(ms: Int(args[2]) ?? 1000, targetPid: Int32(args[3]) ?? 0, targetWid: Int(args[4]) ?? 0, coverWid: Int(args[5]) ?? 0)
case "diff" where args.count == 4 || args.count == 8:
	diff(args[2], args[3], roi: args.dropFirst(4).compactMap { Int($0) })
default:
	FileHandle.standardError.write("usage: probe-tool sample <ms> <targetPid> <targetWid> <coverWid> | diff <a.jpg> <b.jpg> [x y w h]\n".data(using: .utf8)!)
	exit(2)
}
