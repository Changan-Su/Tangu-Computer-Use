import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ScreenCaptureKit

/// 被操控窗口的**常驻取景流**(Tangu 新增,非上游)。
///
/// 为什么不是"每帧现截":`SCScreenshotManager.captureImage` 每次都要重新协商一次采集会话,
/// 单帧几十到几百毫秒不等,偶发能跑到秒级(所以 `captureWindow` 那边挂着 8 秒超时 +
/// CGWindowList 兜底)。拿它做实时画面就是 1fps 幻灯片 —— 用户实报"掉帧,不是 screen sharing"。
/// ScreenCaptureKit 的正路是开一条 `SCStream` 让系统持续推帧,取景时只从缓存里拿最新那张。
///
/// 三条纪律:
///   1. **只在有人看时跑**。每次取帧记一次时间戳,`idleStopSeconds` 内没人要就自停 —— 采集是有
///      功耗的,不能因为 agent 点过一次窗口就永远在后台录屏。
///   2. **绝不阻塞调用线程**。开流是 async 的;首帧到达前 `latestFrame` 返回 nil,由调用方回落到
///      单帧截图(所以第一帧照样立刻有画面,之后才切到流)。
///   3. **换窗口 / 窗口改尺寸就重开**。SCStream 的输出尺寸在 config 里定死,窗口拉大后不重开只会
///      一直拿到糊的那张。
///
/// 静止的窗口不会有新帧(系统只在内容变化时推 `.complete`),这是**正常**的:不做"帧太旧就作废",
/// 否则一个没人动的窗口会让我们每一帧都退回昂贵的单帧截图。流断了由 `didStopWithError` 清状态。
@available(macOS 14.0, *)
final class LiveWindowStream: NSObject, SCStreamOutput, SCStreamDelegate {
	static let shared = LiveWindowStream()

	/// 没人取帧超过这么久就停流。比视图的最慢轮询(隐藏时 6s)宽一点,免得来回起停。
	private let idleStopSeconds: TimeInterval = 9
	/// 窗口尺寸变化超过这么多像素才算漂了。
	private let resizeTolerancePixels: CGFloat = 8
	/// 漂了还要连续稳住这么久才重开(拖动窗口时尺寸一直在变,见 driftedLongEnoughLocked)。
	private let resizeSettleSeconds: TimeInterval = 0.6
	/// 流采纳后这么久还没来过一帧 = 死流,重开。
	private let deadStreamSeconds: TimeInterval = 2.0
	/// 流的推帧上限。再高也没意义:瓶颈在 JPEG 编码 + base64 过 socket,不在采集。
	private let framesPerSecond: Int32 = 20

	private let lock = NSLock()
	private let sampleQueue = DispatchQueue(label: "com.forsion.tangu-computer-use.livestream")
	private let ciContext = CIContext(options: [.useSoftwareRenderer: false])

	private var stream: SCStream?
	private var streamWindowId: UInt32 = 0
	private var configuredSize = CGSize.zero
	private var latestImage: CGImage?
	/// 每收到一张新画面 +1。调用方带着上次见过的号来,一样就不必重编一遍 JPEG(静止窗口占绝大多数)。
	private var frameSeq: UInt64 = 0
	private var lastWantedAt = Date.distantPast
	private var starting = false
	private var idleTimer: DispatchSourceTimer?
	/// 流被采纳的时刻 —— 用来发现「开起来了却一帧都不来」的死流(见 latestFrame 里的看门狗)。
	private var adoptedAt = Date.distantPast
	/// 尺寸开始漂移的时刻。拖动窗口边缘时尺寸每帧都在变,立刻重开就会变成重开风暴。
	private var driftSince: Date?
	/// 已知启动后就失败了的流对象 —— 不许再被 adopt 装进来当活流用。
	private var failedStream: SCStream?

	/// 取这个窗口的最新一帧。没有就返回 nil(调用方回落到单帧截图),同时把流开起来/切过去。
	/// `maxDimension` 只决定流的输出尺寸,缩放交给系统做 —— 比我们截全尺寸再 downscale 便宜得多。
	/// 返回的 `seq` 每来一张新画面 +1;和调用方上次见过的号一样,说明画面没变过。
	func latestFrame(windowId: UInt32, maxDimension: Int) -> (image: CGImage, seq: UInt64)? {
		lock.lock()
		let now = Date()
		lastWantedAt = now
		let sameWindow = streamWindowId == windowId && stream != nil
		let image = sameWindow ? latestImage : nil
		let seq = frameSeq
		let needsStart = !sameWindow && !starting
		// 死流看门狗:流采纳了这么久还一帧都没来 = 它在 startCapture 与 adopt 之间就死了
		// (didStopWithError 那会儿 self.stream 还不是它,所以清不掉),不重开就永远回落单帧截图。
		let deadStream = sameWindow && !starting && latestImage == nil && now.timeIntervalSince(adoptedAt) > deadStreamSeconds
		let needsRestart = sameWindow && !starting && (deadStream || driftedLongEnoughLocked(windowId: windowId, maxDimension: maxDimension, now: now))
		if needsStart || needsRestart { starting = true }
		lock.unlock()

		if needsStart || needsRestart {
			Task { await self.restart(windowId: windowId, maxDimension: maxDimension) }
		}
		armIdleTimer()
		guard let image else { return nil }
		return (image, seq)
	}

	/// 尺寸漂了、**而且已经稳住一会儿**才算该重开。lock 必须已持有。
	/// ⚠️去抖不能省:拖动窗口边缘时尺寸每 120ms 一变,一变就重开 = 整个拖动过程都在重开流,
	/// 而重开期间流是断的 → 只能回落单帧截图,恰好在最需要看画面的时候退化成幻灯片。
	private func driftedLongEnoughLocked(windowId: UInt32, maxDimension: Int, now: Date) -> Bool {
		guard let bounds = cgWindowBounds(windowId: windowId) else { driftSince = nil; return false }
		let wanted = Self.outputSize(for: bounds.size, maxDimension: maxDimension)
		guard wanted.width > 0, configuredSize.width > 0 else { driftSince = nil; return false }
		let drifted = abs(wanted.width - configuredSize.width) > resizeTolerancePixels
			|| abs(wanted.height - configuredSize.height) > resizeTolerancePixels
		guard drifted else { driftSince = nil; return false }
		guard let since = driftSince else { driftSince = now; return false }
		return now.timeIntervalSince(since) >= resizeSettleSeconds
	}

	/// 窗口尺寸 → 流的输出尺寸(等比缩到 maxDimension 以内;窗口本来就小就别放大)。
	static func outputSize(for size: CGSize, maxDimension: Int) -> CGSize {
		let longest = max(size.width, size.height)
		guard longest > 0 else { return .zero }
		let limit = CGFloat(max(160, maxDimension))
		let scale = min(1, limit / longest)
		return CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
	}

	/// 单帧兜底:流还没起来(首帧、刚换窗口)时用,**与流同一套输出尺寸**。
	///
	/// ⚠️不能退回 bridge 的 `captureWindow`:那边不设 `config.width/height`,ScreenCaptureKit 就按
	/// 整块屏幕出图 —— 230×408 的计算器会得到一张 1920×1080、窗口缩在左上角、其余全是白的图。
	/// 用户报的"Agent Desk 里窗口占不满、有留白",有一半就是这么**烤进 JPEG** 里的,CSS 那头再怎么
	/// 适配也救不回来。设了宽高才拿到窗口本身。
	func captureOnce(windowId: UInt32, maxDimension: Int, timeout: TimeInterval = 3) -> CGImage? {
		let semaphore = DispatchSemaphore(value: 0)
		let box = Box<CGImage?>(nil)
		let task = Task {
			defer { semaphore.signal() }
			guard let shareable = try? await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false),
				let window = shareable.windows.first(where: { $0.windowID == windowId })
			else { return }
			let size = Self.outputSize(for: window.frame.size, maxDimension: maxDimension)
			let config = SCStreamConfiguration()
			config.showsCursor = false
			config.ignoreShadowsSingleWindow = true
			config.width = Int(size.width)
			config.height = Int(size.height)
			config.scalesToFit = true
			box.value = try? await SCScreenshotManager.captureImage(
				contentFilter: SCContentFilter(desktopIndependentWindow: window),
				configuration: config
			)
		}
		// 兜底就该干脆:等不到就让调用方走更老的那条路,别把视图的这一帧卡住。
		if semaphore.wait(timeout: .now() + timeout) == .timedOut {
			task.cancel()
			return nil
		}
		return box.value
	}

	private func restart(windowId: UInt32, maxDimension: Int) async {
		await stopCurrent()
		do {
			let shareable = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
			guard let window = shareable.windows.first(where: { $0.windowID == windowId }) else {
				finishStarting()
				return
			}
			let size = Self.outputSize(for: window.frame.size, maxDimension: maxDimension)
			let config = SCStreamConfiguration()
			config.showsCursor = false
			config.ignoreShadowsSingleWindow = true
			config.width = Int(size.width)
			config.height = Int(size.height)
			config.scalesToFit = true
			config.pixelFormat = kCVPixelFormatType_32BGRA
			config.queueDepth = 3
			config.minimumFrameInterval = CMTime(value: 1, timescale: framesPerSecond)

			let filter = SCContentFilter(desktopIndependentWindow: window)
			let created = SCStream(filter: filter, configuration: config, delegate: self)
			try created.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
			try await created.startCapture()
			adopt(created, windowId: windowId, size: size)
		} catch {
			finishStarting()
		}
	}

	// ⚠️下面三个是**同步**的:NSLock 不能跨 await 持有(Swift 6 里直接是编译错误),
	// 所以 async 的 restart/stopCurrent 只调它们,自己一行锁都不碰。
	private func adopt(_ created: SCStream, windowId: UInt32, size: CGSize) {
		lock.lock()
		// startCapture 成功之后、装进来之前就失败的流:didStopWithError 那会儿 self.stream 还不是它,
		// 只能靠这块墓碑拦住 —— 装进来的话它永远不吐帧,而 sameWindow 恒真,再也不会重开。
		if failedStream === created {
			failedStream = nil
			starting = false
			lock.unlock()
			return
		}
		stream = created
		streamWindowId = windowId
		configuredSize = size
		latestImage = nil
		adoptedAt = Date()
		driftSince = nil
		starting = false
		lock.unlock()
	}

	private func finishStarting() {
		lock.lock()
		starting = false
		lock.unlock()
	}

	private func detachCurrent() -> SCStream? {
		lock.lock()
		defer { lock.unlock() }
		return detachLocked()
	}

	/// 只在「确实还闲着」时才摘 —— 定时器判定与真正动手之间隔着一次加锁,那当口可能刚好来了新的取帧请求
	/// (甚至刚采纳了一条新流)。不复核就会把刚要用的流停掉,下一帧只能回落单帧截图。
	private func detachIfStillIdle() -> SCStream? {
		lock.lock()
		defer { lock.unlock() }
		guard stream != nil, Date().timeIntervalSince(lastWantedAt) > idleStopSeconds else { return nil }
		return detachLocked()
	}

	/// lock 必须已持有。
	private func detachLocked() -> SCStream? {
		let old = stream
		stream = nil
		streamWindowId = 0
		configuredSize = .zero
		latestImage = nil
		adoptedAt = .distantPast
		driftSince = nil
		return old
	}

	private func stopCurrent() async {
		guard let old = detachCurrent() else { return }
		try? old.removeStreamOutput(self, type: .screen)
		try? await old.stopCapture()
	}

	/// 没人取帧就自动收摊。定时器常驻(2 秒一跳,几乎不耗)—— 它只在真的该停时才动手。
	private func armIdleTimer() {
		lock.lock()
		defer { lock.unlock() }
		guard idleTimer == nil else { return }
		let timer = DispatchSource.makeTimerSource(queue: sampleQueue)
		timer.schedule(deadline: .now() + 2, repeating: 2)
		timer.setEventHandler { [weak self] in
			guard let self else { return }
			self.lock.lock()
			let maybeIdle = self.stream != nil && Date().timeIntervalSince(self.lastWantedAt) > self.idleStopSeconds
			self.lock.unlock()
			guard maybeIdle else { return }
			Task {
				// ⚠️必须复核(detachIfStillIdle):上面判完到这里动手之间,新的取帧请求可能已经来了。
				guard let old = self.detachIfStillIdle() else { return }
				try? old.removeStreamOutput(self, type: .screen)
				try? await old.stopCapture()
			}
		}
		idleTimer = timer
		timer.resume()
	}

	// MARK: - SCStreamOutput

	func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
		guard type == .screen, CMSampleBufferIsValid(sampleBuffer) else { return }
		// 只收 .complete:静止的窗口会推 .idle 空帧,拿它去转图会得到一张全黑。
		guard let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
			let rawStatus = attachments.first?[.status] as? Int,
			SCFrameStatus(rawValue: rawStatus) == .complete,
			let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer)
		else { return }
		let ciImage = CIImage(cvPixelBuffer: pixelBuffer)
		guard let image = ciContext.createCGImage(ciImage, from: ciImage.extent) else { return }
		lock.lock()
		// 这一帧属于哪条流?重开期间旧流可能还在吐帧,别把它盖到新窗口上。
		if self.stream === stream {
			latestImage = image
			frameSeq &+= 1
		}
		lock.unlock()
	}

	// MARK: - SCStreamDelegate

	func stream(_ stream: SCStream, didStopWithError error: Error) {
		lock.lock()
		if self.stream === stream {
			_ = detachLocked()
		} else {
			// 还没被 adopt 就死了(startCapture 与 adopt 之间)。留个墓碑,别让它被装进来当活流。
			failedStream = stream
		}
		lock.unlock()
	}
}
