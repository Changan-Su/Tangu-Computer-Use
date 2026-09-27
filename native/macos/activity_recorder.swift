import AppKit
import ApplicationServices
import Carbon
import Foundation

// Tangu 新增:电脑历史(Computer History)采集器 —— `recordSubscribe`(协议 13)的 helper 侧。
// 只观测、不落盘:事件按每个订阅者自己的策略过滤后,一行一条 `{"ev":{…}}` 推给订阅连接;
// 落盘 / 保留 / 清除 / 暂停全归 Forsion 桌面主进程(形状见 Genesis desktop/shared/computerHistory.ts,三处同步)。
//
// 性能纪律(ChatGPT 的 recorder 冻住过 IntelliJ 10–13 秒):
//   - 只给前台 App 建**一个** AXObserver;切走时先逐条 AXObserverRemoveNotification,再摘 run-loop source;
//   - 每个 AX 元素引用各自设 0.3s 消息超时。**不**设在 system-wide 元素上 —— 那会改掉整个进程的全局默认,
//     CU 的 look/act 也跟着变;
//   - 绝不打开 AXEnhancedUserInterface / AXManualAccessibility(不走 Bridge.ensureEnhancedAccessibility),
//     绝不整树遍历:浏览器 URL 只做有上限的广度遍历(≤400 节点、≤12 层、≤200ms),且不进 AXWebArea
//     (每个节点先读角色,再决定读不读子节点 —— 绝不向网页区域要 AXChildren);之后按记住的快路重读;
//   - AX 读取全在独立的 recorder 线程(自己的 CFRunLoop)上做,不占 NSApp 主线程(agent 光标 / 边缘光效在那画)。
//     NSEvent 全局监听与 NSWorkspace / 分布式通知只能挂在主线程,回调里只取几个数就转交 recorder 线程。
// 隐私闸在读 AX **之前**:硬排除名单(密码管理器等)与「所有订阅者都排除了的 App」不建 observer、不读标题;
// 安全输入框 / Secure Input 期间不读值,每次读值 / 报字前都重查(网页能把已聚焦的输入框原地改成密码框);
// 无痕窗口只留激活时那一条不带标题的 App 切换,不发 window 事件(Safari 判不出,整个按无痕处理)。
// 情境(无痕 / 排除站点)在读基线、开始一段输入、停手报字、记点击 / 快捷键之前先对齐(refreshIfStale;
// 浏览器里标题没变也按快路重读网址,同标题换站点算换了情境),不拿上一个窗口 / 标签页 / 页面的情境去判;
// 点击另按窗口列表确认落在前台 App 自己的窗口上。

// MARK: - 纯函数(activity_recorder_tests.swift 覆盖)

enum RecorderLimit {
	static let title = 200
	static let url = 300
	static let label = 80
	static let text = 500
	/// 超过这个字符数的输入框不读值、不做差分,只报 bigEdit。
	static let bigEditChars = 20_000
	/// 不超过这个长度的输入框才边打边采样(聊天框、搜索框);更大的只在停手时读一次。
	static let sampleChars = 2_000
}

/// 始终排除:不建 observer、不读标题,只发一条 `app.excluded` 的切换。桌面下发的排除表叠加在这之上,改不掉这份。
let recorderHardExcludedBundleIds: Set<String> = [
	"com.1password.1password", "com.agilebits.onepassword7", "com.agilebits.onepassword-osx",
	"com.bitwarden.desktop", "com.lastpass.LastPass", "com.dashlane.dashlanephonefinal",
	"com.nordsec.nordpass", "me.proton.pass.electron",
	"com.apple.keychainaccess", "com.apple.Passwords", "org.keepassxc.keepassxc",
	"com.apple.SecurityAgent", "com.apple.ScreenContinuity",
	"com.forsion.tangu-computer-use",
]

/// 系统浮层:激活了也当没发生(不切 observer、不发事件),免得时间线被调度中心 / 通知中心切碎。
let recorderIgnoredBundleIds: Set<String> = [
	"com.apple.WindowManager", "com.apple.controlcenter", "com.apple.notificationcenterui",
	"com.apple.LocalAuthentication.UIAgent",
]

/// 无痕 / 私密窗口的标题标记(小写比较,多语言)。宁可误判成无痕少记,也不把无痕窗口记进去。
let recorderPrivateMarkers: [String] = [
	"private browsing", "private window", "incognito", "inprivate",
	"privater modus", "navigation privée", "navegación privada", "navegação privada", "navigazione anonima",
	"инкогнито", "приватный просмотр", "プライベートブラウズ", "シークレット", "시크릿",
	"无痕", "無痕", "隐私浏览", "隱私瀏覽", "隐身", "隱身", "私密浏览", "私密瀏覽",
]

func recorderHasPrivateMarker(_ text: String) -> Bool {
	let lower = text.lowercased()
	return recorderPrivateMarkers.contains { lower.contains($0) }
}

/// 无痕窗口**没有**可靠标记、又还没验证出别的判定办法的 App:整个 App 按无痕处理(只留不带标题的切换,
/// 连标题都不读)。Safari 的私密窗口标题就是网页标题;Window 菜单里「移到新的私密窗口」那一项随语言变、
/// 切窗口后是否及时刷新也没验证过。等 `node scripts/probe-recorder.mjs` 在真机上找到信号再从这里移除。
let recorderPrivateUnverifiedBundleIds: Set<String> = ["com.apple.safari", "com.apple.safaritechnologypreview"]

func recorderPrivateUnverified(_ bundleId: String) -> Bool {
	recorderPrivateUnverifiedBundleIds.contains(bundleId.lowercased())
}

/// 按浏览器处理(读网址、找无痕提示、排除站点读不到网址就按排除算)的 App。CU 自己那份表只有正式渠道,
/// 这里补上 Beta / Dev / Canary 等渠道与其他常见浏览器;前缀按「.」边界匹配(不把 Thunderbird 之类算进来)。
let recorderBrowserBundleIds: Set<String> = [
	"com.apple.safari", "com.apple.safaritechnologypreview",
	"org.chromium.chromium", "net.imput.helium", "app.zen-browser.zen", "com.kagi.kfmac",
	"com.duckduckgo.macos.browser", "org.mozilla.firefox", "org.mozilla.firefoxdeveloperedition", "org.mozilla.nightly",
]
let recorderBrowserBundlePrefixes: [String] = [
	"com.google.chrome", "com.microsoft.edgemac", "com.brave.browser", "com.vivaldi.vivaldi",
	"com.operasoftware", "company.thebrowser",
]

func recorderIsBrowser(_ bundleId: String) -> Bool {
	let id = bundleId.lowercased()
	return recorderBrowserBundleIds.contains(id) || recorderBrowserBundlePrefixes.contains { id == $0 || id.hasPrefix($0 + ".") }
}

/// 按字符(字素簇,不会切出半个汉字 / emoji)截到 max;第二项 = 是否截过。
func recorderTruncate(_ value: String, max: Int) -> (String, Bool) {
	guard value.count > max else { return (value, false) }
	return (String(value.prefix(max)), true)
}

private func recorderCollapse(_ raw: String?) -> String? {
	guard let raw else { return nil }
	let collapsed = raw.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
	return collapsed.isEmpty ? nil : collapsed
}

/// 界面标签(控件名):空白与换行折叠成一个空格,≤80;空串 → nil。
func recorderLabel(_ raw: String?) -> String? {
	recorderCollapse(raw).map { recorderTruncate($0, max: RecorderLimit.label).0 }
}

/// 窗口标题:同上,≤200。
func recorderTitle(_ raw: String?) -> String? {
	recorderCollapse(raw).map { recorderTruncate($0, max: RecorderLimit.title).0 }
}

func recorderFirstNonEmpty(_ values: String?...) -> String? {
	values.first { !($0?.isEmpty ?? true) } ?? nil
}

struct RecorderTextDiff: Equatable {
	/// 新值独有的那段(替换 / 插入);纯删除时为空串。
	let inserted: String
	/// 旧值被删掉的字符数。
	let deleted: Int
}

/// 两版值剥掉公共前缀 / 后缀,剩下中间那段。相同 → nil。按 Character 比较,不会把一个字拆成两半。
func recorderTextDiff(old: String, new: String) -> RecorderTextDiff? {
	if old == new { return nil }
	let before = Array(old), after = Array(new)
	let limit = min(before.count, after.count)
	var prefix = 0
	while prefix < limit && before[prefix] == after[prefix] { prefix += 1 }
	var suffix = 0
	while suffix < limit - prefix && before[before.count - 1 - suffix] == after[after.count - 1 - suffix] { suffix += 1 }
	return RecorderTextDiff(inserted: String(after[prefix..<(after.count - suffix)]), deleted: before.count - prefix - suffix)
}

/// 一段输入停手后该报什么。baseline = 上次报过时的值;latest = 期间最后一次采样;final = 停手后读到的值。
/// 正常按 baseline→final;若 final 相对 baseline 没有新增(发送后被清空、打完又删回去)而 latest 有,
/// 就按 baseline→latest —— 不然聊天框里「打字 + 回车」这种最常见的输入整段都会丢。
func recorderSettleText(baseline: String, latest: String?, final: String) -> RecorderTextDiff? {
	let direct = recorderTextDiff(old: baseline, new: final)
	if let direct, !direct.inserted.isEmpty { return direct }
	if let latest, let mid = recorderTextDiff(old: baseline, new: latest), !mid.inserted.isEmpty { return mid }
	return direct
}

/// 差分 → text 事件字段:插入段 ≤500(超了带 truncated),纯删除只报 deleted:<n>。
func recorderTextFields(_ diff: RecorderTextDiff) -> [String: Any] {
	var fields: [String: Any] = [:]
	if !diff.inserted.isEmpty {
		let (text, truncated) = recorderTruncate(diff.inserted, max: RecorderLimit.text)
		fields["text"] = text
		if truncated { fields["truncated"] = true }
	}
	if diff.deleted > 0 { fields["deleted"] = diff.deleted }
	return fields
}

func recorderIsSecureField(role: String, subrole: String) -> Bool {
	role == "AXSecureTextField" || subrole == "AXSecureTextField"
}

/// 焦点元素是不是「可编辑文本」:只有这类的 ValueChanged 才处理。安全输入框一律不是。
func recorderIsEditableText(role: String, subrole: String, editable: Bool) -> Bool {
	if recorderIsSecureField(role: role, subrole: subrole) { return false }
	return ["AXTextField", "AXTextArea", "AXComboBox", "AXSearchField"].contains(role) || subrole == "AXSearchField" || editable
}

/// 点击只给按钮 / 链接 / 菜单项 / 标签页这类控件带标签;文本框的值绝不当标签。
func recorderClickLabelAllowed(role: String, subrole: String) -> Bool {
	if role == "AXSecureTextField" || subrole == "AXSecureTextField" { return false }
	return ["AXButton", "AXPopUpButton", "AXMenuButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXRadioButton", "AXTab", "AXCheckBox", "AXDisclosureTriangle"].contains(role)
		|| subrole == "AXTabButton"
}

/// 点击命中的控件一次要读的属性(一次 IPC)。**不含 AXValue**:点到文本框 / 安全输入框时连值都不读;
/// 标签只从标题 / 描述来(弹出按钮这类只有值、没有标题 / 描述的控件因此不带标签)。
let recorderClickAttributes: [String] = [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute]

enum RecorderFieldState: Equatable {
	case plain
	/// 安全输入框,或 Secure Input 开着。
	case secure
	/// 角色读不到(元素已销毁 / 超时):证明不了还是普通框。
	case unreadable
}

func recorderFieldState(secureInput: Bool, role: String, subrole: String) -> RecorderFieldState {
	if secureInput { return .secure }
	if recorderIsSecureField(role: role, subrole: subrole) { return .secure }
	return role.isEmpty ? .unreadable : .plain
}

enum RecorderFieldRead: Equatable {
	/// 此刻是安全输入框 / Secure Input 开着:值没读。调用方丢掉待发、基线与这个框的 ValueChanged 观察。
	case secure
	/// 角色或值读不到:值没读到(停手时退回最后一次采样)。
	case unreadable
	/// 超过 bigEditChars:只能报 bigEdit。
	case big
	case value(String)
}

/// 读焦点框的值(基线、采样、停手)的唯一入口。先查 Secure Input,再重查角色 / 子角色(与字数同一次 IPC)——
/// 网页能把已聚焦的普通输入框原地改成密码框而 AX 身份不变,聚焦时查过的那一次不算数。
/// 安全输入框 / Secure Input → .secure,值根本不读;角色读不到 → .unreadable,也不读值。
/// 读数经闭包注入(真路径是 AX,单测是假读数)。
func recorderReadField(
	secureInput: () -> Bool,
	probe: () -> (role: String, subrole: String, count: Int?),
	value: () -> String?
) -> RecorderFieldRead {
	if secureInput() { return .secure }
	let (role, subrole, count) = probe()
	switch recorderFieldState(secureInput: false, role: role, subrole: subrole) {
	case .secure: return .secure
	case .unreadable: return .unreadable
	case .plain: break
	}
	if let count, count > RecorderLimit.bigEditChars { return .big }
	guard let text = value() else { return .unreadable }
	return text.utf16.count > RecorderLimit.bigEditChars ? .big : .value(text)
}

/// 地址栏的描述 / 标题(浏览器 URL 的兜底来源)。
func recorderIsAddressFieldLabel(_ label: String) -> Bool {
	let lower = label.lowercased()
	return ["address", "url", "地址", "search or enter", "搜索或输入", "location"].contains { lower.contains($0) }
}

/// 浏览器 URL 出 helper 前的形状:只收 http(s),去掉 query / fragment / 用户名密码,≤300。
/// 地址栏里没写 scheme 的(example.com/path)按 https 补上;带空白的(搜索词)不是 URL → nil。
func recorderSanitizeURL(_ raw: String) -> String? {
	var text = raw.trimmingCharacters(in: .whitespacesAndNewlines)
	guard !text.isEmpty, !text.contains(where: { $0.isWhitespace }) else { return nil }
	if !text.contains("://") {
		let host = text.split(separator: "/", maxSplits: 1).first.map(String.init) ?? ""
		guard host.contains("."), !host.hasPrefix("."), !host.hasSuffix(".") else { return nil }
		text = "https://" + text
	}
	guard var components = URLComponents(string: text),
		let scheme = components.scheme?.lowercased(), scheme == "http" || scheme == "https",
		let host = components.host, !host.isEmpty
	else { return nil }
	components.user = nil
	components.password = nil
	components.query = nil
	components.fragment = nil
	guard let clean = components.string else { return nil }
	return recorderTruncate(clean, max: RecorderLimit.url).0
}

func recorderURLHost(_ url: String) -> String? {
	URLComponents(string: url)?.host?.lowercased()
}

/// 浏览器内置页(新标签页、设置页、本地文件):读到了网址、但不属于任何站点,排除站点管不到它们。
/// 能包住别的网址的 scheme(view-source: / blob: / 扩展页)不在这里 —— 那类读到了也按「没读到」算。
private let recorderInternalSchemes: Set<String> = ["about", "chrome", "edge", "brave", "vivaldi", "opera", "arc", "file"]

/// AXWebArea 的 AXURL → (出 helper 的网址, 算不算读到了)。空串、解析不了、或包着别的网址的 scheme → 没读到。
func recorderWebAreaURL(_ raw: String?) -> (url: String?, resolved: Bool) {
	guard let raw = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !raw.isEmpty else { return (nil, false) }
	if let url = recorderSanitizeURL(raw) { return (url, true) }
	guard let scheme = URLComponents(string: raw)?.scheme?.lowercased(), recorderInternalSchemes.contains(scheme) else { return (nil, false) }
	return (nil, true)
}

/// 排除站点条目归一成裸域名:去 scheme / 路径 / 用户名 / 端口 / 前导「*.」「.」/ 末尾点,小写。不像域名 → nil。
func recorderNormalizeDomain(_ raw: String) -> String? {
	var text = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
	if let range = text.range(of: "://") { text = String(text[range.upperBound...]) }
	text = String(text.split(separator: "/", maxSplits: 1, omittingEmptySubsequences: false).first ?? "")
	if let at = text.lastIndex(of: "@") { text = String(text[text.index(after: at)...]) }
	if let colon = text.firstIndex(of: ":") { text = String(text[..<colon]) }
	while text.hasPrefix("*.") { text.removeFirst(2) }
	while text.hasPrefix(".") { text.removeFirst() }
	while text.hasSuffix(".") { text.removeLast() }
	guard !text.isEmpty, !text.contains(where: { $0.isWhitespace || $0 == "*" }) else { return nil }
	return text
}

/// host 等于该域名或是它的子域(`docs.example.com` 命中 `example.com`,`badexample.com` 不命中)。
func recorderHostMatches(_ host: String, domain: String) -> Bool {
	var normalized = host.lowercased()
	while normalized.hasSuffix(".") { normalized.removeLast() }
	return normalized == domain || normalized.hasSuffix("." + domain)
}

/// bundle id 匹配(不分大小写):精确,或以「.*」结尾的前缀通配(桌面默认只记标题的 `com.forsion.*`)。
func recorderBundleMatches(_ bundleId: String, pattern: String) -> Bool {
	let id = bundleId.lowercased(), rule = pattern.lowercased()
	if rule.hasSuffix(".*") { return id.hasPrefix(String(rule.dropLast())) }
	return id == rule
}

private let recorderSpecialKeys: [UInt16: String] = [
	36: "↩", 76: "⌤", 48: "⇥", 49: "Space", 51: "⌫", 117: "⌦", 53: "⎋",
	123: "←", 124: "→", 125: "↓", 126: "↑", 115: "↖", 119: "↘", 116: "⇞", 121: "⇟",
	122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8",
	101: "F9", 109: "F10", 103: "F11", 111: "F12",
]

/// 快捷键的主键名:特殊键查表,其余取不计修饰键的字符并大写;控制字符 / 私有区功能键码 → nil(不报)。
func recorderKeyName(keyCode: UInt16, characters: String?) -> String? {
	if let special = recorderSpecialKeys[keyCode] { return special }
	guard let first = characters?.first else { return nil }
	guard !first.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7F || (0xF700...0xF8FF).contains($0.value) }) else { return nil }
	return String(first).uppercased()
}

/// 快捷键组合串,如「⌘⇧P」「⌃C」。没按 ⌘ / ⌃ 的一律不算快捷键 → nil。
func recorderKeyCombo(command: Bool, control: Bool, option: Bool, shift: Bool, key: String) -> String? {
	guard command || control, !key.isEmpty else { return nil }
	return (control ? "⌃" : "") + (option ? "⌥" : "") + (command ? "⌘" : "") + (shift ? "⇧" : "") + key
}

/// 订阅者随 recordSubscribe 下发的策略。全部可选;硬排除名单与 Secure Input 在它之上生效。
struct RecorderPolicy {
	var excludeBundleIds: [String] = []
	var titleOnlyBundleIds: [String] = []
	/// 已归一的裸域名。
	var excludeDomains: [String] = []
	var text = true
	var clicks = true
	var keys = true

	init() {}

	init(json: Any?) {
		let object = json as? [String: Any] ?? [:]
		func list(_ key: String) -> [String] {
			Array(((object[key] as? [Any]) ?? []).compactMap { $0 as? String }.prefix(1000))
		}
		excludeBundleIds = list("excludeBundleIds")
		titleOnlyBundleIds = list("titleOnlyBundleIds")
		excludeDomains = list("excludeDomains").compactMap(recorderNormalizeDomain)
		text = object["text"] as? Bool ?? true
		clicks = object["clicks"] as? Bool ?? true
		keys = object["keys"] as? Bool ?? true
	}

	func excludes(bundleId: String) -> Bool { excludeBundleIds.contains { recorderBundleMatches(bundleId, pattern: $0) } }
	func titleOnly(bundleId: String) -> Bool { titleOnlyBundleIds.contains { recorderBundleMatches(bundleId, pattern: $0) } }
}

/// 一次观测时的前台情境。纯数据(不含 AX 引用),过滤只看它 —— 所以能单测。
struct RecorderContext: Equatable {
	var name: String
	var bundleId: String
	/// 硬排除(密码管理器 / 钥匙串 / helper 自己):连标题都没读。
	var hardExcluded = false
	/// 无痕 / 私密窗口时恒为 nil(标题与 URL 根本不进这个结构)。
	var title: String?
	var url: String?
	/// 浏览器但网址没读到(超时 / 没找到网页区域与地址栏)。订阅者设了排除站点时按排除处理。
	var urlUnknown = false
	var isPrivate = false
}

enum RecorderKind: String {
	case app, window, text, click, key, system
}

/// 按某个订阅者的策略,把一次观测变成事件体(不含 t / origin / 各 kind 自己的字段)。nil = 这个订阅者不该收到。
///   - 排除 App(硬排除 / 策略排除):只有切到它的那一条 app 事件,只带 `app.excluded` —— App 里的窗口切换
///     一概不发,连时间点和次数都不外泄;
///   - 排除站点(当前 URL 命中 / 设了排除站点而浏览器网址没读到):app 切换与 window 标记,只带 `app.excluded`
///     (同一浏览器里从允许的页面进到排除站点,靠这条 window 标记结束上一段的计时;连着的标记由 emit 按情境键去重);
///   - 无痕窗口:只有激活时那一条 app 事件,不带标题与 URL;window 事件一概不发,连进出无痕窗口的时间点都不外泄
///     (同一 App 里切走后的下一条情境事件照常发出,见 recorderContextDelivery);
///   - 只记标题的 App:没有 text / click / key。
func recorderEventBody(kind: RecorderKind, context: RecorderContext?, policy: RecorderPolicy) -> [String: Any]? {
	var body: [String: Any] = ["kind": kind.rawValue]
	guard let context else { return kind == .system ? body : nil }
	var app: [String: Any] = ["name": context.name]
	if !context.bundleId.isEmpty { app["bundleId"] = context.bundleId }
	let domainExcluded: Bool
	if let host = context.url.flatMap(recorderURLHost) {
		domainExcluded = policy.excludeDomains.contains { recorderHostMatches(host, domain: $0) }
	} else {
		// 读不到网址就判断不了是不是排除站点:宁可少记(连标题都不带),也不把排除站点记进去。
		domainExcluded = context.urlUnknown && !policy.excludeDomains.isEmpty
	}
	let appExcluded = context.hardExcluded || policy.excludes(bundleId: context.bundleId)
	if appExcluded || domainExcluded {
		guard kind == .app || (kind == .window && !appExcluded) else { return nil }
		app["excluded"] = true
		body["app"] = app
		return body
	}
	body["app"] = app
	if context.isPrivate {
		guard kind == .app else { return nil }
		return body
	}
	switch kind {
	case .text: if !policy.text { return nil }
	case .click: if !policy.clicks { return nil }
	case .key: if !policy.keys { return nil }
	default: break
	}
	if kind == .text || kind == .click || kind == .key, policy.titleOnly(bundleId: context.bundleId) { return nil }
	if let title = context.title, !title.isEmpty { body["title"] = title }
	if let url = context.url { body["url"] = url }
	return body
}

/// app / window 事件的去重键:同一订阅者连着收到两条同键的情境事件是冗余的。
func recorderContextKey(_ body: [String: Any]) -> String {
	let app = body["app"] as? [String: Any] ?? [:]
	return [app["bundleId"] as? String ?? app["name"] as? String ?? "",
	        (app["excluded"] as? Bool) == true ? "x" : "",
	        body["title"] as? String ?? "", body["url"] as? String ?? ""].joined(separator: "\u{1F}")
}

/// 一条 app / window 情境事件对某个订阅者:发什么(nil = 不发)、之后记住的情境键。
///   - dedupe 且与上一条同键 → 不发;
///   - 被滤掉的 window 事件(无痕窗口;排除 App 里的窗口变化):不发,但键记成这个情境的 app 事件的键。
///     同一浏览器里从普通窗口 A 切进无痕窗口、再切回 A 时,回来的那条必须照常发出 —— 键若还停在 A,它会被当成重复吞掉,
///     中间那段就全算进了 A。记成无痕情境的键(不带标题),还在无痕窗口时同一 App 重新激活的那条 app 事件照样去重。
///     排除 App 的键本来就是切进来时那条,记不记都一样。
func recorderContextDelivery(kind: RecorderKind, context: RecorderContext?, policy: RecorderPolicy, lastKey: String?, dedupe: Bool) -> (body: [String: Any]?, key: String?) {
	guard let body = recorderEventBody(kind: kind, context: context, policy: policy) else {
		if kind == .window, let app = recorderEventBody(kind: .app, context: context, policy: policy) { return (nil, recorderContextKey(app)) }
		return (nil, lastKey)
	}
	let key = recorderContextKey(body)
	if dedupe && key == lastKey { return (nil, lastKey) }
	return (body, key)
}

func recorderJSONLine(_ object: [String: Any]) -> Data? {
	guard JSONSerialization.isValidJSONObject(object),
		var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes])
	else { return nil }
	data.append(0x0A)
	return data
}

func recorderNowMs() -> Double { Date().timeIntervalSince1970 * 1000 }

/// Secure Input(密码框、「安全键盘输入」)开着就不读值、不报按键。两个来源都看:Carbon 的全局开关,
/// 以及 WindowServer 会话字典里的开启者 pid(ChatGPT 用的就是后者)。
func recorderSecureInputActive() -> Bool {
	if IsSecureEventInputEnabled() { return true }
	if let session = CGSessionCopyCurrentDictionary() as? [String: Any],
		let pid = (session["kCGSSessionSecureInputPID"] as? NSNumber)?.intValue, pid != 0 { return true }
	return false
}

/// 当前会话是不是「人不在」:屏幕已锁,或快速切换用户后这个会话不在控制台上。开始订阅时据此定初始状态。
func recorderSessionLocked(_ session: [String: Any]?) -> Bool {
	guard let session else { return false }
	if (session["CGSSessionScreenIsLocked"] as? NSNumber)?.boolValue == true { return true }
	if let onConsole = session["kCGSSessionOnConsoleKey"] as? NSNumber, !onConsole.boolValue { return true }
	return false
}

/// 屏幕上这一点最上面的窗口属于哪个进程:CGWindowList(从前往后)里第一个包含该点的窗口,跳过全透明的
/// 与 skipPid(helper 自己的 agent 光标 / 边缘光效浮层)。只用属主 pid / 边界 / 透明度,不需要屏幕录制授权。
/// 找不到 → nil,调用方按「不记」处理。
func recorderWindowOwner(at point: CGPoint, windows: [[String: Any]], skipPid: pid_t) -> pid_t? {
	for entry in windows {
		guard let owner = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value, owner != skipPid else { continue }
		if let alpha = (entry[kCGWindowAlpha as String] as? NSNumber)?.doubleValue, alpha <= 0 { continue }
		guard let boundsDict = entry[kCGWindowBounds as String] as? [String: Any],
			let bounds = CGRect(dictionaryRepresentation: boundsDict as CFDictionary),
			bounds.contains(point)
		else { continue }
		return owner
	}
	return nil
}

enum RecorderPendingAction: Equatable {
	case keep, flush, drop
}

/// 窗口情境刷新时,待发那段输入怎么办:
///   - 新情境没有订阅者要文字(无痕窗口 / 排除站点 / 排除 App)→ 丢,连基线一起作废 —— 这段可能正是在新窗口、
///     新标签页里打的(焦点通知比窗口 / 标题通知先到),不能按旧情境报出去;
///   - 换了窗口,或同一窗口里网址变了(导航,含标题不变的换站点)→ 按它自己的情境先报;
///   - 同一窗口、同一网址只是标题变了 → 留着,停手时照常报。
func recorderPendingOnRefresh(nextWantsText: Bool, windowChanged: Bool, urlChanged: Bool) -> RecorderPendingAction {
	if !nextWantsText { return .drop }
	return windowChanged || urlChanged ? .flush : .keep
}

/// 快路重读到的网址(fresh)与情境里记的是否不同 —— 同一窗口、同一标题下的换站点 / 站内导航。
/// fresh = nil:这个窗口没有记住的快路,判不了 → 不算变(不为此走遍历,等标题 / 焦点变化)。
/// 现在读不到了(resolved = false)而情境里读到过 → 算变:刷新后按「网址没读到」处理,设了排除站点的订阅者据此失败即关闭。
func recorderURLChanged(_ context: RecorderContext, fresh: (url: String?, resolved: Bool)?) -> Bool {
	guard let fresh else { return false }
	return fresh.url != context.url || fresh.resolved == context.urlUnknown
}

/// 无痕提示可能出现在的控件角色(Chromium 系工具栏上的头像按钮写着「Incognito / InPrivate」)。
let recorderPrivateHintRoles: Set<String> = ["AXButton", "AXMenuButton", "AXPopUpButton"]

/// 有上限的遍历在哪儿停了手 —— 也就是无痕扫描没看完的原因。
enum RecorderWalkStop: String, CaseIterable {
	/// 找到网页区域后,剩下的非网页节点不再展开(更深处的工具栏节点没看;子节点没读,所以不知道有没有)。
	case afterWebArea
	/// 到了深度上限还有没展开的节点(同上,不知道有没有子节点)。
	case depthCap
	/// 节点数到上限,还有没排进队的子节点。
	case nodeCap
	/// 时间预算用完,还有排着队没看的节点。
	case deadline
}

struct RecorderWalkResult<Node> {
	var url: String?
	/// 网页区域或地址栏读到了网址(含没有网址的内置页)。
	var resolved = false
	var isPrivate = false
	/// 读到网址的那个网页区域的父节点(之后的快路)。
	var webContainer: Node?
	var addressField: Node?
	var visited = 0
	/// 空 = 窗口外框(网页内容本就不进)全看完了;非空 = 无痕扫描不完整,这些是停手的原因。
	var stops: Set<RecorderWalkStop> = []
	var complete: Bool { stops.isEmpty }
}

/// 有上限的广度遍历:找浏览器网址(网页区域的 AXURL,或地址栏)与工具栏上的无痕提示。读数经闭包注入
/// (真路径是 AX 调用,单测是假树):
///   - describe(node):一次取角色与标签(description + title)。**先知道角色,再决定读不读子节点**;
///   - webURL(node):只对 AXWebArea 调用,只读它自己的 AXURL;
///   - children(node):只对准备展开的非网页节点调用 —— 绝不向 AXWebArea 要 AXChildren,那会逼浏览器
///     把整棵网页无障碍树生成出来(复杂页面上万节点,拖慢目标 App);
///   - fieldValue(node):没读到网页区域网址时,读地址栏的值兜底。
/// 访问顺序与覆盖范围和以前一致(找到网页区域后不再展开,但把已排进队列的节点看完);无痕扫描不完整时
/// 仍按普通窗口处理(行为暂不改,等真机探针的数据),只在 stops 里如实报出来。
func recorderBoundedWalk<Node>(
	root: Node, nodeCap: Int, depthCap: Int, expired: () -> Bool,
	describe: (Node) -> (role: String, label: String),
	webURL: (Node) -> (url: String?, resolved: Bool),
	fieldValue: (Node) -> String?,
	children: (Node) -> [Node]
) -> RecorderWalkResult<Node> {
	var result = RecorderWalkResult<Node>()
	var queue: [(node: Node, parent: Node?, depth: Int)] = [(root, nil, 0)]
	var head = 0
	while head < queue.count {
		if expired() { result.stops.insert(.deadline); break }
		let (node, parent, depth) = queue[head]
		head += 1
		result.visited += 1
		let (role, label) = describe(node)
		if role == "AXWebArea" {
			// 只读网页区域自己的 AXURL,绝不往里走(也不读它的子节点)。
			if !result.resolved {
				let found = webURL(node)
				if found.resolved {
					result.url = found.url
					result.resolved = true
					result.webContainer = parent
				}
			}
			continue
		}
		if recorderPrivateHintRoles.contains(role) && recorderHasPrivateMarker(label) { result.isPrivate = true }
		if result.addressField == nil && (role == "AXTextField" || role == "AXComboBox") && recorderIsAddressFieldLabel(label) { result.addressField = node }
		// 找到网页区域后不再往下展开,但把已排进队列的节点看完:工具栏(无痕头像按钮)不一定排在网页区域前面。
		if result.resolved { result.stops.insert(.afterWebArea); continue }
		if depth >= depthCap { result.stops.insert(.depthCap); continue }
		for child in children(node) {
			guard queue.count < nodeCap else { result.stops.insert(.nodeCap); break }
			queue.append((child, node, depth + 1))
		}
	}
	if !result.resolved, let field = result.addressField, let url = fieldValue(field).flatMap(recorderSanitizeURL) {
		result.url = url
		result.resolved = true
	}
	return result
}

/// 无痕扫描(有上限的遍历)的计数:走了几次、几次没看完、各因什么停手。只进 diagnostics(只有计数,不含任何内容),
/// 给真机探针判断「扫描不完整时仍按普通窗口记」这条要不要改(Codex #3)。任意线程。
final class RecorderScanStats {
	private let lock = NSLock()
	private var walks = 0
	private var incomplete = 0
	private var stops: [RecorderWalkStop: Int] = [:]

	func record(_ reasons: Set<RecorderWalkStop>) {
		lock.lock(); defer { lock.unlock() }
		walks += 1
		if !reasons.isEmpty { incomplete += 1 }
		for reason in reasons { stops[reason, default: 0] += 1 }
	}

	/// stops 的四个原因总是都在(没发生过为 0),形状稳定。
	func snapshot() -> (walks: Int, incomplete: Int, stops: [String: Int]) {
		lock.lock(); defer { lock.unlock() }
		var byName: [String: Int] = [:]
		for reason in RecorderWalkStop.allCases { byName[reason.rawValue] = stops[reason] ?? 0 }
		return (walks, incomplete, byName)
	}
}

/// 浏览器窗口的网址读取:按窗口记住上次遍历找到的网页区域父节点 / 地址栏(快路)与那次的无痕结论。
/// 读数经闭包注入(真路径是 AX 调用,单测是假读数)。只在 recorder 线程用。
///   - lookup 每次都先走快路重读网址,**不**按标题命中缓存:同标题换站点 / 不改标题的站内导航时,
///     标题没变、网址变了(Codex #2)。这里根本不存网址 —— 网址的真源永远是这一次的读数;
///   - 快路没有或读不到时才考虑遍历:只在标题变了(或第一次见这个窗口)时走;同一窗口 30 秒内走过一遍
///     且一无所获(没留下快路)就不再重走。标题没变而快路读不到 → 按没读到返回(排除站点失败即关闭),不走遍历。
final class RecorderBrowserURLs {
	struct Walked {
		var url: String?
		var resolved: Bool
		var isPrivate: Bool
		var webContainer: AXUIElement?
		var addressField: AXUIElement?
	}

	private struct Entry {
		let window: AXUIElement
		var title: String
		/// 无痕与否按窗口定:一个窗口不会从普通变成无痕(遍历过一次认出来就一直算)。
		var isPrivate: Bool
		var webContainer: AXUIElement?
		var addressField: AXUIElement?
		var walkedAt: Double
		var hasFastPath: Bool { webContainer != nil || addressField != nil }
	}

	static let rewalkAfter: Double = 30
	static let capacity = 32

	private var entries: [CFHashCode: Entry] = [:]
	private let fastRead: (_ webContainer: AXUIElement?, _ addressField: AXUIElement?) -> (url: String?, resolved: Bool)
	private let walk: (AXUIElement) -> Walked
	private let now: () -> Double

	init(
		fastRead: @escaping (_ webContainer: AXUIElement?, _ addressField: AXUIElement?) -> (url: String?, resolved: Bool),
		walk: @escaping (AXUIElement) -> Walked,
		now: @escaping () -> Double = { CFAbsoluteTimeGetCurrent() }
	) {
		self.fastRead = fastRead
		self.walk = walk
		self.now = now
	}

	/// 这个窗口现在的网址与无痕结论(readContext 用)。
	func lookup(window: AXUIElement, title: String) -> (url: String?, resolved: Bool, isPrivate: Bool) {
		let hash = CFHash(window)
		let cached = entry(for: window)
		var found = cached.flatMap(fast) ?? (url: nil, resolved: false)
		var next = cached ?? Entry(window: window, title: title, isPrivate: false, webContainer: nil, addressField: nil, walkedAt: -Double.infinity)
		let mayWalk = cached.map { $0.title != title && ($0.hasFastPath || now() - $0.walkedAt > Self.rewalkAfter) } ?? true
		if !found.resolved && mayWalk {
			let walked = walk(window)
			found = (walked.url, walked.resolved)
			next.isPrivate = next.isPrivate || walked.isPrivate
			next.webContainer = walked.webContainer
			next.addressField = walked.addressField
			next.walkedAt = now()
		}
		next.title = title
		if entries[hash] == nil && entries.count >= Self.capacity { entries.removeAll() }
		entries[hash] = next
		return (found.url, found.resolved, next.isPrivate)
	}

	/// 只走快路重读一次(refreshIfStale 用,1–2 次 AX 读)。这个窗口没有记住的快路 → nil,绝不在这里走遍历。
	func fastURL(window: AXUIElement) -> (url: String?, resolved: Bool)? {
		entry(for: window).flatMap(fast)
	}

	func removeAll() { entries = [:] }

	private func entry(for window: AXUIElement) -> Entry? {
		entries[CFHash(window)].flatMap { CFEqual($0.window, window) ? $0 : nil }
	}

	private func fast(_ entry: Entry) -> (url: String?, resolved: Bool)? {
		guard entry.hasFastPath else { return nil }
		return fastRead(entry.webContainer, entry.addressField)
	}
}

/// 订阅只给同一用户的进程(socket 在用户自己的 Caches 下,这是纵深防御)。不校验对端签名,helper 也不知道桌面端
/// 开没开电脑历史:helper 在运行时,同一用户的任何进程都能带自己的策略订阅,桌面端关闭 / 暂停 / 排除都管不到它
/// (内置的硬排除、Secure Input、无痕窗口照常生效)。与它已经能在同一 socket 上调 getUserContext / axReadText /
/// focusedElement / look 读屏幕内容是同一暴露面,0.6.0 接受这个风险;已知限制与后续计划记在 CHANGELOG 0.6.0。
func recorderPeerIsSameUser(_ fd: Int32) -> Bool {
	var uid: uid_t = 0
	var gid: gid_t = 0
	return getpeereid(fd, &uid, &gid) == 0 && uid == getuid()
}

/// agent 动作的深度计数:act / actBatch 等执行期间,以及结束后一小段(AX 通知是异步到的),
/// 观测到的事件打 `origin:"agent"`。与 ForegroundActivity 无关 —— 那个只在物理输入时亮。
final class RecorderAgentGate {
	private let lock = NSLock()
	private var depth = 0
	private var lastLeave = -Double.infinity
	private let grace: Double
	private let now: () -> Double

	init(grace: Double = 0.75, now: @escaping () -> Double = { CFAbsoluteTimeGetCurrent() }) {
		self.grace = grace
		self.now = now
	}

	func enter() { lock.lock(); depth += 1; lock.unlock() }
	func leave() {
		lock.lock()
		if depth > 0 {
			depth -= 1
			if depth == 0 { lastLeave = now() }
		}
		lock.unlock()
	}
	func active() -> Bool {
		lock.lock(); defer { lock.unlock() }
		return depth > 0 || now() - lastLeave < grace
	}
}

// MARK: - 订阅连接

/// 一个订阅连接。写入走它自己的串行队列:recorder 线程只管入队,永远不因某个订阅者读得慢而卡住;
/// 积压到上限就丢弃并计数,下一条能入队时先补一条 `system/dropped`。写失败(对端关了 / 超时)→ shutdown 套接字,
/// 让读侧(Bridge.processClient)拿到 EOF,走唯一的退订路径。
final class RecorderSubscriber {
	let fd: Int32
	let policy: RecorderPolicy
	/// 只在 recorder 线程读写:上一次发给它的 app/window 情境键(去重 + 判断要不要补发快照)。
	var lastContextKey: String?
	private let queue: DispatchQueue
	private let lock = NSLock()
	private let maxPending: Int
	private var pending = 0
	private var dropped = 0
	private var failed = false
	private var closed = false

	init(fd: Int32, policy: RecorderPolicy, maxPending: Int = 256, sendTimeout: Int = 2) {
		self.fd = fd
		self.policy = policy
		self.maxPending = maxPending
		queue = DispatchQueue(label: "forsion.recorder.subscriber.\(fd)")
		// 写阻塞上限:对端卡住不读时,写队列最多等这么久就判失败断开,不会永远挂着。
		var timeout = timeval(tv_sec: sendTimeout, tv_usec: 0)
		_ = setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
		var bufferSize: Int32 = 256 * 1024
		_ = setsockopt(fd, SOL_SOCKET, SO_SNDBUF, &bufferSize, socklen_t(MemoryLayout<Int32>.size))
	}

	var isFailed: Bool { lock.lock(); defer { lock.unlock() }; return failed }

	/// 入队一行 JSON。永不阻塞调用方。
	func send(_ object: [String: Any]) {
		guard let line = recorderJSONLine(object) else { return }
		lock.lock()
		if failed || closed { lock.unlock(); return }
		if pending >= maxPending {
			dropped += 1
			lock.unlock()
			return
		}
		var lines = [line]
		if dropped > 0 {
			let marker: [String: Any] = ["ev": ["t": Int64(recorderNowMs()), "kind": "system", "state": "dropped", "count": dropped]]
			if let markerLine = recorderJSONLine(marker) { lines.insert(markerLine, at: 0) }
			dropped = 0
		}
		pending += 1
		lock.unlock()
		queue.async { [self] in
			for next in lines { deliver(next) }
			lock.lock(); pending -= 1; lock.unlock()
		}
	}

	/// 退订:之后的入队全部丢弃,并等写队列排空 —— 调用方随后才能关 fd(否则排队的写会落到被复用的 fd 上)。
	func close() {
		lock.lock(); closed = true; lock.unlock()
		queue.sync {}
	}

	private func deliver(_ data: Data) {
		lock.lock()
		let skip = failed || closed
		lock.unlock()
		guard !skip else { return }
		if !writeAll(data) {
			lock.lock(); failed = true; lock.unlock()
			Darwin.shutdown(fd, SHUT_RDWR)
		}
	}

	private func writeAll(_ data: Data) -> Bool {
		data.withUnsafeBytes { raw -> Bool in
			guard let base = raw.baseAddress else { return true }
			var offset = 0
			while offset < raw.count {
				let sent = Darwin.send(fd, base.advanced(by: offset), raw.count - offset, 0)
				if sent > 0 { offset += sent; continue }
				if sent < 0 && errno == EINTR { continue }
				return false
			}
			return true
		}
	}
}

// MARK: - 采集器

private func recorderAXCallback(_ observer: AXObserver, _ element: AXUIElement, _ notification: CFString, _ refcon: UnsafeMutableRawPointer?) {
	guard let refcon else { return }
	Unmanaged<ActivityRecorder>.fromOpaque(refcon).takeUnretainedValue().handleAX(observer: observer, element: element, notification: notification as String)
}

final class ActivityRecorder {
	static let shared = ActivityRecorder()

	private static let axTimeout: Float = 0.3
	private static let textDebounce: TimeInterval = 1.5
	private static let sampleDelay: TimeInterval = 0.25
	private static let windowDebounce: TimeInterval = 0.3
	private static let walkNodeCap = 400
	private static let walkDepthCap = 12
	private static let walkBudget: TimeInterval = 0.2

	let agentGate = RecorderAgentGate()
	/// 无痕扫描计数(diagnostics 读,任意线程)。
	let scanStats = RecorderScanStats()
	/// 测试缝:单测注入「已授权」,好在没有辅助功能授权的机器上跑通订阅流(未授权时观察者本身照样建不起来)。
	var accessibilityTrusted: () -> Bool = { AXIsProcessTrusted() }
	/// 测试缝:开始订阅时会话是不是锁着(单测两种都要跑,不能取决于跑测试时屏幕锁没锁)。
	var sessionLocked: () -> Bool = { recorderSessionLocked(CGSessionCopyCurrentDictionary() as? [String: Any]) }

	// 订阅者注册表(任意线程,registryLock)。
	private let registryLock = NSLock()
	private var subscribers: [Int32: RecorderSubscriber] = [:]

	// recorder 线程本身。
	private let threadLock = NSLock()
	private var runLoop: CFRunLoop?

	// ↓ 以下只在 recorder 线程读写。
	private var running = false
	private var locked = false
	private var asleep = false
	private var suspended: Bool { locked || asleep }
	private var browserIds: Set<String> = []
	private var observer: AXObserver?
	private var observedApp: AXUIElement?
	private var observedRunningApp: NSRunningApplication?
	private var observedPid: pid_t = 0
	private var appNotifications: [String] = []
	private var context: RecorderContext?
	private var focusedWindow: AXUIElement?
	/// 焦点窗口标题的哈希(不存标题本身):判断情境是不是已经过时(标题变了、通知还没到 / 还在去抖)。
	private var focusedTitleKey: Int?
	private var windowTimer: Timer?
	private var retryTimer: Timer?
	private var focusElement: AXUIElement?
	private var focusEl: [String: Any] = [:]
	private var focusSampling = false
	private var pending: PendingText?
	private var textTimer: Timer?
	private var sampleTimer: Timer?
	private var baselines: [(element: AXUIElement, value: String)] = []
	private lazy var browserURLs = RecorderBrowserURLs(
		fastRead: { [unowned self] container, field in fastBrowserURL(container: container, field: field) },
		walk: { [unowned self] window in walkBrowserWindow(window) }
	)

	// ↓ 以下只在主线程读写。
	private var mainObservers: [(NotificationCenter, NSObjectProtocol)] = []
	private var mouseMonitor: Any?
	private var keyMonitor: Any?
	/// 只给测试:主线程观察者一共收到过几条通知。拆掉之后再发通知,这个数不该再涨(只数数组长度证明不了真的摘掉了)。
	private(set) var debugMainDeliveries = 0

	private struct PendingText {
		let element: AXUIElement
		let context: RecorderContext
		let el: [String: Any]
		var lastChange: Double
		var agent: Bool
		var latest: String?
	}

	// MARK: 对外(任意线程)

	var subscriberCount: Int {
		registryLock.lock(); defer { registryLock.unlock() }
		return subscribers.count
	}

	/// 在 serve socket 的专用连接上开始订阅。成功 → nil,回包已排在这条连接写队列的第一位;
	/// 失败 → 错误码与信息,由调用方回错误包(连接照常当普通连接用)。
	func subscribe(fd: Int32, id: String, policy: Any?, protocolVersion: Int, browserBundleIds: Set<String>) -> (code: String, message: String)? {
		guard recorderPeerIsSameUser(fd) else {
			return ("forbidden", "recordSubscribe is only served to processes of the same user")
		}
		guard accessibilityTrusted() else {
			return ("accessibility_denied", "The helper does not have the Accessibility permission")
		}
		let subscriber = RecorderSubscriber(fd: fd, policy: RecorderPolicy(json: policy))
		subscriber.send(["id": id, "ok": true, "result": ["subscribed": true, "protocolVersion": protocolVersion, "axTrusted": true]])
		registryLock.lock()
		subscribers[fd] = subscriber
		registryLock.unlock()
		perform { [self] in
			browserIds = browserBundleIds
			let wasRunning = running
			if wasRunning { resetText() } else { start() }
			if suspended {
				// 锁屏 / 睡眠 / 会话切走时订阅:只给新来的补一条当前状态,不拍前台(人不在),解锁通知来了再接上。
				subscriber.send(["ev": ["t": Int64(recorderNowMs()), "kind": "system", "state": locked ? "locked" : "sleep"]])
				return
			}
			guard wasRunning else { return activated(NSWorkspace.shared.frontmostApplication) }
			if observer == nil, let app = observedRunningApp, !isHardExcluded(app), appWanted(app.bundleIdentifier ?? "") {
				// 之前的订阅者都排除了当前 App(所以没建 observer),或上次没挂上:新来的要它,重新接上。
				observedPid = 0
				activated(app)
			} else {
				emitSnapshot()
			}
		}
		return nil
	}

	/// 连接读到 EOF(对端关闭,或写失败后我们自己 shutdown 了)时调用。最后一个订阅者走了就全部拆掉。
	func unsubscribe(fd: Int32) {
		registryLock.lock()
		let subscriber = subscribers.removeValue(forKey: fd)
		registryLock.unlock()
		guard let subscriber else { return }
		subscriber.close()
		perform { [self] in
			resetText()
			stopIfIdle()
		}
	}

	/// 只给测试:采集器拆没拆干净。须在主线程调用(recorder 线程上的字段经 perform 同步取)。
	struct DebugState: Equatable {
		var running = false
		var observer = false
		var focus = false
		var pendingText = false
		var timers = false
		var baselines = 0
		var mainObservers = 0
		var mouseMonitor = false
		var keyMonitor = false
	}

	func debugState() -> DebugState {
		precondition(Thread.isMainThread, "debugState reads main-thread fields")
		var state = DebugState()
		let done = DispatchSemaphore(value: 0)
		perform { [self] in
			state.running = running
			state.observer = observer != nil || observedApp != nil
			state.focus = focusElement != nil
			state.pendingText = pending != nil
			state.timers = windowTimer != nil || retryTimer != nil || textTimer != nil || sampleTimer != nil
			state.baselines = baselines.count
			done.signal()
		}
		done.wait()
		state.mainObservers = mainObservers.count
		state.mouseMonitor = mouseMonitor != nil
		state.keyMonitor = keyMonitor != nil
		return state
	}

	func agentEnter() { agentGate.enter() }
	func agentLeave() { agentGate.leave() }

	// MARK: recorder 线程

	private func ensureThread() -> CFRunLoop? {
		threadLock.lock(); defer { threadLock.unlock() }
		if let runLoop { return runLoop }
		let ready = DispatchSemaphore(value: 0)
		var created: CFRunLoop?
		let thread = Thread {
			created = CFRunLoopGetCurrent()
			// 常驻一个空端口,run loop 才不会因为「没有源」立刻返回。没有订阅者时这个线程只是睡在 mach_msg 里。
			RunLoop.current.add(NSMachPort(), forMode: .default)
			ready.signal()
			while true {
				autoreleasepool { _ = RunLoop.current.run(mode: .default, before: .distantFuture) }
			}
		}
		thread.name = "forsion.activity-recorder"
		thread.qualityOfService = .utility
		thread.start()
		ready.wait()
		runLoop = created
		return created
	}

	private func perform(_ block: @escaping () -> Void) {
		guard let runLoop = ensureThread() else { return }
		CFRunLoopPerformBlock(runLoop, CFRunLoopMode.defaultMode.rawValue, block)
		CFRunLoopWakeUp(runLoop)
	}

	private func makeTimer(_ interval: TimeInterval, _ block: @escaping () -> Void) -> Timer {
		let timer = Timer(timeInterval: interval, repeats: false) { _ in block() }
		RunLoop.current.add(timer, forMode: .default)
		return timer
	}

	private func subscriberSnapshot() -> [RecorderSubscriber] {
		registryLock.lock(); defer { registryLock.unlock() }
		return Array(subscribers.values)
	}

	/// 只装观察者、定初始状态,不发事件 —— 首条事件由 subscribe 按是否「人不在」决定(快照或 system 标记)。
	private func start() {
		guard !running else { return }
		running = true
		// 锁屏 / 会话切走时开始订阅(helper 在锁屏期间重启、桌面端退避重连):照实记下,等解锁通知再拍前台。
		locked = sessionLocked()
		asleep = false
		DispatchQueue.main.async { [self] in installMainObservers() }
	}

	private func stopIfIdle() {
		guard running, subscriberCount == 0 else { return }
		running = false
		// 没人收了:丢掉未发的输入与所有基线,不再读任何东西。
		pending = nil
		textTimer?.invalidate(); textTimer = nil
		sampleTimer?.invalidate(); sampleTimer = nil
		teardownObserver()
		context = nil
		baselines = []
		browserURLs.removeAll()
		DispatchQueue.main.async { [self] in removeMainObservers() }
	}

	/// 订阅者来去时:未发的输入丢掉(不报)、差分基线全部作废,再按当前值重建焦点框的基线。
	/// 桌面端「清除」后会断开重订阅 —— 不这样的话,清除前打的字会作为待发输入、或经旧基线的差分在清除后重新冒出来。
	/// 多个订阅者(dev + 正式版)并存时基线是共用的,所以任何一方来去都做,不只最后一个走的时候。
	private func resetText() {
		textTimer?.invalidate(); textTimer = nil
		sampleTimer?.invalidate(); sampleTimer = nil
		pending = nil
		baselines = []
		guard running, !suspended, let focusElement, let context, wants(.text, context) else { return }
		primeBaseline(focusElement)
	}

	private func emit(_ kind: RecorderKind, context: RecorderContext?, t: Double? = nil, fields: [String: Any] = [:], agent: Bool = false, dedupe: Bool = false) {
		let time = Int64(t ?? recorderNowMs())
		for subscriber in subscriberSnapshot() {
			let delivered: [String: Any]?
			if kind == .app || kind == .window {
				let (body, key) = recorderContextDelivery(kind: kind, context: context, policy: subscriber.policy, lastKey: subscriber.lastContextKey, dedupe: dedupe)
				subscriber.lastContextKey = key
				delivered = body
			} else {
				delivered = recorderEventBody(kind: kind, context: context, policy: subscriber.policy)
			}
			guard var body = delivered else { continue }
			for (name, value) in fields { body[name] = value }
			body["t"] = time
			if agent { body["origin"] = "agent" }
			subscriber.send(["ev": body])
		}
	}

	private func wants(_ kind: RecorderKind, _ context: RecorderContext) -> Bool {
		subscriberSnapshot().contains { recorderEventBody(kind: kind, context: context, policy: $0.policy) != nil }
	}

	/// 有没有订阅者需要这个 App 的标题以上的信息。都排除了 → 连 observer 都不建(用户的排除表也在读 AX 之前生效)。
	private func appWanted(_ bundleId: String) -> Bool {
		subscriberSnapshot().contains { !$0.policy.excludes(bundleId: bundleId) }
	}

	private func textWanted(_ bundleId: String) -> Bool {
		subscriberSnapshot().contains { $0.policy.text && !$0.policy.excludes(bundleId: bundleId) && !$0.policy.titleOnly(bundleId: bundleId) }
	}

	private func emitSnapshot() {
		guard running, !suspended, let context else { return }
		emit(.app, context: context, dedupe: true)
	}

	// MARK: 前台 App 与 observer

	private func isHardExcluded(_ app: NSRunningApplication) -> Bool {
		app.processIdentifier == getpid() || recorderHardExcludedBundleIds.contains(app.bundleIdentifier ?? "")
	}

	fileprivate func activated(_ app: NSRunningApplication?) {
		guard running, !suspended, let app else { return }
		if recorderIgnoredBundleIds.contains(app.bundleIdentifier ?? "") { return }
		flushText()
		let samePid = app.processIdentifier == observedPid
		if !samePid { retarget(app) }
		let (next, window, titleKey) = readContext(app)
		let windowChanged = !sameElement(window, focusedWindow)
		context = next
		focusedWindow = window
		focusedTitleKey = titleKey
		emit(.app, context: next, agent: agentGate.active(), dedupe: samePid)
		if !samePid || windowChanged { setFocus(focusedUIElement()) }
	}

	private static let retargetRetryDelays: [TimeInterval] = [0.5, 1, 2]

	private func retarget(_ app: NSRunningApplication, attempt: Int = 0) {
		teardownObserver()
		observedRunningApp = app
		observedPid = app.processIdentifier
		guard !isHardExcluded(app), appWanted(app.bundleIdentifier ?? ""), let runLoop else { return }
		let appElement = AXUIElementCreateApplication(app.processIdentifier)
		AXUIElementSetMessagingTimeout(appElement, Self.axTimeout)
		observedApp = appElement
		var created: AXObserver?
		if AXObserverCreate(app.processIdentifier, recorderAXCallback, &created) == .success, let created {
			let refcon = Unmanaged.passUnretained(self).toOpaque()
			for name in [kAXFocusedWindowChangedNotification, kAXMainWindowChangedNotification, kAXTitleChangedNotification, kAXFocusedUIElementChangedNotification] {
				let status = AXObserverAddNotification(created, appElement, name as CFString, refcon)
				if status == .success || status == .notificationAlreadyRegistered { appNotifications.append(name) }
			}
			if !appNotifications.isEmpty {
				CFRunLoopAddSource(runLoop, AXObserverGetRunLoopSource(created), .defaultMode)
				observer = created
				return
			}
		}
		// 一个通知都没挂上:刚启动的 App 常常还没开始应答辅助功能(cannotComplete)。它还在前台就隔一会儿重来,
		// 最多 3 次(0.5 / 1 / 2 秒);不然它在前台多久,这段时间就一条窗口 / 输入都记不到。
		guard attempt < Self.retargetRetryDelays.count else { return }
		let pid = app.processIdentifier
		retryTimer = makeTimer(Self.retargetRetryDelays[attempt]) { [self] in
			retryTimer = nil
			guard running, !suspended, observer == nil, observedPid == pid else { return }
			retarget(app, attempt: attempt + 1)
			// 挂上了:按现在的窗口补一次情境(首次读时 App 可能还没应答,标题是空的)。
			if observer != nil { refreshWindow() }
		}
	}

	private func teardownObserver() {
		windowTimer?.invalidate(); windowTimer = nil
		retryTimer?.invalidate(); retryTimer = nil
		releaseFocus()
		if let observer, let appElement = observedApp {
			// 顺序要紧:先逐条摘通知,再摘 run-loop source(反过来会漏 wired memory,aw-watcher #139)。
			for name in appNotifications { AXObserverRemoveNotification(observer, appElement, name as CFString) }
			if let runLoop { CFRunLoopRemoveSource(runLoop, AXObserverGetRunLoopSource(observer), .defaultMode) }
		}
		observer = nil
		observedApp = nil
		observedRunningApp = nil
		observedPid = 0
		appNotifications = []
		focusedWindow = nil
		focusedTitleKey = nil
	}

	fileprivate func handleAX(observer: AXObserver, element: AXUIElement, notification: String) {
		guard running, !suspended, let current = self.observer, CFEqual(current, observer) else { return }
		switch notification {
		case kAXValueChangedNotification:
			valueChanged(element)
		case kAXFocusedUIElementChangedNotification:
			// 焦点通知可能比窗口 / 标题通知先到(或那边还在去抖):先把情境对齐,再按新情境决定读不读基线 ——
			// 不然刚打开的无痕窗口、刚切到的排除站点标签页,会拿上一个窗口的情境读值、记字。
			refreshIfStale()
			// 回调给的元素在少数 App 里是 App 本身;以 App 的 AXFocusedUIElement 为准。
			setFocus(focusedUIElement())
		case kAXUIElementDestroyedNotification:
			if let focus = focusElement, CFEqual(focus, element) {
				flushText()
				releaseFocus()
			}
		case kAXTitleChangedNotification:
			// App 级订阅会收到所有元素的标题变化;只关心焦点窗口的。
			if focusedWindow == nil || CFEqual(focusedWindow!, element) { scheduleWindowRefresh() }
		default:
			scheduleWindowRefresh()
		}
	}

	private func scheduleWindowRefresh() {
		windowTimer?.invalidate()
		windowTimer = makeTimer(Self.windowDebounce) { [self] in refreshWindow() }
	}

	private func refreshWindow() {
		windowTimer?.invalidate(); windowTimer = nil
		guard running, !suspended, let app = observedRunningApp else { return }
		let (next, window, titleKey) = readContext(app)
		let windowChanged = !sameElement(window, focusedWindow)
		// 同一窗口里网址变了(导航,含标题不变的换站点)也算换了情境:待发输入先按旧情境报,新情境不收文字就丢。
		let urlChanged = !windowChanged && context.map { $0.url != next.url || $0.urlUnknown != next.urlUnknown } == true
		switch recorderPendingOnRefresh(nextWantsText: wants(.text, next), windowChanged: windowChanged, urlChanged: urlChanged) {
		case .drop: dropText()
		case .flush: flushText()
		case .keep: break
		}
		context = next
		focusedWindow = window
		focusedTitleKey = titleKey
		emit(.window, context: next, agent: agentGate.active(), dedupe: true)
		if windowChanged { setFocus(focusedUIElement()) }
	}

	/// 情境是不是已经过时:窗口刷新还在去抖、焦点窗口换了、它的标题变了(通知还在路上),或浏览器里标题没变
	/// 而网址变了(同标题换站点 / 站内导航)→ 立刻同步刷新一次。读基线、开始一段输入、停手报字、记点击 / 快捷键之前
	/// 都先过这一步;平时只多两次轻量 AX 读(焦点窗口、标题),浏览器里再多 1–2 次(记住的快路,绝不在这里走遍历)。
	private func refreshIfStale() {
		guard running, !suspended else { return }
		if windowTimer != nil { return refreshWindow() }
		guard let appElement = observedApp else { return }
		let window = axElement(axCopy(appElement, kAXFocusedWindowAttribute))
		guard sameElement(window, focusedWindow) else { return refreshWindow() }
		guard let window, let context, !context.hardExcluded, !recorderPrivateUnverified(context.bundleId) else { return }
		if titleKey(window) != focusedTitleKey { return refreshWindow() }
		// 这个窗口没有快路(上次遍历没找到网页区域与地址栏)→ fastURL 为 nil、不刷新:那时情境本就是「网址没读到」,
		// 设了排除站点的订阅者已经失败即关闭。焦点窗口的缓存项只会在换了焦点窗口之后被挤掉,换回来时 refreshWindow 会重建。
		if !context.isPrivate, isBrowser(context.bundleId), recorderURLChanged(context, fresh: browserURLs.fastURL(window: window)) {
			refreshWindow()
		}
	}

	private func titleKey(_ window: AXUIElement) -> Int? {
		AXUIElementSetMessagingTimeout(window, Self.axTimeout)
		return (axCopy(window, kAXTitleAttribute) as? String)?.hashValue
	}

	private func sameElement(_ lhs: AXUIElement?, _ rhs: AXUIElement?) -> Bool {
		switch (lhs, rhs) {
		case (nil, nil): return true
		case let (lhs?, rhs?): return CFEqual(lhs, rhs)
		default: return false
		}
	}

	private func isBrowser(_ bundleId: String) -> Bool {
		browserIds.contains(bundleId) || recorderIsBrowser(bundleId)
	}

	/// 读前台窗口的情境。第三项 = 标题哈希(refreshIfStale 比对用;标题本身不留)。
	private func readContext(_ app: NSRunningApplication) -> (RecorderContext, AXUIElement?, Int?) {
		let bundleId = app.bundleIdentifier ?? ""
		var next = RecorderContext(name: app.localizedName ?? bundleId, bundleId: bundleId)
		next.hardExcluded = isHardExcluded(app)
		guard !next.hardExcluded, let appElement = observedApp,
			let window = axElement(axCopy(appElement, kAXFocusedWindowAttribute))
		else { return (next, nil, nil) }
		// Safari 等判不出无痕窗口的 App:整个按无痕处理,标题都不读(见 recorderPrivateUnverifiedBundleIds)。
		if recorderPrivateUnverified(bundleId) {
			next.isPrivate = true
			return (next, window, nil)
		}
		AXUIElementSetMessagingTimeout(window, Self.axTimeout)
		let rawTitle = axCopy(window, kAXTitleAttribute) as? String
		let title = recorderTitle(rawTitle)
		var isPrivate = title.map(recorderHasPrivateMarker) ?? false
		var url: String?
		var urlUnknown = false
		if !isPrivate && isBrowser(bundleId) {
			let info = browserURLs.lookup(window: window, title: title ?? "")
			url = info.url
			urlUnknown = !info.resolved
			isPrivate = info.isPrivate
		}
		next.isPrivate = isPrivate
		if !isPrivate {
			next.title = title
			next.url = url
			next.urlUnknown = urlUnknown
		}
		return (next, window, rawTitle?.hashValue)
	}

	// MARK: 浏览器 URL(有上限、绝不进网页内容;缓存与读取策略见 RecorderBrowserURLs)

	/// 快路:上次遍历记下的网页区域父节点 / 地址栏。父节点只读它的直接子节点,每个子节点一次取角色 + AXURL;
	/// 通常 2 次 AX 调用。父节点本身绝不是网页区域(遍历从不展开网页区域),所以这里也不会向网页区域要子节点。
	private func fastBrowserURL(container: AXUIElement?, field: AXUIElement?) -> (url: String?, resolved: Bool) {
		if let container {
			for element in axChildren(container) {
				AXUIElementSetMessagingTimeout(element, Self.axTimeout)
				let values = axMulti(element, [kAXRoleAttribute, "AXURL"])
				guard values[0] as? String == "AXWebArea" else { continue }
				let found = recorderWebAreaURL(rawURL(values[1]))
				if found.resolved { return found }
			}
		}
		if let field, let url = (axCopy(field, kAXValueAttribute) as? String).flatMap(recorderSanitizeURL) { return (url, true) }
		return (nil, false)
	}

	private func rawURL(_ value: AnyObject?) -> String? {
		(value as? URL)?.absoluteString ?? (value as? String)
	}

	/// 慢路:有上限的广度遍历(≤400 节点、≤12 层、≤200ms)。先读角色、再决定读不读子节点,绝不向 AXWebArea 要 AXChildren。
	private func walkBrowserWindow(_ window: AXUIElement) -> RecorderBrowserURLs.Walked {
		let deadline = CFAbsoluteTimeGetCurrent() + Self.walkBudget
		let walked = recorderBoundedWalk(
			root: window, nodeCap: Self.walkNodeCap, depthCap: Self.walkDepthCap,
			expired: { CFAbsoluteTimeGetCurrent() >= deadline },
			describe: { [self] element in
				AXUIElementSetMessagingTimeout(element, Self.axTimeout)
				let values = axMulti(element, [kAXRoleAttribute, kAXDescriptionAttribute, kAXTitleAttribute])
				return (values[0] as? String ?? "", [values[1] as? String, values[2] as? String].compactMap { $0 }.joined(separator: " "))
			},
			webURL: { [self] element in recorderWebAreaURL(rawURL(axCopy(element, "AXURL"))) },
			fieldValue: { [self] element in axCopy(element, kAXValueAttribute) as? String },
			children: { [self] element in axChildren(element) }
		)
		scanStats.record(walked.stops)
		return RecorderBrowserURLs.Walked(url: walked.url, resolved: walked.resolved, isPrivate: walked.isPrivate, webContainer: walked.webContainer, addressField: walked.addressField)
	}

	// MARK: 焦点输入框与文本差分

	private func focusedUIElement() -> AXUIElement? {
		guard let observedApp else { return nil }
		return axElement(axCopy(observedApp, kAXFocusedUIElementAttribute))
	}

	private func setFocus(_ element: AXUIElement?) {
		if let element, let current = focusElement, CFEqual(element, current) {
			// 同一个 AX 元素再次聚焦:网页可能已原地把它改成了密码框(身份不变)。复核一次,是就立刻撒手。
			if fieldSecure(current) { dropSecureField(current) }
			return
		}
		flushText()
		releaseFocus()
		// 无痕窗口(含整个 Safari)里连焦点框都不看:不读控件名、不挂 ValueChanged(一个窗口的无痕与否不会变,换窗口会重新 setFocus)。
		guard let element, let observer, let context, !context.hardExcluded, !context.isPrivate, textWanted(context.bundleId) else { return }
		AXUIElementSetMessagingTimeout(element, Self.axTimeout)
		let values = axMulti(element, [kAXRoleAttribute, kAXSubroleAttribute, kAXTitleAttribute, kAXDescriptionAttribute, "AXPlaceholderValue", "AXEditable"])
		let role = values[0] as? String ?? ""
		let subrole = values[1] as? String ?? ""
		guard recorderIsEditableText(role: role, subrole: subrole, editable: (values[5] as? NSNumber)?.boolValue ?? false) else { return }
		// ValueChanged 只挂在焦点输入框上:挂在 App 上会收到进度条、滑块、网页内容的全部值变化。
		let refcon = Unmanaged.passUnretained(self).toOpaque()
		guard AXObserverAddNotification(observer, element, kAXValueChangedNotification as CFString, refcon) == .success else { return }
		_ = AXObserverAddNotification(observer, element, kAXUIElementDestroyedNotification as CFString, refcon)
		focusElement = element
		var el: [String: Any] = ["role": role]
		if let label = recorderLabel(recorderFirstNonEmpty(values[2] as? String, values[3] as? String, values[4] as? String)) { el["label"] = label }
		focusEl = el
		// 无痕窗口 / 排除站点里连基线都不读(值不进 helper 内存;调用方已先 refreshIfStale,情境是新的);
		// 之后变成想要时,第一段输入只建基线。
		if wants(.text, context) { primeBaseline(element) } else { setBaseline(element, nil) }
	}

	private func releaseFocus() {
		sampleTimer?.invalidate(); sampleTimer = nil
		if let element = focusElement, let observer {
			AXObserverRemoveNotification(observer, element, kAXValueChangedNotification as CFString)
			AXObserverRemoveNotification(observer, element, kAXUIElementDestroyedNotification as CFString)
		}
		focusElement = nil
		focusEl = [:]
		focusSampling = false
	}

	/// 聚焦时记下当前值作为差分基线(聚焦前就有的内容不算「打的字」)。
	private func primeBaseline(_ element: AXUIElement) {
		focusSampling = false
		switch readField(element, withCount: true) {
		case .secure: dropSecureField(element)
		case .big, .unreadable: setBaseline(element, nil)
		case .value(let value):
			setBaseline(element, value)
			focusSampling = value.utf16.count <= RecorderLimit.sampleChars
		}
	}

	/// recorderReadField 的 AX 版。withCount:基线 / 停手把字数与角色放在同一次 IPC 里取(与以前读字数 + 读值一样是两次);
	/// 采样不取字数(比以前多一次角色读取)。value 缺省读 AXValue。
	private func readField(_ element: AXUIElement, withCount: Bool, value: (() -> String?)? = nil) -> RecorderFieldRead {
		recorderReadField(
			secureInput: recorderSecureInputActive,
			probe: { [self] in
				let attributes = withCount ? [kAXRoleAttribute, kAXSubroleAttribute, kAXNumberOfCharactersAttribute] : [kAXRoleAttribute, kAXSubroleAttribute]
				let values = axMulti(element, attributes)
				return (values[0] as? String ?? "", values[1] as? String ?? "", withCount ? (values[2] as? NSNumber)?.intValue : nil)
			},
			value: value ?? { [self] in axCopy(element, kAXValueAttribute) as? String }
		)
	}

	/// 报字之前再核一次(只查角色与 Secure Input,不读值):读值与报出之间,这个框可能刚被改成密码框。
	/// 角色读不到(元素已销毁)不算安全输入框 —— 要报的内容是它还是普通框时读的。
	private func fieldSecure(_ element: AXUIElement) -> Bool {
		if recorderSecureInputActive() { return true }
		let values = axMulti(element, [kAXRoleAttribute, kAXSubroleAttribute])
		return recorderFieldState(secureInput: false, role: values[0] as? String ?? "", subrole: values[1] as? String ?? "") == .secure
	}

	/// 焦点框此刻是安全输入框(或 Secure Input 开着):待发输入、差分基线、这个框的 ValueChanged 观察全部立刻丢掉,不报。
	/// 之后要等焦点换走再回来(setFocus 重新按角色判断)才会再看它。调用方在这之后不能再碰 focusElement。
	private func dropSecureField(_ element: AXUIElement) {
		textTimer?.invalidate(); textTimer = nil
		sampleTimer?.invalidate(); sampleTimer = nil
		if let pendingElement = pending?.element { setBaseline(pendingElement, nil) }
		pending = nil
		setBaseline(element, nil)
		if let focus = focusElement, CFEqual(focus, element) { releaseFocus() }
	}

	private func baseline(_ element: AXUIElement) -> String? {
		baselines.first { CFEqual($0.element, element) }?.value
	}

	private func setBaseline(_ element: AXUIElement, _ value: String?) {
		baselines.removeAll { CFEqual($0.element, element) }
		guard let value else { return }
		baselines.append((element, value))
		if baselines.count > 8 { baselines.removeFirst(baselines.count - 8) }
	}

	private func valueChanged(_ element: AXUIElement) {
		guard let focus = focusElement, CFEqual(element, focus) else { return }
		// 一段新输入的开头:先确认情境没过时(同一个输入框所在的标签页可能刚切到排除站点)。刷新若换了焦点,这次作废。
		// 当前情境本就不收文字时不查:过时只会让这段多丢,不会多记(也免得无痕窗口里每敲一下都多两次 AX 读)。
		if pending == nil, let context, wants(.text, context) { refreshIfStale() }
		guard let focus = focusElement, CFEqual(element, focus), let context else { return }
		if recorderSecureInputActive() { return dropSecureField(focus) }
		guard wants(.text, context) else {
			// 这段期间的值不能进下一次差分:丢掉待发与基线。
			pending = nil
			textTimer?.invalidate(); textTimer = nil
			return setBaseline(focus, nil)
		}
		let now = recorderNowMs()
		let agent = agentGate.active()
		if var current = pending {
			current.lastChange = now
			current.agent = current.agent || agent
			pending = current
		} else {
			pending = PendingText(element: focus, context: context, el: focusEl, lastChange: now, agent: agent, latest: nil)
		}
		textTimer?.invalidate()
		textTimer = makeTimer(Self.textDebounce) { [self] in settleText() }
		if focusSampling && sampleTimer == nil {
			sampleTimer = makeTimer(Self.sampleDelay) { [self] in sampleText() }
		}
	}

	/// 小输入框边打边采样(≤4 次/秒):抓住「发送后立刻被清空」之前的那一版。
	private func sampleText() {
		sampleTimer = nil
		// 两头都要:打字时的情境,以及现在的情境(之间若刷新成了无痕 / 排除站点,refreshWindow 已丢掉待发)。
		guard var current = pending, let focus = focusElement, CFEqual(current.element, focus), let live = context,
			wants(.text, current.context), wants(.text, live)
		else { return }
		// 只给读值本身计时(角色复核那次 IPC 不算进去,不然慢一点的 App 会因此停掉采样)。
		var readTime = 0.0
		let value: String
		switch readField(focus, withCount: false, value: { [self] in
			let started = CFAbsoluteTimeGetCurrent()
			defer { readTime = CFAbsoluteTimeGetCurrent() - started }
			return axCopy(focus, kAXValueAttribute) as? String
		}) {
		case .secure: return dropSecureField(focus)
		case .unreadable: return
		case .big: focusSampling = false; return
		case .value(let text): value = text
		}
		// 读一次超过 50ms 的 App、或者文本变大了:退回只在停手时读,不给目标 App 添负担。
		if readTime > 0.05 || value.utf16.count > RecorderLimit.sampleChars { focusSampling = false }
		if value.isEmpty, let latest = current.latest, !latest.isEmpty {
			// 输入框被清空(聊天框发送的典型形态):清空前那版立刻当作一段输入报出去,基线归零。
			// 报之前先确认情境没过时(这段输入期间页面可能已同标题换到排除站点);刷新若换了情境,待发已被报掉或丢掉。
			refreshIfStale()
			guard pending != nil, let still = focusElement, CFEqual(still, focus) else { return }
			if fieldSecure(focus) { return dropSecureField(focus) }
			if let base = baseline(focus), let diff = recorderSettleText(baseline: base, latest: latest, final: value), !diff.inserted.isEmpty {
				emit(.text, context: current.context, t: current.lastChange, fields: recorderTextFields(diff).merging(["el": current.el]) { $1 }, agent: current.agent)
			}
			setBaseline(focus, value)
			pending = nil
			textTimer?.invalidate(); textTimer = nil
			return
		}
		current.latest = value
		pending = current
	}

	/// 停手(去抖到期):先确认情境没过时 —— 同一个输入框还在,所在页面却可能已同标题换到排除站点(单页应用常见),
	/// 段首那次 refreshIfStale 管不到段中的导航。刷新若判定情境变了,refreshWindow 已按规则报掉或丢掉待发,
	/// 这里的 flushText 就是空操作。
	private func settleText() {
		textTimer = nil
		refreshIfStale()
		flushText()
	}

	private func flushText() {
		textTimer?.invalidate(); textTimer = nil
		sampleTimer?.invalidate(); sampleTimer = nil
		guard let current = pending else { return }
		pending = nil
		let element = current.element
		if recorderSecureInputActive() { return dropSecureField(element) }
		guard wants(.text, current.context), let live = context, wants(.text, live) else {
			return setBaseline(element, nil)
		}
		let final: String
		switch readField(element, withCount: true) {
		case .secure: return dropSecureField(element)
		case .big:
			setBaseline(element, nil)
			return emit(.text, context: current.context, t: current.lastChange, fields: ["el": current.el, "bigEdit": true], agent: current.agent)
		case .unreadable:
			// 元素已销毁 / 超时:用最后一次采样兜底(有的聊天 App 发送后直接换掉输入框)。采样时它还是普通框(每次采样前都复核过)。
			guard let latest = current.latest else { return }
			final = latest
		case .value(let text): final = text
		}
		// 没有基线(聚焦时读不到 / 刚从大文本缩回来):这次只建基线,不猜哪些是新打的。
		guard let base = baseline(element), let diff = recorderSettleText(baseline: base, latest: current.latest, final: final) else {
			return setBaseline(element, final)
		}
		if fieldSecure(element) { return dropSecureField(element) }
		setBaseline(element, final)
		emit(.text, context: current.context, t: current.lastChange, fields: recorderTextFields(diff).merging(["el": current.el]) { $1 }, agent: current.agent)
	}

	/// 丢掉待发输入(不报),并作废相关基线 —— 只丢待发、不清基线的话,下一次差分会把丢掉的字又带出来。
	private func dropText() {
		textTimer?.invalidate(); textTimer = nil
		sampleTimer?.invalidate(); sampleTimer = nil
		if let element = pending?.element { setBaseline(element, nil) }
		pending = nil
		if let focusElement { setBaseline(focusElement, nil) }
	}

	// MARK: 点击 / 快捷键 / 系统

	fileprivate func clicked(at point: CGPoint, agent: Bool) {
		guard running, !suspended, let before = context, observedApp != nil, wants(.click, before) else { return }
		// 点的可能是刚打开的无痕窗口 / 刚切到的排除站点:先把情境对齐。
		refreshIfStale()
		guard let context, let appElement = observedApp, wants(.click, context) else { return }
		// 点到别的 App 会先切前台;那一下不记。
		guard NSWorkspace.shared.frontmostApplication?.processIdentifier == observedPid else { return }
		// 命中测试以被观察的 App 为根,返回的总是它自己的控件 —— 哪怕那一点上压着的是 Spotlight、Raycast、通知横幅、
		// Dock、菜单栏图标这类不抢前台的窗口。所以先按窗口列表确认那一点最上面的窗口确实是它的,不是就不记。
		let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
		guard recorderWindowOwner(at: point, windows: windows, skipPid: getpid()) == observedPid else { return }
		if pending != nil { flushText() }
		var hit: AXUIElement?
		guard AXUIElementCopyElementAtPosition(appElement, Float(point.x), Float(point.y), &hit) == .success, let hit else { return }
		var pid: pid_t = 0
		guard AXUIElementGetPid(hit, &pid) == .success, pid == observedPid else { return }
		AXUIElementSetMessagingTimeout(hit, Self.axTimeout)
		let values = axMulti(hit, recorderClickAttributes)
		let role = values[0] as? String ?? ""
		guard !role.isEmpty else { return }
		var el: [String: Any] = ["role": role]
		if recorderClickLabelAllowed(role: role, subrole: values[1] as? String ?? ""),
			let label = recorderLabel(recorderFirstNonEmpty(values[2] as? String, values[3] as? String)) {
			el["label"] = label
		}
		emit(.click, context: context, fields: ["el": el], agent: agent)
	}

	/// target = 事件自带的目标 pid(没有为 0)。有就以它为准:不是被观察的 App → 不记。没有就只能认前台 App ——
	/// 那时 Spotlight 这类不抢前台的面板拿着键盘焦点,组合键仍会记到前台 App 名下(只有组合键,不含内容)。
	fileprivate func keyed(_ combo: String, target: pid_t, agent: Bool) {
		guard running, !suspended, let before = context, !recorderSecureInputActive(), wants(.key, before) else { return }
		guard NSWorkspace.shared.frontmostApplication?.processIdentifier == observedPid else { return }
		if target > 0 && target != getpid() && target != observedPid { return }
		refreshIfStale()
		guard let context, wants(.key, context) else { return }
		if pending != nil { flushText() }
		emit(.key, context: context, fields: ["keys": combo], agent: agent)
	}

	fileprivate func systemEvent(_ state: String) {
		guard running else { return }
		let wasSuspended = suspended
		switch state {
		case "locked": locked = true
		case "unlocked": locked = false
		case "sleep": asleep = true
		case "wake": asleep = false
		default: break
		}
		if suspended && !wasSuspended { flushText() }
		emit(.system, context: nil, fields: ["state": state])
		if wasSuspended && !suspended {
			// 回来了:重新拍一次前台情境,时间线从这里接上。
			for subscriber in subscriberSnapshot() { subscriber.lastContextKey = nil }
			observedPid = 0
			activated(NSWorkspace.shared.frontmostApplication)
		}
	}

	// MARK: 主线程观察者

	private func installMainObservers() {
		guard mainObservers.isEmpty else { return }
		func on(_ center: NotificationCenter, _ name: Notification.Name, _ body: @escaping (Notification) -> Void) {
			mainObservers.append((center, center.addObserver(forName: name, object: nil, queue: nil) { [self] note in
				debugMainDeliveries += 1
				body(note)
			}))
		}
		let workspace = NSWorkspace.shared.notificationCenter
		on(workspace, NSWorkspace.didActivateApplicationNotification) { [self] note in
			let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication
			perform { [self] in activated(app) }
		}
		on(workspace, NSWorkspace.willSleepNotification) { [self] _ in perform { [self] in systemEvent("sleep") } }
		on(workspace, NSWorkspace.didWakeNotification) { [self] _ in perform { [self] in systemEvent("wake") } }
		// 快速切换用户:会话让出 = 人不在这台屏幕前,按锁屏处理。
		on(workspace, NSWorkspace.sessionDidResignActiveNotification) { [self] _ in perform { [self] in systemEvent("locked") } }
		on(workspace, NSWorkspace.sessionDidBecomeActiveNotification) { [self] _ in perform { [self] in systemEvent("unlocked") } }
		let distributed = DistributedNotificationCenter.default()
		on(distributed, Notification.Name("com.apple.screenIsLocked")) { [self] _ in perform { [self] in systemEvent("locked") } }
		on(distributed, Notification.Name("com.apple.screenIsUnlocked")) { [self] _ in perform { [self] in systemEvent("unlocked") } }
		mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: .leftMouseDown) { [self] event in
			guard let point = event.cgEvent?.location else { return }
			let agent = agentGate.active()
			perform { [self] in clicked(at: point, agent: agent) }
		}
		keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { [self] event in
			let flags = event.modifierFlags
			// 只看修饰键:没按 ⌘ / ⌃ 的普通按键到这里就结束,键值碰都不碰。
			guard flags.contains(.command) || flags.contains(.control) else { return }
			guard let key = recorderKeyName(keyCode: event.keyCode, characters: event.charactersIgnoringModifiers),
				let combo = recorderKeyCombo(command: flags.contains(.command), control: flags.contains(.control), option: flags.contains(.option), shift: flags.contains(.shift), key: key)
			else { return }
			let target = event.cgEvent.map { pid_t(truncatingIfNeeded: $0.getIntegerValueField(.eventTargetUnixProcessID)) } ?? 0
			let agent = agentGate.active()
			perform { [self] in keyed(combo, target: target, agent: agent) }
		}
	}

	private func removeMainObservers() {
		for (center, token) in mainObservers { center.removeObserver(token) }
		mainObservers = []
		if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
		if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
		mouseMonitor = nil
		keyMonitor = nil
	}

	// MARK: AX 小工具

	private func axCopy(_ element: AXUIElement, _ attribute: String) -> AnyObject? {
		var value: AnyObject?
		guard AXUIElementCopyAttributeValue(element, attribute as CFString, &value) == .success else { return nil }
		return value
	}

	private func axElement(_ value: AnyObject?) -> AXUIElement? {
		guard let value, CFGetTypeID(value as CFTypeRef) == AXUIElementGetTypeID() else { return nil }
		return unsafeBitCast(value, to: AXUIElement.self)
	}

	private func axChildren(_ element: AXUIElement) -> [AXUIElement] {
		AXUIElementSetMessagingTimeout(element, Self.axTimeout)
		return (axCopy(element, kAXChildrenAttribute) as? [AnyObject] ?? []).compactMap(axElement)
	}

	/// 一次 IPC 取多个属性;缺的属性(AXValue 包着的错误)按 nil 返回。
	private func axMulti(_ element: AXUIElement, _ attributes: [String]) -> [AnyObject?] {
		var values: CFArray?
		let status = AXUIElementCopyMultipleAttributeValues(element, attributes as CFArray, AXCopyMultipleAttributeOptions(rawValue: 0), &values)
		guard status == .success, let array = values as? [AnyObject], array.count == attributes.count else {
			return attributes.map { _ in nil }
		}
		return array.map { value -> AnyObject? in
			let ref = value as CFTypeRef
			if CFGetTypeID(ref) == AXValueGetTypeID(), AXValueGetType(unsafeBitCast(ref, to: AXValue.self)) == .axError { return nil }
			return value
		}
	}
}
