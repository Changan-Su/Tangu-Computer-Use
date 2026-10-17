import CoreGraphics
import Foundation

// 截图把同一个 App 叠在目标窗口上面的那几扇窗口一起画进来(非上游)。
// Forsion 反馈 69651ff8:微信的搜索结果下拉是单独一扇窗口,不在 0 层,配不上窗口号;截主窗口走的是
// desktopIndependentWindow(只截那一扇),所以下拉不在任何一张截图里,模型只能盲按回车,打开的是排第一的群。
// 点在这些像素上,点击落到的就是上面那扇窗口,所以截图要照屏幕上的样子画。

/// 一扇窗口在截图这边的样子(从 SCWindow 抄过来,纯数据,方便离线测)。frame = 全局屏幕点、左上角原点。
struct OverlayCandidate {
	let id: UInt32
	let pid: Int32
	let layer: Int
	let frame: CGRect
	let onScreen: Bool
}

/// 要一起画进 target 截图的窗口:同一个进程、在屏幕上、层级比 target 高、和 target 相交。
/// ponytail: 同层的窗口一律不画 —— 同层的兄弟窗口在执行器把 target 提到最前之后会沉到它下面,点那里落到的是 target;
/// CG 也分不出同层的子窗口弹层和兄弟窗口。真有 App 把弹层放在 0 层再加子窗口判断。
func overlayWindowIds(target: OverlayCandidate, candidates: [OverlayCandidate], limit: Int = 8) -> [UInt32] {
	Array(candidates.lazy.filter {
		$0.id != target.id && $0.pid == target.pid && $0.onScreen && $0.layer > target.layer
			&& $0.frame.width >= 2 && $0.frame.height >= 2 && $0.frame.intersects(target.frame)
	}.prefix(limit).map(\.id))
}

/// OCR 的语言。不设时 Vision 只认英文,中文读成乱码(反馈 69651ff8:「жлa」「฿ёx#t」);自动检测会把中英混排的名字
/// (「Sakura 粉丝群」)读烂。英文照样认得出,只是标点会出全角,由 foldFullwidthASCII 折回去。
/// ponytail: 固定中英;要认日文 / 韩文界面再按 Locale.preferredLanguages 加 ja-JP / ko-KR。
let ocrRecognitionLanguages = ["zh-Hans", "zh-Hant", "en-US"]

/// 全角 ASCII(U+FF01–FF5E)和全角空格折回半角:中文识别模型给英文配的是全角标点(「fix？」「（30）」),
/// 而无障碍文字、搜索词、expect 用的都是半角,不折就对不上。
func foldFullwidthASCII(_ s: String) -> String {
	var out = String.UnicodeScalarView()
	for u in s.unicodeScalars {
		if (0xFF01...0xFF5E).contains(u.value), let half = Unicode.Scalar(u.value - 0xFEE0) { out.append(half) }
		else if u.value == 0x3000 { out.append(" ") }
		else { out.append(u) }
	}
	return String(out)
}

/// pid 投递的指针事件该交给哪扇窗口:candidates 按从前到后排,取点上第一扇「目标自己,或会画进目标截图的叠窗」。
func pointerWindowId(target: OverlayCandidate, candidates: [OverlayCandidate], at point: CGPoint) -> UInt32 {
	let overlays = Set(overlayWindowIds(target: target, candidates: candidates))
	return candidates.first { ($0.id == target.id || overlays.contains($0.id)) && $0.frame.contains(point) }?.id ?? target.id
}

/// 两张截图有多少像素变了:都缩到最长边 ≤ maxDimension 再逐像素比(任一通道差 > 24 算变)。
/// 尺寸不一样 = 窗口变了,算全变。给「投给后台窗口的点击 / 滚轮落没落下」用 —— App 不回话,只能看画面。
/// quiet:投之前稍早的一张。和 a 之间就在变的 cell×cell 格子(播放进度、动图、歌词)整格不算 ——
/// 否则 App 没收到点击、画面照样在动,会被当成落下了(10-17 Codex 评审)。
/// ponytail: 只看两张之间 ~150ms 的变化;1 秒才跳一下的(时钟数字)抓不到,会算进去。要更准就跨请求记住每扇窗口的忙格子。
func changedPixels(_ a: CGImage, _ b: CGImage, quiet: CGImage? = nil, maxDimension: Int = 800, cell: Int = 16) -> Int {
	guard a.width == b.width, a.height == b.height else { return Int.max }
	let scale = min(1, Double(maxDimension) / Double(max(a.width, a.height)))
	let w = max(1, Int(Double(a.width) * scale)), h = max(1, Int(Double(a.height) * scale))
	func pixels(_ image: CGImage) -> [UInt8] {
		var buffer = [UInt8](repeating: 0, count: w * h * 4)
		buffer.withUnsafeMutableBytes { raw in
			CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)?
				.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
		}
		return buffer
	}
	// ⚠️拆成单独的语句:写成一个 max(abs(...), ...) 表达式,Swift 类型检查要跑好几分钟
	func differs(_ p: [UInt8], _ q: [UInt8], _ i: Int) -> Bool {
		for c in 0..<3 {
			let d: Int = Int(p[i + c]) - Int(q[i + c])
			if d > 24 || d < -24 { return true }
		}
		return false
	}
	let pa = pixels(a), pb = pixels(b)
	let columns = (w + cell - 1) / cell
	var busy = [Bool](repeating: false, count: columns * ((h + cell - 1) / cell))
	if let quiet, quiet.width == a.width, quiet.height == a.height {
		let pq = pixels(quiet)
		for y in 0..<h {
			for x in 0..<w where differs(pq, pa, (y * w + x) * 4) { busy[(y / cell) * columns + x / cell] = true }
		}
	}
	var changed = 0
	for y in 0..<h {
		for x in 0..<w where !busy[(y / cell) * columns + x / cell] && differs(pa, pb, (y * w + x) * 4) { changed += 1 }
	}
	return changed
}
