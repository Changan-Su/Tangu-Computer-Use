import AppKit
import Foundation

// 全局手势订阅(hotkey_monitor.swift)的单测(npm run check:hotkey-logic),不需要任何授权。
// 纯逻辑:左右修饰键状态机 / 从 flagsChanged 的标志算左右 ⌘ / 让手势作废的修饰键 / 窗口候选与焦点窗口的对齐 / 事件形状。
// subscriptionStream 走真实的订阅路径:会装上 NSEvent 全局监听(本进程没有辅助功能授权时收不到按键),
// 按键一律由测试直接喂给监听的入口(不往系统里发任何事件),前台快照与焦点窗口用假的;
// 断言回包与事件的形状、excludePids、Secure Input、退订后的拆除。绝不读真实前台、不打印事件内容。
@main struct HotkeyMonitorTests {
	static func check(_ yes: Bool, _ name: String) {
		precondition(yes, name)
		print("PASS \(name)")
	}

	static func main() {
		setvbuf(stdout, nil, _IOLBF, 0)
		machine()
		commandState()
		windows()
		eventShape()
		subscriptionStream()
	}

	// MARK: 状态机

	enum Step {
		case mods(Bool, Bool, others: Bool = false)
		case key
	}

	/// 跑一串输入,返回触发发生在第几步(下标)。
	static func fires(_ steps: [Step]) -> [Int] {
		var machine = ModPairMachine()
		var fired: [Int] = []
		for (index, step) in steps.enumerated() {
			switch step {
			case let .mods(left, right, others):
				if machine.modifiers(left: left, right: right, others: others) { fired.append(index) }
			case .key:
				machine.otherKey()
			}
		}
		return fired
	}

	static func machine() {
		check(fires([.mods(true, false), .mods(true, true)]) == [1], "left then right fires when the second goes down")
		check(fires([.mods(false, true), .mods(true, true)]) == [1], "right then left fires when the second goes down")
		check(fires([.mods(true, false)]) == [] && fires([.mods(false, true), .mods(false, false)]) == [], "one key alone never fires")
		check(fires([.mods(true, false), .mods(true, true), .mods(true, true), .mods(true, true)]) == [1], "holding both does not fire again")
		check(fires([.mods(true, false), .mods(true, false), .mods(true, false), .mods(true, true)]) == [3], "key repeat of the first key changes nothing")
		check(fires([.mods(true, false), .mods(true, true), .mods(true, false), .mods(true, true)]) == [1], "releasing one and pressing it again does not fire")
		check(fires([.mods(true, false), .mods(true, true), .mods(false, true), .mods(false, false), .mods(false, true), .mods(true, true)]) == [1, 5], "after both are released it can fire again")

		check(fires([.mods(true, false, others: true), .mods(true, true, others: true)]) == [], "another modifier held from the start cancels")
		check(fires([.mods(true, false), .mods(true, true, others: true)]) == [], "another modifier held when the second goes down cancels")
		check(fires([.mods(true, false), .mods(true, false, others: true), .mods(true, false), .mods(true, true)]) == [], "another modifier tapped in between cancels until both are released")
		check(fires([.mods(false, false, others: true), .mods(false, false), .mods(true, false), .mods(true, true)]) == [3], "another modifier released before the first key does not cancel")

		check(fires([.mods(true, false), .key, .mods(true, true)]) == [], "a non-modifier key while the first is down cancels")
		check(fires([.mods(true, false), .key, .mods(true, true), .mods(false, true), .mods(true, true)]) == [], "a cancelled round stays cancelled until both are released")
		check(fires([.mods(true, false), .key, .mods(false, false), .mods(true, false), .mods(true, true)]) == [4], "a cancelled round ends when both are released")
		check(fires([.key, .key, .mods(true, false), .mods(true, true)]) == [3], "keys typed before the first modifier do not cancel")
		check(fires([.mods(true, false), .mods(true, true), .key, .mods(true, false), .mods(true, true)]) == [1], "a key after firing changes nothing")

		check(fires([.mods(true, true)]) == [], "jumping from none to both (a missed event) does not fire")
		check(fires([.mods(true, true), .mods(true, false), .mods(true, true)]) == [], "a round that started with a missed event stays spent")
		check(fires([.mods(true, true), .mods(false, false), .mods(true, false), .mods(true, true)]) == [3], "a missed event heals once both are released")
		check(fires([.mods(true, false), .mods(false, true)]) == [], "swapping keys without overlap does not fire")
	}

	// MARK: flagsChanged → 左右 ⌘

	static let released: UInt = 0x100
	static let command = NSEvent.ModifierFlags.command.rawValue
	static let leftDown = command | 0x100 | modPairDeviceLeftCommand
	static let rightDown = command | 0x100 | modPairDeviceRightCommand
	static let bothDown = leftDown | rightDown

	static func commandState() {
		func state(_ previous: (Bool, Bool), _ keyCode: UInt16, _ flags: UInt) -> [Bool] {
			let next = modPairCommandState(previous: (left: previous.0, right: previous.1), keyCode: keyCode, flags: flags)
			return [next.left, next.right]
		}
		check(modPairDeviceLeftCommand == 0x08 && modPairDeviceRightCommand == 0x10, "device bits match NX_DEVICELCMDKEYMASK / NX_DEVICERCMDKEYMASK")
		check(state((false, false), 55, leftDown) == [true, false], "left command down is read from its device bit")
		check(state((true, false), 54, bothDown) == [true, true], "right command down while left is held")
		check(state((true, true), 55, rightDown) == [false, true], "left command up while right is held")
		check(state((true, true), 54, released) == [false, false], "no command flag means both are up")
		check(state((true, true), 56, NSEvent.ModifierFlags.shift.rawValue | 0x102) == [false, false], "a missed key-up heals on the next flags change of any modifier")
		check(state((false, false), 54, bothDown) == [true, true], "device bits win over what was tracked before")

		// 合成事件:只有 ⌘ 标志,没有设备位 → 按键码翻转。
		check(state((false, false), 55, command) == [true, false], "without device bits the key code tells which side went down")
		check(state((true, false), 54, command) == [true, true], "without device bits the second key code completes the pair")
		check(state((true, true), 54, command) == [true, false], "without device bits a repeated key code is that key going up")
		check(state((true, false), 55, 0) == [false, false], "without device bits a cleared command flag still resets both")
		check(state((true, false), 55, command) == [true, false], "a toggle that would leave nothing down while command is set counts as a key down")
		check(state((true, false), 56, command | NSEvent.ModifierFlags.shift.rawValue) == [true, false], "another modifier's change keeps the tracked state")
		check(state((false, false), 56, command | NSEvent.ModifierFlags.shift.rawValue) == [false, false], "an unknown side stays unknown")

		check(modPairDisqualified(flags: leftDown | NSEvent.ModifierFlags.shift.rawValue), "shift disqualifies")
		check(modPairDisqualified(flags: leftDown | NSEvent.ModifierFlags.option.rawValue), "option disqualifies")
		check(modPairDisqualified(flags: leftDown | NSEvent.ModifierFlags.control.rawValue), "control disqualifies")
		check(!modPairDisqualified(flags: bothDown), "command alone does not disqualify")
		check(!modPairDisqualified(flags: bothDown | NSEvent.ModifierFlags.capsLock.rawValue | NSEvent.ModifierFlags.function.rawValue), "caps lock and fn do not disqualify")
	}

	// MARK: 窗口

	static func windows() {
		func entry(pid: Int, id: Int, x: Double, y: Double, w: Double, h: Double, layer: Int = 0, name: String? = nil, alpha: Double? = nil) -> [String: Any] {
			var item: [String: Any] = [
				kCGWindowOwnerPID as String: pid, kCGWindowNumber as String: id, kCGWindowLayer as String: layer,
				kCGWindowBounds as String: ["X": x, "Y": y, "Width": w, "Height": h],
			]
			if let name { item[kCGWindowName as String] = name }
			if let alpha { item[kCGWindowAlpha as String] = alpha }
			return item
		}
		let entries = [
			entry(pid: 7, id: 1, x: 0, y: 0, w: 1440, h: 24, layer: 25),
			entry(pid: 9, id: 2, x: 10, y: 10, w: 500, h: 400, name: "Other app"),
			entry(pid: 7, id: 3, x: 300, y: 200, w: 480, h: 300, alpha: 0),
			entry(pid: 7, id: 4, x: 320, y: 220, w: 420, h: 260),
			entry(pid: 7, id: 5, x: 100, y: 80, w: 900, h: 700, name: "Document"),
			[kCGWindowOwnerPID as String: 7, kCGWindowLayer as String: 0],
		]
		let found = hotkeyWindowCandidates(pid: 7, entries: entries)
		check(found.map(\.windowId) == [4, 5], "candidates keep front-to-back order and skip other apps, other layers, transparent and malformed entries")
		check(found[0].title == "" && found[1].title == "Document", "a missing window name becomes an empty title")
		check(hotkeyWindowCandidates(pid: 11, entries: entries).isEmpty, "an app without windows has no candidates")

		let sheet = HotkeyWindowCandidate(windowId: 4, bounds: CGRect(x: 320, y: 220, width: 420, height: 260), title: "")
		let document = HotkeyWindowCandidate(windowId: 5, bounds: CGRect(x: 100, y: 80, width: 900, height: 700), title: "Document")
		let tiny = HotkeyWindowCandidate(windowId: 6, bounds: CGRect(x: 0, y: 0, width: 40, height: 20), title: "")
		check(hotkeyTopWindow([tiny, document])?.windowId == 5, "the top window skips tiny overlays")
		check(hotkeyTopWindow([tiny])?.windowId == 6 && hotkeyTopWindow([]) == nil, "a tiny window is better than none")
		check(hotkeyNeedsFocusedWindow([sheet, document]) && !hotkeyNeedsFocusedWindow([document, sheet]) && hotkeyNeedsFocusedWindow([]), "AX is asked only when the top window has no title")

		let focusedDocument = HotkeyFocusedWindow(frame: CGRect(x: 101, y: 80, width: 900, height: 699), title: "Report.pages")
		check(hotkeyResolveWindow([sheet, document], focused: focusedDocument) == (5, "Report.pages"), "the focused window is matched by frame even when a sheet is on top")
		check(hotkeyResolveWindow([sheet, document], focused: HotkeyFocusedWindow(frame: CGRect(x: 0, y: 0, width: 10, height: 10), title: "Elsewhere")) == (4, "Elsewhere"), "an unmatched focused window falls back to the top window")
		check(hotkeyResolveWindow([sheet, document], focused: HotkeyFocusedWindow(frame: nil, title: "No frame")) == (4, "No frame"), "a focused window without a frame falls back to the top window")
		check(hotkeyResolveWindow([document], focused: HotkeyFocusedWindow(frame: document.bounds, title: "")) == (5, "Document"), "an empty AX title falls back to the window name")
		check(hotkeyResolveWindow([document, sheet], focused: nil) == (5, "Document"), "without AX the top window and its name are used")
		check(hotkeyResolveWindow([], focused: HotkeyFocusedWindow(frame: nil, title: "Only a title")) == (0, "Only a title"), "no window on screen leaves windowId 0")
		check(hotkeyResolveWindow([], focused: nil) == (0, ""), "nothing known leaves 0 and an empty title")
	}

	// MARK: 事件形状

	static func eventShape() {
		let snapshot = HotkeyFrontSnapshot(pid: 4242, app: "Notes", bundleId: "com.example.notes", windows: [
			HotkeyWindowCandidate(windowId: 77, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), title: ""),
		])
		let front = hotkeyFrontJSON(snapshot, focused: HotkeyFocusedWindow(frame: snapshot.windows[0].bounds, title: "  Shopping\n list  "))
		check(Set(front.keys) == ["bundleId", "app", "pid", "windowId", "title"], "front has exactly the five documented fields")
		check(front["bundleId"] as? String == "com.example.notes" && front["app"] as? String == "Notes" && front["pid"] as? Int == 4242 && front["windowId"] as? Int == 77, "front carries the app and window identity")
		check(front["title"] as? String == "Shopping list", "the title is collapsed to one line")
		let long = hotkeyFrontJSON(snapshot, focused: HotkeyFocusedWindow(frame: nil, title: String(repeating: "长", count: 500)))
		check((long["title"] as? String)?.count == RecorderLimit.title, "the title is capped like recorder titles")
		let bare = hotkeyFrontJSON(HotkeyFrontSnapshot(pid: 5, app: "", bundleId: "", windows: []), focused: nil)
		check(bare["bundleId"] as? String == "" && bare["windowId"] as? Int == 0 && bare["title"] as? String == "", "unavailable fields are empty or zero, never missing")

		func decoded(_ object: [String: Any]) -> [String: Any]? {
			guard let line = recorderJSONLine(object) else { return nil }
			return (try? JSONSerialization.jsonObject(with: line.dropLast())) as? [String: Any]
		}
		let event = decoded(hotkeyEvent(gesture: "modPair", at: 1_760_000_000_123, front: front))
		let body = event?["ev"] as? [String: Any]
		check(event?.count == 1 && Set(body?.keys.map { $0 } ?? []) == ["t", "kind", "gesture", "front"], "an event is one {\"ev\":{t,kind,gesture,front}} line")
		check(body?["t"] as? Int == 1_760_000_000_123 && body?["kind"] as? String == "hotkey" && body?["gesture"] as? String == "modPair", "the event carries its time, kind and gesture")
		check((body?["front"] as? [String: Any])?["windowId"] as? Int == 77, "front survives serialization")
		let unknown = decoded(hotkeyEvent(gesture: "modPair", at: 1, front: nil))?["ev"] as? [String: Any]
		check(unknown?["front"] is NSNull, "an undetermined front is JSON null")
	}

	// MARK: 订阅流

	/// 一条订阅连接的读端:非阻塞地把已到的行读出来。
	final class Reader {
		let fd: Int32
		private var buffer = [UInt8]()
		private(set) var lines: [[String: Any]] = []

		init(fd: Int32) {
			self.fd = fd
			_ = fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK)
		}

		func drain() {
			var chunk = [UInt8](repeating: 0, count: 65536)
			while true {
				let count = read(fd, &chunk, chunk.count)
				if count <= 0 { break }
				buffer.append(contentsOf: chunk[0..<count])
			}
			while let newline = buffer.firstIndex(of: 0x0A) {
				let line = Data(buffer[buffer.startIndex..<newline])
				buffer.removeSubrange(buffer.startIndex...newline)
				if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { lines.append(object) }
			}
		}

		/// 等到一共收到 count 行(最多 2 秒)。不转主线程的 run loop:监听回调不会插进来。
		func wait(count: Int) {
			let deadline = Date().addingTimeInterval(2)
			drain()
			while lines.count < count && Date() < deadline {
				usleep(10_000)
				drain()
			}
		}

		/// 确认没有新行:先让投递排空,再留一小段时间给写队列。
		func settle() {
			usleep(150_000)
			drain()
		}

		var events: [[String: Any]] { lines.compactMap { $0["ev"] as? [String: Any] } }
	}

	static func subscriptionStream() {
		let monitor = HotkeyMonitor.shared
		var frontPid: pid_t = 4242
		var front: HotkeyFrontSnapshot? {
			HotkeyFrontSnapshot(pid: frontPid, app: "Notes", bundleId: "com.example.notes", windows: [
				HotkeyWindowCandidate(windowId: 77, bounds: CGRect(x: 0, y: 0, width: 800, height: 600), title: ""),
			])
		}
		var frontKnown = true
		var focusedReads = 0
		monitor.frontmost = { frontKnown ? front : nil }
		monitor.focusedWindow = { _ in
			focusedReads += 1
			return HotkeyFocusedWindow(frame: CGRect(x: 0, y: 0, width: 800, height: 600), title: "Shopping list")
		}
		monitor.secureInputActive = { false }

		var first: [Int32] = [0, 0]
		var second: [Int32] = [0, 0]
		precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &first) == 0 && socketpair(AF_UNIX, SOCK_STREAM, 0, &second) == 0)
		let readerA = Reader(fd: first[1])
		let readerB = Reader(fd: second[1])

		monitor.accessibilityTrusted = { false }
		check(monitor.subscribe(fd: first[0], id: "h0", gesture: "tripleTap", excludePids: [])?.code == "unknown_gesture", "an unknown gesture is rejected")
		check(monitor.subscribe(fd: first[0], id: "h0", gesture: nil, excludePids: [])?.code == "unknown_gesture", "a missing gesture is rejected the same way")
		check(monitor.subscribe(fd: first[0], id: "h0", gesture: "modPair", excludePids: [])?.code == "accessibility_denied", "without Accessibility the subscription is denied")
		readerA.settle()
		check(monitor.subscriberCount == 0 && readerA.lines.isEmpty, "a rejected subscription registers nothing and writes nothing itself")

		monitor.accessibilityTrusted = { true }
		check(monitor.subscribe(fd: first[0], id: "h1", gesture: "modPair", excludePids: [999]) == nil, "a trusted subscription succeeds")
		check(monitor.subscribe(fd: second[0], id: "h2", gesture: "modPair", excludePids: [4242, 1]) == nil, "a second subscriber is accepted")
		check(monitor.subscriberCount == 2, "both subscribers are registered")
		readerA.wait(count: 1)
		readerB.wait(count: 1)
		let ack = readerA.lines.first
		check(ack?["id"] as? String == "h1" && ack?["ok"] as? Bool == true, "the reply is the first line and echoes the id")
		check((ack?["result"] as? [String: Any])?.count == 1 && (ack?["result"] as? [String: Any])?["subscribed"] as? Bool == true, "the reply is exactly {subscribed:true}")
		check(readerB.lines.first?["id"] as? String == "h2", "each subscriber gets its own reply")

		RunLoop.main.run(until: Date().addingTimeInterval(0.2)) // 全局监听靠主队列装上
		check(monitor.debugMonitorsInstalled, "the first subscriber installs the global monitors")

		/// 先归零(转 run loop 时真键盘的事件可能进来过),再同步喂一串 flagsChanged;中途不转 run loop。
		func press(_ steps: [(UInt16, UInt)], key afterFirst: Bool = false) {
			monitor.flagsChanged(keyCode: 0, flags: released)
			for (index, step) in steps.enumerated() {
				monitor.flagsChanged(keyCode: step.0, flags: step.1)
				if index == 0 && afterFirst { monitor.otherKeyDown() }
			}
			monitor.flagsChanged(keyCode: 0, flags: released)
			monitor.debugDrain()
		}
		let pair: [(UInt16, UInt)] = [(55, leftDown), (54, bothDown)]

		let before = Int64(Date().timeIntervalSince1970 * 1000)
		press(pair)
		readerA.wait(count: 2)
		readerB.settle()
		let event = readerA.events.first
		let eventFront = event?["front"] as? [String: Any]
		check(readerA.lines.count == 2 && Set(event?.keys.map { $0 } ?? []) == ["t", "kind", "gesture", "front"], "the gesture streams one ev line")
		check(event?["kind"] as? String == "hotkey" && event?["gesture"] as? String == "modPair", "the event names its kind and gesture")
		check(((event?["t"] as? Int).map { Int64($0) >= before && Int64($0) <= before + 5000 }) == true, "t is the epoch time of the gesture in milliseconds")
		check(eventFront?["bundleId"] as? String == "com.example.notes" && eventFront?["app"] as? String == "Notes" && eventFront?["pid"] as? Int == 4242
			&& eventFront?["windowId"] as? Int == 77 && eventFront?["title"] as? String == "Shopping list", "front describes the frontmost app and its focused window")
		check(focusedReads == 1, "the focused window is read once per gesture")
		check(readerB.lines.count == 1, "a subscriber that excludes the frontmost pid gets nothing")

		press([(54, rightDown), (55, bothDown)])
		readerA.wait(count: 3)
		check(readerA.lines.count == 3, "right then left fires too")

		press(pair, key: true)
		press([(56, NSEvent.ModifierFlags.shift.rawValue | 0x102), (55, leftDown | NSEvent.ModifierFlags.shift.rawValue), (54, bothDown | NSEvent.ModifierFlags.shift.rawValue)])
		press([(55, leftDown), (55, leftDown), (55, released), (54, rightDown), (54, released)])
		readerA.settle()
		check(readerA.lines.count == 3, "a key in between, a held shift, or the two keys one after the other do not fire")

		monitor.secureInputActive = { true }
		press(pair)
		readerA.settle()
		check(readerA.lines.count == 3, "nothing fires while Secure Input is on")
		monitor.secureInputActive = { false }

		frontPid = getpid()
		press(pair)
		readerA.settle()
		check(readerA.lines.count == 3, "nothing fires while the helper itself is frontmost")

		frontPid = 5000
		press(pair)
		readerA.wait(count: 4)
		readerB.wait(count: 2)
		check((readerA.events.last?["front"] as? [String: Any])?["pid"] as? Int == 5000 && (readerB.events.last?["front"] as? [String: Any])?["pid"] as? Int == 5000, "every subscriber that does not exclude the frontmost pid gets the event")

		frontKnown = false
		press(pair)
		readerA.wait(count: 5)
		readerB.wait(count: 3)
		check(readerA.events.last?["front"] is NSNull && readerB.events.last?["front"] is NSNull, "an undetermined front is sent as null to everyone")
		frontKnown = true

		// 真的 NSEvent 走一遍入口(不往系统里发):键码与标志是从事件上读出来的。
		func flagsEvent(_ keyCode: UInt16, _ flags: UInt) -> NSEvent? {
			NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: NSEvent.ModifierFlags(rawValue: flags), timestamp: 0, windowNumber: 0, context: nil, characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: keyCode)
		}
		if let reset = flagsEvent(54, released), let down = flagsEvent(55, leftDown), let second = flagsEvent(54, bothDown) {
			for next in [reset, down, second, reset] { monitor.handle(next) }
			monitor.debugDrain()
			readerA.wait(count: 6)
			check(readerA.lines.count == 6, "flagsChanged NSEvents drive the same path")
		} else {
			check(false, "flagsChanged NSEvents can be constructed")
		}

		monitor.unsubscribe(fd: second[0])
		check(monitor.subscriberCount == 1, "closing one connection leaves the other subscribed")
		RunLoop.main.run(until: Date().addingTimeInterval(0.2))
		check(monitor.debugMonitorsInstalled, "the monitors stay while a subscriber remains")
		readerB.settle()
		let countB = readerB.lines.count
		press(pair)
		readerA.wait(count: 7)
		readerB.settle()
		check(readerA.lines.count == 7 && readerB.lines.count == countB, "an unsubscribed connection gets nothing more")

		monitor.unsubscribe(fd: first[0])
		monitor.unsubscribe(fd: first[0])
		check(monitor.subscriberCount == 0, "unsubscribing twice is harmless and empties the registry")
		let settle = Date().addingTimeInterval(3)
		while monitor.debugMonitorsInstalled && Date() < settle { RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
		check(!monitor.debugMonitorsInstalled, "the last subscriber leaving removes the global monitors")
		press(pair)
		readerA.settle()
		check(readerA.lines.count == 7, "nothing is streamed after the last subscriber leaves")
		check(readerA.lines.dropFirst().allSatisfy { ($0["ev"] as? [String: Any])?["kind"] as? String == "hotkey" }, "every streamed line after the reply is a hotkey ev")
		for fd in first + second { close(fd) }
	}
}
