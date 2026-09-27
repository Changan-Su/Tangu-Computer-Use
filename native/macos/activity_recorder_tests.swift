import AppKit
import Foundation

// 电脑历史采集器的单测(npm run check:recorder-logic),不需要任何授权。
// 纯逻辑:差分 / 截断 / 无痕判定 / 浏览器与 bundle 匹配 / 快捷键串 / URL 清洗 / 按订阅者过滤 / 锁屏判定 /
// 点击归属与点击读取的属性 / 情境事件的去重与无痕窗口 / 焦点框变成密码框(读值闸)/ 情境刷新时待发输入的去留 /
// 同标题换站点 / 有上限遍历(假树)/ 无痕扫描计数 / agent 计数 / 订阅写队列。
// subscriptionStream 走真实的订阅路径:会装上主线程观察者与 NSEvent 全局监听、对前台 App 发 AX 读取
// (本进程没有辅助功能授权时这些读取都失败、键盘监听收不到东西),只断言事件形状与退订后的拆除状态,绝不打印事件内容。
@main struct ActivityRecorderTests {
	static func check(_ yes: Bool, _ name: String) {
		precondition(yes, name)
		print("PASS \(name)")
	}

	static func main() {
		setvbuf(stdout, nil, _IOLBF, 0)
		textDiff()
		truncation()
		privateMarkers()
		urls()
		domains()
		bundles()
		keys()
		filtering()
		privateContextDelivery()
		secureFieldFlip()
		browsers()
		sessionLock()
		clickOwner()
		pendingOnRefresh()
		sameTitleNavigation()
		boundedWalk()
		scanStats()
		agentGate()
		subscriberQueue()
		subscriptionStream(locked: false)
		subscriptionStream(locked: true)
	}

	static func textDiff() {
		check(recorderTextDiff(old: "abc", new: "abc") == nil, "identical values produce no diff")
		check(recorderTextDiff(old: "", new: "hello") == RecorderTextDiff(inserted: "hello", deleted: 0), "insert into empty")
		check(recorderTextDiff(old: "hello world", new: "hello brave world") == RecorderTextDiff(inserted: "brave ", deleted: 0), "insert in the middle")
		check(recorderTextDiff(old: "hello world", new: "hello") == RecorderTextDiff(inserted: "", deleted: 6), "pure deletion reports only a count")
		check(recorderTextDiff(old: "cat", new: "cot") == RecorderTextDiff(inserted: "o", deleted: 1), "replacement reports segment and count")
		check(recorderTextDiff(old: "aa", new: "aaa") == RecorderTextDiff(inserted: "a", deleted: 0), "repeated characters never overlap prefix and suffix")
		check(recorderTextDiff(old: "你好", new: "你们好") == RecorderTextDiff(inserted: "们", deleted: 0), "CJK diff is per character")
		check(recorderTextDiff(old: "hi 👋🏽", new: "hi 👋🏽!") == RecorderTextDiff(inserted: "!", deleted: 0), "emoji clusters are never split")

		// 聊天框:打字 → 回车发送 → 被清空。停手时 final 为空,必须按采样到的 latest 报。
		check(recorderSettleText(baseline: "", latest: "hello", final: "") == RecorderTextDiff(inserted: "hello", deleted: 0), "cleared-after-send falls back to the sampled value")
		check(recorderSettleText(baseline: "draft", latest: "draft more", final: "draft more!") == RecorderTextDiff(inserted: " more!", deleted: 0), "normal typing uses the final value")
		check(recorderSettleText(baseline: "abc", latest: nil, final: "ab") == RecorderTextDiff(inserted: "", deleted: 1), "deletion without samples stays a deletion")
		check(recorderSettleText(baseline: "x", latest: "x", final: "x") == nil, "no change settles to nothing")

		let fields = recorderTextFields(RecorderTextDiff(inserted: String(repeating: "字", count: 600), deleted: 3))
		check((fields["text"] as? String)?.count == RecorderLimit.text && fields["truncated"] as? Bool == true && fields["deleted"] as? Int == 3, "long insert is capped at 500 with truncated")
		let deletion = recorderTextFields(RecorderTextDiff(inserted: "", deleted: 12))
		check(deletion["text"] == nil && deletion["deleted"] as? Int == 12, "pure deletion emits deleted without text")
	}

	static func truncation() {
		check(recorderTruncate("abc", max: 5) == ("abc", false), "short strings are untouched")
		check(recorderTruncate("abcdef", max: 3) == ("abc", true), "long strings are cut and flagged")
		check(recorderLabel("  Send\n  message  ") == "Send message", "labels collapse whitespace and newlines")
		check(recorderLabel("   ") == nil, "blank labels are dropped")
		check(recorderLabel(String(repeating: "x", count: 200))?.count == RecorderLimit.label, "labels are capped at 80")
		check(recorderTitle(String(repeating: "t", count: 300))?.count == RecorderLimit.title, "titles are capped at 200")
		check(recorderFirstNonEmpty(nil, "", "b", "c") == "b", "first non-empty label wins")
	}

	static func privateMarkers() {
		check(recorderHasPrivateMarker("Example — Private Browsing"), "Firefox private title")
		check(recorderHasPrivateMarker("New Tab - Google Chrome (Incognito)"), "Chrome incognito title")
		check(recorderHasPrivateMarker("[InPrivate] Bing"), "Edge InPrivate title")
		check(recorderHasPrivateMarker("新标签页 - 无痕模式"), "Chinese incognito title")
		check(recorderHasPrivateMarker("隐私浏览"), "Safari Chinese private title")
		check(!recorderHasPrivateMarker("Pull requests · Private repo"), "the bare word private is not a marker")
		check(!recorderHasPrivateMarker("Inbox (3) - Gmail"), "ordinary titles are not private")
	}

	static func urls() {
		check(recorderSanitizeURL("https://example.com/path?token=abc#frag") == "https://example.com/path", "query and fragment are stripped")
		check(recorderSanitizeURL("https://user:pw@example.com/a") == "https://example.com/a", "credentials are stripped")
		check(recorderSanitizeURL("example.com/docs") == "https://example.com/docs", "scheme-less address bar text gets https")
		check(recorderSanitizeURL("how to cook rice") == nil, "search text is not a URL")
		check(recorderSanitizeURL("file:///Users/me/secret.pdf") == nil, "non-web schemes are rejected")
		check(recorderSanitizeURL("chrome://newtab") == nil, "browser-internal pages are rejected")
		let long = recorderSanitizeURL("https://example.com/" + String(repeating: "p", count: 400))
		check(long?.count == RecorderLimit.url, "URLs are capped at 300")
		check(recorderURLHost("https://Docs.Example.com/x") == "docs.example.com", "host is lowercased")
		check(recorderIsAddressFieldLabel("Address and search bar"), "Chrome address field label")
		check(!recorderIsAddressFieldLabel("Message"), "ordinary field is not the address bar")
	}

	static func domains() {
		check(recorderNormalizeDomain("https://www.Example.com/path") == "www.example.com", "scheme and path are removed")
		check(recorderNormalizeDomain("*.example.com") == "example.com", "leading wildcard is removed")
		check(recorderNormalizeDomain(".example.com.") == "example.com", "leading and trailing dots are removed")
		check(recorderNormalizeDomain("example.com:8443") == "example.com", "port is removed")
		check(recorderNormalizeDomain("   ") == nil, "blank domain is rejected")
		check(recorderHostMatches("example.com", domain: "example.com"), "exact host matches")
		check(recorderHostMatches("mail.example.com", domain: "example.com"), "subdomain matches")
		check(recorderHostMatches("MAIL.example.com.", domain: "example.com"), "case and trailing dot are ignored")
		check(!recorderHostMatches("badexample.com", domain: "example.com"), "suffix without a dot boundary does not match")
		check(!recorderHostMatches("example.com.evil.net", domain: "example.com"), "prefix does not match")
	}

	static func bundles() {
		check(recorderBundleMatches("com.forsion.desktop", pattern: "com.forsion.*"), "trailing wildcard matches a prefix")
		check(!recorderBundleMatches("com.forsionx.desktop", pattern: "com.forsion.*"), "wildcard respects the dot boundary")
		check(recorderBundleMatches("com.apple.Terminal", pattern: "com.apple.terminal"), "bundle ids compare case-insensitively")
		check(!recorderBundleMatches("com.apple.TerminalX", pattern: "com.apple.Terminal"), "exact pattern does not prefix-match")
		check(recorderHardExcludedBundleIds.contains("com.1password.1password") && recorderHardExcludedBundleIds.contains("com.apple.keychainaccess"), "password managers are hard-excluded")
		check(recorderIsEditableText(role: "AXTextArea", subrole: "", editable: false), "text areas are editable")
		check(!recorderIsEditableText(role: "AXTextField", subrole: "AXSecureTextField", editable: true), "secure fields are never editable text")
		check(!recorderIsEditableText(role: "AXButton", subrole: "", editable: false), "buttons are not editable text")
		check(recorderClickLabelAllowed(role: "AXButton", subrole: ""), "buttons carry a label")
		check(recorderClickLabelAllowed(role: "AXRadioButton", subrole: "AXTabButton"), "tabs carry a label")
		check(!recorderClickLabelAllowed(role: "AXTextField", subrole: ""), "text fields never carry their value as a label")
		check(!recorderClickAttributes.contains(kAXValueAttribute), "a click never reads the hit element's value")
		check(recorderClickAttributes == [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute], "a click reads only role, subrole, title and description")
	}

	static func keys() {
		check(recorderKeyCombo(command: true, control: false, option: false, shift: true, key: "P") == "⌘⇧P", "command shift combo")
		check(recorderKeyCombo(command: false, control: true, option: false, shift: false, key: "C") == "⌃C", "control combo")
		check(recorderKeyCombo(command: false, control: false, option: true, shift: true, key: "A") == nil, "no command or control means no shortcut")
		check(recorderKeyName(keyCode: 0, characters: "a") == "A", "letters are uppercased")
		check(recorderKeyName(keyCode: 36, characters: "\r") == "↩", "return has a symbol")
		check(recorderKeyName(keyCode: 122, characters: "\u{F704}") == "F1", "function keys are named")
		check(recorderKeyName(keyCode: 8, characters: "\u{3}") == nil, "control characters are not key names")
	}

	static func filtering() {
		let chrome = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs", url: "https://docs.example.com/a")
		let open = RecorderPolicy()
		let full = recorderEventBody(kind: .text, context: chrome, policy: open)
		check(full?["title"] as? String == "Docs" && full?["url"] as? String == "https://docs.example.com/a", "default policy keeps title and url")

		let domainOff = RecorderPolicy(json: ["excludeDomains": ["https://example.com/"]])
		let switched = recorderEventBody(kind: .app, context: chrome, policy: domainOff)
		check((switched?["app"] as? [String: Any])?["excluded"] as? Bool == true && switched?["title"] == nil && switched?["url"] == nil, "excluded domain keeps only an excluded app marker")
		check(recorderEventBody(kind: .text, context: chrome, policy: domainOff) == nil, "excluded domain drops text")
		check(recorderEventBody(kind: .click, context: chrome, policy: domainOff) == nil, "excluded domain drops clicks")

		// 排除 App:只有切到它的那一条 app 事件(不带标题),App 里的窗口变化一概不发。
		let appOff = RecorderPolicy(json: ["excludeBundleIds": ["com.google.Chrome"]])
		let appSwitch = recorderEventBody(kind: .app, context: chrome, policy: appOff)
		check((appSwitch?["app"] as? [String: Any])?["excluded"] as? Bool == true && appSwitch?["title"] == nil && appSwitch?["url"] == nil, "excluded app keeps only an untitled app switch")
		check(recorderEventBody(kind: .window, context: chrome, policy: appOff) == nil, "excluded app emits no window events")
		check(recorderEventBody(kind: .key, context: chrome, policy: appOff) == nil, "excluded app drops keys")
		// 排除站点:还留一条不带标题 / 网址的 window 标记(结束同一浏览器里上一页的计时)。
		let domainMarker = recorderEventBody(kind: .window, context: chrome, policy: domainOff)
		check((domainMarker?["app"] as? [String: Any])?["excluded"] as? Bool == true && domainMarker?["title"] == nil && domainMarker?["url"] == nil, "excluded domain keeps a content-free window marker")

		let terminal = RecorderContext(name: "Terminal", bundleId: "com.apple.Terminal", title: "zsh")
		let titleOnly = RecorderPolicy(json: ["titleOnlyBundleIds": ["com.apple.Terminal", "com.forsion.*"]])
		check(recorderEventBody(kind: .window, context: terminal, policy: titleOnly)?["title"] as? String == "zsh", "title-only app keeps its title")
		check(recorderEventBody(kind: .text, context: terminal, policy: titleOnly) == nil, "title-only app drops text")
		let forsion = RecorderContext(name: "Forsion", bundleId: "com.forsion.desktop", title: "Chat")
		check(recorderEventBody(kind: .click, context: forsion, policy: titleOnly) == nil, "wildcard title-only covers Forsion")

		var incognito = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome")
		incognito.isPrivate = true
		let privateApp = recorderEventBody(kind: .app, context: incognito, policy: open)
		check(privateApp != nil && privateApp?["title"] == nil && (privateApp?["app"] as? [String: Any])?["excluded"] == nil, "private window keeps an untitled switch")
		check(recorderEventBody(kind: .text, context: incognito, policy: open) == nil, "private window drops text")
		check(recorderEventBody(kind: .window, context: incognito, policy: open) == nil, "private window emits no window events")

		var keychain = RecorderContext(name: "Keychain Access", bundleId: "com.apple.keychainaccess")
		keychain.hardExcluded = true
		check((recorderEventBody(kind: .app, context: keychain, policy: open)?["app"] as? [String: Any])?["excluded"] as? Bool == true, "hard exclusion cannot be overridden by an open policy")
		check(recorderEventBody(kind: .window, context: keychain, policy: open) == nil, "hard-excluded app emits no window events")

		let noText = RecorderPolicy(json: ["text": false, "clicks": true, "keys": false])
		check(recorderEventBody(kind: .text, context: chrome, policy: noText) == nil, "text switch off drops text")
		check(recorderEventBody(kind: .key, context: chrome, policy: noText) == nil, "keys switch off drops keys")
		check(recorderEventBody(kind: .click, context: chrome, policy: noText) != nil, "clicks stay on")
		check(recorderEventBody(kind: .system, context: nil, policy: open)?["kind"] as? String == "system", "system events pass every policy")

		// 真实路径的策略来自 JSONSerialization(布尔是 __NSCFBoolean,不是 Swift Bool)。
		let wire = #"{"text":false,"clicks":true,"excludeBundleIds":["a.b"],"excludeDomains":["Example.com"]}"#
		let parsed = RecorderPolicy(json: try? JSONSerialization.jsonObject(with: Data(wire.utf8)))
		check(parsed.text == false && parsed.clicks && parsed.keys && parsed.excludeBundleIds == ["a.b"] && parsed.excludeDomains == ["example.com"], "policy parses real JSON booleans and lists")

		let garbage = RecorderPolicy(json: ["excludeBundleIds": "not-a-list", "text": "yes"])
		check(garbage.excludeBundleIds.isEmpty && garbage.text, "malformed policy falls back to defaults")

		let a = recorderContextKey(recorderEventBody(kind: .app, context: chrome, policy: open)!)
		let b = recorderContextKey(recorderEventBody(kind: .window, context: chrome, policy: open)!)
		var retitled = chrome
		retitled.title = "Other"
		check(a == b && a != recorderContextKey(recorderEventBody(kind: .window, context: retitled, policy: open)!), "context key dedupes identical contexts only")

		// 浏览器网址没读到:设了排除站点的订阅者按排除处理(不带标题),没设的照常。
		var unknown = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome.beta", title: "Chase — Accounts")
		unknown.urlUnknown = true
		let failClosed = recorderEventBody(kind: .window, context: unknown, policy: domainOff)
		check((failClosed?["app"] as? [String: Any])?["excluded"] as? Bool == true && failClosed?["title"] == nil, "unknown browser URL fails closed when sites are excluded")
		check(recorderEventBody(kind: .text, context: unknown, policy: domainOff) == nil && recorderEventBody(kind: .click, context: unknown, policy: domainOff) == nil && recorderEventBody(kind: .key, context: unknown, policy: domainOff) == nil, "unknown browser URL drops text, clicks and keys when sites are excluded")
		check(recorderEventBody(kind: .window, context: unknown, policy: open)?["title"] as? String == "Chase — Accounts", "unknown browser URL is recorded when no site is excluded")
		let newTab = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome", title: "New Tab")
		check(recorderEventBody(kind: .window, context: newTab, policy: domainOff)?["title"] as? String == "New Tab", "a resolved page without a web URL is not treated as excluded")
	}

	/// 情境事件对一个订阅者的去重(emit 用的就是这个函数):无痕窗口不发 window 事件,但同一浏览器里切回普通窗口那条照常发出。
	static func privateContextDelivery() {
		let docs = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome", title: "Docs", url: "https://docs.example.com/a")
		let mail = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome", title: "Inbox", url: "https://mail.example.com/")
		var incognito = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome")
		incognito.isPrivate = true
		var key: String?
		func deliver(_ kind: RecorderKind, _ context: RecorderContext, dedupe: Bool, policy: RecorderPolicy = RecorderPolicy()) -> [String: Any]? {
			let (body, next) = recorderContextDelivery(kind: kind, context: context, policy: policy, lastKey: key, dedupe: dedupe)
			key = next
			return body
		}
		check(deliver(.app, docs, dedupe: false)?["title"] as? String == "Docs", "switching into the browser sends a titled app event")
		check(deliver(.window, docs, dedupe: true) == nil, "an identical window event is deduped")
		// 普通 → 无痕 → 普通(同一个浏览器、切回同一个普通窗口)。
		check(deliver(.window, incognito, dedupe: true) == nil, "entering a private window in the same browser sends no window event")
		check(deliver(.window, incognito, dedupe: true) == nil, "staying in private windows sends nothing")
		let back = deliver(.window, docs, dedupe: true)
		check(back?["kind"] as? String == "window" && back?["title"] as? String == "Docs" && back?["url"] as? String == "https://docs.example.com/a", "returning to the same normal window is sent again, not deduped")
		check(deliver(.window, docs, dedupe: true) == nil, "after returning, identical window events are deduped again")
		// 还在无痕窗口时同一 App 重新激活(activated 的 samePid 路径,带去重):不再补一条切换。
		_ = deliver(.window, incognito, dedupe: true)
		check(deliver(.app, incognito, dedupe: true) == nil, "re-activating the browser while still private sends no second switch")
		check(deliver(.window, docs, dedupe: true)?["title"] as? String == "Docs", "after that re-activation, returning to the normal window is still sent")
		// 普通 → 无痕 → 另一个普通窗口。
		_ = deliver(.window, incognito, dedupe: true)
		check(deliver(.window, mail, dedupe: true)?["title"] as? String == "Inbox", "leaving a private window for another normal window is sent")
		// 从别的 App 切进无痕窗口:只有一条不带标题的 app 切换。
		key = "com.apple.Terminal"
		let entered = deliver(.app, incognito, dedupe: false)
		check(entered?["kind"] as? String == "app" && entered?["title"] == nil && entered?["url"] == nil, "switching into a private window from another app sends one untitled switch")
		// 排除 App:切进来那条之后,里面的窗口变化不发,键也不变。
		let appOff = RecorderPolicy(json: ["excludeBundleIds": ["com.google.Chrome"]])
		key = nil
		check(deliver(.app, docs, dedupe: false, policy: appOff) != nil, "an excluded app still gets its untitled switch")
		let excludedKey = key
		check(deliver(.window, mail, dedupe: true, policy: appOff) == nil && key == excludedKey, "window changes inside an excluded app send nothing and keep the key")
	}

	/// 焦点框在读值前被网页原地改成密码框(AX 身份不变):读值闸每次都重查角色 / 子角色与 Secure Input,是就不读值。
	static func secureFieldFlip() {
		var role = "AXTextField"
		var subrole = ""
		var count: Int? = 5
		var secureInput = false
		var probes = 0
		var valueReads = 0
		func read() -> RecorderFieldRead {
			recorderReadField(
				secureInput: { secureInput },
				probe: { probes += 1; return (role, subrole, count) },
				value: { valueReads += 1; return "hello" }
			)
		}
		check(read() == .value("hello") && valueReads == 1, "a plain focused field is read")
		subrole = "AXSecureTextField" // 同一个元素,type=text → type=password
		check(read() == .secure && valueReads == 1, "a field that turned into a password field is not read")
		subrole = ""
		role = "AXSecureTextField"
		check(read() == .secure && valueReads == 1, "a secure-role field is not read")
		role = "AXTextField"
		secureInput = true
		let probesBefore = probes
		check(read() == .secure && valueReads == 1 && probes == probesBefore, "secure input skips the field without any AX read")
		secureInput = false
		role = ""
		check(read() == .unreadable && valueReads == 1, "an unreadable role is not proven plain, so the value is not read")
		role = "AXTextField"
		count = RecorderLimit.bigEditChars + 1
		check(read() == .big && valueReads == 1, "an oversized field reports big without reading the value")
		count = nil
		check(read() == .value("hello") && valueReads == 2, "a field without a character count is still read")
		check(recorderFieldState(secureInput: false, role: "AXTextField", subrole: "AXSecureTextField") == .secure, "the emit-time recheck treats a secure subrole as secure")
		check(recorderFieldState(secureInput: true, role: "AXTextField", subrole: "") == .secure, "the emit-time recheck treats secure input as secure")
		check(recorderFieldState(secureInput: false, role: "", subrole: "") == .unreadable, "the emit-time recheck does not call a destroyed field secure")
		check(recorderFieldState(secureInput: false, role: "AXTextArea", subrole: "") == .plain, "an ordinary text area is plain")
	}

	static func browsers() {
		for id in ["com.google.Chrome", "com.google.Chrome.beta", "com.google.Chrome.canary", "com.microsoft.edgemac.Dev", "com.brave.Browser.nightly",
		           "com.operasoftware.Opera", "com.operasoftware.OperaGX", "company.thebrowser.Browser", "company.thebrowser.dia",
		           "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "app.zen-browser.zen", "com.kagi.kfmac",
		           "com.duckduckgo.macos.browser", "com.apple.SafariTechnologyPreview"] {
			check(recorderIsBrowser(id), "\(id) is a browser")
		}
		for id in ["org.mozilla.thunderbird", "com.google.chromeremotedesktop", "com.apple.Terminal", "com.operasoftwarex.app"] {
			check(!recorderIsBrowser(id), "\(id) is not a browser")
		}
		check(recorderPrivateUnverified("com.apple.Safari") && recorderPrivateUnverified("com.apple.SafariTechnologyPreview"), "Safari windows are treated as private until detection is verified")
		check(!recorderPrivateUnverified("com.google.Chrome"), "Chrome relies on title and toolbar markers")

		check(recorderWebAreaURL("https://example.com/a?q=1") == ("https://example.com/a", true), "web URL resolves and is sanitized")
		check(recorderWebAreaURL("chrome://newtab/") == (nil, true) && recorderWebAreaURL("about:blank") == (nil, true), "browser-internal pages resolve without a URL")
		check(recorderWebAreaURL("view-source:https://mybank.com/") == (nil, false), "wrapped URLs do not count as resolved")
		check(recorderWebAreaURL("blob:https://mybank.com/123") == (nil, false), "blob URLs do not count as resolved")
		check(recorderWebAreaURL("") == (nil, false) && recorderWebAreaURL(nil) == (nil, false), "missing URL is unresolved")
	}

	static func sessionLock() {
		check(!recorderSessionLocked(nil), "no session dictionary means not locked")
		check(!recorderSessionLocked(["kCGSSessionOnConsoleKey": true]), "an active console session is not locked")
		check(recorderSessionLocked(["CGSSessionScreenIsLocked": true, "kCGSSessionOnConsoleKey": true]), "a locked screen is locked")
		check(recorderSessionLocked(["kCGSSessionOnConsoleKey": false]), "a switched-away session counts as locked")
		// 真实字典里是 __NSCFBoolean。
		let wire = try? JSONSerialization.jsonObject(with: Data(#"{"CGSSessionScreenIsLocked":false,"kCGSSessionOnConsoleKey":true}"#.utf8)) as? [String: Any]
		check(!recorderSessionLocked(wire), "real boolean values parse")
	}

	static func clickOwner() {
		func window(_ pid: pid_t, _ rect: CGRect, alpha: Double = 1) -> [String: Any] {
			[kCGWindowOwnerPID as String: NSNumber(value: pid), kCGWindowAlpha as String: NSNumber(value: alpha),
			 kCGWindowBounds as String: rect.dictionaryRepresentation as NSDictionary as! [String: Any]]
		}
		let helper: pid_t = 10, xcode: pid_t = 20, spotlight: pid_t = 30, tint: pid_t = 40
		let screen = CGRect(x: 0, y: 0, width: 1512, height: 982)
		// 从前往后:helper 自己的全屏光标浮层、全透明窗口、Spotlight 面板、被观察 App 的最大化窗口。
		let windows = [
			window(helper, screen),
			window(tint, screen, alpha: 0),
			window(spotlight, CGRect(x: 456, y: 200, width: 600, height: 60)),
			window(xcode, screen),
		]
		check(recorderWindowOwner(at: CGPoint(x: 700, y: 220), windows: windows, skipPid: helper) == spotlight, "a click on a non-activating panel belongs to the panel")
		check(recorderWindowOwner(at: CGPoint(x: 700, y: 600), windows: windows, skipPid: helper) == xcode, "own overlays and transparent windows are skipped")
		check(recorderWindowOwner(at: CGPoint(x: 5000, y: 5000), windows: windows, skipPid: helper) == nil, "a point outside every window has no owner")
		check(recorderWindowOwner(at: CGPoint(x: 10, y: 10), windows: [], skipPid: helper) == nil, "an empty window list has no owner")
	}

	static func pendingOnRefresh() {
		check(recorderPendingOnRefresh(nextWantsText: false, windowChanged: true, urlChanged: false) == .drop, "new private or excluded window drops pending text")
		check(recorderPendingOnRefresh(nextWantsText: false, windowChanged: false, urlChanged: false) == .drop, "same window turning excluded drops pending text")
		check(recorderPendingOnRefresh(nextWantsText: true, windowChanged: true, urlChanged: false) == .flush, "an ordinary window change flushes pending text")
		check(recorderPendingOnRefresh(nextWantsText: true, windowChanged: false, urlChanged: false) == .keep, "a title change keeps pending text")
		check(recorderPendingOnRefresh(nextWantsText: true, windowChanged: false, urlChanged: true) == .flush, "a URL change in the same window flushes pending text like a window change")
		check(recorderPendingOnRefresh(nextWantsText: false, windowChanged: false, urlChanged: true) == .drop, "a URL change onto an excluded site drops pending text")
	}

	/// Codex #2:同一窗口、同一标题,网址换到了排除站点(单页应用 / 同名登录页)。窗口与快路句柄只当不透明的身份用
	/// (AXUIElementCreateApplication 造的,不会被读),读数全是注入的 —— 不需要授权,也不碰任何真实 App。
	static func sameTitleNavigation() {
		let window = AXUIElementCreateApplication(900_001)
		let container = AXUIElementCreateApplication(900_002)
		var live: (url: String?, resolved: Bool) = ("https://news.example.org/story?id=7", true)
		var walkResult = RecorderBrowserURLs.Walked(url: nil, resolved: false, isPrivate: false, webContainer: container, addressField: nil)
		var walks = 0
		var fastReads = 0
		var clock = 0.0
		let urls = RecorderBrowserURLs(
			fastRead: { webContainer, _ in
				fastReads += 1
				guard webContainer != nil else { return (nil, false) }
				return (live.url.flatMap(recorderSanitizeURL), live.resolved)
			},
			walk: { _ in
				walks += 1
				var result = walkResult
				result.url = live.url.flatMap(recorderSanitizeURL)
				result.resolved = live.resolved
				return result
			},
			now: { clock }
		)
		let first = urls.lookup(window: window, title: "Sign in")
		check(first.url == "https://news.example.org/story" && first.resolved && walks == 1, "first sight of a browser window walks once")
		var context = RecorderContext(name: "Google Chrome", bundleId: "com.google.Chrome", title: "Sign in", url: first.url)
		check(!recorderURLChanged(context, fresh: urls.fastURL(window: window)), "an unchanged URL does not make the context stale")

		live = ("https://login.bank.com/", true) // 同标题,换了站点
		check(recorderURLChanged(context, fresh: urls.fastURL(window: window)), "same title on another host makes the context stale")
		let second = urls.lookup(window: window, title: "Sign in")
		check(second.url == "https://login.bank.com/" && second.resolved && walks == 1, "a same-title lookup re-reads the URL through the remembered fast path instead of reusing the cached one")
		context.url = second.url
		let policy = RecorderPolicy(json: ["excludeDomains": ["bank.com"]])
		let nextWantsText = recorderEventBody(kind: .text, context: context, policy: policy) != nil
		check(!nextWantsText, "the excluded host drops text")
		check(recorderEventBody(kind: .click, context: context, policy: policy) == nil && recorderEventBody(kind: .key, context: context, policy: policy) == nil, "the excluded host drops clicks and keys")
		check(recorderPendingOnRefresh(nextWantsText: nextWantsText, windowChanged: false, urlChanged: true) == .drop, "text pending from before the hop is dropped")
		let marker = recorderEventBody(kind: .window, context: context, policy: policy)
		check((marker?["app"] as? [String: Any])?["excluded"] as? Bool == true && marker?["url"] == nil, "the hop is marked by a content-free window event")

		// 页面在加载 / 网页区域没了:快路读不到。情境里读到过网址 → 算变;同标题不走遍历,按没读到返回(失败即关闭)。
		live = (nil, false)
		check(recorderURLChanged(context, fresh: urls.fastURL(window: window)), "losing the URL counts as a change")
		let third = urls.lookup(window: window, title: "Sign in")
		check(!third.resolved && third.url == nil && walks == 1, "a same-title lookup that cannot read the URL fails closed without walking")
		context.url = nil
		context.urlUnknown = true
		check(recorderEventBody(kind: .text, context: context, policy: policy) == nil, "an unknown URL still drops text for a subscriber that excludes sites")

		// 标题变了而快路读不到 → 走一次遍历(有快路时不受 30 秒限制)。
		live = ("https://news.example.org/next", true)
		walkResult.webContainer = nil // 这次遍历什么句柄都没找到
		let fastBefore = fastReads
		_ = urls.lookup(window: window, title: "Next story")
		check(walks == 1 && fastReads == fastBefore + 1, "a new title first tries the fast path")
		live = (nil, false)
		_ = urls.lookup(window: window, title: "Another story")
		check(walks == 2, "a new title with an unreadable fast path walks again")
		check(urls.fastURL(window: window) == nil, "a walk that finds nothing leaves no fast path, so refreshIfStale has no verdict")
		_ = urls.lookup(window: window, title: "Yet another")
		check(walks == 2, "a fruitless walk is not repeated within 30 seconds")
		clock += RecorderBrowserURLs.rewalkAfter + 1
		_ = urls.lookup(window: window, title: "Much later")
		check(walks == 3, "after 30 seconds a new title walks again")

		let other = AXUIElementCreateApplication(900_003)
		check(urls.fastURL(window: other) == nil, "an unseen window has no fast path")
		urls.removeAll()
		check(urls.fastURL(window: window) == nil, "removeAll forgets every window")
	}

	/// 有上限的遍历(Codex #4 / #3):假树 + 计数。先读角色再读子节点,绝不向网页区域要子节点;无痕扫描不完整时如实报原因。
	final class FakeNode {
		let role: String
		let label: String
		let url: String?
		let value: String?
		let children: [FakeNode]
		init(_ role: String, _ label: String = "", url: String? = nil, value: String? = nil, children: [FakeNode] = []) {
			self.role = role
			self.label = label
			self.url = url
			self.value = value
			self.children = children
		}
	}

	struct WalkTrace {
		var described: [ObjectIdentifier] = []
		var childrenAsked: [FakeNode] = []
		var childrenBeforeDescribe = 0
		var webURLReads = 0
	}

	static func walk(_ root: FakeNode, nodeCap: Int = 400, depthCap: Int = 12, expireAfter: Int = .max) -> (RecorderWalkResult<FakeNode>, WalkTrace) {
		var trace = WalkTrace()
		var ticks = 0
		let result = recorderBoundedWalk(
			root: root, nodeCap: nodeCap, depthCap: depthCap,
			expired: { ticks += 1; return ticks > expireAfter },
			describe: { node in
				trace.described.append(ObjectIdentifier(node))
				return (node.role, node.label)
			},
			webURL: { node in
				trace.webURLReads += 1
				return recorderWebAreaURL(node.url)
			},
			fieldValue: { $0.value },
			children: { node in
				if !trace.described.contains(ObjectIdentifier(node)) { trace.childrenBeforeDescribe += 1 }
				trace.childrenAsked.append(node)
				return node.children
			}
		)
		return (result, trace)
	}

	static func boundedWalk() {
		// 窗口:工具栏(地址栏 + 无痕头像按钮)排在网页区域前面;网页区域下面还挂着一大片网页内容。
		let page = FakeNode("AXWebArea", url: "https://docs.example.com/a?q=1", children: (0..<50).map { FakeNode("AXGroup", "content \($0)") })
		let webContainer = FakeNode("AXGroup", children: [page])
		let toolbar = FakeNode("AXToolbar", children: [
			FakeNode("AXTextField", "Address and search bar", value: "docs.example.com/a"),
			FakeNode("AXButton", "Incognito"),
		])
		let window = FakeNode("AXWindow", children: [toolbar, webContainer])
		let (full, trace) = walk(window)
		check(!trace.childrenAsked.contains { $0.role == "AXWebArea" }, "the walk never asks a web area for its children")
		check(trace.childrenBeforeDescribe == 0, "every node's role is read before its children")
		check(trace.webURLReads == 1, "the web area is asked only for its own URL")
		check(full.url == "https://docs.example.com/a" && full.resolved && full.webContainer === webContainer, "the web area URL resolves and remembers its parent as the fast path")
		check(full.isPrivate && full.addressField?.role == "AXTextField", "toolbar markers and the address field are found on the way")
		check(full.complete && full.stops.isEmpty, "a toolbar ahead of the web area is scanned completely")
		check(full.visited == 6, "the walk visits the window chrome and the web area but none of the page content")

		// Codex #3 的形状:网页区域比工具栏里的无痕按钮浅。行为暂不改(仍按普通窗口),但如实报「没看完」。
		let deepToolbar = FakeNode("AXToolbar", children: [FakeNode("AXGroup", children: [FakeNode("AXGroup", children: [FakeNode("AXButton", "InPrivate")])])])
		let (early, earlyTrace) = walk(FakeNode("AXWindow", children: [FakeNode("AXGroup", children: [page]), deepToolbar]))
		check(early.resolved && !early.isPrivate, "a private hint deeper than the web area is not reached (behavior unchanged for now)")
		check(!early.complete && early.stops == [.afterWebArea], "stopping after the web area is reported as an incomplete private scan")
		check(!earlyTrace.childrenAsked.contains { $0.role == "AXWebArea" }, "the early stop never asks a web area for its children either")

		// 网页区域读不到网址 → 地址栏兜底;不因网页区域没读到就往里走。
		let loading = FakeNode("AXWebArea", url: "", children: [FakeNode("AXGroup")])
		let (fallback, fallbackTrace) = walk(FakeNode("AXWindow", children: [FakeNode("AXTextField", "Address", value: "example.org/path?x=1"), FakeNode("AXGroup", children: [loading])]))
		check(fallback.url == "https://example.org/path" && fallback.resolved && fallback.webContainer == nil, "an unreadable web area falls back to the address field")
		check(!fallbackTrace.childrenAsked.contains { $0.role == "AXWebArea" }, "an unresolved web area is not entered either")
		check(fallback.complete, "a fully scanned window without a web URL is complete")

		// 上限:节点数、深度、时间预算,各自报原因。
		let (capped, _) = walk(FakeNode("AXWindow", children: (0..<20).map { FakeNode("AXGroup", "g\($0)") }), nodeCap: 5)
		check(capped.visited == 5 && capped.stops.contains(.nodeCap) && !capped.complete, "the node cap stops the walk and is reported")
		var chain = FakeNode("AXGroup")
		for _ in 0..<20 { chain = FakeNode("AXGroup", children: [chain]) }
		let (deep, _) = walk(chain, depthCap: 3)
		check(deep.visited == 4 && deep.stops == [.depthCap], "the depth cap stops expansion and is reported")
		let (late, _) = walk(window, expireAfter: 2)
		check(late.visited == 2 && late.stops.contains(.deadline) && !late.resolved, "the time budget stops the walk and is reported")
	}

	static func scanStats() {
		let stats = RecorderScanStats()
		let empty = stats.snapshot()
		check(empty.walks == 0 && empty.incomplete == 0 && Set(empty.stops.keys) == Set(RecorderWalkStop.allCases.map(\.rawValue)) && empty.stops.values.allSatisfy { $0 == 0 }, "scan stats start at zero with every reason present")
		stats.record([])
		stats.record([.afterWebArea])
		stats.record([.afterWebArea, .deadline])
		let after = stats.snapshot()
		check(after.walks == 3 && after.incomplete == 2, "scan stats count walks and incomplete walks")
		check(after.stops["afterWebArea"] == 2 && after.stops["deadline"] == 1 && after.stops["nodeCap"] == 0 && after.stops["depthCap"] == 0, "scan stats count each stop reason")
	}

	static func agentGate() {
		var now = 100.0
		let gate = RecorderAgentGate(grace: 0.75, now: { now })
		check(!gate.active(), "idle gate is inactive")
		gate.enter(); gate.enter()
		check(gate.active(), "inside an action the gate is active")
		gate.leave()
		now = 200
		check(gate.active(), "nested action keeps the gate active")
		gate.leave()
		now = 200.5
		check(gate.active(), "grace period covers late AX notifications")
		now = 201
		check(!gate.active(), "gate expires after the grace period")
		gate.leave()
		check(!gate.active(), "extra leave never goes negative")
	}

	/// 写队列:回包在前、事件按序;对端不读时丢弃并计数,再次能写时先补 dropped;对端关闭 → 写失败 → shutdown。
	static func subscriberQueue() {
		var fds: [Int32] = [0, 0]
		precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
		var noSigPipe: Int32 = 1
		_ = setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
		let subscriber = RecorderSubscriber(fd: fds[0], policy: RecorderPolicy(), maxPending: 4, sendTimeout: 1)
		var small: Int32 = 2048
		_ = setsockopt(fds[0], SOL_SOCKET, SO_SNDBUF, &small, socklen_t(MemoryLayout<Int32>.size))
		subscriber.send(["id": "r1", "ok": true])
		let padding = String(repeating: "x", count: 1500)
		for index in 0..<200 { subscriber.send(["ev": ["t": index, "kind": "text", "text": padding]]) }
		// 对端开始读:能读到回包、若干事件,以及后续入队时补上的 dropped 标记。
		let reader = FileHandle(fileDescriptor: fds[1], closeOnDealloc: false)
		var received = Data()
		var lines: [[String: Any]] = []
		let deadline = Date().addingTimeInterval(5)
		var sentAfterDrain = false
		while Date() < deadline {
			let chunk = reader.availableData
			if chunk.isEmpty { break }
			received.append(chunk)
			while let newline = received.firstIndex(of: 0x0A) {
				let line = received[received.startIndex..<newline]
				received.removeSubrange(received.startIndex...newline)
				if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { lines.append(object) }
			}
			if !sentAfterDrain && lines.count >= 4 {
				sentAfterDrain = true
				subscriber.send(["ev": ["t": 999, "kind": "key", "keys": "⌘S"]])
			}
			if lines.contains(where: { (($0["ev"] as? [String: Any])?["t"] as? Int) == 999 }) { break }
		}
		check(lines.first?["id"] as? String == "r1", "reply is the first line on the connection")
		let dropped = lines.compactMap { ($0["ev"] as? [String: Any]).flatMap { $0["state"] as? String == "dropped" ? $0["count"] as? Int : nil } }.first
		check((dropped ?? 0) > 0, "a stalled reader causes drops that are reported with a count")
		// dropped 标记自带当前时间戳,可能插在任意两条之间;只比事件自己的顺序。
		let times = lines.compactMap { ($0["ev"] as? [String: Any]).flatMap { $0["state"] == nil ? $0["t"] as? Int : nil } }.filter { $0 != 999 }
		check(!times.isEmpty && times == times.sorted(), "delivered events keep their order")
		check(!subscriber.isFailed, "a slow but alive reader does not fail the subscriber")

		close(fds[1])
		subscriber.send(["ev": ["t": 1000, "kind": "key", "keys": "⌘W"]])
		let failDeadline = Date().addingTimeInterval(3)
		while !subscriber.isFailed && Date() < failDeadline { usleep(20_000) }
		check(subscriber.isFailed, "writing to a closed peer marks the subscriber failed")
		subscriber.close()
		close(fds[0])
		print("PASS subscriber closes after draining")
	}

	/// 订阅流接线(不需要授权):回包在前、首条是 app 快照(锁屏时是 system/locked)、主线程观察者装上后
	/// sleep / wake 变成 system 事件、退订后注册表归零且观察者 / 全局监听 / 定时器 / 基线全部拆掉。
	/// sleep / wake 只发到本进程的 NSWorkspace 通知中心,不碰系统级分布式通知。
	/// 只断言形状,绝不打印事件内容(跑测试的终端若恰好有辅助功能授权,这里读到的是真实前台窗口)。
	static func subscriptionStream(locked lockedNow: Bool) {
		print("-- subscription stream (session \(lockedNow ? "locked" : "unlocked"))")
		var fds: [Int32] = [0, 0]
		precondition(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds) == 0)
		var noSigPipe: Int32 = 1
		_ = setsockopt(fds[0], SOL_SOCKET, SO_NOSIGPIPE, &noSigPipe, socklen_t(MemoryLayout<Int32>.size))
		_ = fcntl(fds[1], F_SETFL, fcntl(fds[1], F_GETFL) | O_NONBLOCK)
		let recorder = ActivityRecorder()
		recorder.sessionLocked = { lockedNow }
		recorder.accessibilityTrusted = { false }
		check(recorder.subscribe(fd: fds[0], id: "x", policy: nil, protocolVersion: 13, browserBundleIds: [])?.code == "accessibility_denied", "untrusted helper refuses to subscribe")
		check(recorder.subscriberCount == 0, "refused subscription registers nothing")
		recorder.accessibilityTrusted = { true }
		check(recorder.subscribe(fd: fds[0], id: "s1", policy: ["titleOnlyBundleIds": ["com.forsion.*"]], protocolVersion: 13, browserBundleIds: []) == nil, "trusted helper subscribes")
		check(recorder.subscriberCount == 1, "subscription is registered")

		var buffer = Data()
		var lines: [[String: Any]] = []
		func pump(until done: () -> Bool, seconds: Double = 5) {
			let deadline = Date().addingTimeInterval(seconds)
			var chunk = [UInt8](repeating: 0, count: 65_536)
			while !done() && Date() < deadline {
				RunLoop.main.run(until: Date().addingTimeInterval(0.05)) // 主线程观察者靠主队列装上
				let count = read(fds[1], &chunk, chunk.count)
				if count > 0 { buffer.append(contentsOf: chunk[0..<count]) }
				while let newline = buffer.firstIndex(of: 0x0A) {
					let line = buffer[buffer.startIndex..<newline]
					buffer.removeSubrange(buffer.startIndex...newline)
					if let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any] { lines.append(object) }
				}
			}
		}
		func events(_ kind: String) -> [[String: Any]] { lines.compactMap { $0["ev"] as? [String: Any] }.filter { $0["kind"] as? String == kind } }

		// 锁屏时开始订阅:先报 locked,不拍前台。
		let hasFrontmost = NSWorkspace.shared.frontmostApplication != nil && !lockedNow
		pump(until: { lines.count >= (hasFrontmost || lockedNow ? 2 : 1) })
		check((lines.first?["id"] as? String) == "s1" && (lines.first?["result"] as? [String: Any])?["subscribed"] as? Bool == true, "reply is the first line of the stream")
		if lockedNow {
			check(events("system").first?["state"] as? String == "locked" && events("app").isEmpty, "subscribing while locked reports locked instead of a snapshot")
		} else if hasFrontmost {
			let app = events("app").first
			check(app?["t"] is Int && (app?["app"] as? [String: Any])?["name"] is String, "stream starts with an app snapshot")
		}

		pump(until: { false }, seconds: 0.3) // 让主线程把 NSWorkspace 观察者装上
		let live = recorder.debugState()
		check(live.running && live.mainObservers > 0, "subscribing starts the recorder and installs main-thread observers")
		NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: NSWorkspace.shared)
		pump(until: { events("system").contains { $0["state"] as? String == "sleep" } })
		check(events("system").contains { $0["state"] as? String == "sleep" }, "sleep becomes a system event")
		let appsBeforeWake = events("app").count
		NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.didWakeNotification, object: NSWorkspace.shared)
		pump(until: { events("system").contains { $0["state"] as? String == "wake" } && (!hasFrontmost || events("app").count > appsBeforeWake) })
		check(events("system").contains { $0["state"] as? String == "wake" }, "wake becomes a system event")
		if hasFrontmost { check(events("app").count > appsBeforeWake, "waking re-snapshots the frontmost app") }
		if lockedNow { check(events("app").count == appsBeforeWake, "waking while still locked takes no snapshot") }
		check(lines.dropFirst().allSatisfy { ($0["ev"] as? [String: Any])?["t"] is Int }, "every streamed line is an ev object")

		recorder.unsubscribe(fd: fds[0])
		check(recorder.subscriberCount == 0, "unsubscribe empties the registry")
		// 等 recorder 线程跑完 stopIfIdle、主线程拆完观察者(debugState 本身先排空 recorder 线程)。
		var after = recorder.debugState()
		let settle = Date().addingTimeInterval(3)
		while after != ActivityRecorder.DebugState() && Date() < settle {
			RunLoop.main.run(until: Date().addingTimeInterval(0.05))
			after = recorder.debugState()
		}
		check(!after.running && !after.observer && !after.focus && !after.pendingText && !after.timers && after.baselines == 0, "the last subscriber leaving stops the recorder and drops observer, focus, timers and baselines")
		check(after.mainObservers == 0 && !after.mouseMonitor && !after.keyMonitor, "the last subscriber leaving removes notification observers and global monitors")
		let before = lines.count
		let deliveries = recorder.debugMainDeliveries
		check(deliveries > 0, "main-thread observers received the test notifications while subscribed")
		NSWorkspace.shared.notificationCenter.post(name: NSWorkspace.willSleepNotification, object: NSWorkspace.shared)
		pump(until: { false }, seconds: 0.3)
		check(lines.count == before, "nothing is streamed after the last subscriber leaves")
		check(recorder.debugMainDeliveries == deliveries, "removed observers no longer receive notifications")
		close(fds[0])
		close(fds[1])
	}
}
