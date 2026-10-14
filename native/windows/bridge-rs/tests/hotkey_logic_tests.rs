//! 全局手势订阅纯逻辑(src/hotkey_logic.rs)的单测 —— 状态机与 macOS hotkey_monitor_tests.swift 同一批用例,
//! 任何平台都能跑(`cargo test --test hotkey_logic_tests`)。
//! 状态机本身不分哪一族(`fires` 那几条只跑一遍);分族的是虚拟键这一层,`PAIRS` 三族各跑一遍同样的规则。

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

/// 一族修饰键的三个虚拟键(值照 WinUser.h 抄,不引用被测模块里的常量)。
#[derive(Clone, Copy, Debug)]
struct Pair {
    family: Family,
    gesture: &'static str,
    left: u32,
    right: u32,
    /// 不分左右的那个:VK_CONTROL / VK_SHIFT / VK_MENU。
    either: u32,
}

const CTRL: Pair = Pair { family: Family::Ctrl, gesture: "modPair", left: 0xA2, right: 0xA3, either: 0x11 };
const SHIFT: Pair = Pair { family: Family::Shift, gesture: "shiftPair", left: 0xA0, right: 0xA1, either: 0x10 };
const ALT: Pair = Pair { family: Family::Alt, gesture: "altPair", left: 0xA4, right: 0xA5, either: 0x12 };
const PAIRS: [Pair; 3] = [CTRL, SHIFT, ALT];
const WIN: [u32; 2] = [0x5B, 0x5C];
const NONE: [&str; 0] = [];

impl Pair {
    /// 另外两族的全部键(含不分左右的)+ Win:这一族的那一轮里按过任何一个就作废。
    fn disqualifiers(self) -> Vec<u32> {
        PAIRS
            .iter()
            .filter(|other| other.family != self.family)
            .flat_map(|other| [other.left, other.right, other.either])
            .chain(WIN)
            .collect()
    }
}

#[test]
fn virtual_keys_are_classified() {
    for pair in PAIRS {
        assert_eq!(classify_vk(pair.left), KeyClass::Left(pair.family));
        assert_eq!(classify_vk(pair.right), KeyClass::Right(pair.family));
        assert_eq!(classify_vk(pair.either), KeyClass::Either(pair.family));
        // 自己这一族的三个键(含不分左右的)不作废,另外两族的和 Win 都作废。
        for own in [pair.left, pair.right, pair.either] {
            assert!(!classify_vk(own).disqualifies(pair.family), "{} vk {own:#x}", pair.gesture);
        }
        for vk in pair.disqualifiers() {
            assert!(classify_vk(vk).disqualifies(pair.family), "{} vk {vk:#x}", pair.gesture);
        }
        assert!(!KeyClass::Other.disqualifies(pair.family));
    }
    for vk in WIN {
        assert_eq!(classify_vk(vk), KeyClass::Win, "vk {vk:#x}");
    }
    // 字母、数字、功能键、Caps Lock、Esc、注入 Unicode 用的 VK_PACKET:都只是「别的键」。
    for vk in [0x41, 0x43, 0x30, 0x70, 0x14, 0x1B, 0x0D, 0x20, 0xE7] {
        assert_eq!(classify_vk(vk), KeyClass::Other, "vk {vk:#x}");
    }
}

fn keys(left_ctrl: bool, right_ctrl: bool) -> AsyncKeys {
    AsyncKeys { left_ctrl, right_ctrl, ..AsyncKeys::default() }
}

/// 在 `keys` 上把 `family` 的左右两个键设成系统报的样子。
fn with_sides(mut keys: AsyncKeys, family: Family, left: bool, right: bool) -> AsyncKeys {
    match family {
        Family::Ctrl => (keys.left_ctrl, keys.right_ctrl) = (left, right),
        Family::Shift => (keys.left_shift, keys.right_shift) = (left, right),
        Family::Alt => (keys.left_alt, keys.right_alt) = (left, right),
    }
    keys
}

/// 在 `keys` 上把 `family` 不分左右的那个键设成按着(只有它,左右两个不动)。
fn with_either(mut keys: AsyncKeys, family: Family) -> AsyncKeys {
    match family {
        Family::Ctrl => keys.ctrl = true,
        Family::Shift => keys.shift = true,
        Family::Alt => keys.alt = true,
    }
    keys
}

fn sides(family: Family, left: bool, right: bool) -> AsyncKeys {
    with_sides(AsyncKeys::default(), family, left, right)
}

fn mods(left: bool, right: bool, others: bool) -> KeyInput {
    KeyInput::Modifiers { left, right, others }
}

#[test]
fn key_events_become_state_snapshots() {
    // 回调时系统还没更新这次事件的那个键:它以事件为准,另一个以系统报的为准。
    assert_eq!(key_input(Family::Ctrl, VK_LCONTROL, true, keys(false, false)), KeyInput::Modifiers { left: true, right: false, others: false });
    assert_eq!(key_input(Family::Ctrl, VK_RCONTROL, true, keys(true, false)), KeyInput::Modifiers { left: true, right: true, others: false });
    assert_eq!(key_input(Family::Ctrl, VK_RCONTROL, false, keys(true, true)), KeyInput::Modifiers { left: true, right: false, others: false });
    assert_eq!(key_input(Family::Ctrl, VK_LCONTROL, false, keys(true, false)), KeyInput::Modifiers { left: false, right: false, others: false });
    // 漏掉了左 Ctrl 的抬起(安全桌面期间):下一次修饰键事件时系统报它没按着,状态对齐回来。
    assert_eq!(key_input(Family::Ctrl, VK_RCONTROL, true, keys(false, false)), KeyInput::Modifiers { left: false, right: true, others: false });
    // 不分左右的 Ctrl:左右都向系统问。
    assert_eq!(key_input(Family::Ctrl, VK_CONTROL, true, keys(true, false)), KeyInput::Modifiers { left: true, right: false, others: false });
}

#[test]
fn shift_alt_win_disqualify() {
    let shift = AsyncKeys { left_ctrl: true, shift: true, ..AsyncKeys::default() };
    assert_eq!(key_input(Family::Ctrl, VK_RCONTROL, true, shift), KeyInput::Modifiers { left: true, right: true, others: true });
    let alt = AsyncKeys { alt: true, ..AsyncKeys::default() };
    assert_eq!(key_input(Family::Ctrl, VK_LCONTROL, true, alt), KeyInput::Modifiers { left: true, right: false, others: true });
    let win = AsyncKeys { left_ctrl: true, win: true, ..AsyncKeys::default() };
    assert_eq!(key_input(Family::Ctrl, VK_RCONTROL, true, win), KeyInput::Modifiers { left: true, right: true, others: true });
    // Shift 自己按下的那条事件:系统还没报它按着,以事件为准。
    assert_eq!(key_input(Family::Ctrl, VK_LSHIFT, true, keys(true, false)), KeyInput::Modifiers { left: true, right: false, others: true });
    assert_eq!(key_input(Family::Ctrl, VK_LSHIFT, false, keys(false, false)), KeyInput::Modifiers { left: false, right: false, others: false });
}

#[test]
fn every_pair_snapshots_its_own_sides() {
    for pair in PAIRS {
        let (family, l, r, msg) = (pair.family, pair.left, pair.right, pair.gesture);
        // 回调时系统还没更新这次事件的那个键:它以事件为准,另一个以系统报的为准。
        assert_eq!(key_input(family, l, true, sides(family, false, false)), mods(true, false, false), "{msg}");
        assert_eq!(key_input(family, r, true, sides(family, true, false)), mods(true, true, false), "{msg}");
        assert_eq!(key_input(family, r, false, sides(family, true, true)), mods(true, false, false), "{msg}");
        assert_eq!(key_input(family, l, false, sides(family, true, false)), mods(false, false, false), "{msg}");
        // 漏掉了左键的抬起:下一次修饰键事件时系统报它没按着,状态对齐回来。
        assert_eq!(key_input(family, r, true, sides(family, false, false)), mods(false, true, false), "{msg}");
        // 自己这一族不分左右的键:左右都向系统问,不算别的修饰键 —— 按下、抬起、系统报它按着,都一样。
        assert_eq!(key_input(family, pair.either, true, sides(family, true, false)), mods(true, false, false), "{msg}");
        assert_eq!(key_input(family, pair.either, false, sides(family, false, true)), mods(false, true, false), "{msg}");
        let own_either = with_either(sides(family, true, false), family);
        assert_eq!(key_input(family, r, true, own_either), mods(true, true, false), "{msg}");
        // 别的族的左右键、Win 都不会被当成这一族的左右。
        for other in pair.disqualifiers() {
            assert_eq!(key_input(family, other, true, sides(family, false, false)), mods(false, false, true), "{msg} vk {other:#x}");
        }
    }
}

#[test]
fn other_families_and_win_disqualify_every_pair() {
    for pair in PAIRS {
        let (family, l, r, msg) = (pair.family, pair.left, pair.right, pair.gesture);
        for other in PAIRS.into_iter().filter(|other| other.family != family) {
            // 系统报另一族按着:左、右、只有不分左右的那个,都算。
            for held in [sides(other.family, true, false), sides(other.family, false, true), with_either(AsyncKeys::default(), other.family)] {
                let keys = with_sides(held, family, true, false);
                assert_eq!(key_input(family, r, true, keys), mods(true, true, true), "{msg} with {} held", other.gesture);
            }
            // 另一族的键自己按下的那条事件:系统还没报它按着,以事件为准。
            for vk in [other.left, other.right, other.either] {
                assert_eq!(key_input(family, vk, true, sides(family, true, false)), mods(true, false, true), "{msg} vk {vk:#x}");
                // 它的抬起(系统已经不报它了)不算。
                assert_eq!(key_input(family, vk, false, sides(family, false, false)), mods(false, false, false), "{msg} vk {vk:#x}");
            }
        }
        let win = AsyncKeys { win: true, ..sides(family, true, false) };
        assert_eq!(key_input(family, r, true, win), mods(true, true, true), "{msg}");
        for vk in WIN {
            assert_eq!(key_input(family, vk, true, sides(family, true, false)), mods(true, false, true), "{msg}");
        }
        // 反过来:这一族的键按下,对另外两族就是别的修饰键。
        for other in PAIRS.into_iter().filter(|other| other.family != family) {
            for vk in [l, r, pair.either] {
                assert_eq!(key_input(other.family, vk, true, sides(other.family, true, false)), mods(true, false, true), "{} vk {vk:#x}", other.gesture);
            }
        }
    }
}

#[test]
fn other_keys_carry_no_value() {
    for family in Family::ALL {
        assert_eq!(key_input(family, 0x43, true, AsyncKeys::default()), KeyInput::OtherKey);
        assert_eq!(key_input(family, 0x56, true, AsyncKeys::default()), KeyInput::OtherKey);
        assert_eq!(key_input(family, 0x43, false, AsyncKeys::default()), KeyInput::Ignore);
        // 系统报的状态对非修饰键不起作用(钩子遇到非修饰键根本不问系统)。
        let busy = AsyncKeys { left_ctrl: true, right_shift: true, alt: true, win: true, ..AsyncKeys::default() };
        assert_eq!(key_input(family, 0x43, true, busy), KeyInput::OtherKey);
    }
}

/// 按真实的事件顺序喂:每条事件之后「系统报的状态」跟着更新。和钩子一样三族各一台状态机、每条事件三台都喂,
/// 返回成立的手势名 —— 所以每条用例同时也验了「别的族不会跟着报」。
struct Keyboard {
    machines: [ModPair; 3],
    down: std::collections::BTreeSet<u32>,
}

impl Keyboard {
    fn new() -> Self {
        Self { machines: [ModPair::new(); 3], down: Default::default() }
    }

    fn event(&mut self, vk: u32, down: bool) -> Vec<&'static str> {
        let held = |keys: &[u32]| keys.iter().any(|key| self.down.contains(key));
        let snapshot = AsyncKeys {
            left_ctrl: held(&[VK_LCONTROL]),
            right_ctrl: held(&[VK_RCONTROL]),
            left_shift: held(&[VK_LSHIFT]),
            right_shift: held(&[VK_RSHIFT]),
            left_alt: held(&[VK_LMENU]),
            right_alt: held(&[VK_RMENU]),
            // 不分左右的那个 = 左右之和(再加上直接按下的不分左右的键)。
            ctrl: held(&[VK_CONTROL, VK_LCONTROL, VK_RCONTROL]),
            shift: held(&[VK_SHIFT, VK_LSHIFT, VK_RSHIFT]),
            alt: held(&[VK_MENU, VK_LMENU, VK_RMENU]),
            win: held(&[VK_LWIN, VK_RWIN]),
        };
        let mut fired = Vec::new();
        for family in Family::ALL {
            if self.machines[family.index()].feed(key_input(family, vk, down, snapshot)) {
                fired.push(family.gesture());
            }
        }
        if down {
            self.down.insert(vk);
        } else {
            self.down.remove(&vk);
        }
        fired
    }

    fn run(&mut self, events: &[(u32, bool)]) -> Vec<&'static str> {
        events.iter().flat_map(|(vk, down)| self.event(*vk, *down)).collect()
    }
}

#[test]
fn real_key_sequences() {
    let pair = [(VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)];
    assert_eq!(Keyboard::new().run(&pair), ["modPair"]);
    assert_eq!(Keyboard::new().run(&[(VK_RCONTROL, true), (VK_LCONTROL, true), (VK_LCONTROL, false), (VK_RCONTROL, false)]), ["modPair"]);
    // 两遍 = 两次。
    let mut keyboard = Keyboard::new();
    assert_eq!([keyboard.run(&pair), keyboard.run(&pair)].concat(), ["modPair", "modPair"]);
    // 按住不放的重复按下。
    assert_eq!(
        Keyboard::new().run(&[(VK_LCONTROL, true), (VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, true), (VK_LCONTROL, true)]),
        ["modPair"]
    );
    // Ctrl+C,然后另一个 Ctrl。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (0x43, true), (0x43, false), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)]), NONE);
    // Shift 按着。
    assert_eq!(Keyboard::new().run(&[(VK_LSHIFT, true), (VK_LCONTROL, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false), (VK_LSHIFT, false)]), NONE);
    // AltGr = 驱动先补一个左 Ctrl,再来右 Alt:之后按右 Ctrl 不算。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (VK_RMENU, true), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_RMENU, false), (VK_LCONTROL, false)]), NONE);
    // Win+Ctrl 组合。
    assert_eq!(Keyboard::new().run(&[(VK_LWIN, true), (VK_LCONTROL, true), (VK_RCONTROL, true)]), NONE);
    // 作废的一轮过后,干净地再来一次照常触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (0x41, true), (0x41, false), (VK_RCONTROL, true), (VK_RCONTROL, false), (VK_LCONTROL, false)]), NONE);
    assert_eq!(keyboard.run(&pair), ["modPair"]);
    // 一先一后、没有重叠。
    assert_eq!(Keyboard::new().run(&[(VK_LCONTROL, true), (VK_LCONTROL, false), (VK_RCONTROL, true), (VK_RCONTROL, false)]), NONE);
}

#[test]
fn a_missed_key_up_heals_without_firing() {
    // 左 Ctrl 按下之后切进了安全桌面,抬起没收到;回来后单按右 Ctrl 不该触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.event(VK_LCONTROL, true), NONE);
    keyboard.down.clear();
    assert_eq!(keyboard.event(VK_RCONTROL, true), NONE);
    assert_eq!(keyboard.event(VK_RCONTROL, false), NONE);
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true)]), ["modPair"]);

    // 触发之后右 Ctrl 的抬起没收到(左 Ctrl 的收到了):下一次干净的手势照常触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true), (VK_LCONTROL, false)]), ["modPair"]);
    keyboard.down.clear();
    assert_eq!(keyboard.run(&[(VK_LCONTROL, true), (VK_RCONTROL, true)]), ["modPair"]);
}

/// 一族的整套规则(与上面 Ctrl 的那几条同一批用例),三族各跑一遍。
fn check_pair_rules(pair: Pair) {
    let (l, r, msg) = (pair.left, pair.right, pair.gesture);
    let once = [pair.gesture];
    let both = [(l, true), (r, true), (r, false), (l, false)];

    // 第二个键按下的那一刻触发,恰好一次,两种先后都算;只报这一族的手势。
    assert_eq!(Keyboard::new().run(&both), once, "{msg}");
    assert_eq!(Keyboard::new().run(&[(r, true), (l, true), (l, false), (r, false)]), once, "{msg}");
    assert_eq!(Keyboard::new().run(&[(l, true)]), NONE, "{msg}");
    // 两遍 = 两次。
    let mut keyboard = Keyboard::new();
    assert_eq!([keyboard.run(&both), keyboard.run(&both)].concat(), [pair.gesture, pair.gesture], "{msg}");
    // 按住不放的重复按下不再触发;松开一个再按回来也不算,两个都松开才是新的一轮。
    assert_eq!(Keyboard::new().run(&[(l, true), (l, true), (r, true), (r, true), (r, true), (l, true)]), once, "{msg}");
    assert_eq!(Keyboard::new().run(&[(l, true), (r, true), (r, false), (r, true), (r, false), (l, false)]), once, "{msg}");
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(l, true), (r, true), (l, false), (r, false), (r, true), (l, true)]), [pair.gesture, pair.gesture], "{msg}");
    // 一先一后、没有重叠。
    assert_eq!(Keyboard::new().run(&[(l, true), (l, false), (r, true), (r, false)]), NONE, "{msg}");

    // 中途按过任何非修饰键 → 这一轮作废,两个都松开之后照常;触发之后再按别的键不影响已经报过的那一次。
    for key in [0x43, 0x41, 0x31, 0x20, 0x1B, 0x0D, 0x70, 0xE7] {
        let mut keyboard = Keyboard::new();
        assert_eq!(keyboard.run(&[(l, true), (key, true), (key, false), (r, true), (r, false), (l, false)]), NONE, "{msg} key {key:#x}");
        assert_eq!(keyboard.run(&both), once, "{msg} key {key:#x}");
        assert_eq!(Keyboard::new().run(&[(l, true), (r, true), (key, true), (key, false), (r, false), (l, false)]), once, "{msg} key {key:#x}");
    }

    // 另外两族的任何一个键(含不分左右的)或 Win:在第一个键之前按住、两个键之间按一下、或者按着不放,这一轮都作废;
    // 作废的一轮过后,干净地再来一次照常触发。
    for other in pair.disqualifiers() {
        let before = [(other, true), (l, true), (r, true), (r, false), (l, false), (other, false)];
        let between = [(l, true), (other, true), (other, false), (r, true), (r, false), (l, false)];
        let held = [(l, true), (other, true), (r, true), (r, false), (other, false), (l, false)];
        for sequence in [&before[..], &between[..], &held[..]] {
            let fired = Keyboard::new().run(sequence);
            assert!(!fired.contains(&pair.gesture), "{msg} with vk {other:#x}: {fired:?}");
        }
        let mut keyboard = Keyboard::new();
        keyboard.run(&between);
        assert_eq!(keyboard.run(&both), once, "{msg} after vk {other:#x}");
    }

    // 自己这一族不分左右的键(注入的输入可能这样报)不算别的修饰键:在第一个键之前、两个键之间都照常触发。
    let either = pair.either;
    assert_eq!(Keyboard::new().run(&[(l, true), (either, true), (r, true)]), once, "{msg}");
    assert_eq!(Keyboard::new().run(&[(either, true), (l, true), (r, true)]), once, "{msg}");
    assert_eq!(Keyboard::new().run(&[(l, true), (either, true), (either, false), (r, true)]), once, "{msg}");

    // 左键按下之后切进了安全桌面,抬起没收到;回来后单按右键不该触发,之后干净的一次照常。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.event(l, true), NONE, "{msg}");
    keyboard.down.clear();
    assert_eq!(keyboard.run(&[(r, true), (r, false)]), NONE, "{msg}");
    assert_eq!(keyboard.run(&[(l, true), (r, true)]), once, "{msg}");
    // 触发之后右键的抬起没收到(左键的收到了):下一次干净的手势照常触发。
    let mut keyboard = Keyboard::new();
    assert_eq!(keyboard.run(&[(l, true), (r, true), (l, false)]), once, "{msg}");
    keyboard.down.clear();
    assert_eq!(keyboard.run(&[(l, true), (r, true)]), once, "{msg}");
    // 别的修饰键按着时抬起没收到,系统那边早松开了:下一次照常触发。
    for other in pair.disqualifiers() {
        let mut keyboard = Keyboard::new();
        keyboard.event(other, true);
        keyboard.down.clear();
        assert_eq!(keyboard.run(&both), once, "{msg} after a missed vk {other:#x} up");
    }
}

#[test]
fn ctrl_pair_rules() {
    check_pair_rules(CTRL);
}

#[test]
fn shift_pair_rules() {
    check_pair_rules(SHIFT);
}

#[test]
fn alt_pair_rules() {
    check_pair_rules(ALT);
}

#[test]
fn pairs_do_not_mix() {
    // 左 Ctrl + 右 Shift、左 Shift + 右 Alt 之类:哪一族都不成立。
    for (a, b) in [(VK_LCONTROL, VK_RSHIFT), (VK_LSHIFT, VK_RMENU), (VK_LMENU, VK_RCONTROL), (VK_RSHIFT, VK_LCONTROL)] {
        assert_eq!(Keyboard::new().run(&[(a, true), (b, true), (b, false), (a, false)]), NONE, "{a:#x} + {b:#x}");
    }
    // 两族同时凑齐(左右 Ctrl 按着再按左右 Shift):第一对报了,第二对因为第一族按着而作废。
    assert_eq!(
        Keyboard::new().run(&[(VK_LCONTROL, true), (VK_RCONTROL, true), (VK_LSHIFT, true), (VK_RSHIFT, true)]),
        ["modPair"]
    );
    // 三族轮流各来一次,各报各的。
    let mut keyboard = Keyboard::new();
    let mut fired = Vec::new();
    for pair in PAIRS {
        fired.extend(keyboard.run(&[(pair.left, true), (pair.right, true), (pair.right, false), (pair.left, false)]));
    }
    assert_eq!(fired, ["modPair", "shiftPair", "altPair"]);
}

#[test]
fn alt_gr_never_completes_alt_pair() {
    // AltGr 布局(德语、法语等)的右 Alt = 驱动先补一个左 Ctrl、再来右 Alt:Ctrl 对 Alt 这一族是别的修饰键,
    // 所以这类布局上左 Alt + AltGr 永远不算 altPair(也不算 modPair)。
    let alt_gr_down = [(VK_LCONTROL, true), (VK_RMENU, true)];
    let alt_gr_up = [(VK_RMENU, false), (VK_LCONTROL, false)];
    assert_eq!(Keyboard::new().run(&[&[(VK_LMENU, true)][..], &alt_gr_down[..], &alt_gr_up[..], &[(VK_LMENU, false)][..]].concat()), NONE);
    assert_eq!(Keyboard::new().run(&[&alt_gr_down[..], &[(VK_LMENU, true), (VK_LMENU, false)][..], &alt_gr_up[..]].concat()), NONE);
    // 用过 AltGr 之后,干净的左右 Alt 照常。
    let mut keyboard = Keyboard::new();
    keyboard.run(&[&alt_gr_down[..], &alt_gr_up[..]].concat());
    assert_eq!(keyboard.run(&[(VK_LMENU, true), (VK_RMENU, true), (VK_RMENU, false), (VK_LMENU, false)]), ["altPair"]);
}

#[test]
fn gesture_names() {
    for name in ["modPair", "shiftPair", "altPair"] {
        assert!(gesture_known(Some(name)), "{name}");
    }
    for name in ["modpair", "ShiftPair", "altpair", "ctrlPair", "optionPair", "tripleTap", ""] {
        assert!(!gesture_known(Some(name)), "{name}");
    }
    assert!(!gesture_known(None));
    for pair in PAIRS {
        assert_eq!(pair.family.gesture(), pair.gesture);
        assert_eq!(Family::from_gesture(pair.gesture), Some(pair.family));
    }
    // 状态机的下标与 `Family::ALL` 的顺序一致;`unknown_gesture` 的报错按这个顺序列出全部手势。
    assert_eq!(Family::ALL.map(Family::index), [0, 1, 2]);
    assert_eq!(Family::ALL.map(Family::gesture), GESTURES);
    assert_eq!(GESTURES.join(", "), "modPair, shiftPair, altPair");
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
        event("modPair", 1_760_000_000_123, Some(&front)),
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
    let unknown = event("modPair", 1, None);
    assert!(unknown["ev"]["front"].is_null());
    assert_eq!(unknown["ev"].as_object().map(|body| body.len()), Some(4));
    // 一行一条:序列化后不含换行。
    assert!(!serde_json::to_string(&event("modPair", 1, Some(&front))).unwrap().contains('\n'));
    // 事件带的是成立的那个手势名,其余形状不变。
    for gesture in GESTURES {
        let line = event(gesture, 7, Some(&front));
        assert_eq!(line["ev"]["gesture"], gesture);
        assert_eq!(line["ev"]["kind"], "hotkey");
        assert_eq!(line["ev"]["t"], 7);
        assert_eq!(line["ev"]["front"]["exe"], "chrome.exe");
        assert_eq!(line["ev"].as_object().map(|body| body.len()), Some(4));
    }
    assert_eq!(event(Family::Shift.gesture(), 1, None), json!({ "ev": { "t": 1, "kind": "hotkey", "gesture": "shiftPair", "front": null } }));
    assert_eq!(event(Family::Alt.gesture(), 1, None), json!({ "ev": { "t": 1, "kind": "hotkey", "gesture": "altPair", "front": null } }));
}
