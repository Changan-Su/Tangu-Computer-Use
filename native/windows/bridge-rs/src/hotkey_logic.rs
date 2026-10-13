//! Tangu 新增:全局手势订阅(`hotkeySubscribe`)的纯逻辑 —— Windows `serve` 模式。
//!
//! 与 macOS 的 `native/macos/hotkey_monitor.swift` 同一份语义(那边的状态机逐条移植到这里,单测在
//! `tests/hotkey_logic_tests.rs`,在任何平台都能跑)。平台相关的部分(键盘钩子、前台窗口)在 `hotkey.rs`,只在 Windows 编译。
//!
//! 目前只有一个手势 `modPair`:左右两个 Ctrl 同时按下(macOS 上是左右两个 ⌘)。
//! 隐私:键盘钩子只取「左右 Ctrl 各自按没按下」与「有没有按过别的键」这一个布尔,键值不存、不发。

use serde_json::{json, Value};

use crate::recorder_logic;

pub const GESTURE_MOD_PAIR: &str = "modPair";

pub fn gesture_known(gesture: Option<&str>) -> bool {
    gesture == Some(GESTURE_MOD_PAIR)
}

/// 「左右两个同名修饰键同时按下」的状态机。输入只有两种:修饰键的按下状态变了(左、右各自按没按下,
/// 以及有没有别的修饰键按着),和「按了一个非修饰键」(不带键值)。
/// 规则:第二个键按下、第一个还按着的那一刻触发,恰好一次;之后两个都松开才能再触发。
/// 第一个键按下之后混进过别的修饰键或任何非修饰键 → 这一轮作废,同样要两个都松开才重新开始。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct ModPair {
    left: bool,
    right: bool,
    /// 这一轮(从第一个键按下到两个都松开)已经用掉:触发过了、被别的键作废了,或者没看见第一个键是怎么按下的。
    spent: bool,
}

impl ModPair {
    pub const fn new() -> Self {
        Self { left: false, right: false, spent: false }
    }

    /// 传入的是变化**之后**的状态(调用方每次都向系统重新问,不靠自己数按下 / 抬起),所以漏掉一次抬起也会在
    /// 下一次变化时自愈;同一状态重复送进来(按键重复)不会再触发。返回 true = 手势成立。
    pub fn modifiers(&mut self, left: bool, right: bool, others: bool) -> bool {
        let was_exactly_one = self.left != self.right;
        self.left = left;
        self.right = right;
        if !left && !right {
            self.spent = false;
            return false;
        }
        if others {
            self.spent = true;
        }
        if !(left && right) {
            return false;
        }
        // 从「一个都没按」直接跳到「两个都按着」= 中间漏了事件,不知道期间发生过什么,不触发。
        let fire = was_exactly_one && !self.spent;
        self.spent = true;
        fire
    }

    /// 按了一个非修饰键。只在左 / 右有一个按着时才有意义(Ctrl+C 之后再按另一个 Ctrl 不算手势)。
    pub fn other_key(&mut self) {
        if self.left || self.right {
            self.spent = true;
        }
    }

    pub fn feed(&mut self, input: KeyInput) -> bool {
        match input {
            KeyInput::Modifiers { left, right, others } => self.modifiers(left, right, others),
            KeyInput::OtherKey => {
                self.other_key();
                false
            }
            KeyInput::Ignore => false,
        }
    }
}

pub const VK_SHIFT: u32 = 0x10;
pub const VK_CONTROL: u32 = 0x11;
pub const VK_MENU: u32 = 0x12;
pub const VK_LWIN: u32 = 0x5B;
pub const VK_RWIN: u32 = 0x5C;
pub const VK_LSHIFT: u32 = 0xA0;
pub const VK_RSHIFT: u32 = 0xA1;
pub const VK_LCONTROL: u32 = 0xA2;
pub const VK_RCONTROL: u32 = 0xA3;
pub const VK_LMENU: u32 = 0xA4;
pub const VK_RMENU: u32 = 0xA5;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyClass {
    LeftCtrl,
    RightCtrl,
    /// 不分左右的 Ctrl(注入的输入可能这样报):不算别的修饰键,左右各自的状态照旧向系统问。
    Ctrl,
    /// 让手势作废的修饰键:Shift / Alt / Win。
    Disqualifier,
    Other,
}

pub fn classify_vk(vk: u32) -> KeyClass {
    match vk {
        VK_LCONTROL => KeyClass::LeftCtrl,
        VK_RCONTROL => KeyClass::RightCtrl,
        VK_CONTROL => KeyClass::Ctrl,
        VK_SHIFT | VK_MENU | VK_LSHIFT | VK_RSHIFT | VK_LMENU | VK_RMENU | VK_LWIN | VK_RWIN => KeyClass::Disqualifier,
        _ => KeyClass::Other,
    }
}

/// 钩子回调那一刻系统报的键状态(GetAsyncKeyState)。⚠️回调时**这次事件的那个键**还没更新进去,别的键是准的。
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct AsyncKeys {
    pub left_ctrl: bool,
    pub right_ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub win: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyInput {
    Modifiers { left: bool, right: bool, others: bool },
    OtherKey,
    Ignore,
}

/// 一次键盘钩子事件对状态机意味着什么。事件里的那个键以事件为准,其余的以系统报的为准 ——
/// 所以漏过事件(UAC 安全桌面、锁屏、提权窗口在前台时钩子收不到)之后,下一次修饰键变化就对齐回来。
/// 非修饰键只看按下,而且不需要 `keys`(调用方可以不问系统)。
pub fn key_input(vk: u32, down: bool, keys: AsyncKeys) -> KeyInput {
    let class = classify_vk(vk);
    if class == KeyClass::Other {
        return if down { KeyInput::OtherKey } else { KeyInput::Ignore };
    }
    KeyInput::Modifiers {
        left: if class == KeyClass::LeftCtrl { down } else { keys.left_ctrl },
        right: if class == KeyClass::RightCtrl { down } else { keys.right_ctrl },
        // 抬起别的修饰键时系统还报它按着,多算一次「有别的修饰键」无妨:它按着的时候这一轮已经作废了。
        others: keys.shift || keys.alt || keys.win || (class == KeyClass::Disqualifier && down),
    }
}

/// 请求里的 `excludePids`:订阅方自己的进程。它在前台时手势由它自己的窗口处理,这里不再推。
pub fn exclude_pids(value: Option<&Value>) -> Vec<u32> {
    value
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_u64).filter_map(|pid| u32::try_from(pid).ok()).collect())
        .unwrap_or_default()
}

pub fn excluded(exclude: &[u32], front_pids: &[u32]) -> bool {
    front_pids.iter().any(|pid| exclude.contains(pid))
}

/// 手势那一刻的前台窗口。Windows 上没有 bundle id:`exe` = 小写的可执行文件名(与电脑历史里的 App 标识同一口径),
/// `path` = 完整路径,`window_id` = 顶层窗口的 HWND。拿不到的给空串。
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Front {
    pub exe: String,
    pub path: String,
    pub app: String,
    pub pid: u32,
    pub window_id: i64,
    pub title: String,
}

/// App 的显示名:版本资源里的 FileDescription(「Google Chrome」「记事本」),没有就用去掉 .exe 的文件名。
pub fn app_name(description: Option<&str>, exe: &str) -> String {
    let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe);
    description.and_then(recorder_logic::label).unwrap_or_else(|| stem.to_owned())
}

/// 标题收成一行、按电脑历史的上限截断。
pub fn window_title(raw: &str) -> String {
    recorder_logic::title(raw).unwrap_or_default()
}

/// 推给订阅连接的一行:与电脑历史同一个 `{"ev":{…}}` 信封。前台判断不出来 → `front: null`。
pub fn event(at: i64, front: Option<&Front>) -> Value {
    let front = front.map(|f| {
        json!({
            "exe": f.exe,
            "path": f.path,
            "app": f.app,
            "pid": f.pid,
            "windowId": f.window_id,
            "title": f.title,
        })
    });
    json!({ "ev": { "t": at, "kind": "hotkey", "gesture": GESTURE_MOD_PAIR, "front": front } })
}
