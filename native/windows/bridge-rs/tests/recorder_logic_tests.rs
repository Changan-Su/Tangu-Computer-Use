//! 电脑历史采集器纯逻辑(src/recorder_logic.rs)的单测 —— 与 macOS activity_recorder_tests.swift 同一批用例,
//! 任何平台都能跑(`cargo test`)。

use serde_json::{json, Value};
use windows_bridge::recorder_logic::*;

fn ctx(name: &str, bundle: &str, title: Option<&str>, url: Option<&str>) -> Context {
    Context {
        name: name.into(),
        bundle_id: bundle.into(),
        title: title.map(Into::into),
        url: url.map(Into::into),
        ..Context::default()
    }
}

fn excluded(body: &Option<serde_json::Map<String, Value>>) -> bool {
    body.as_ref()
        .and_then(|b| b.get("app"))
        .and_then(|a| a.get("excluded"))
        .and_then(Value::as_bool)
        == Some(true)
}

fn field<'a>(body: &'a Option<serde_json::Map<String, Value>>, key: &str) -> Option<&'a str> {
    body.as_ref().and_then(|b| b.get(key)).and_then(Value::as_str)
}

#[test]
fn text_diff_matches_macos() {
    assert_eq!(text_diff("abc", "abc"), None);
    assert_eq!(text_diff("", "hello"), Some(TextDiff { inserted: "hello".into(), deleted: 0 }));
    assert_eq!(text_diff("hello world", "hello brave world"), Some(TextDiff { inserted: "brave ".into(), deleted: 0 }));
    assert_eq!(text_diff("hello world", "hello"), Some(TextDiff { inserted: "".into(), deleted: 6 }));
    assert_eq!(text_diff("cat", "cot"), Some(TextDiff { inserted: "o".into(), deleted: 1 }));
    assert_eq!(text_diff("aa", "aaa"), Some(TextDiff { inserted: "a".into(), deleted: 0 }));
    assert_eq!(text_diff("你好", "你们好"), Some(TextDiff { inserted: "们".into(), deleted: 0 }));
}

#[test]
fn settle_text_matches_macos() {
    assert_eq!(settle_text("", Some("hello"), ""), Some(TextDiff { inserted: "hello".into(), deleted: 0 }), "cleared after send");
    assert_eq!(settle_text("draft", Some("draft more"), "draft more!"), Some(TextDiff { inserted: " more!".into(), deleted: 0 }));
    assert_eq!(settle_text("abc", None, "ab"), Some(TextDiff { inserted: "".into(), deleted: 1 }));
    assert_eq!(settle_text("x", Some("x"), "x"), None);
}

#[test]
fn text_fields_cap_and_deletions() {
    let long = text_fields(&TextDiff { inserted: "x".repeat(900), deleted: 3 });
    assert_eq!(long["text"].as_str().unwrap().chars().count(), limit::TEXT);
    assert_eq!(long["truncated"], json!(true));
    assert_eq!(long["deleted"], json!(3));
    let deletion = text_fields(&TextDiff { inserted: "".into(), deleted: 12 });
    assert!(deletion.get("text").is_none());
    assert_eq!(deletion["deleted"], json!(12));
}

#[test]
fn strings_are_collapsed_and_capped() {
    assert_eq!(truncate("abc", 5), ("abc".into(), false));
    assert_eq!(truncate("abcdef", 3), ("abc".into(), true));
    assert_eq!(truncate("你好世界", 2), ("你好".into(), true));
    assert_eq!(label("  Send\n  message  "), Some("Send message".into()));
    assert_eq!(label("   "), None);
    assert_eq!(label(&"x".repeat(200)).unwrap().len(), limit::LABEL);
    assert_eq!(title(&"t".repeat(300)).unwrap().len(), limit::TITLE);
}

#[test]
fn private_markers() {
    assert!(has_private_marker("Example — Mozilla Firefox Private Browsing"));
    assert!(has_private_marker("New Tab - Google Chrome (Incognito)"));
    assert!(has_private_marker("[InPrivate] Bing - Microsoft Edge"));
    assert!(has_private_marker("新标签页 - 无痕模式"));
    assert!(!has_private_marker("Pull requests · Private repo"));
    assert!(!has_private_marker("Inbox (3) - Gmail"));
}

#[test]
fn urls_are_sanitized() {
    assert_eq!(sanitize_url("https://example.com/path?token=abc#frag").as_deref(), Some("https://example.com/path"));
    assert_eq!(sanitize_url("https://user:pw@example.com/a").as_deref(), Some("https://example.com/a"));
    assert_eq!(sanitize_url("example.com/docs").as_deref(), Some("https://example.com/docs"));
    assert_eq!(sanitize_url("github.com").as_deref(), Some("https://github.com"));
    assert_eq!(sanitize_url("HTTP://Example.com:8080/a?b").as_deref(), Some("http://Example.com:8080/a"));
    assert_eq!(sanitize_url("how to cook rice"), None);
    assert_eq!(sanitize_url("githu"), None);
    assert_eq!(sanitize_url("file:///C:/Users/me/secret.pdf"), None);
    assert_eq!(sanitize_url("chrome://newtab"), None);
    assert_eq!(sanitize_url("edge://settings"), None);
    assert_eq!(sanitize_url(&format!("https://example.com/{}", "a".repeat(400))).unwrap().chars().count(), limit::URL);
    assert_eq!(url_host("https://Docs.Example.com/x").as_deref(), Some("docs.example.com"));
    assert_eq!(url_host("https://user@Example.com:8443/x").as_deref(), Some("example.com"));
    assert_eq!(url_host("http://[::1]:3000/").as_deref(), Some("::1"));
}

#[test]
fn address_bar_values() {
    assert_eq!(address_bar_url(""), (None, true), "new tab page: resolved, no site");
    assert_eq!(address_bar_url("github.com/forsion"), (Some("https://github.com/forsion".into()), true));
    assert_eq!(address_bar_url("chrome://settings/privacy"), (None, true));
    assert_eq!(address_bar_url("edge://newtab"), (None, true));
    assert_eq!(address_bar_url("about:blank"), (None, true));
    assert_eq!(address_bar_url("mybank"), (None, false), "half-typed text is unresolved");
    assert_eq!(address_bar_url("how to cook rice"), (None, false));
    assert_eq!(address_bar_url("view-source:https://x.com"), (None, false), "wrapping schemes are not internal pages");
}

#[test]
fn address_field_detection() {
    assert!(is_address_field("Address and search bar", "OmniboxViewViews", ""));
    assert!(is_address_field("", "OmniboxViewViews", ""));
    assert!(is_address_field("Search with Google or enter address", "", "urlbar-input"));
    assert!(is_address_field("地址和搜索栏", "", ""));
    assert!(!is_address_field("Message", "", ""));
}

#[test]
fn domains_and_bundles() {
    assert_eq!(normalize_domain("https://www.Example.com/path").as_deref(), Some("www.example.com"));
    assert_eq!(normalize_domain("*.example.com").as_deref(), Some("example.com"));
    assert_eq!(normalize_domain(".example.com.").as_deref(), Some("example.com"));
    assert_eq!(normalize_domain("example.com:8443").as_deref(), Some("example.com"));
    assert_eq!(normalize_domain("   "), None);
    assert!(host_matches("example.com", "example.com"));
    assert!(host_matches("mail.example.com", "example.com"));
    assert!(host_matches("MAIL.example.com.", "example.com"));
    assert!(!host_matches("badexample.com", "example.com"));
    assert!(!host_matches("example.com.evil.net", "example.com"));
    assert!(bundle_matches("com.forsion.desktop", "com.forsion.*"));
    assert!(!bundle_matches("com.forsionx.desktop", "com.forsion.*"));
    assert!(bundle_matches("Chrome.EXE", "chrome.exe"));
    assert!(!bundle_matches("chrome.exe.bak", "chrome.exe"));
    assert!(is_hard_excluded("KeePassXC.exe"));
    assert!(is_hard_excluded("1Password.exe"));
    assert!(!is_hard_excluded("notepad.exe"));
    assert!(is_browser("MSEdge.exe") && is_browser("firefox.exe") && !is_browser("thunderbird.exe"));
    assert!(is_ignored("SearchHost.exe", "") && is_ignored("explorer.exe", "Shell_TrayWnd"));
    assert!(!is_ignored("explorer.exe", "CabinetWClass"));
}

#[test]
fn controls() {
    assert_eq!(text_mode(CT_EDIT, false, Some(true), None), Some(TextMode::Value));
    assert_eq!(text_mode(CT_EDIT, true, Some(true), None), None, "password fields are never text");
    assert_eq!(text_mode(CT_EDIT, false, Some(false), Some(true)), None, "read-only value means not editable");
    assert_eq!(text_mode(CT_DOCUMENT, false, None, Some(true)), Some(TextMode::Text), "rich text documents");
    assert_eq!(text_mode(CT_DOCUMENT, false, None, Some(false)), None, "a read-only web page is not a field");
    assert_eq!(text_mode(CT_GROUP, false, None, Some(true)), Some(TextMode::Text), "web contenteditable");
    assert_eq!(text_mode(CT_BUTTON, false, Some(true), None), None, "buttons with a value are not text");
    assert_eq!(text_mode(CT_COMBOBOX, false, None, Some(true)), None);
    assert_eq!(text_mode(CT_BUTTON, false, None, None), None);
    assert!(click_label_allowed(CT_BUTTON) && click_label_allowed(CT_TABITEM) && click_label_allowed(CT_HYPERLINK));
    assert!(!click_label_allowed(CT_EDIT), "text fields never carry a label");
    assert!(!click_label_allowed(CT_DOCUMENT));
    assert_eq!(control_type_name(CT_MENUITEM), "MenuItem");
    assert_eq!(control_type_name(CT_RADIOBUTTON), "RadioButton");
    assert_eq!(control_type_name(1), "Unknown");
}

#[test]
fn shortcuts() {
    assert_eq!(key_combo(true, false, true, false, "P").as_deref(), Some("Ctrl+Shift+P"));
    assert_eq!(key_combo(false, false, true, true, "S").as_deref(), Some("Win+Shift+S"));
    assert_eq!(key_combo(false, true, true, false, "A"), None, "no Ctrl or Win means no shortcut");
    assert_eq!(key_name(0x41, None).as_deref(), Some("A"));
    assert_eq!(key_name(0x35, None).as_deref(), Some("5"));
    assert_eq!(key_name(0x0D, None).as_deref(), Some("Enter"));
    assert_eq!(key_name(0x70, None).as_deref(), Some("F1"));
    assert_eq!(key_name(0x7B, None).as_deref(), Some("F12"));
    assert_eq!(key_name(0xBF, Some('/')).as_deref(), Some("/"));
    assert_eq!(key_name(0xBA, Some('\u{3}')), None, "control characters are not key names");
    assert_eq!(key_name(0xBA, None), None);
}

#[test]
fn event_bodies() {
    let open = Policy::default();
    let chrome = ctx("Google Chrome", "chrome.exe", Some("Docs"), Some("https://docs.example.com/a"));
    let full = event_body(Kind::Window, Some(&chrome), &open);
    assert_eq!(field(&full, "title"), Some("Docs"));
    assert_eq!(field(&full, "url"), Some("https://docs.example.com/a"));

    let domain_off = Policy::from_json(Some(&json!({ "excludeDomains": ["example.com"] })));
    let switched = event_body(Kind::App, Some(&chrome), &domain_off);
    assert!(excluded(&switched) && field(&switched, "title").is_none() && field(&switched, "url").is_none());
    assert!(event_body(Kind::Text, Some(&chrome), &domain_off).is_none());
    assert!(event_body(Kind::Click, Some(&chrome), &domain_off).is_none());
    let marker = event_body(Kind::Window, Some(&chrome), &domain_off);
    assert!(excluded(&marker) && field(&marker, "title").is_none());

    let app_off = Policy::from_json(Some(&json!({ "excludeBundleIds": ["Chrome.exe"] })));
    let app_switch = event_body(Kind::App, Some(&chrome), &app_off);
    assert!(excluded(&app_switch) && field(&app_switch, "title").is_none());
    assert!(event_body(Kind::Window, Some(&chrome), &app_off).is_none());
    assert!(event_body(Kind::Key, Some(&chrome), &app_off).is_none());

    let title_only = Policy::from_json(Some(&json!({ "titleOnlyBundleIds": ["windowsterminal.exe", "com.forsion.*"] })));
    let terminal = ctx("Windows Terminal", "windowsterminal.exe", Some("pwsh"), None);
    assert_eq!(field(&event_body(Kind::Window, Some(&terminal), &title_only), "title"), Some("pwsh"));
    assert!(event_body(Kind::Text, Some(&terminal), &title_only).is_none());

    let mut incognito = ctx("Google Chrome", "chrome.exe", None, None);
    incognito.is_private = true;
    let private_app = event_body(Kind::App, Some(&incognito), &open);
    assert!(private_app.is_some() && field(&private_app, "title").is_none() && !excluded(&private_app));
    assert!(event_body(Kind::Text, Some(&incognito), &open).is_none());
    assert!(event_body(Kind::Window, Some(&incognito), &open).is_none());

    let mut vault = ctx("KeePassXC", "keepassxc.exe", None, None);
    vault.hard_excluded = true;
    assert!(excluded(&event_body(Kind::App, Some(&vault), &open)), "hard exclusion beats an open policy");
    assert!(event_body(Kind::Window, Some(&vault), &open).is_none());

    let no_text = Policy::from_json(Some(&json!({ "text": false, "clicks": true, "keys": false })));
    assert!(event_body(Kind::Text, Some(&chrome), &no_text).is_none());
    assert!(event_body(Kind::Key, Some(&chrome), &no_text).is_none());
    assert!(event_body(Kind::Click, Some(&chrome), &no_text).is_some());
    assert_eq!(field(&event_body(Kind::System, None, &open), "kind"), Some("system"));

    let garbage = Policy::from_json(Some(&json!({ "excludeBundleIds": "not-a-list", "text": "yes" })));
    assert!(garbage.exclude_bundle_ids.is_empty() && garbage.text);
    assert_eq!(Policy::from_json(Some(&json!({ "excludeDomains": ["Example.com"] }))).exclude_domains, vec!["example.com"]);

    let mut unknown = ctx("Google Chrome", "chrome.exe", Some("Chase — Accounts"), None);
    unknown.url_unknown = true;
    let fail_closed = event_body(Kind::Window, Some(&unknown), &domain_off);
    assert!(excluded(&fail_closed) && field(&fail_closed, "title").is_none(), "unknown URL fails closed when sites are excluded");
    assert_eq!(field(&event_body(Kind::Window, Some(&unknown), &open), "title"), Some("Chase — Accounts"));
}

#[test]
fn private_context_delivery() {
    let docs = ctx("Google Chrome", "chrome.exe", Some("Docs"), Some("https://docs.example.com/a"));
    let mail = ctx("Google Chrome", "chrome.exe", Some("Inbox"), Some("https://mail.example.com/"));
    let mut incognito = ctx("Google Chrome", "chrome.exe", None, None);
    incognito.is_private = true;
    let open = Policy::default();
    let mut state = DeliveryState::default();
    let mut deliver = |kind, c: &Context, dedupe| context_delivery(kind, Some(c), &open, &mut state, dedupe);
    assert_eq!(field(&deliver(Kind::App, &docs, false), "title"), Some("Docs"));
    assert!(deliver(Kind::Window, &docs, true).is_none(), "identical window event is deduped");
    assert!(deliver(Kind::Window, &incognito, true).is_none(), "entering private sends nothing");
    let back = deliver(Kind::Window, &docs, true);
    assert_eq!(field(&back, "title"), Some("Docs"), "returning to the same normal window is sent again");
    assert_eq!(back.as_ref().unwrap()["resumed"], json!(true), "and carries the resumed marker");
    assert!(deliver(Kind::Window, &docs, true).is_none());
    let _ = deliver(Kind::Window, &incognito, true);
    assert!(deliver(Kind::App, &incognito, true).is_none(), "re-activation while private sends no second switch");
    assert_eq!(field(&deliver(Kind::Window, &mail, true), "title"), Some("Inbox"));
}

#[test]
fn resumed_marker_is_per_policy_and_once() {
    let docs = ctx("Google Chrome", "chrome.exe", Some("Docs"), Some("https://docs.example.com/a"));
    let bank = ctx("Google Chrome", "chrome.exe", Some("Accounts"), Some("https://mybank.com/accounts"));
    let site_off = Policy::from_json(Some(&json!({ "excludeDomains": ["mybank.com"] })));
    let mut state = DeliveryState::default();
    assert!(context_delivery(Kind::App, Some(&docs), &site_off, &mut state, false).unwrap().get("resumed").is_none());
    let marker = context_delivery(Kind::Window, Some(&bank), &site_off, &mut state, true);
    assert!(excluded(&marker) && marker.as_ref().unwrap().get("resumed").is_none(), "the excluded marker itself never carries resumed");
    let back = context_delivery(Kind::Window, Some(&docs), &site_off, &mut state, true).unwrap();
    assert_eq!(back["resumed"], json!(true));
    let again = context_delivery(Kind::Window, Some(&bank), &site_off, &mut state, true);
    assert!(excluded(&again));
    // 另一个不排除这个站点的订阅者:同一串情境没有断点
    let mut open_state = DeliveryState::default();
    let open = Policy::default();
    let _ = context_delivery(Kind::App, Some(&docs), &open, &mut open_state, false);
    let _ = context_delivery(Kind::Window, Some(&bank), &open, &mut open_state, true);
    assert!(context_delivery(Kind::Window, Some(&docs), &open, &mut open_state, true).unwrap().get("resumed").is_none());
}

#[test]
fn pending_actions() {
    assert_eq!(pending_on_refresh(false, false, false), PendingAction::Drop);
    assert_eq!(pending_on_refresh(true, true, false), PendingAction::Flush);
    assert_eq!(pending_on_refresh(true, false, true), PendingAction::Flush);
    assert_eq!(pending_on_refresh(true, false, false), PendingAction::Keep);
}

#[test]
fn pipe_names() {
    assert!(pipe_name_valid(r"\\.\pipe\tangu-computer-use-recorder-1a2b3c4d-0123456789ab"));
    assert!(!pipe_name_valid(r"\\server\pipe\x"));
    assert!(!pipe_name_valid(r"\\.\pipe\"));
    assert!(!pipe_name_valid(r"\\.\pipe\a\b"));
    assert!(!pipe_name_valid(r"C:\temp\x"));
}

#[test]
fn context_keys_match_desktop() {
    let open = Policy::default();
    let chrome = ctx("Google Chrome", "chrome.exe", Some("Docs"), Some("https://docs.example.com/a"));
    let a = context_key(&event_body(Kind::App, Some(&chrome), &open).unwrap());
    let b = context_key(&event_body(Kind::Window, Some(&chrome), &open).unwrap());
    let mut retitled = chrome.clone();
    retitled.title = Some("Other".into());
    assert_eq!(a, b);
    assert_ne!(a, context_key(&event_body(Kind::Window, Some(&retitled), &open).unwrap()));
    assert_eq!(a, "chrome.exe\u{1F}\u{1F}Docs\u{1F}https://docs.example.com/a");
}
