import AppKit
import ApplicationServices
import Foundation

// Tangu 新增:全局手势订阅 —— `hotkeySubscribe`(协议 15)的 helper 侧。目前只有一个手势 `modPair`:
// 左右两个 ⌘ 同时按下。Forsion 桌面端自己在前台时能在渲染层里看到这个手势;别的 App 在前台时只有 helper
// (辅助功能授权)看得到,所以由 helper 在手势发生的那一刻拍下前台 App 与窗口,推给订阅连接。
//
// 与电脑历史(activity_recorder.swift)同一套订阅模型,并复用它的写队列(RecorderSubscriber):专用连接、
// 首行是回包、之后一行一条 `{"ev":{…}}`,对端关闭即退订;最后一个订阅者走后全局监听随即拆掉。
//
// 隐私:键盘监听只取「左右 ⌘ 各自按没按下」与「有没有按过别的键」这一个布尔 —— `.keyDown` 的回调不碰事件本身,
// 键码、字符都不读、不存、不发。Secure Input(密码框)期间系统不投递按键,「中途按过别的键」无从得知,一律不触发。
// 线程:NSEvent 全局监听只能挂在主线程;回调里只做状态机和一次 CGWindowList 快照(不碰 AX),
// 读焦点窗口标题(AX)放到自己的串行队列上,不占 NSApp 主线程(agent 光标 / 边缘光效在那画)。

// MARK: - 纯逻辑(hotkey_monitor_tests.swift 覆盖;与 Windows 的 hotkey_logic.rs 同一份语义)

/// 「左右两个同名修饰键同时按下」的状态机。输入只有两种:修饰键的按下状态变了(左、右各自按没按下,
/// 以及有没有别的修饰键按着),和「按了一个非修饰键」(不带键值)。
/// 规则:第二个键按下、第一个还按着的那一刻触发,恰好一次;之后两个都松开才能再触发。
/// 第一个键按下之后混进过别的修饰键或任何非修饰键 → 这一轮作废,同样要两个都松开才重新开始。
struct ModPairMachine: Equatable {
	private(set) var left = false
	private(set) var right = false
	/// 这一轮(从第一个键按下到两个都松开)已经用掉:触发过了、被别的键作废了,或者没看见第一个键是怎么按下的。
	private(set) var spent = false

	/// 传入的是变化**之后**的状态(调用方从事件的修饰键标志算,不靠自己数按下 / 抬起),所以漏掉一次抬起也会在
	/// 下一次变化时自愈;同一状态重复送进来(按键重复)不会再触发。返回 true = 手势成立。
	mutating func modifiers(left: Bool, right: Bool, others: Bool) -> Bool {
		let wasExactlyOne = self.left != self.right
		// 换了边(上一次只按着左、这一次只按着右):中间那次抬起没看到,但两个键必然同时松开过 —— 按新的一轮算。
		// 不这样的话,漏掉一次抬起会让下一次干净的手势白按。
		let swapped = wasExactlyOne && left != right && left != self.left
		self.left = left
		self.right = right
		guard left || right else {
			spent = false
			return false
		}
		if swapped { spent = false }
		if others { spent = true }
		guard left && right else { return false }
		// 从「一个都没按」直接跳到「两个都按着」= 中间漏了事件,不知道期间发生过什么,不触发。
		let fire = wasExactlyOne && !spent
		spent = true
		return fire
	}

	/// 按了一个非修饰键。只在左 / 右有一个按着时才有意义(⌘C 之后再按另一个 ⌘ 不算手势)。
	mutating func otherKey() {
		if left || right { spent = true }
	}
}

/// NSEvent.modifierFlags 低 16 位里与设备相关的位(IOKit hidsystem/IOLLEvent.h 的 NX_DEVICELCMDKEYMASK /
/// NX_DEVICERCMDKEYMASK):哪一边的 ⌘ 此刻按着。真键盘的事件都带;合成事件可能不带。
let modPairDeviceLeftCommand: UInt = 0x0000_0008
let modPairDeviceRightCommand: UInt = 0x0000_0010
let modPairLeftCommandKeyCode: UInt16 = 55
let modPairRightCommandKeyCode: UInt16 = 54

/// 一条 flagsChanged 事件之后,左右 ⌘ 各自按没按下。以事件自带的标志为准:
///   - 没有 ⌘ 标志 → 两个都没按(漏掉的抬起在这里自愈);
///   - 带设备位 → 直接读;
///   - ⌘ 标志在、设备位不在(合成事件)→ 只能按键码翻转上一次的状态。
func modPairCommandState(previous: (left: Bool, right: Bool), keyCode: UInt16, flags: UInt) -> (left: Bool, right: Bool) {
	guard flags & NSEvent.ModifierFlags.command.rawValue != 0 else { return (false, false) }
	let deviceLeft = flags & modPairDeviceLeftCommand != 0
	let deviceRight = flags & modPairDeviceRightCommand != 0
	if deviceLeft || deviceRight { return (deviceLeft, deviceRight) }
	var next = previous
	switch keyCode {
	case modPairLeftCommandKeyCode: next.left.toggle()
	case modPairRightCommandKeyCode: next.right.toggle()
	default: return previous
	}
	// ⌘ 标志还在,却算出两个都没按:这条事件只能是「按下」。
	if !next.left && !next.right {
		if keyCode == modPairLeftCommandKeyCode { next.left = true } else { next.right = true }
	}
	return next
}

/// 让手势作废的修饰键:⇧ ⌥ ⌃(Caps Lock、Fn 不算)。
func modPairDisqualified(flags: UInt) -> Bool {
	let mask = NSEvent.ModifierFlags.shift.rawValue | NSEvent.ModifierFlags.option.rawValue | NSEvent.ModifierFlags.control.rawValue
	return flags & mask != 0
}

struct HotkeyWindowCandidate: Equatable {
	var windowId: UInt32
	var bounds: CGRect
	var title: String
	/// CGWindowLayer:0 = 普通窗口;浮动面板、菜单等在更高的层。
	var layer = 0
}

/// 手势发生那一刻的前台:App 身份 + 它在屏上的窗口(前 → 后)。全部来自 NSWorkspace 与 CGWindowList,不碰 AX。
struct HotkeyFrontSnapshot: Equatable {
	var pid: pid_t
	var app: String
	var bundleId: String
	var windows: [HotkeyWindowCandidate]
}

struct HotkeyFocusedWindow: Equatable {
	var frame: CGRect?
	var title: String
}

/// 某个进程在屏上的窗口(不透明的),按 CGWindowList 的顺序(前 → 后)。与 dockCandidates 同一个来源,
/// 所以 windowId 对得上。各层都收(焦点可能落在浮动面板上),层号记下来。kCGWindowName 要屏幕录制授权,没有就是空串。
func hotkeyWindowCandidates(pid: pid_t, entries: [[String: Any]]) -> [HotkeyWindowCandidate] {
	var candidates: [HotkeyWindowCandidate] = []
	for entry in entries {
		guard (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
			let windowId = (entry[kCGWindowNumber as String] as? NSNumber)?.uint32Value,
			let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary)
		else { continue }
		if let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha <= 0 { continue }
		candidates.append(HotkeyWindowCandidate(
			windowId: windowId, bounds: bounds, title: (entry[kCGWindowName as String] as? String) ?? "",
			layer: (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
		))
		if candidates.count == 64 { break }
	}
	return candidates
}

/// 没有 AX 焦点窗口可对时取哪一个:最前面那个够大的普通窗口(小的多半是浮层 / 提示),都不够大就取最前面的普通窗口。
func hotkeyTopWindow(_ windows: [HotkeyWindowCandidate]) -> HotkeyWindowCandidate? {
	let ordinary = windows.filter { $0.layer == 0 }
	return ordinary.first { $0.bounds.width >= 100 && $0.bounds.height >= 80 } ?? ordinary.first
}

/// 最前面的窗口已经有标题(有屏幕录制授权)就不用再问 AX。
func hotkeyNeedsFocusedWindow(_ windows: [HotkeyWindowCandidate]) -> Bool {
	hotkeyTopWindow(windows)?.title.isEmpty ?? true
}

/// 焦点窗口与候选窗口的位置大小差多少以内算同一个(四个量的差之和,单位点)。叠放的窗口一般错开几十点。
let hotkeyFrameTolerance: CGFloat = 12

/// 「正在看的窗口」。`windows` 是手势那一刻拍下的;`focused` 是随后才读到的 AX 焦点窗口,只在它的位置大小
/// 对得上那一刻的某个窗口时才采用(表单 / 对话框压在文档窗口上时,焦点窗口是文档窗口;焦点也可能在浮动面板上)——
/// 对不上说明读的时候焦点已经换了,或者它不在屏上:窗口号仍用那一刻最前面的,绝不把一个窗口的标题安到另一个窗口头上。
/// 都拿不到 → 0 / ""。
func hotkeyResolveWindow(_ windows: [HotkeyWindowCandidate], focused: HotkeyFocusedWindow?) -> (windowId: UInt32, title: String) {
	let top = hotkeyTopWindow(windows)
	let fallback = (windowId: top?.windowId ?? 0, title: top?.title ?? "")
	guard let focused else { return fallback }
	// 屏上一个窗口都没有:窗口号给不出,标题照实给。
	if windows.isEmpty { return (0, focused.title) }
	guard let frame = focused.frame else {
		// 没有位置大小可对:只有一个窗口时才敢把这个标题安给它。
		return windows.count == 1 && !focused.title.isEmpty ? (fallback.windowId, focused.title) : fallback
	}
	func distance(_ window: HotkeyWindowCandidate) -> CGFloat {
		abs(window.bounds.minX - frame.minX) + abs(window.bounds.minY - frame.minY)
			+ abs(window.bounds.width - frame.width) + abs(window.bounds.height - frame.height)
	}
	guard let nearest = windows.min(by: { distance($0) < distance($1) }), distance(nearest) <= hotkeyFrameTolerance else { return fallback }
	return (nearest.windowId, focused.title.isEmpty ? nearest.title : focused.title)
}

/// 事件里的 `front`。字段与 dockCandidates 的一项同名同义;拿不到的给 0 / ""。
func hotkeyFrontJSON(_ snapshot: HotkeyFrontSnapshot, focused: HotkeyFocusedWindow?) -> [String: Any] {
	let window = hotkeyResolveWindow(snapshot.windows, focused: focused)
	return [
		"bundleId": snapshot.bundleId,
		"app": snapshot.app,
		"pid": Int(snapshot.pid),
		"windowId": Int(window.windowId),
		"title": recorderTitle(window.title) ?? "",
	]
}

func hotkeyEvent(gesture: String, at: Int64, front: [String: Any]?) -> [String: Any] {
	["ev": ["t": at, "kind": "hotkey", "gesture": gesture, "front": front ?? NSNull()] as [String: Any]]
}

// MARK: - 读前台(真实来源)

private let hotkeyAXTimeout: Float = 0.3

func hotkeyFrontmost() -> HotkeyFrontSnapshot? {
	guard let app = NSWorkspace.shared.frontmostApplication else { return nil }
	let pid = app.processIdentifier
	let entries = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
	return HotkeyFrontSnapshot(
		pid: pid,
		app: app.localizedName ?? "",
		bundleId: app.bundleIdentifier ?? "",
		windows: hotkeyWindowCandidates(pid: pid, entries: entries)
	)
}

/// App 的焦点窗口(没有就主窗口)的标题与位置大小。只读、每个元素 0.3s 超时;绝不打开 AXEnhancedUserInterface。
func hotkeyAXFocusedWindow(pid: pid_t) -> HotkeyFocusedWindow? {
	let app = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(app, hotkeyAXTimeout)
	var window: AXUIElement?
	for attribute in [kAXFocusedWindowAttribute, kAXMainWindowAttribute] {
		var value: AnyObject?
		let status = AXUIElementCopyAttributeValue(app, attribute as CFString, &value)
		if status == .success, let value, CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() {
			window = unsafeBitCast(value, to: AXUIElement.self)
			break
		}
		// App 没在回消息(卡死 / 没授权):再问一个属性也是白等。
		if status == .cannotComplete || status == .apiDisabled { return nil }
	}
	guard let window else { return nil }
	AXUIElementSetMessagingTimeout(window, hotkeyAXTimeout)
	var values: CFArray?
	let attributes = [kAXTitleAttribute, kAXPositionAttribute, kAXSizeAttribute] as CFArray
	guard AXUIElementCopyMultipleAttributeValues(window, attributes, AXCopyMultipleAttributeOptions(rawValue: 0), &values) == .success,
		let array = values as? [AnyObject], array.count == 3
	else { return nil }
	func axValue(_ value: AnyObject, _ type: AXValueType) -> AXValue? {
		guard CFGetTypeID(value as CFTypeRef) == AXValueGetTypeID() else { return nil }
		let boxed = unsafeBitCast(value, to: AXValue.self)
		return AXValueGetType(boxed) == type ? boxed : nil
	}
	var frame: CGRect?
	var origin = CGPoint.zero
	var size = CGSize.zero
	if let position = axValue(array[1], .cgPoint), let extent = axValue(array[2], .cgSize),
		AXValueGetValue(position, .cgPoint, &origin), AXValueGetValue(extent, .cgSize, &size) {
		frame = CGRect(origin: origin, size: size)
	}
	return HotkeyFocusedWindow(frame: frame, title: array[0] as? String ?? "")
}

// MARK: - 订阅与全局监听

final class HotkeyMonitor {
	static let shared = HotkeyMonitor()
	static let gestures: Set<String> = ["modPair"]

	/// 测试缝:单测注入「已授权」,好在没有辅助功能授权的机器上跑通订阅流(未授权时全局监听收不到按键)。
	var accessibilityTrusted: () -> Bool = { AXIsProcessTrusted() }
	/// 测试缝:Secure Input 开没开(单测不能取决于跑测试时别的 App 有没有开着密码框)。
	var secureInputActive: () -> Bool = { recorderSecureInputActive() }
	/// 测试缝:手势那一刻的前台快照(主线程调,不碰 AX)与之后补读的焦点窗口(工作队列上调)。
	var frontmost: () -> HotkeyFrontSnapshot? = { hotkeyFrontmost() }
	var focusedWindow: (pid_t) -> HotkeyFocusedWindow? = { hotkeyAXFocusedWindow(pid: $0) }

	private struct Entry {
		let writer: RecorderSubscriber
		let excludePids: Set<pid_t>
	}

	// 订阅者注册表(任意线程,registryLock)。
	private let registryLock = NSLock()
	private var subscribers: [Int32: Entry] = [:]
	/// 读 AX 标题与投递。串行:事件按发生顺序出去。
	private let work = DispatchQueue(label: "forsion.hotkey", qos: .userInitiated)

	// ↓ 以下只在主线程读写。
	private var flagsMonitor: Any?
	private var keyMonitor: Any?
	private var machine = ModPairMachine()
	private var command: (left: Bool, right: Bool) = (false, false)

	// MARK: 对外(任意线程)

	var subscriberCount: Int {
		registryLock.lock(); defer { registryLock.unlock() }
		return subscribers.count
	}

	/// 在 serve socket 的专用连接上开始订阅。成功 → nil,回包已排在这条连接写队列的第一位;
	/// 失败 → 错误码与信息,由调用方回错误包(连接照常当普通连接用)。
	func subscribe(fd: Int32, id: String, gesture: String?, excludePids: Set<pid_t>) -> (code: String, message: String)? {
		guard let gesture, Self.gestures.contains(gesture) else {
			return ("unknown_gesture", "Unknown gesture '\(gesture ?? "")'. Supported: \(Self.gestures.sorted().joined(separator: ", "))")
		}
		guard recorderPeerIsSameUser(fd) else {
			return ("forbidden", "hotkeySubscribe is only served to processes of the same user")
		}
		guard accessibilityTrusted() else {
			return ("accessibility_denied", "The helper does not have the Accessibility permission")
		}
		let writer = RecorderSubscriber(fd: fd, policy: RecorderPolicy(json: nil))
		// 先排回包、再进注册表:触发路径从注册表取订阅者,所以事件一定排在回包后面。
		writer.send(["id": id, "ok": true, "result": ["subscribed": true]])
		registryLock.lock()
		subscribers[fd] = Entry(writer: writer, excludePids: excludePids)
		registryLock.unlock()
		DispatchQueue.main.async { [self] in syncMonitors() }
		return nil
	}

	/// 连接读到 EOF 时调用(没订阅过的 fd 是空操作)。先排空它的写队列,调用方随后才能关 fd。
	func unsubscribe(fd: Int32) {
		registryLock.lock()
		let entry = subscribers.removeValue(forKey: fd)
		registryLock.unlock()
		guard let entry else { return }
		// 先排上拆监听,再排空写队列(对端卡住时要等到写超时):没有订阅者了,监听不该多留那几秒。
		DispatchQueue.main.async { [self] in syncMonitors() }
		entry.writer.close()
	}

	/// 只给测试:全局监听装没装上。须在主线程调用。
	var debugMonitorsInstalled: Bool {
		precondition(Thread.isMainThread, "debugMonitorsInstalled reads main-thread fields")
		return flagsMonitor != nil || keyMonitor != nil
	}

	/// 只给测试:等工作队列上排着的投递都入了各订阅者的写队列。
	func debugDrain() { work.sync {} }

	// MARK: 主线程

	/// 按「现在有没有订阅者」对齐全局监听:有就装、没有就拆。幂等,所以订阅 / 退订交错到达也不会装两份或漏拆。
	private func syncMonitors() {
		guard subscriberCount > 0 else {
			if let flagsMonitor { NSEvent.removeMonitor(flagsMonitor) }
			if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
			flagsMonitor = nil
			keyMonitor = nil
			return
		}
		// 两个监听各自补齐(哪个没装上,下一次对齐时只补那一个,不会把已有的再装一份)。
		if flagsMonitor == nil {
			machine = ModPairMachine()
			command = (false, false)
			flagsMonitor = NSEvent.addGlobalMonitorForEvents(matching: .flagsChanged) { [self] event in handle(event) }
		}
		if keyMonitor == nil {
			// 只用来知道「按了一个非修饰键」:事件本身碰都不碰。
			keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [self] _ in otherKeyDown() }
		}
	}

	func handle(_ event: NSEvent) {
		guard event.type == .flagsChanged else { return }
		flagsChanged(keyCode: event.keyCode, flags: event.modifierFlags.rawValue)
	}

	func flagsChanged(keyCode: UInt16, flags: UInt) {
		command = modPairCommandState(previous: command, keyCode: keyCode, flags: flags)
		if machine.modifiers(left: command.left, right: command.right, others: modPairDisqualified(flags: flags)) {
			fired()
		}
	}

	func otherKeyDown() {
		machine.otherKey()
	}

	private func fired() {
		let at = Int64(recorderNowMs())
		guard !secureInputActive() else { return }
		let snapshot = frontmost()
		// helper 自己(授权引导窗口)在前台:没有可引用的东西。
		if let snapshot, snapshot.pid == getpid() { return }
		registryLock.lock()
		let targets = subscribers.values.filter { entry in snapshot.map { !entry.excludePids.contains($0.pid) } ?? true }.map(\.writer)
		registryLock.unlock()
		guard !targets.isEmpty else { return }
		work.async { [self] in
			var front: [String: Any]?
			if let snapshot {
				let focused = hotkeyNeedsFocusedWindow(snapshot.windows) ? focusedWindow(snapshot.pid) : nil
				front = hotkeyFrontJSON(snapshot, focused: focused)
			}
			let event = hotkeyEvent(gesture: "modPair", at: at, front: front)
			for target in targets { target.send(event) }
		}
	}
}
