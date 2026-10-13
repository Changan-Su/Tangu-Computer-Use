//! Tangu 新增:全局手势订阅的 Windows 侧 —— `windows-bridge.exe serve --pipe <name>` 里的 `hotkeySubscribe`。
//!
//! 与 macOS 的 `native/macos/hotkey_monitor.swift` 同一份合同;纯逻辑(状态机、事件形状)在 `hotkey_logic.rs`。
//! 订阅连接(命名管道、首行回包、之后一行一条 `{"ev":{…}}`、对端关闭即退订)由 `recorder.rs` 的 `serve_client` 接进来,
//! 写队列复用它的 `Outbox`。
//!
//! 线程:
//!   - 钩子线程:自己的低层键盘钩子 + 消息循环,只在有手势订阅者时存在(与电脑历史的钩子线程互不相干,那个只在有
//!     电脑历史订阅者时存在)。回调里只更新状态机;手势成立时取前台窗口句柄和时间,丢进通道就返回 ——
//!     **绝不**在回调里读进程路径 / 版本资源 / 标题(低层钩子回调慢了会拖住全系统输入,超时还会被系统摘掉),
//!     也从不吞键,一律 CallNextHookEx。
//!   - 投递线程:把句柄解析成 App 身份与标题,发给没有排除它的订阅者。

use std::cell::{Cell, RefCell};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde_json::Value;
use windows::Win32::Foundation::{HINSTANCE, HWND, LPARAM, LRESULT, WPARAM};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Threading::{GetCurrentProcessId, GetCurrentThreadId};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    CallNextHookEx, GetForegroundWindow, GetMessageW, PostThreadMessageW, SetWindowsHookExW, UnhookWindowsHookEx,
    HC_ACTION, KBDLLHOOKSTRUCT, MSG, WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
};

use crate::hotkey_logic::{self as logic, AsyncKeys, Front, KeyClass, ModPair};
use crate::recorder::{self, Outbox};

struct Sub {
    id: u64,
    exclude: Vec<u32>,
    outbox: Arc<Outbox>,
    /// 订阅那一刻的手势序号:在这之前发生、还排在投递线程里的手势不归它(按序号比,不按时钟 —— 时钟会被调)。
    since: u64,
}

struct Hook {
    tid: u32,
    join: JoinHandle<()>,
}

#[derive(Default)]
struct Registry {
    subs: Vec<Sub>,
    hook: Option<Hook>,
}

struct Fired {
    hwnd: isize,
    /// 手势那一刻前台窗口所属的进程。对 `excludePids` 用它:等投递线程去查时窗口可能已经关了。
    owner: u32,
    at: i64,
    seq: u64,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| Mutex::new(Registry::default()))
}

static SUBSCRIBERS: AtomicUsize = AtomicUsize::new(0);
static NEXT_ID: AtomicU64 = AtomicU64::new(1);
/// 手势序号:每成立一次加一(钩子线程写)。
static FIRE_SEQ: AtomicU64 = AtomicU64::new(0);

/// 手势订阅者数(diagnostics 报;空闲退出的看门狗也看它 —— 有手势订阅者时进程不能退)。
pub fn subscriber_count() -> usize {
    SUBSCRIBERS.load(Ordering::Acquire)
}

/// 注册一个订阅者;第一个订阅者到来时装键盘钩子,装不上 → Err(调用方回错误包)。
/// `ack` 在持锁期间排进它的出口:投递也要这把锁,所以事件一定排在回包后面。
pub fn subscribe(exclude: Vec<u32>, outbox: Arc<Outbox>, ack: &Value) -> Result<u64, String> {
    let mut registry = registry().lock().map_err(|_| "hotkey registry is poisoned".to_owned())?;
    if registry.hook.is_none() {
        registry.hook = Some(start_hook()?);
    }
    outbox.send(ack);
    let id = NEXT_ID.fetch_add(1, Ordering::AcqRel);
    registry.subs.push(Sub { id, exclude, outbox, since: FIRE_SEQ.load(Ordering::Acquire) });
    SUBSCRIBERS.store(registry.subs.len(), Ordering::Release);
    Ok(id)
}

/// 连接断开时调用。最后一个订阅者走了就摘掉钩子。
pub fn unsubscribe(id: u64) {
    let Ok(mut registry) = registry().lock() else { return };
    registry.subs.retain(|sub| sub.id != id);
    SUBSCRIBERS.store(registry.subs.len(), Ordering::Release);
    if registry.subs.is_empty() {
        if let Some(hook) = registry.hook.take() {
            // 持锁等钩子线程退出:它从不拿这把锁(回调只往通道里丢),所以不会死锁;等它退了,下一个订阅者
            // 才会装新的钩子,不会有两个钩子同时在、把同一次手势报两遍。投递线程随通道关闭自己结束。
            let _ = unsafe { PostThreadMessageW(hook.tid, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = hook.join.join();
        }
    }
}

thread_local! {
    // 只在钩子线程上用:低层钩子的回调总是在装钩子的那个线程上被调。
    static MACHINE: Cell<ModPair> = const { Cell::new(ModPair::new()) };
    static FIRED: RefCell<Option<Sender<Fired>>> = const { RefCell::new(None) };
}

fn start_hook() -> Result<Hook, String> {
    let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
    let (fired_tx, fired_rx) = mpsc::channel::<Fired>();
    thread::spawn(move || dispatch(fired_rx));
    let join = thread::spawn(move || unsafe {
        let module = GetModuleHandleW(None).unwrap_or_default();
        let hook = match SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), HINSTANCE(module.0), 0) {
            Ok(hook) => hook,
            Err(error) => {
                let _ = ready_tx.send(Err(format!("SetWindowsHookEx(WH_KEYBOARD_LL): {error}")));
                return;
            }
        };
        MACHINE.with(|machine| machine.set(ModPair::new()));
        FIRED.with(|fired| *fired.borrow_mut() = Some(fired_tx));
        if ready_tx.send(Ok(GetCurrentThreadId())).is_err() {
            // 等的人已经超时走了,没人会来停这个线程:自己把钩子摘掉退出,不留一个没人管的钩子。
            let _ = UnhookWindowsHookEx(hook);
            FIRED.with(|fired| fired.borrow_mut().take());
            return;
        }
        // 这个线程没有窗口:GetMessage 只用来让系统把钩子回调派进来,以及收 WM_QUIT。
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {}
        let _ = UnhookWindowsHookEx(hook);
        FIRED.with(|fired| fired.borrow_mut().take());
    });
    match ready_rx.recv_timeout(Duration::from_secs(5)) {
        Ok(Ok(tid)) => Ok(Hook { tid, join }),
        Ok(Err(error)) => Err(error),
        Err(_) => Err("keyboard hook thread did not start".to_owned()),
    }
}

fn key_down(vk: u32) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) }) < 0
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let message = wparam.0 as u32;
        let down = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
        if down || message == WM_KEYUP || message == WM_SYSKEYUP {
            on_key((*(lparam.0 as *const KBDLLHOOKSTRUCT)).vkCode, down);
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

fn on_key(vk: u32, down: bool) {
    // 非修饰键只置一个标志,连系统的键状态都不问;键值到这里为止,不存不发。
    let keys = if logic::classify_vk(vk) == KeyClass::Other {
        AsyncKeys::default()
    } else {
        AsyncKeys {
            left_ctrl: key_down(logic::VK_LCONTROL),
            right_ctrl: key_down(logic::VK_RCONTROL),
            shift: key_down(logic::VK_SHIFT),
            alt: key_down(logic::VK_MENU),
            win: key_down(logic::VK_LWIN) || key_down(logic::VK_RWIN),
        }
    };
    let input = logic::key_input(vk, down, keys);
    let fire = MACHINE.with(|cell| {
        let mut machine = cell.get();
        let fire = machine.feed(input);
        cell.set(machine);
        fire
    });
    if !fire {
        return;
    }
    // 手势成立的那一刻就把前台窗口和它所属的进程记下(一个句柄、一个进程号);其余的交给投递线程。
    let foreground = unsafe { GetForegroundWindow() };
    let owner = if foreground.0.is_null() { 0 } else { recorder::window_pid(foreground) };
    FIRED.with(|fired| {
        if let Some(tx) = fired.borrow().as_ref() {
            let seq = FIRE_SEQ.fetch_add(1, Ordering::AcqRel);
            let _ = tx.send(Fired { hwnd: foreground.0 as isize, owner, at: recorder::now_ms(), seq });
        }
    });
}

fn dispatch(rx: Receiver<Fired>) {
    let own = unsafe { GetCurrentProcessId() };
    for fired in rx {
        let front = front_of(fired.hwnd, fired.owner);
        // 那一刻窗口所属的进程,加上解析出来的 App 进程(UWP 的窗口挂在宿主进程名下)。窗口没了也照样按前者排除。
        let mut pids = Vec::with_capacity(2);
        if fired.owner != 0 {
            pids.push(fired.owner);
        }
        if let Some(front) = &front {
            pids.push(front.pid);
        }
        if pids.contains(&own) {
            continue;
        }
        let targets: Vec<Arc<Outbox>> = match registry().lock() {
            Ok(registry) => registry
                .subs
                .iter()
                .filter(|sub| sub.since <= fired.seq && !logic::excluded(&sub.exclude, &pids))
                .map(|sub| Arc::clone(&sub.outbox))
                .collect(),
            Err(_) => return,
        };
        if targets.is_empty() {
            continue;
        }
        let line = logic::event(fired.at, front.as_ref());
        for outbox in targets {
            outbox.send(&line);
        }
    }
}

/// 前台窗口 → App 身份与标题。`pid` 是真正的 App 进程(UWP 的窗口属于 ApplicationFrameHost,App 在它里面);
/// `windowId` 始终是顶层窗口的句柄。那一刻没有前台窗口,或窗口已经不在了(句柄不再属于当时的进程)→ None(事件里 `front: null`)。
fn front_of(hwnd: isize, owner: u32) -> Option<Front> {
    if hwnd == 0 || owner == 0 || recorder::window_pid(HWND(hwnd as *mut _)) != owner {
        return None;
    }
    // 读不到进程路径(受保护的进程)时 window_app 给 None:照样报进程号、窗口和标题,exe / path 留空。
    let (pid, exe) = recorder::window_app(hwnd).map(|(pid, exe, _)| (pid, exe)).unwrap_or((owner, String::new()));
    let path = recorder::process_path(pid).unwrap_or_default();
    let description = recorder::file_description(&path);
    Some(Front {
        exe: exe.to_lowercase(),
        app: logic::app_name(description.as_deref(), &exe),
        path,
        pid,
        window_id: hwnd as i64,
        title: logic::window_title(&recorder::window_text(hwnd)),
    })
}
