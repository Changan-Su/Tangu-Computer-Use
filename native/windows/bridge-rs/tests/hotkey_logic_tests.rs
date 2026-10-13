//! 全局手势订阅纯逻辑(src/hotkey_logic.rs)的单测 —— 状态机与 macOS hotkey_monitor_tests.swift 同一批用例,
//! 任何平台都能跑(`cargo test --test hotkey_logic_tests`)。

use serde_json::json;
use windows_bridge::hotkey_logic::*;

#[derive(Clone, Copy)]
enum Step {
    Mods(bool, bool),
    ModsWithOthers(bool, bool),
    Key,
}
use Step::*;

/// 跑一串输入,返回触发发生在第几步(下标)。
fn fires(steps: &[Step]) -> Vec<usize> {
    let mut machine = ModPair::new();
    let mut fired = Vec::new();
    for (index, step) in steps.iter().enumerate() {
        let fire = match *step {
            Mods(left, right) => machine.modifiers(left, right, false),
            ModsWithOthers(left, right) => machine.modifiers(left, right, true),
            Key => {
                machine.other_key();
                false
            }
        };
        if fire {
            fired.push(index);
        }
    }
    fired
}

#[test]
fn fires_once_when_the_second_goes_down() {
    assert_eq!(fires(&[Mods(true, false), Mods(true, true)]), [1]);
    assert_eq!(fires(&[Mods(false, true), Mods(true, true)]), [1]);
    assert!(fires(&[Mods(true, false)]).is_empty());
    assert!(fires(&[Mods(false, true), Mods(false, false)]).is_empty());
}

#[test]
fn holding_and_key_repeat_do_not_fire_again() {
    assert_eq!(fires(&[Mods(true, false), Mods(true, true), Mods(true, true), Mods(true, true)]), [1]);
    // Windows 上按住修饰键会一直重复 WM_KEYDOWN:同一状态重复送进来。
    assert_eq!(fires(&[Mods(true, false), Mods(true, false), Mods(true, false), Mods(true, true)]), [3]);
    assert_eq!(fires(&[Mods(true, false), Mods(true, true), Mods(true, false), Mods(true, true)]), [1]);
}

#[test]
fn both_must_be_released_before_it_fires_again() {
    assert_eq!(
        fires(&[Mods(true, false), Mods(true, true), Mods(false, true), Mods(false, false), Mods(false, true), Mods(true, true)]),
        [1, 5]
    );
}

#[test]
fn other_modifiers_cancel() {
    assert!(fires(&[ModsWithOthers(true, false), ModsWithOthers(true, true)]).is_empty());
    assert!(fires(&[Mods(true, false), ModsWithOthers(true, true)]).is_empty());
    assert!(fires(&[Mods(true, false), ModsWithOthers(true, false), Mods(true, false), Mods(true, true)]).is_empty());
    assert_eq!(fires(&[ModsWithOthers(false, false), Mods(false, false), Mods(true, false), Mods(true, true)]), [3]);
}

#[test]
fn a_non_modifier_key_cancels_until_both_are_released() {
    assert!(fires(&[Mods(true, false), Key, Mods(true, true)]).is_empty());
    assert!(fires(&[Mods(true, false), Key, Mods(true, true), Mods(false, true), Mods(true, true)]).is_empty());
    assert_eq!(fires(&[Mods(true, false), Key, Mods(false, false), Mods(true, false), Mods(true, true)]), [4]);
    assert_eq!(fires(&[Key, Key, Mods(true, false), Mods(true, true)]), [3]);
    assert_eq!(fires(&[Mods(true, false), Mods(true, true), Key, Mods(true, false), Mods(true, true)]), [1]);
}

#[test]
fn missed_events_do_not_fire_and_heal() {
    assert!(fires(&[Mods(true, true)]).is_empty());
    assert!(fires(&[Mods(true, true), Mods(true, false), Mods(true, true)]).is_empty());
    assert_eq!(fires(&[Mods(true, true), Mods(false, false), Mods(true, false), Mods(true, true)]), [3]);
    assert!(fires(&[Mods(true, false), Mods(false, true)]).is_empty());
    // 触发之后松开左键,右键的抬起没收到;下一次只按着左键 = 换了边,中间两个必然都松开过。
    assert_eq!(fires(&[Mods(true, false), Mods(true, true), Mods(false, true), Mods(true, false), Mods(true, true)]), [1, 4]);
    assert_eq!(fires(&[Mods(true, false), Key, Mods(false, true), Mods(true, true)]), [3]);
    assert!(fires(&[Mods(true, false), ModsWithOthers(false, true), ModsWithOthers(true, true)]).is_empty());
}

#[test]
fn virtual_keys_are_classified() {
    assert_eq!(classify_vk(0xA2), KeyClass::LeftCtrl);
    assert_eq!(classify_vk(0xA3), KeyClass::RightCtrl);
    assert_eq!(classify_vk(0x11), KeyClass::Ctrl);
    for vk in [0x10, 0x12, 0xA0, 0xA1, 0xA4, 0xA5, 0x5B, 0x5C] {
        assert_eq!(classify_vk(vk), KeyClass::Disqualifier, "vk {vk:#x}");
    }
    // 字母、数字、功能键、Caps Lock、Esc、注入 Unicode 用的 VK_PACKET:都只是「别的键」。
    for vk in [0x41, 0x43, 0x30, 0x70, 0x14, 0x1B, 0x0D, 0x20, 0xE7] {
        assert_eq!(classify_vk(vk), KeyClass::Other, "vk {vk:#x}");
    }
}

fn keys(left_ctrl: bool, right_ctrl: bool) -> AsyncKeys {
    AsyncKeys { left_ctrl, right_ctrl, ..AsyncKeys::default() }
}

#[test]
fn key_events_become_state_snapshots() {
    // 回调时系统还没更新这次事件的那个键:它以事件为准,另一个以系统报的为准。
    assert_eq!(key_input(VK_LCONTROL, true, keys(false, false)), KeyInput::Modifiers { left: true, right: false, others: false });
    assert_eq!(key_input(VK_RCONTROL, true, keys(true, false)), KeyInput::Modifiers { left: true, right: true, others: false });
    assert_eq!(key_input(VK_RCONTROL, false, keys(true, true)), KeyInput::Modifiers { left: true, right: false, others: false });
    assert_eq!(key_input(VK_LCONTROL, false, keys(true, false)), KeyInput::Modifiers { left: false, right: false, others: false });
    // 漏掉了左 Ctrl 的抬起(安全桌面期间):下一次修饰键事件时系统报它没按着,状态对齐回来。
    assert_eq!(key_input(VK_RCONTROL, true, keys(false, false)), KeyInput::Modifiers { left: false, right: true, others: false });
    // 不分左右的 Ctrl:左右都向系统问。
    assert_eq!(key_input(VK_CONTROL, true, keys(true, false)), KeyInput::Modifiers { left: true, right: false, others: false });
}

#[test]
fn shift_alt_win_disqualify() {
    let shift = AsyncKeys { left_ctrl: true, shift: true, ..AsyncKeys::default() };
    assert_eq!(key_input(VK_RCONTROL, true, shift), KeyInput::Modifiers { left: true, right: true, others: true });
    let alt = AsyncKeys { alt: true, ..AsyncKeys::default() };
    assert_eq!(key_input(VK_LCONTROL, true, alt), KeyInput::Modifiers { left: true, right: false, others: true });
    let win = AsyncKeys { left_ctrl: true, win: true, ..AsyncKeys::default() };
    assert_eq!(key_input(VK_RCONTROL, true, win), KeyInput::Modifiers { left: true, right: true, others: true });
    // Shift 自己按下的那条事件:系统还没报它按着,以事件为准。
    assert_eq!(key_input(VK_LSHIFT, true, keys(true, false)), KeyInput::Modifiers { left: true, right: false, others: true });
    assert_eq!(key_input(VK_LSHIFT, false, keys(false, false)), KeyInput::Modifiers { left: false, right: false, others: false });
}

#[test]
fn other_keys_carry_no_value() {
    assert_eq!(key_input(0x43, true, AsyncKeys::default()), KeyInput::OtherKey);
    assert_eq!(key_input(0x56, true, AsyncKeys::default()), KeyInput::OtherKey);
    assert_eq!(key_input(0x43, false, AsyncKeys::default()), KeyInput::Ignore);
}

/// 按真实的事件顺序喂:每条事件之后「系统报的状态」跟着更新。
struct Keyboard {
    machine: ModPair,
    down: std::collections::BTreeSet<u32>,
}

impl Keyboard {
    fn new() -> Self {
        Self { machine: ModPair::new(), down: Default::default() }
    }

    fn event(&mut self, vk: u32, down: bool) -> bool {
        let held = |keys: &[u32]| keys.iter().any(|key| self.down.contains(key));
        let snapshot = AsyncKeys {
            left_ctrl: held(&[VK_LCONTROL]),
            right_ctrl: held(&[VK_RCONTROL]),
            shift: held(&[VK_LSHIFT, VK_RSHIFT]),
            alt: held(&[VK_LMENU, VK_RMENU]),
            win: held(&[VK_LWIN, VK_RWIN]),
        };
        let fire = self.machine.feed(key_input(vk, down, snapshot));
        if down {
            self.down.insert(vk);
        } else {
            self.down.remove(&vk);
        }
        fire
    }

    fn run(&mut self, events: &[(u32, bool)]) -> usize {
        events.iter().filter(|(vk, down)| self.event(*vk, *down)).count()
    }
}

#[test]
fn real_key_sequences() {
    let pair = [(VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)];
    assert_eq!(Keyboard::new().run(&pair), 1);
    assert_eq!(Keyboard::new().run(&[(VK_RCONTROL, true), (VK_LCONTROL, true), (VK_LCONTROL, false), (VK_RCONTROL, false)]), 1);
    // 两遍 = 两次。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&pair) + keyboard.run(&pair), 2);
    // 按住不放的重复按下。
    assert_eq!(
        Keyboard::new().run(&[(VK_LCONTROL, true), (VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, true), (VK_LCONTROL, true)]),
        1
    );
    // Ctrl+C,然后另一个 Ctrl。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (0x43, true), (0x43, false), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)]), 0);
    // Shift 按着。
    assert_eq!(Keyboard::new().run(&[(VK_LSHIFT, true), (VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false), (VK_LSHIFT, false)]), 0);
    // AltGr = 驱动先补一个左 Ctrl,再来右 Alt:之后按右 Ctrl 不算。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (VK_RMENU, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_RMENU, false), (VK_LCONTROL, false)]), 0);
    // Win+Ctrl 组合。
    assert_eq!(Keyboard::new().run(&[(VK_LWIN, true), (VK_LCONTROL, true), (VK_RCONTROL, true)]), 0);
    // 作废的一轮过后,干净地再来一次照常触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (0x41, true), (0x41, false), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)]), 0);
    assert_eq!(keyboard.run(&pair), 1);
    // 一先一后、没有重叠。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (VK_LCONTROL, false), (VK_RCONTROL, true), (VK_RCONTROL, false)]), 0);
}

#[test]
fn a_missed_key_up_heals_without_firing() {
    // 左 Ctrl 按下之后切进了安全桌面,抬起没收到;回来后单按右 Ctrl 不该触发。
    let mut keyboard = Keyboard::new();
    assert!(!keyboard.event(VK_LCONTROL, true));
    keyboard.down.clear();
    assert!(!keyboard.event(VK_RCONTROL, true));
    assert!(!keyboard.event(VK_RCONTROL, false));
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true)]), 1);

    // 触发之后右 Ctrl 的抬起没收到(左 Ctrl 的收到了):下一次干净的手势照常触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true), (VK_LCONTROL, false)]), 1);
    keyboard.down.clear();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true)]), 1);
}

#[test]
fn gesture_names() {
    assert!(gesture_known(Some("modPair")));
    assert!(!gesture_known(Some("modpair")));
    assert!(!gesture_known(Some("tripleTap")));
    assert!(!gesture_known(None));
}

#[test]
fn exclude_pids_are_parsed_leniently() {
    assert_eq!(exclude_pids(Some(&json!([1234, 5678]))), [1234, 5678]);
    assert_eq!(exclude_pids(Some(&json!([1, "2", -3, 4.5, null, 4294967296u64, 7]))), [1, 7]);
    assert!(exclude_pids(Some(&json!("1234"))).is_empty());
    assert!(exclude_pids(None).is_empty());
    assert!(excluded(&[10, 20], &[5, 20]));
    assert!(!excluded(&[10, 20], &[5, 6]));
    assert!(!excluded(&[], &[5]));
    assert!(!excluded(&[10], &[]));
}

#[test]
fn app_names_and_titles() {
    assert_eq!(app_name(Some("Google Chrome"), "chrome.exe"), "Google Chrome");
    assert_eq!(app_name(Some("   "), "Notepad.exe"), "Notepad");
    assert_eq!(app_name(None, "CODE.EXE"), "CODE");
    assert_eq!(app_name(None, ""), "");
    assert_eq!(window_title("  Untitled\r\n - Notepad  "), "Untitled - Notepad");
    assert_eq!(window_title(""), "");
    assert_eq!(window_title(&"字".repeat(500)).chars().count(), windows_bridge::recorder_logic::limit::TITLE);
}

#[test]
fn event_shape() {
    let front = Front {
        exe: "chrome.exe".into(),
        path: r"C:\Program Files\Google\Chrome\Application\chrome.exe".into(),
        app: "Google Chrome".into(),
        pid: 4242,
        window_id: 0x0001_0A2C,
        title: "Example Domain - Google Chrome".into(),
    };
    assert_eq!(
        event(1_760_000_000_123, Some(&front)),
        json!({ "ev": {
            "t": 1_760_000_000_123i64,
            "kind": "hotkey",
            "gesture": "modPair",
            "front": {
                "exe": "chrome.exe",
                "path": r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                "app": "Google Chrome",
                "pid": 4242,
                "windowId": 68140,
                "title": "Example Domain - Google Chrome",
            },
        }})
    );
    let unknown = event(1, None);
    assert!(unknown["ev"]["front"].is_null());
    assert_eq!(unknown["ev"].as_object().map(|body| body.len()), Some(4));
    // 一行一条:序列化后不含换行。
    assert!(!serde_json::to_string(&event(1, Some(&front))).unwrap().contains('\n'));
}
