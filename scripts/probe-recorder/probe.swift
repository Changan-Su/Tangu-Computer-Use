// Computer History step-0 probe. Answers, per running app and with Accessibility ONLY (no Screen
// Recording, never enabling AXEnhancedUserInterface / AXManualAccessibility itself):
//   - can we read the focused window title via AX?
//   - do browsers expose the active URL (AXWebArea AXURL or the address field) without enhanced mode?
//   - which AX notifications fire while the user works (ValueChanged for typing, TitleChanged for tabs)?
//   - do NSEvent global monitors (mouse down, modified key down) deliver under Accessibility alone?
//   - which signal (title / menu item / toolbar label / identifier) tells a browser's private window apart?
//     (`privateSignals` per browser row; Safari stays "treated as private" in the recorder until this finds one)
// Privacy: the report holds booleans, counts, lengths and URL schemes only — never titles, text or hosts.
// Usage: ch-probe.app/Contents/MacOS/probe <out.json> <liveSeconds>   (launch with `open -n -g ... --args`)
import AppKit
import ApplicationServices
import Carbon

let args = CommandLine.arguments
let outPath = args.count > 1 ? args[1] : NSTemporaryDirectory() + "ch-probe.json"
let liveSeconds = args.count > 2 ? Double(args[2]) ?? 60 : 60

func attr(_ el: AXUIElement, _ name: String) -> AnyObject? {
	var v: AnyObject?
	return AXUIElementCopyAttributeValue(el, name as CFString, &v) == .success ? v : nil
}
func str(_ el: AXUIElement, _ name: String) -> String? { attr(el, name) as? String }
func children(_ el: AXUIElement) -> [AXUIElement] { (attr(el, kAXChildrenAttribute) as? [AXUIElement]) ?? [] }
func bool(_ el: AXUIElement, _ name: String) -> Bool? { (attr(el, name) as? NSNumber)?.boolValue }

// Bounded BFS: the probe must itself stay cheap (this is exactly the cost question).
func findWebURL(_ root: AXUIElement) -> (webArea: Bool, url: String?, addressField: Bool, nodes: Int) {
	var queue: [(AXUIElement, Int)] = [(root, 0)]
	var nodes = 0, webArea = false, addressField = false
	var url: String?
	while !queue.isEmpty && nodes < 2500 {
		let (el, depth) = queue.removeFirst()
		nodes += 1
		let role = str(el, kAXRoleAttribute) ?? ""
		if role == "AXWebArea" {
			webArea = true
			if url == nil, let u = attr(el, "AXURL") { url = (u as? URL)?.absoluteString ?? (u as? String) }
			continue // never descend into page content
		}
		if role == "AXTextField" || role == "AXComboBox" {
			let label = ((str(el, kAXDescriptionAttribute) ?? "") + " " + (str(el, "AXIdentifier") ?? "") + " " + (str(el, kAXTitleAttribute) ?? "")).lowercased()
			if label.contains("address") || label.contains("地址") || label.contains("url") || label.contains("search or enter") {
				addressField = true
				if url == nil, let v = str(el, kAXValueAttribute), !v.isEmpty { url = v.contains("://") ? v : "addressbar:" + v }
			}
		}
		if depth < 14 { for c in children(el) { queue.append((c, depth + 1)) } }
	}
	return (webArea, url, addressField, nodes)
}

// Private-window signals for browsers (the recorder treats Safari as private until one of these is proven).
// Run once with a private window in front of the browser and once with a normal window, then compare
// `privateSignals`. Only booleans, counts and developer identifiers are reported — never titles or labels.
let privateMarkers = ["private browsing", "private window", "incognito", "inprivate", "无痕", "無痕", "隐私浏览", "私密浏览", "隐身"]
func hasMarker(_ text: String?) -> Bool {
	guard let lower = text?.lowercased() else { return false }
	return privateMarkers.contains { lower.contains($0) }
}
let browserHints = ["safari", "chrome", "firefox", "edgemac", "brave", "vivaldi", "opera", "thebrowser", "kfmac", "duckduckgo", "zen"]

func privateSignals(app: AXUIElement, window: AXUIElement) -> [String: Any] {
	var out: [String: Any] = ["titleMarker": hasMarker(str(window, kAXTitleAttribute)), "documentAttr": attr(window, "AXDocument") != nil]
	// Menu bar: e.g. Safari's Window menu says "Move Tab to New Private Window" in a private window.
	var menuItems = 0, menuHits = 0
	if let bar = attr(app, kAXMenuBarAttribute) {
		for top in children(bar as! AXUIElement) {
			for menu in children(top) {
				for item in children(menu) {
					menuItems += 1
					if hasMarker(str(item, kAXTitleAttribute)) { menuHits += 1 }
				}
			}
		}
	}
	out["menuItems"] = menuItems
	out["menuMarkerItems"] = menuHits
	// Window chrome outside web content: which roles / attributes carry a marker, plus developer identifiers.
	var queue: [(AXUIElement, Int)] = [(window, 0)]
	var nodes = 0
	var hits: [String: Int] = [:]
	var identifiers = Set<String>()
	while !queue.isEmpty && nodes < 800 {
		let (el, depth) = queue.removeFirst()
		nodes += 1
		let role = str(el, kAXRoleAttribute) ?? ""
		if role == "AXWebArea" { continue }
		for name in [kAXTitleAttribute, kAXDescriptionAttribute, kAXHelpAttribute, "AXPlaceholderValue"] where hasMarker(str(el, name)) {
			hits["\(role).\(name)", default: 0] += 1
		}
		if let id = str(el, "AXIdentifier"), id.range(of: #"^[A-Za-z0-9_.:-]{1,64}$"#, options: .regularExpression) != nil, identifiers.count < 120 {
			identifiers.insert("\(role)#\(id)")
		}
		if depth < 14 { for c in children(el) { queue.append((c, depth + 1)) } }
	}
	out["chromeNodes"] = nodes
	out["chromeMarkerHits"] = hits
	out["identifiers"] = identifiers.sorted()
	return out
}

func scheme(_ url: String?) -> String? {
	guard let url else { return nil }
	if url.hasPrefix("addressbar:") { return "addressbar-text" }
	return URL(string: url)?.scheme ?? "unparsed"
}

if !AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary) {
	// Registers ch-probe in System Settings > Accessibility (unchecked) and shows the system prompt.
	FileManager.default.createFile(atPath: outPath, contents: #"{"axTrusted":false}"#.data(using: .utf8))
	exit(0)
}

var snapshot: [[String: Any]] = []
for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
	let pid = app.processIdentifier
	let el = AXUIElementCreateApplication(pid)
	AXUIElementSetMessagingTimeout(el, 0.5)
	let started = Date()
	var row: [String: Any] = ["bundleId": app.bundleIdentifier ?? "?", "name": app.localizedName ?? "?"]
	row["enhancedAlreadyOn"] = bool(el, "AXEnhancedUserInterface") as Any
	row["manualAlreadyOn"] = bool(el, "AXManualAccessibility") as Any
	let windows = (attr(el, kAXWindowsAttribute) as? [AXUIElement]) ?? []
	row["windowCount"] = windows.count
	row["windowsWithTitle"] = windows.filter { !(str($0, kAXTitleAttribute) ?? "").isEmpty }.count
	if let fw = attr(el, kAXFocusedWindowAttribute) {
		let w = fw as! AXUIElement
		row["focusedWindowTitleLen"] = (str(w, kAXTitleAttribute) ?? "").count
		let web = findWebURL(w)
		row["webArea"] = web.webArea
		row["addressField"] = web.addressField
		row["urlScheme"] = scheme(web.url) as Any
		row["nodesWalked"] = web.nodes
		let bundle = (app.bundleIdentifier ?? "").lowercased()
		if browserHints.contains(where: { bundle.contains($0) }) { row["privateSignals"] = privateSignals(app: el, window: w) }
	}
	if let fe = attr(el, kAXFocusedUIElementAttribute) {
		let f = fe as! AXUIElement
		row["focusedRole"] = str(f, kAXRoleAttribute) ?? ""
		row["focusedSubrole"] = str(f, kAXSubroleAttribute) ?? ""
		row["focusedValueLen"] = (str(f, kAXValueAttribute) ?? "").count
		row["focusedCharCount"] = (attr(f, kAXNumberOfCharactersAttribute) as? NSNumber)?.intValue as Any
	}
	row["ms"] = Int(Date().timeIntervalSince(started) * 1000)
	snapshot.append(row)
}

// ---- live phase: observe the frontmost app while the user works ----
final class Live {
	var counts: [String: [String: Int]] = [:]
	var valueLenSamples: [String: [Int]] = [:]
	var secureInputSeen = 0
	var observer: AXObserver?
	var observedPid: pid_t = 0
	var mouseDowns = 0, modifiedKeys = 0, plainKeys = 0
	func bump(_ bundle: String, _ key: String) { counts[bundle, default: [:]][key, default: 0] += 1 }
	func bundle(of pid: pid_t) -> String { NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "?" }

	func observeFrontmost() {
		guard let app = NSWorkspace.shared.frontmostApplication else { return }
		let pid = app.processIdentifier
		if pid == observedPid { return }
		if let old = observer { CFRunLoopRemoveSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(old), .defaultMode) }
		observer = nil
		observedPid = pid
		bump(bundle(of: pid), "activated")
		var obs: AXObserver?
		let cb: AXObserverCallback = { _, element, note, refcon in
			let me = Unmanaged<Live>.fromOpaque(refcon!).takeUnretainedValue()
			var pid: pid_t = 0
			AXUIElementGetPid(element, &pid)
			let b = me.bundle(of: pid)
			me.bump(b, note as String)
			if (note as String) == kAXValueChangedNotification {
				if IsSecureEventInputEnabled() { me.secureInputSeen += 1 }
				let role = str(element, kAXRoleAttribute) ?? ""
				me.bump(b, "value:" + role)
				me.valueLenSamples[b, default: []].append((str(element, kAXValueAttribute) ?? "").count)
			}
		}
		guard AXObserverCreate(pid, cb, &obs) == .success, let obs else { bump(bundle(of: pid), "observerCreateFailed"); return }
		let appEl = AXUIElementCreateApplication(pid)
		AXUIElementSetMessagingTimeout(appEl, 0.5)
		let refcon = Unmanaged.passUnretained(self).toOpaque()
		for n in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXTitleChangedNotification,
		          kAXFocusedUIElementChangedNotification, kAXValueChangedNotification, kAXSelectedTextChangedNotification] {
			let r = AXObserverAddNotification(obs, appEl, n as CFString, refcon)
			if r != .success { bump(bundle(of: pid), "addFail:" + n) }
		}
		CFRunLoopAddSource(CFRunLoopGetMain(), AXObserverGetRunLoopSource(obs), .defaultMode)
		observer = obs
	}
}

let live = Live()
NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { _ in live.observeFrontmost() }
let mouseMon = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { _ in live.mouseDowns += 1 }
let keyMon = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { e in
	if !e.modifierFlags.intersection([.command, .control]).isEmpty { live.modifiedKeys += 1 } else { live.plainKeys += 1 }
}
live.observeFrontmost()

DispatchQueue.main.asyncAfter(deadline: .now() + liveSeconds) {
	var lenStats: [String: Any] = [:]
	for (b, s) in live.valueLenSamples { lenStats[b] = ["n": s.count, "max": s.max() ?? 0] }
	let report: [String: Any] = [
		"axTrusted": AXIsProcessTrusted(),
		"screenRecording": CGPreflightScreenCaptureAccess(),
		"snapshot": snapshot,
		"live": ["seconds": liveSeconds, "notifications": live.counts, "valueLen": lenStats,
		         "secureInputDuringValueChange": live.secureInputSeen,
		         "globalMouseDownMonitor": mouseMon != nil, "mouseDowns": live.mouseDowns,
		         "globalKeyMonitor": keyMon != nil, "modifiedKeyDowns": live.modifiedKeys, "plainKeyDowns": live.plainKeys],
	]
	let data = try! JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
	FileManager.default.createFile(atPath: outPath, contents: data)
	exit(0)
}
NSApplication.shared.setActivationPolicy(.accessory)
NSApp.run()
