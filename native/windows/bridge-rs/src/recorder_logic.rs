//! Tangu 新增:电脑历史(Computer History)采集器的纯逻辑 —— Windows `serve` 模式的 `recordSubscribe`。
//!
//! 与 macOS 的 `native/macos/activity_recorder.swift` 同一份语义(那边的纯函数逐条移植到这里,单测在
//! `tests/recorder_logic_tests.rs`,在任何平台都能跑);事件形状见 Genesis `desktop/shared/computerHistory.ts`,
//! 三处同步。平台相关的部分(钩子、UIA、命名管道)在 `recorder.rs`,只在 Windows 编译。
//!
//! Windows 上的「bundle id」= 小写的可执行文件名(`chrome.exe`),桌面下发的排除 / 只记标题表按它匹配。

use serde_json::{json, Map, Value};

/// recordSubscribe 合同的版本号(与 macOS helper 的协议号同一口径:桌面要求 ≥ 13)。
/// **不是** stdio 协议号(`protocol::PROTOCOL_VERSION`,vendor TS 按 `!==` 校验,不能动)。
pub const RECORDER_PROTOCOL: u32 = 13;

pub mod limit {
    pub const TITLE: usize = 200;
    pub const URL: usize = 300;
    pub const LABEL: usize = 80;
    pub const TEXT: usize = 500;
    /// 超过这个字符数的输入框不做差分,只报 bigEdit。
    pub const BIG_EDIT_CHARS: usize = 20_000;
    /// 不超过这个长度的输入框才边打边采样(聊天框、搜索框);更大的只在停手时读一次。
    pub const SAMPLE_CHARS: usize = 2_000;
    /// 一次采样超过这么久的 App 不再边打边采样。
    pub const SAMPLE_MS: u128 = 50;
}

/// 始终排除:不读标题、不看输入框,只发一条 `app.excluded` 的切换。桌面下发的排除表叠加在这之上,改不掉这份。
pub const HARD_EXCLUDED_EXES: &[&str] = &[
    "1password.exe",
    "bitwarden.exe",
    "keepass.exe",
    "keepassxc.exe",
    "lastpass.exe",
    "dashlane.exe",
    "nordpass.exe",
    "proton pass.exe",
    "protonpass.exe",
    "enpass.exe",
    "roboform.exe",
    "keeper.exe",
    "keepersecurity.exe",
    // Windows 自己的凭据 / 提权界面
    "credentialuibroker.exe",
    "consent.exe",
    "logonui.exe",
    // 采集器自己(windows-bridge*.exe 另按 pid 判)
    "windows-bridge.exe",
];

/// 系统浮层:前台切到它们当没发生(不切情境、不发事件),免得时间线被开始菜单 / 搜索 / 通知中心 / 输入法切碎。
pub const IGNORED_EXES: &[&str] = &[
    "searchhost.exe",
    "searchapp.exe",
    "searchui.exe",
    "startmenuexperiencehost.exe",
    "shellexperiencehost.exe",
    "textinputhost.exe",
    "lockapp.exe",
];

/// 同上,按前台窗口类名判(任务栏、Alt+Tab 切换器、托盘溢出区都属于 explorer.exe,不能按进程排)。
pub const IGNORED_CLASSES: &[&str] = &[
    "Shell_TrayWnd",
    "Shell_SecondaryTrayWnd",
    "NotifyIconOverflowWindow",
    "TopLevelWindowForOverflowXamlIsland",
    "MultitaskingViewFrame",
    "XamlExplorerHostIslandWindow",
    "TaskSwitcherWnd",
    "ForegroundStaging",
];

/// 按浏览器处理(读网址、找无痕提示、排除站点读不到网址就按排除算)的可执行文件。
pub const BROWSER_EXES: &[&str] = &[
    "chrome.exe",
    "chromium.exe",
    "msedge.exe",
    "brave.exe",
    "vivaldi.exe",
    "opera.exe",
    "opera_gx.exe",
    "arc.exe",
    "thorium.exe",
    "duckduckgo.exe",
    "firefox.exe",
    "librewolf.exe",
    "waterfox.exe",
    "floorp.exe",
    "zen.exe",
    "360se.exe",
    "360chrome.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
    "2345explorer.exe",
    "liebao.exe",
];

/// 无痕 / 私密窗口的标题标记(小写比较,多语言;与 macOS 那份一致)。宁可误判成无痕少记,也不把无痕窗口记进去。
pub const PRIVATE_MARKERS: &[&str] = &[
    "private browsing",
    "private window",
    "incognito",
    "inprivate",
    "privater modus",
    "navigation privée",
    "navegación privada",
    "navegação privada",
    "navigazione anonima",
    "инкогнито",
    "приватный просмотр",
    "プライベートブラウズ",
    "シークレット",
    "시크릿",
    "无痕",
    "無痕",
    "隐私浏览",
    "隱私瀏覽",
    "隐身",
    "隱身",
    "私密浏览",
    "私密瀏覽",
];

fn exe_in(list: &[&str], exe: &str) -> bool {
    let exe = exe.to_lowercase();
    list.iter().any(|item| *item == exe)
}

pub fn is_hard_excluded(exe: &str) -> bool {
    exe_in(HARD_EXCLUDED_EXES, exe)
}

pub fn is_ignored(exe: &str, class_name: &str) -> bool {
    exe_in(IGNORED_EXES, exe) || IGNORED_CLASSES.contains(&class_name)
}

pub fn is_browser(exe: &str) -> bool {
    exe_in(BROWSER_EXES, exe)
}

/// 无痕窗口的标题一定带标记的浏览器:Edge 的 InPrivate 窗口标题带「[InPrivate]」,Firefox 系带「Private Browsing」。
/// 这几家标题没标记就可以信是普通窗口。**Chromium 系(Chrome、Brave 等)在 Windows 上无痕窗口的标题没有任何标记**
/// (CI 实测:无痕窗口标题就是「Example Domain - Google Chrome」),只能靠工具栏上的无痕提示判定。
pub const TITLE_MARKS_PRIVATE_EXES: &[&str] = &[
    "msedge.exe",
    "firefox.exe",
    "librewolf.exe",
    "waterfox.exe",
    "floorp.exe",
    "zen.exe",
];

pub fn title_marks_private(exe: &str) -> bool {
    exe_in(TITLE_MARKS_PRIVATE_EXES, exe)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PrivateVerdict {
    Private,
    Normal,
    /// 判不了(工具栏遍历没走完):调用方按无痕处理,下次刷新再遍历 —— 失败即关闭。
    Unknown,
}

/// 标题里没有无痕标记的浏览器窗口(有标记的调用方已经直接按无痕处理)算不算无痕:工具栏上找到无痕提示 → 无痕;
/// 标题可信的浏览器 → 普通;遍历走完了也没找到 → 普通;遍历没走完 → 判不了。
pub fn private_verdict(title_trusted: bool, hint_found: bool, walk_complete: bool) -> PrivateVerdict {
    if hint_found {
        PrivateVerdict::Private
    } else if title_trusted || walk_complete {
        PrivateVerdict::Normal
    } else {
        PrivateVerdict::Unknown
    }
}

pub fn has_private_marker(text: &str) -> bool {
    let lower = text.to_lowercase();
    PRIVATE_MARKERS.iter().any(|marker| lower.contains(marker))
}

// ---------------------------------------------------------------------------
// 字符串收敛
// ---------------------------------------------------------------------------

/// 按字符截到 max(不会切出半个汉字);第二项 = 是否截过。
pub fn truncate(value: &str, max: usize) -> (String, bool) {
    match value.char_indices().nth(max) {
        Some((cut, _)) => (value[..cut].to_owned(), true),
        None => (value.to_owned(), false),
    }
}

fn collapse(raw: &str) -> Option<String> {
    let collapsed = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    (!collapsed.is_empty()).then_some(collapsed)
}

/// 界面标签(控件名):空白与换行折叠成一个空格,≤80;空串 → None。
pub fn label(raw: &str) -> Option<String> {
    collapse(raw).map(|s| truncate(&s, limit::LABEL).0)
}

/// 窗口标题:同上,≤200。
pub fn title(raw: &str) -> Option<String> {
    collapse(raw).map(|s| truncate(&s, limit::TITLE).0)
}

// ---------------------------------------------------------------------------
// 文本差分
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextDiff {
    /// 新值独有的那段(替换 / 插入);纯删除时为空串。
    pub inserted: String,
    /// 旧值被删掉的字符数。
    pub deleted: usize,
}

/// 两版值剥掉公共前缀 / 后缀,剩下中间那段。相同 → None。按字符比较。
pub fn text_diff(old: &str, new: &str) -> Option<TextDiff> {
    if old == new {
        return None;
    }
    let before: Vec<char> = old.chars().collect();
    let after: Vec<char> = new.chars().collect();
    let limit = before.len().min(after.len());
    let mut prefix = 0;
    while prefix < limit && before[prefix] == after[prefix] {
        prefix += 1;
    }
    let mut suffix = 0;
    while suffix < limit - prefix
        && before[before.len() - 1 - suffix] == after[after.len() - 1 - suffix]
    {
        suffix += 1;
    }
    Some(TextDiff {
        inserted: after[prefix..after.len() - suffix].iter().collect(),
        deleted: before.len() - prefix - suffix,
    })
}

/// 一段输入停手后该报什么(与 macOS recorderSettleText 一致):正常按 baseline→final;final 相对 baseline 没有新增
/// (发送后被清空、打完又删回去)而 latest 有,就按 baseline→latest。
pub fn settle_text(baseline: &str, latest: Option<&str>, final_value: &str) -> Option<TextDiff> {
    let direct = text_diff(baseline, final_value);
    if let Some(diff) = &direct {
        if !diff.inserted.is_empty() {
            return direct;
        }
    }
    if let Some(mid) = latest.and_then(|latest| text_diff(baseline, latest)) {
        if !mid.inserted.is_empty() {
            return Some(mid);
        }
    }
    direct
}

/// 差分 → text 事件字段:插入段 ≤500(超了带 truncated),纯删除只报 deleted。
pub fn text_fields(diff: &TextDiff) -> Map<String, Value> {
    let mut fields = Map::new();
    if !diff.inserted.is_empty() {
        let (text, truncated) = truncate(&diff.inserted, limit::TEXT);
        fields.insert("text".into(), json!(text));
        if truncated {
            fields.insert("truncated".into(), json!(true));
        }
    }
    if diff.deleted > 0 {
        fields.insert("deleted".into(), json!(diff.deleted));
    }
    fields
}

// ---------------------------------------------------------------------------
// UIA 控件
// ---------------------------------------------------------------------------

pub const CT_BUTTON: i32 = 50000;
pub const CT_CHECKBOX: i32 = 50002;
pub const CT_COMBOBOX: i32 = 50003;
pub const CT_EDIT: i32 = 50004;
pub const CT_HYPERLINK: i32 = 50005;
pub const CT_MENUITEM: i32 = 50011;
pub const CT_RADIOBUTTON: i32 = 50013;
pub const CT_SPLITBUTTON: i32 = 50031;
pub const CT_TABITEM: i32 = 50019;
pub const CT_DOCUMENT: i32 = 50030;

/// 事件里 `el.role` 用的控件类型名(UIA 的程序名,与 macOS 的 AXButton 之类各用各的平台词汇)。
pub fn control_type_name(control_type: i32) -> &'static str {
    match control_type {
        50000 => "Button",
        50001 => "Calendar",
        50002 => "CheckBox",
        50003 => "ComboBox",
        50004 => "Edit",
        50005 => "Hyperlink",
        50006 => "Image",
        50007 => "ListItem",
        50008 => "List",
        50009 => "Menu",
        50010 => "MenuBar",
        50011 => "MenuItem",
        50012 => "ProgressBar",
        50013 => "RadioButton",
        50014 => "ScrollBar",
        50015 => "Slider",
        50016 => "Spinner",
        50017 => "StatusBar",
        50018 => "Tab",
        50019 => "TabItem",
        50020 => "Text",
        50021 => "ToolBar",
        50022 => "ToolTip",
        50023 => "Tree",
        50024 => "TreeItem",
        50025 => "Custom",
        50026 => "Group",
        50027 => "Thumb",
        50028 => "DataGrid",
        50029 => "DataItem",
        50030 => "Document",
        50031 => "SplitButton",
        50032 => "Window",
        50033 => "Pane",
        50034 => "Header",
        50035 => "HeaderItem",
        50036 => "Table",
        50037 => "TitleBar",
        50038 => "Separator",
        50039 => "SemanticZoom",
        50040 => "AppBar",
        _ => "Unknown",
    }
}

/// 点击只给按钮 / 链接 / 菜单项 / 标签页这类控件带标签;文本框的值绝不当标签(点击也从不读值)。
pub fn click_label_allowed(control_type: i32) -> bool {
    matches!(
        control_type,
        CT_BUTTON
            | CT_SPLITBUTTON
            | CT_HYPERLINK
            | CT_MENUITEM
            | CT_TABITEM
            | CT_CHECKBOX
            | CT_RADIOBUTTON
            | 50010 // MenuBar 本身不常被点,保守起见也给
    )
}

pub const CT_GROUP: i32 = 50026;
pub const CT_CUSTOM: i32 = 50025;
pub const CT_PANE: i32 = 50033;

/// 焦点输入框怎么读值。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextMode {
    /// ValuePattern.Value(普通输入框、网页 input / textarea)。
    Value,
    /// TextPattern 的文档区间(没有 ValuePattern 的富文本:Word、写字板、网页 contenteditable)。
    Text,
}

/// 焦点元素能不能当「可编辑文本」看,按什么读。密码框一律不是。
/// value_editable:Some(true) = ValuePattern 可写;Some(false) = 有但只读;None = 没有 ValuePattern。
/// text_editable:TextPattern 文档区间的 IsReadOnly 为假(调用方只在没有 ValuePattern 时才去查;None = 没查 / 没有)。
/// 网页里的 contenteditable 在 UIA 里常是 Group / Custom,不能只认 Edit。
pub fn text_mode(control_type: i32, is_password: bool, value_editable: Option<bool>, text_editable: Option<bool>) -> Option<TextMode> {
    if is_password {
        return None;
    }
    let texty = matches!(control_type, CT_EDIT | CT_DOCUMENT | CT_COMBOBOX | CT_GROUP | CT_CUSTOM | CT_PANE);
    match value_editable {
        Some(true) if texty => Some(TextMode::Value),
        Some(_) => None,
        None if control_type != CT_COMBOBOX && text_editable == Some(true) => Some(TextMode::Text),
        None => None,
    }
}

/// 浏览器地址栏:Chromium 系的类名是 OmniboxViewViews,Firefox 的 AutomationId 是 urlbar-input,其余按名字(多语言)。
pub fn is_address_field(name: &str, class_name: &str, automation_id: &str) -> bool {
    if class_name.contains("Omnibox") || automation_id == "urlbar-input" {
        return true;
    }
    let lower = name.to_lowercase();
    [
        "address",
        "url",
        "地址",
        "网址",
        "網址",
        "search or enter",
        "enter address",
        "搜索或输入",
        "location",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

// ---------------------------------------------------------------------------
// URL 与域名
// ---------------------------------------------------------------------------

struct UrlParts<'a> {
    scheme: String,
    host_port: &'a str,
    path: &'a str,
}

fn split_url(text: &str) -> Option<UrlParts<'_>> {
    let (scheme, rest) = text.split_once("://")?;
    if scheme.is_empty() || !scheme.chars().all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c)) {
        return None;
    }
    let end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..end];
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let tail = &rest[end..];
    let path = &tail[..tail.find(['?', '#']).unwrap_or(tail.len())];
    Some(UrlParts { scheme: scheme.to_lowercase(), host_port, path })
}

fn host_of(host_port: &str) -> &str {
    if let Some(stripped) = host_port.strip_prefix('[') {
        return stripped.split(']').next().unwrap_or("");
    }
    host_port.split(':').next().unwrap_or("")
}

/// 浏览器 URL 出 helper 前的形状:只收 http(s),去掉 query / fragment / 用户名密码,≤300。
/// 地址栏里没写 scheme 的(example.com/path)按 https 补上;带空白的(搜索词)不是 URL → None。
pub fn sanitize_url(raw: &str) -> Option<String> {
    let mut text = raw.trim().to_owned();
    if text.is_empty() || text.chars().any(char::is_whitespace) {
        return None;
    }
    if !text.contains("://") {
        let host = text.split('/').next().unwrap_or("");
        if !host.contains('.') || host.starts_with('.') || host.ends_with('.') {
            return None;
        }
        text = format!("https://{text}");
    }
    let parts = split_url(&text)?;
    if parts.scheme != "http" && parts.scheme != "https" || host_of(parts.host_port).is_empty() {
        return None;
    }
    let clean = format!("{}://{}{}", parts.scheme, parts.host_port, parts.path);
    Some(truncate(&clean, limit::URL).0)
}

/// 浏览器内置页的 scheme(新标签页、设置页、本地文件):读到了、但不属于任何站点,排除站点管不到它们。
const INTERNAL_SCHEMES: &[&str] = &[
    "about", "chrome", "edge", "brave", "vivaldi", "opera", "arc", "file", "moz-extension",
];

/// 地址栏里的值 → (出 helper 的网址, 算不算读到了)。空串 = 新标签页(读到了、没有网址);内置页同理;
/// 别的解析不了(正在输入的搜索词、半截网址)= 没读到 —— 设了排除站点的订阅者据此失败即关闭。
pub fn address_bar_url(raw: &str) -> (Option<String>, bool) {
    let text = raw.trim();
    if text.is_empty() {
        return (None, true);
    }
    if let Some(url) = sanitize_url(text) {
        return (Some(url), true);
    }
    let internal = text
        .split_once(':')
        .is_some_and(|(scheme, _)| INTERNAL_SCHEMES.contains(&scheme.to_lowercase().as_str()));
    (None, internal)
}

pub fn url_host(url: &str) -> Option<String> {
    let host = host_of(split_url(url)?.host_port);
    (!host.is_empty()).then(|| host.to_lowercase())
}

/// 排除站点条目归一成裸域名:去 scheme / 路径 / 用户名 / 端口 / 前导「*.」「.」/ 末尾点,小写。不像域名 → None。
pub fn normalize_domain(raw: &str) -> Option<String> {
    let mut text = raw.trim().to_lowercase();
    if let Some((_, rest)) = text.split_once("://") {
        text = rest.to_owned();
    }
    text = text.split('/').next().unwrap_or("").to_owned();
    if let Some((_, rest)) = text.rsplit_once('@') {
        text = rest.to_owned();
    }
    if let Some((host, _)) = text.split_once(':') {
        text = host.to_owned();
    }
    while let Some(rest) = text.strip_prefix("*.") {
        text = rest.to_owned();
    }
    let text = text.trim_start_matches('.').trim_end_matches('.').to_owned();
    if text.is_empty() || text.chars().any(|c| c.is_whitespace() || c == '*') {
        return None;
    }
    Some(text)
}

/// host 等于该域名或是它的子域(`docs.example.com` 命中 `example.com`,`badexample.com` 不命中)。
pub fn host_matches(host: &str, domain: &str) -> bool {
    let normalized = host.to_lowercase();
    let normalized = normalized.trim_end_matches('.');
    normalized == domain || normalized.ends_with(&format!(".{domain}"))
}

/// bundle id(Windows 上 = exe 名)匹配:不分大小写;精确,或以「.*」结尾的前缀通配。
pub fn bundle_matches(bundle_id: &str, pattern: &str) -> bool {
    let id = bundle_id.to_lowercase();
    let rule = pattern.to_lowercase();
    match rule.strip_suffix('*') {
        Some(prefix) if rule.ends_with(".*") => id.starts_with(prefix),
        _ => id == rule,
    }
}

// ---------------------------------------------------------------------------
// 快捷键
// ---------------------------------------------------------------------------

/// 主键名:特殊键查表,字母 / 数字取虚拟键码,其余(标点)用调用方按当前键盘布局换算出的字符;取不到 → None(不报)。
pub fn key_name(vk: u32, character: Option<char>) -> Option<String> {
    let special = match vk {
        0x08 => "Backspace",
        0x09 => "Tab",
        0x0D => "Enter",
        0x1B => "Esc",
        0x20 => "Space",
        0x21 => "PageUp",
        0x22 => "PageDown",
        0x23 => "End",
        0x24 => "Home",
        0x25 => "Left",
        0x26 => "Up",
        0x27 => "Right",
        0x28 => "Down",
        0x2C => "PrintScreen",
        0x2D => "Insert",
        0x2E => "Delete",
        _ => "",
    };
    if !special.is_empty() {
        return Some(special.to_owned());
    }
    match vk {
        0x30..=0x39 | 0x41..=0x5A => return char::from_u32(vk).map(String::from),
        0x60..=0x69 => return Some(format!("Num{}", vk - 0x60)),
        0x70..=0x87 => return Some(format!("F{}", vk - 0x6F)),
        _ => {}
    }
    let ch = character?;
    if ch.is_control() || ch.is_whitespace() {
        return None;
    }
    Some(ch.to_uppercase().collect())
}

/// 组合串,如「Ctrl+Shift+P」「Win+E」。没按 Ctrl / Win 的一律不算快捷键 → None。
pub fn key_combo(ctrl: bool, alt: bool, shift: bool, win: bool, key: &str) -> Option<String> {
    if !(ctrl || win) || key.is_empty() {
        return None;
    }
    let mut parts = Vec::with_capacity(5);
    if win {
        parts.push("Win");
    }
    if ctrl {
        parts.push("Ctrl");
    }
    if alt {
        parts.push("Alt");
    }
    if shift {
        parts.push("Shift");
    }
    parts.push(key);
    Some(parts.join("+"))
}

// ---------------------------------------------------------------------------
// 策略、情境、投递
// ---------------------------------------------------------------------------

/// 订阅者随 recordSubscribe 下发的策略。全部可选;硬排除名单在它之上生效。
#[derive(Debug, Clone, PartialEq)]
pub struct Policy {
    pub exclude_bundle_ids: Vec<String>,
    pub title_only_bundle_ids: Vec<String>,
    /// 已归一的裸域名。
    pub exclude_domains: Vec<String>,
    pub text: bool,
    pub clicks: bool,
    pub keys: bool,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            exclude_bundle_ids: Vec::new(),
            title_only_bundle_ids: Vec::new(),
            exclude_domains: Vec::new(),
            text: true,
            clicks: true,
            keys: true,
        }
    }
}

impl Policy {
    pub fn from_json(value: Option<&Value>) -> Self {
        let empty = Map::new();
        let object = value.and_then(Value::as_object).unwrap_or(&empty);
        let list = |key: &str| -> Vec<String> {
            object
                .get(key)
                .and_then(Value::as_array)
                .map(|items| {
                    items
                        .iter()
                        .filter_map(Value::as_str)
                        .take(1000)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        };
        let flag = |key: &str| object.get(key).and_then(Value::as_bool).unwrap_or(true);
        Self {
            exclude_bundle_ids: list("excludeBundleIds"),
            title_only_bundle_ids: list("titleOnlyBundleIds"),
            exclude_domains: list("excludeDomains")
                .iter()
                .filter_map(|d| normalize_domain(d))
                .collect(),
            text: flag("text"),
            clicks: flag("clicks"),
            keys: flag("keys"),
        }
    }

    pub fn excludes(&self, bundle_id: &str) -> bool {
        self.exclude_bundle_ids
            .iter()
            .any(|p| bundle_matches(bundle_id, p))
    }

    pub fn title_only(&self, bundle_id: &str) -> bool {
        self.title_only_bundle_ids
            .iter()
            .any(|p| bundle_matches(bundle_id, p))
    }

    /// 这个订阅者要不要这个 App 标题以上的信息。
    pub fn wants_app(&self, bundle_id: &str) -> bool {
        !self.excludes(bundle_id)
    }

    pub fn wants_text_in(&self, bundle_id: &str) -> bool {
        self.text && !self.excludes(bundle_id) && !self.title_only(bundle_id)
    }
}

/// 一次观测时的前台情境。纯数据,过滤只看它 —— 所以能单测。
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Context {
    pub name: String,
    /// 小写 exe 名。
    pub bundle_id: String,
    /// 硬排除(密码管理器 / 凭据界面 / 采集器自己):连标题都没读。
    pub hard_excluded: bool,
    /// 无痕 / 私密窗口时恒为 None。
    pub title: Option<String>,
    pub url: Option<String>,
    /// 浏览器但网址没读到。订阅者设了排除站点时按排除处理。
    pub url_unknown: bool,
    pub is_private: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    App,
    Window,
    Text,
    Click,
    Key,
    System,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::App => "app",
            Kind::Window => "window",
            Kind::Text => "text",
            Kind::Click => "click",
            Kind::Key => "key",
            Kind::System => "system",
        }
    }
}

/// 按某个订阅者的策略,把一次观测变成事件体(不含 t / origin / 各 kind 自己的字段)。None = 这个订阅者不该收到。
/// 规则与 macOS recorderEventBody 逐条一致:排除 App 只留切换;排除站点(含设了排除站点而网址没读到)留不带内容的
/// app / window 标记;无痕窗口只留一条不带标题的切换;只记标题的 App 没有 text / click / key。
pub fn event_body(kind: Kind, context: Option<&Context>, policy: &Policy) -> Option<Map<String, Value>> {
    let mut body = Map::new();
    body.insert("kind".into(), json!(kind.as_str()));
    let Some(context) = context else {
        return (kind == Kind::System).then_some(body);
    };
    let mut app = Map::new();
    app.insert("name".into(), json!(context.name));
    if !context.bundle_id.is_empty() {
        app.insert("bundleId".into(), json!(context.bundle_id));
    }
    let domain_excluded = match context.url.as_deref().and_then(url_host) {
        Some(host) => policy.exclude_domains.iter().any(|d| host_matches(&host, d)),
        None => context.url_unknown && !policy.exclude_domains.is_empty(),
    };
    let app_excluded = context.hard_excluded || policy.excludes(&context.bundle_id);
    if app_excluded || domain_excluded {
        if !(kind == Kind::App || (kind == Kind::Window && !app_excluded)) {
            return None;
        }
        app.insert("excluded".into(), json!(true));
        body.insert("app".into(), Value::Object(app));
        return Some(body);
    }
    body.insert("app".into(), Value::Object(app));
    if context.is_private {
        return (kind == Kind::App).then_some(body);
    }
    match kind {
        Kind::Text if !policy.text => return None,
        Kind::Click if !policy.clicks => return None,
        Kind::Key if !policy.keys => return None,
        _ => {}
    }
    if matches!(kind, Kind::Text | Kind::Click | Kind::Key) && policy.title_only(&context.bundle_id) {
        return None;
    }
    if let Some(title) = context.title.as_deref().filter(|t| !t.is_empty()) {
        body.insert("title".into(), json!(title));
    }
    if let Some(url) = &context.url {
        body.insert("url".into(), json!(url));
    }
    Some(body)
}

/// app / window 事件的去重键(与 macOS recorderContextKey、桌面 contextKey 同口径)。
pub fn context_key(body: &Map<String, Value>) -> String {
    let app = body.get("app").and_then(Value::as_object);
    let id = app
        .and_then(|a| a.get("bundleId").or_else(|| a.get("name")))
        .and_then(Value::as_str)
        .unwrap_or("");
    let excluded = app
        .and_then(|a| a.get("excluded"))
        .and_then(Value::as_bool)
        == Some(true);
    let field = |key: &str| body.get(key).and_then(Value::as_str).unwrap_or("");
    [id, if excluded { "x" } else { "" }, field("title"), field("url")].join("\u{1F}")
}

/// 一个订阅者的情境投递状态。只在 recorder 线程读写。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct DeliveryState {
    pub last_key: Option<String>,
    /// 最近处理过的情境对它没记(无痕 / 排除):下一条可记录的情境事件带 `resumed: true`。
    pub unrecorded: bool,
}

pub fn context_recorded(context: &Context, policy: &Policy) -> bool {
    event_body(Kind::Window, Some(context), policy).is_some_and(|body| {
        body.get("app")
            .and_then(|a| a.get("excluded"))
            .and_then(Value::as_bool)
            != Some(true)
    })
}

/// 一条 app / window 情境事件对某个订阅者:发什么(None = 不发),并更新它的投递状态。
/// 与 macOS recorderContextDelivery 一致(去重、无痕窗口的键、断点 resumed 的规则见那边的长注释)。
pub fn context_delivery(
    kind: Kind,
    context: Option<&Context>,
    policy: &Policy,
    state: &mut DeliveryState,
    dedupe: bool,
) -> Option<Map<String, Value>> {
    let context = context?;
    let recorded = context_recorded(context, policy);
    if !recorded {
        state.unrecorded = true;
    }
    let Some(mut body) = event_body(kind, Some(context), policy) else {
        if kind == Kind::Window {
            if let Some(app) = event_body(Kind::App, Some(context), policy) {
                state.last_key = Some(context_key(&app));
            }
        }
        return None;
    };
    let key = context_key(&body);
    let resumed = recorded && state.unrecorded;
    if dedupe && state.last_key.as_deref() == Some(key.as_str()) && !resumed {
        return None;
    }
    if resumed {
        body.insert("resumed".into(), json!(true));
        state.unrecorded = false;
    }
    state.last_key = Some(key);
    Some(body)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PendingAction {
    Keep,
    Flush,
    Drop,
}

/// 窗口情境刷新时待发那段输入怎么办(与 macOS recorderPendingOnRefresh 一致)。
pub fn pending_on_refresh(next_wants_text: bool, window_changed: bool, url_changed: bool) -> PendingAction {
    if !next_wants_text {
        PendingAction::Drop
    } else if window_changed || url_changed {
        PendingAction::Flush
    } else {
        PendingAction::Keep
    }
}

/// `serve --pipe` 的管道名只收本机命名管道(`\\.\pipe\…`,不含别的反斜杠以外的路径成分)。
pub fn pipe_name_valid(name: &str) -> bool {
    name.strip_prefix(r"\\.\pipe\").is_some_and(|rest| {
        !rest.is_empty()
            && rest.len() <= 200
            && !rest.contains('\\')
            && rest
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
    })
}
