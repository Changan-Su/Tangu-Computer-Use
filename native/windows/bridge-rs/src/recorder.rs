//! Tangu 新增:电脑历史(Computer History)采集器的 Windows 侧 —— `windows-bridge.exe serve --pipe <name>`。
//!
//! 与 macOS 的 `native/macos/activity_recorder.swift` 同一份合同(recordSubscribe,事件形状见 Genesis
//! `desktop/shared/computerHistory.ts`);纯逻辑在 `recorder_logic.rs`。只观测、不落盘。
//!
//! 进程模型:这是桌面端(Forsion 主进程)单独拉起的常驻进程,与引擎拉起的 stdio 助手互不相干 —— 桌面从自己的
//! 副本(`<computer-history>/bin/windows-bridge-<hash>.exe`)拉起它,管道名里带用户与版本哈希。单实例
//! (FILE_FLAG_FIRST_PIPE_INSTANCE),管道只给当前用户(显式 DACL)且拒绝远程客户端;最后一个订阅者走后 60 秒自行退出。
//!
//! 线程:
//!   - 钩子线程:只泵消息 —— 低层鼠标 / 键盘钩子、前台与标题的 WinEvent、会话锁屏 / 睡眠的隐藏窗口。回调里只取
//!     几个数就转交 recorder 线程,**绝不**在这里做 UIA 调用(低层钩子回调慢了会拖住全系统输入,超时还会被系统摘掉);
//!   - recorder 线程(MTA):持有 IUIAutomation 与全部状态、计时器、投递。UIA 事件处理器只投一条消息,焦点元素
//!     由 recorder 自己重新取(与 macOS「以 App 的 AXFocusedUIElement 为准」同一立场)。
//!
//! 性能纪律(ChatGPT 的 recorder 冻住过 IntelliJ):UIA 连接 / 事务超时压到 1 秒;只给焦点输入框挂值变化事件;
//! 浏览器网址只做有上限的遍历(≤400 节点、≤12 层、≤200ms),绝不展开网页内容(Document);之后按记住的地址栏快路重读。
//! 隐私闸在读 UIA **之前**:硬排除(密码管理器、凭据界面)与「所有订阅者都排除了的 App」不读标题、不看输入框;
//! 密码框(IsPassword)不读值,每次读值 / 报字前都重查(查不到也按密码框算);无痕窗口只留一条不带标题的切换。
//! 键盘钩子只看修饰键:没按 Ctrl / Win 的普通按键只转交一个「有输入」的信号(不带键值),用来触发对焦点框的差分读取。

use std::collections::HashMap;
use std::fs::File;
use std::io::{BufRead, BufReader, Read, Write};
use std::os::windows::io::{AsRawHandle, FromRawHandle};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};
use windows::core::{implement, Interface, BSTR, HSTRING, PCWSTR, PWSTR, VARIANT};
use windows::Win32::Foundation::*;
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1,
};
use windows::Win32::Security::{
    GetTokenInformation, TokenUser, PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES, TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_ACCESS_DUPLEX,
};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED};
use windows::Win32::System::LibraryLoader::GetModuleHandleW;
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::{
    WTSRegisterSessionNotification, WTSUnRegisterSessionNotification, NOTIFY_FOR_THIS_SESSION,
};
use windows::Win32::System::StationsAndDesktops::{
    CloseDesktop, GetUserObjectInformationW, OpenInputDesktop, DESKTOP_CONTROL_FLAGS, DESKTOP_READOBJECTS,
    UOI_NAME,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, GetCurrentThreadId, OpenProcess, OpenProcessToken,
    QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows::Win32::UI::Accessibility::*;
use windows::Win32::UI::Input::KeyboardAndMouse::{
    GetAsyncKeyState, MapVirtualKeyW, MAPVK_VK_TO_CHAR, VK_CONTROL, VK_LWIN, VK_RMENU, VK_RWIN, VK_SHIFT,
    VK_MENU,
};
use windows::Win32::UI::WindowsAndMessaging::*;

use crate::agent_marker;
use crate::recorder_logic::{self as logic, limit, Context, DeliveryState, Kind, PendingAction, Policy, TextMode};

const IDLE_EXIT: Duration = Duration::from_secs(60);
const SUBSCRIBER_QUEUE: usize = 256;
const MAX_LINE_BYTES: u64 = 64 * 1024;

const WINDOW_DEBOUNCE: Duration = Duration::from_millis(300);
const TEXT_DEBOUNCE: Duration = Duration::from_millis(1500);
const SAMPLE_DELAY: Duration = Duration::from_millis(250);
const WALK_NODE_CAP: usize = 400;
const WALK_DEPTH_CAP: usize = 12;
const WALK_BUDGET: Duration = Duration::from_millis(200);
const BROWSER_CACHE_CAP: usize = 16;
const UIA_TIMEOUT_MS: u32 = 1000;

const WM_APP_RETARGET: u32 = WM_APP + 1;
const UIA_E_ELEMENTNOTAVAILABLE: i32 = 0x8004_0201_u32 as i32;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ===========================================================================
// 订阅连接(命名管道)
// ===========================================================================

/// 一个订阅连接的出口。recorder 线程只管 try_send,永不因某个订阅者读得慢而卡住;积压满了就丢弃计数,
/// 下一条能入队时先补一条 `system/dropped`。写失败由写线程断开管道,读线程随之拿到 EOF 走唯一的退订路径。
pub struct Outbox {
    tx: SyncSender<String>,
    dropped: AtomicUsize,
}

impl Outbox {
    fn send(&self, object: &Value) {
        let Ok(mut line) = serde_json::to_string(object) else { return };
        line.push('\n');
        let dropped = self.dropped.load(Ordering::Acquire);
        if dropped > 0 {
            let marker = json!({ "ev": { "t": now_ms(), "kind": "system", "state": "dropped", "count": dropped } });
            match self.tx.try_send(format!("{marker}\n")) {
                Ok(()) => self.dropped.store(0, Ordering::Release),
                Err(TrySendError::Full(_)) => {
                    self.dropped.fetch_add(1, Ordering::AcqRel);
                    return;
                }
                Err(TrySendError::Disconnected(_)) => return,
            }
        }
        if let Err(TrySendError::Full(_)) = self.tx.try_send(line) {
            self.dropped.fetch_add(1, Ordering::AcqRel);
        }
    }
}

static SUBSCRIBERS: AtomicUsize = AtomicUsize::new(0);
static LAST_ACTIVITY_MS: AtomicU64 = AtomicU64::new(0);
static NEXT_SUB_ID: AtomicU64 = AtomicU64::new(1);

fn touch_activity() {
    LAST_ACTIVITY_MS.store(now_ms() as u64, Ordering::Release);
}

/// `serve --pipe <name>` 的入口。返回进程退出码。
pub fn serve(pipe: &str) -> i32 {
    if !logic::pipe_name_valid(pipe) {
        eprintln!("[recorder] invalid pipe name");
        return 2;
    }
    let security = match PipeSecurity::current_user() {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[recorder] pipe security: {e}");
            return 1;
        }
    };
    let name = HSTRING::from(pipe);
    let mut first = match create_pipe(&name, true, &security) {
        Ok(h) => Some(h),
        Err(e) => {
            // 同名管道已有服务者(另一个同版本实例):让它服务,我们安静退出。
            eprintln!("[recorder] pipe busy: {e}");
            return 0;
        }
    };
    touch_activity();
    start_recorder_thread();
    thread::spawn(idle_watchdog);
    loop {
        let handle = first.take().or_else(|| create_pipe(&name, false, &security).ok());
        let Some(handle) = handle else {
            thread::sleep(Duration::from_millis(200));
            continue;
        };
        let connected = unsafe { ConnectNamedPipe(handle, None) };
        let ok = connected.is_ok() || unsafe { GetLastError() } == ERROR_PIPE_CONNECTED;
        if !ok {
            let _ = unsafe { CloseHandle(handle) };
            continue;
        }
        let raw = handle.0 as isize;
        thread::spawn(move || serve_client(raw));
    }
}

fn idle_watchdog() {
    loop {
        thread::sleep(Duration::from_secs(5));
        let idle = (now_ms() as u64).saturating_sub(LAST_ACTIVITY_MS.load(Ordering::Acquire));
        if SUBSCRIBERS.load(Ordering::Acquire) == 0 && idle >= IDLE_EXIT.as_millis() as u64 {
            std::process::exit(0);
        }
    }
}

/// 管道的安全描述符:只给当前用户(与 SYSTEM)。命名管道缺省 DACL 给 Everyone 读权限,这里收紧 ——
/// 相当于 macOS 那边按 getpeereid 只服务同一用户。
struct PipeSecurity {
    descriptor: PSECURITY_DESCRIPTOR,
}

unsafe impl Send for PipeSecurity {}
unsafe impl Sync for PipeSecurity {}

impl PipeSecurity {
    fn current_user() -> Result<Self, String> {
        let sid = current_user_sid()?;
        let sddl = HSTRING::from(format!("D:P(A;;GA;;;{sid})(A;;GA;;;SY)"));
        let mut descriptor = PSECURITY_DESCRIPTOR::default();
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(&sddl, SDDL_REVISION_1, &mut descriptor, None)
                .map_err(|e| format!("ConvertStringSecurityDescriptor: {e}"))?;
        }
        Ok(Self { descriptor })
    }

    fn attributes(&self) -> SECURITY_ATTRIBUTES {
        SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: self.descriptor.0,
            bInheritHandle: FALSE,
        }
    }
}

fn current_user_sid() -> Result<String, String> {
    unsafe {
        let mut token = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token).map_err(|e| format!("OpenProcessToken: {e}"))?;
        let mut size = 0u32;
        let _ = GetTokenInformation(token, TokenUser, None, 0, &mut size);
        let mut buffer = vec![0u8; size as usize];
        let result = GetTokenInformation(token, TokenUser, Some(buffer.as_mut_ptr() as *mut _), size, &mut size);
        let _ = CloseHandle(token);
        result.map_err(|e| format!("GetTokenInformation: {e}"))?;
        let user = &*(buffer.as_ptr() as *const TOKEN_USER);
        let mut text = PWSTR::null();
        ConvertSidToStringSidW(user.User.Sid, &mut text).map_err(|e| format!("ConvertSidToStringSid: {e}"))?;
        let sid = text.to_string().map_err(|e| e.to_string());
        let _ = LocalFree(HLOCAL(text.0 as *mut _));
        sid
    }
}

fn create_pipe(name: &HSTRING, first: bool, security: &PipeSecurity) -> Result<HANDLE, String> {
    let attributes = security.attributes();
    let mut mode = PIPE_ACCESS_DUPLEX;
    if first {
        mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    let handle = unsafe {
        CreateNamedPipeW(
            name,
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            64 * 1024,
            64 * 1024,
            0,
            Some(&attributes),
        )
    };
    if handle.is_invalid() {
        return Err(format!("CreateNamedPipe: {:?}", unsafe { GetLastError() }));
    }
    Ok(handle)
}

/// 一条连接:读第一行命令。recordSubscribe → 注册订阅者并一直读到对端关闭;diagnostics → 回一行就关。
fn serve_client(raw: isize) {
    touch_activity();
    // SAFETY: raw 是 ConnectNamedPipe 成功后的管道句柄,所有权交给 File(drop 时 CloseHandle)。
    let file = unsafe { File::from_raw_handle(raw as *mut _) };
    let Ok(read_half) = file.try_clone() else { return };
    let mut reader = BufReader::new(read_half.take(MAX_LINE_BYTES));
    let mut first = String::new();
    if reader.read_line(&mut first).unwrap_or(0) == 0 {
        return;
    }
    let request: Value = serde_json::from_str(first.trim()).unwrap_or(Value::Null);
    let id = request.get("id").and_then(Value::as_str).unwrap_or("unknown").to_owned();
    let mut writer = file;
    match request.get("cmd").and_then(Value::as_str) {
        Some("recordSubscribe") => {}
        Some("diagnostics") => {
            let reply = json!({ "id": id, "ok": true, "result": {
                "protocolVersion": logic::RECORDER_PROTOCOL,
                "pid": std::process::id(),
                "subscribers": SUBSCRIBERS.load(Ordering::Acquire),
                "os": "windows",
            }});
            let _ = writeln!(writer, "{reply}");
            return;
        }
        other => {
            let reply = json!({ "id": id, "ok": false, "error": {
                "code": "unknown_command",
                "message": format!("Unknown command '{}'", other.unwrap_or("")),
            }});
            let _ = writeln!(writer, "{reply}");
            return;
        }
    }

    let (tx, rx) = mpsc::sync_channel::<String>(SUBSCRIBER_QUEUE);
    let outbox = Arc::new(Outbox { tx, dropped: AtomicUsize::new(0) });
    // 回包排在这条连接写队列的第一位,之后才是事件。
    outbox.send(&json!({ "id": id, "ok": true, "result": {
        "subscribed": true, "protocolVersion": logic::RECORDER_PROTOCOL, "axTrusted": true,
    }}));
    let writer_raw = writer.as_raw_handle() as isize;
    let writer_thread = thread::spawn(move || {
        for line in rx {
            if writer.write_all(line.as_bytes()).is_err() {
                // 对端不读了 / 已关:断开管道,读线程拿到错误后退订。
                let _ = unsafe { DisconnectNamedPipe(HANDLE(writer_raw as *mut _)) };
                return;
            }
        }
    });
    let sub_id = NEXT_SUB_ID.fetch_add(1, Ordering::AcqRel);
    SUBSCRIBERS.fetch_add(1, Ordering::AcqRel);
    post(Msg::Subscribe { id: sub_id, policy: Policy::from_json(request.get("policy")), outbox: Arc::clone(&outbox) });
    // 订阅连接之后的内容一律不认(只读到 EOF 判断对端关没关);不限行长会被塞爆内存,所以按块读掉。
    let mut sink = reader.into_inner().into_inner();
    let mut buffer = [0u8; 4096];
    while matches!(sink.read(&mut buffer), Ok(n) if n > 0) {}
    post(Msg::Unsubscribe(sub_id));
    drop(outbox);
    SUBSCRIBERS.fetch_sub(1, Ordering::AcqRel);
    touch_activity();
    let _ = writer_thread.join();
}

// ===========================================================================
// recorder 线程
// ===========================================================================

enum Msg {
    Subscribe { id: u64, policy: Policy, outbox: Arc<Outbox> },
    Unsubscribe(u64),
    Foreground(isize),
    NameChange(isize),
    Click { x: i32, y: i32, agent: bool },
    Key { combo: String, agent: bool },
    KeyActivity { agent: bool },
    FocusChanged,
    ValueChanged,
    System(&'static str),
}

fn sender() -> &'static Mutex<Option<Sender<Msg>>> {
    static SENDER: OnceLock<Mutex<Option<Sender<Msg>>>> = OnceLock::new();
    SENDER.get_or_init(|| Mutex::new(None))
}

fn post(msg: Msg) {
    if let Ok(guard) = sender().lock() {
        if let Some(tx) = guard.as_ref() {
            let _ = tx.send(msg);
        }
    }
}

fn start_recorder_thread() {
    let (tx, rx) = mpsc::channel();
    if let Ok(mut guard) = sender().lock() {
        *guard = Some(tx);
    }
    thread::spawn(move || {
        let hr = unsafe { CoInitializeEx(None, COINIT_MULTITHREADED) };
        if hr.is_err() {
            eprintln!("[recorder] CoInitializeEx: {hr:?}");
            std::process::exit(1);
        }
        let uia: IUIAutomation = match unsafe { CoCreateInstance(&CUIAutomation8, None, CLSCTX_INPROC_SERVER) }
            .or_else(|_| unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) })
        {
            Ok(uia) => uia,
            Err(e) => {
                eprintln!("[recorder] IUIAutomation: {e}");
                std::process::exit(1);
            }
        };
        if let Ok(uia2) = uia.cast::<IUIAutomation2>() {
            unsafe {
                let _ = uia2.SetConnectionTimeout(UIA_TIMEOUT_MS);
                let _ = uia2.SetTransactionTimeout(UIA_TIMEOUT_MS);
            }
        }
        Recorder::new(uia).run(rx);
    });
}

struct Sub {
    id: u64,
    policy: Policy,
    delivery: DeliveryState,
    outbox: Arc<Outbox>,
}

struct Focus {
    element: IUIAutomationElement,
    mode: TextMode,
    el: Map<String, Value>,
    sampling: bool,
}

struct Pending {
    context: Context,
    el: Map<String, Value>,
    last_change: i64,
    agent: bool,
    latest: Option<String>,
}

enum FieldRead {
    /// 密码框,或 IsPassword 查不到(证明不了不是)。
    Secure,
    Big,
    /// 元素已销毁 / 值读不到。
    Unreadable,
    Value(String),
}

struct BrowserWindow {
    address: Option<IUIAutomationElement>,
    private: bool,
}

struct HookThread {
    tid: u32,
    join: JoinHandle<()>,
}

struct Recorder {
    uia: IUIAutomation,
    self_pid: u32,
    subs: Vec<Sub>,
    running: bool,
    locked: bool,
    asleep: bool,
    hooks: Option<HookThread>,
    focus_handler: Option<IUIAutomationFocusChangedEventHandler>,
    focus_cache: Option<IUIAutomationCacheRequest>,
    value_handler: ValueHandlers,
    /// 当前前台(解析过 UWP 宿主之后)的进程与窗口。
    fg_pid: u32,
    fg_hwnd: isize,
    /// 情境是从哪个窗口读的、读时的原始标题(判断情境过没过时用;标题本身不另存)。
    context: Option<Context>,
    context_hwnd: isize,
    context_raw_title: String,
    window_deadline: Option<Instant>,
    focus: Option<Focus>,
    focus_is_password: bool,
    pending: Option<Pending>,
    text_deadline: Option<Instant>,
    sample_deadline: Option<Instant>,
    baseline: Option<String>,
    browser_windows: HashMap<isize, BrowserWindow>,
    app_names: HashMap<String, String>,
}

struct ValueHandlers {
    property: IUIAutomationPropertyChangedEventHandler,
    event: IUIAutomationEventHandler,
}

impl Recorder {
    fn new(uia: IUIAutomation) -> Self {
        let handler: IUIAutomationPropertyChangedEventHandler = ValueHandler.into();
        let event: IUIAutomationEventHandler = handler.cast().expect("ValueHandler implements both interfaces");
        let focus_cache = unsafe { uia.CreateCacheRequest() }.ok();
        if let Some(cache) = &focus_cache {
            for property in [
                UIA_ControlTypePropertyId,
                UIA_IsPasswordPropertyId,
                UIA_ProcessIdPropertyId,
                UIA_NamePropertyId,
                UIA_IsValuePatternAvailablePropertyId,
                UIA_ValueIsReadOnlyPropertyId,
                UIA_IsTextPatternAvailablePropertyId,
            ] {
                let _ = unsafe { cache.AddProperty(property) };
            }
        }
        Self {
            uia,
            self_pid: unsafe { GetCurrentProcessId() },
            subs: Vec::new(),
            running: false,
            locked: false,
            asleep: false,
            hooks: None,
            focus_handler: None,
            focus_cache,
            value_handler: ValueHandlers { property: handler, event },
            fg_pid: 0,
            fg_hwnd: 0,
            context: None,
            context_hwnd: 0,
            context_raw_title: String::new(),
            window_deadline: None,
            focus: None,
            focus_is_password: false,
            pending: None,
            text_deadline: None,
            sample_deadline: None,
            baseline: None,
            browser_windows: HashMap::new(),
            app_names: HashMap::new(),
        }
    }

    fn suspended(&self) -> bool {
        self.locked || self.asleep
    }

    fn run(mut self, rx: Receiver<Msg>) {
        loop {
            let timeout = [self.window_deadline, self.text_deadline, self.sample_deadline]
                .into_iter()
                .flatten()
                .min()
                .map(|d| d.saturating_duration_since(Instant::now()))
                .unwrap_or(Duration::from_secs(3600));
            match rx.recv_timeout(timeout) {
                Ok(msg) => self.handle(msg),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => return,
            }
            self.fire_due();
        }
    }

    fn fire_due(&mut self) {
        let now = Instant::now();
        if self.window_deadline.is_some_and(|d| d <= now) {
            self.refresh_window();
        }
        if self.sample_deadline.is_some_and(|d| d <= now) {
            self.sample_text();
        }
        if self.text_deadline.is_some_and(|d| d <= now) {
            self.text_deadline = None;
            self.refresh_if_stale();
            self.flush_text();
        }
    }

    fn handle(&mut self, msg: Msg) {
        match msg {
            Msg::Subscribe { id, policy, outbox } => self.subscribe(id, policy, outbox),
            Msg::Unsubscribe(id) => {
                self.subs.retain(|s| s.id != id);
                self.reset_text();
                if self.subs.is_empty() {
                    self.stop();
                }
            }
            _ if !self.running => {}
            Msg::System(state) => self.system_event(state),
            _ if self.suspended() => {}
            Msg::Foreground(hwnd) => self.on_foreground(hwnd),
            Msg::NameChange(hwnd) => {
                if hwnd == self.fg_hwnd && self.context.is_some() {
                    self.window_deadline = Some(Instant::now() + WINDOW_DEBOUNCE);
                }
            }
            Msg::Click { x, y, agent } => self.clicked(x, y, agent),
            Msg::Key { combo, agent } => self.keyed(combo, agent),
            Msg::KeyActivity { agent } => {
                if self.focus.is_some() {
                    self.value_changed(agent);
                }
            }
            Msg::FocusChanged => self.focus_changed(),
            Msg::ValueChanged => {
                if self.focus.is_some() {
                    self.value_changed(agent_marker::active());
                }
            }
        }
    }

    fn subscribe(&mut self, id: u64, policy: Policy, outbox: Arc<Outbox>) {
        self.subs.push(Sub { id, policy, delivery: DeliveryState::default(), outbox });
        let was_running = self.running;
        if was_running {
            self.reset_text();
        } else {
            self.start();
        }
        if self.suspended() {
            // 锁屏 / 睡眠时订阅:只给新来的补一条当前状态,不拍前台(人不在),解锁再接上。
            let state = if self.locked { "locked" } else { "sleep" };
            if let Some(sub) = self.subs.last() {
                sub.outbox.send(&json!({ "ev": { "t": now_ms(), "kind": "system", "state": state } }));
            }
            return;
        }
        if was_running && self.context.is_some() {
            let context = self.context.clone();
            self.emit(Kind::App, context.as_ref(), None, Map::new(), false, true);
        } else {
            self.fg_pid = 0;
            self.on_foreground(unsafe { GetForegroundWindow() }.0 as isize);
        }
    }

    fn start(&mut self) {
        if self.running {
            return;
        }
        self.running = true;
        self.locked = session_locked();
        self.asleep = false;
        self.hooks = start_hooks();
        let handler: IUIAutomationFocusChangedEventHandler = FocusHandler.into();
        if unsafe { self.uia.AddFocusChangedEventHandler(None, &handler) }.is_ok() {
            self.focus_handler = Some(handler);
        }
    }

    fn stop(&mut self) {
        if !self.running {
            return;
        }
        self.running = false;
        // 没人收了:丢掉未发的输入与基线,不再读任何东西。
        self.pending = None;
        self.text_deadline = None;
        self.sample_deadline = None;
        self.window_deadline = None;
        self.release_focus();
        if let Some(handler) = self.focus_handler.take() {
            let _ = unsafe { self.uia.RemoveFocusChangedEventHandler(&handler) };
        }
        let _ = unsafe { self.uia.RemoveAllEventHandlers() };
        if let Some(hooks) = self.hooks.take() {
            let _ = unsafe { PostThreadMessageW(hooks.tid, WM_QUIT, WPARAM(0), LPARAM(0)) };
            let _ = hooks.join.join();
        }
        self.context = None;
        self.context_hwnd = 0;
        self.fg_pid = 0;
        self.fg_hwnd = 0;
        self.baseline = None;
        self.browser_windows.clear();
    }

    /// 订阅者来去:未发的输入丢掉、差分基线作废,再按当前值重建(清除前打的字不能在清除后经旧基线冒出来)。
    fn reset_text(&mut self) {
        self.text_deadline = None;
        self.sample_deadline = None;
        self.pending = None;
        self.baseline = None;
        if !self.running || self.suspended() || self.focus.is_none() {
            return;
        }
        if self.context.as_ref().is_some_and(|c| self.wants(Kind::Text, c)) {
            self.prime_baseline();
        }
    }

    // ── 投递 ──

    fn emit(&mut self, kind: Kind, context: Option<&Context>, t: Option<i64>, fields: Map<String, Value>, agent: bool, dedupe: bool) {
        let time = t.unwrap_or_else(now_ms);
        for sub in &mut self.subs {
            let delivered = if matches!(kind, Kind::App | Kind::Window) {
                logic::context_delivery(kind, context, &sub.policy, &mut sub.delivery, dedupe)
            } else {
                logic::event_body(kind, context, &sub.policy)
            };
            let Some(mut body) = delivered else { continue };
            for (name, value) in &fields {
                body.insert(name.clone(), value.clone());
            }
            body.insert("t".into(), json!(time));
            if agent {
                body.insert("origin".into(), json!("agent"));
            }
            sub.outbox.send(&json!({ "ev": body }));
        }
    }

    fn wants(&self, kind: Kind, context: &Context) -> bool {
        self.subs.iter().any(|s| logic::event_body(kind, Some(context), &s.policy).is_some())
    }

    fn app_wanted(&self, bundle_id: &str) -> bool {
        self.subs.iter().any(|s| s.policy.wants_app(bundle_id))
    }

    fn text_wanted(&self, bundle_id: &str) -> bool {
        self.subs.iter().any(|s| s.policy.wants_text_in(bundle_id))
    }

    // ── 前台与情境 ──

    fn on_foreground(&mut self, hwnd: isize) {
        if hwnd == 0 || self.suspended() {
            return;
        }
        let Some((pid, exe, class)) = window_app(hwnd) else { return };
        if logic::is_ignored(&exe, &class) {
            return;
        }
        if pid != self.fg_pid {
            self.activated(hwnd, pid, &exe);
        } else {
            self.fg_hwnd = hwnd;
            self.refresh_window();
        }
    }

    fn activated(&mut self, hwnd: isize, pid: u32, exe: &str) {
        self.flush_text();
        self.release_focus();
        self.window_deadline = None;
        self.fg_pid = pid;
        self.fg_hwnd = hwnd;
        let next = self.read_context(hwnd, pid, exe);
        self.context = Some(next.clone());
        self.context_hwnd = hwnd;
        self.emit(Kind::App, Some(&next), None, Map::new(), agent_marker::active(), false);
        self.focus_changed();
    }

    fn refresh_window(&mut self) {
        self.window_deadline = None;
        if !self.running || self.suspended() || self.fg_hwnd == 0 {
            return;
        }
        let hwnd = self.fg_hwnd;
        let Some((pid, exe, _)) = window_app(hwnd) else { return };
        if pid != self.fg_pid {
            return self.activated(hwnd, pid, &exe);
        }
        let next = self.read_context(hwnd, pid, &exe);
        let window_changed = hwnd != self.context_hwnd;
        let url_changed = !window_changed
            && self.context.as_ref().is_some_and(|c| c.url != next.url || c.url_unknown != next.url_unknown);
        match logic::pending_on_refresh(self.wants(Kind::Text, &next), window_changed, url_changed) {
            PendingAction::Drop => self.drop_text(),
            PendingAction::Flush => self.flush_text(),
            PendingAction::Keep => {}
        }
        self.context = Some(next.clone());
        self.context_hwnd = hwnd;
        self.emit(Kind::Window, Some(&next), None, Map::new(), agent_marker::active(), true);
        if window_changed {
            self.focus_changed();
        }
    }

    /// 情境是不是已经过时(前台换了、标题变了而通知还在路上,或浏览器里标题没变而网址变了)→ 立刻同步刷新一次。
    /// 读基线、开始一段输入、停手报字、记点击 / 快捷键之前都先过这一步。
    fn refresh_if_stale(&mut self) {
        if !self.running || self.suspended() {
            return;
        }
        if self.window_deadline.is_some() {
            return self.refresh_window();
        }
        let fg = unsafe { GetForegroundWindow() }.0 as isize;
        if fg != self.context_hwnd {
            return self.on_foreground(fg);
        }
        let Some(context) = self.context.clone() else { return };
        // 硬排除 / 所有订阅者都排除的 App:标题从没读过,这里也不读来比对。
        if context.hard_excluded || !self.app_wanted(&context.bundle_id) {
            return;
        }
        if window_text(fg) != self.context_raw_title {
            return self.refresh_window();
        }
        if !context.is_private && logic::is_browser(&context.bundle_id) {
            let (url, resolved) = self.fast_url(fg);
            if resolved.is_some_and(|resolved| url != context.url || resolved == context.url_unknown) {
                self.refresh_window();
            }
        }
    }

    fn read_context(&mut self, hwnd: isize, pid: u32, exe: &str) -> Context {
        let bundle_id = exe.to_lowercase();
        let mut next = Context {
            name: self.app_name(pid, exe),
            bundle_id: bundle_id.clone(),
            hard_excluded: pid == self.self_pid || logic::is_hard_excluded(exe) || bundle_id.starts_with("windows-bridge"),
            ..Context::default()
        };
        self.context_raw_title.clear();
        if next.hard_excluded || !self.app_wanted(&bundle_id) {
            return next;
        }
        let raw_title = window_text(hwnd);
        let title = logic::title(&raw_title);
        let mut is_private = title.as_deref().is_some_and(logic::has_private_marker);
        let mut url = None;
        let mut url_unknown = false;
        if !is_private && logic::is_browser(exe) {
            let (found, resolved, private) = self.browser_lookup(hwnd);
            url = found;
            url_unknown = !resolved;
            is_private = private;
        }
        self.context_raw_title = raw_title;
        next.is_private = is_private;
        if !is_private {
            next.title = title;
            next.url = url;
            next.url_unknown = url_unknown;
        }
        next
    }

    fn app_name(&mut self, pid: u32, exe: &str) -> String {
        let path = process_path(pid).unwrap_or_default();
        if let Some(name) = self.app_names.get(&path) {
            return name.clone();
        }
        let stem = exe.strip_suffix(".exe").or_else(|| exe.strip_suffix(".EXE")).unwrap_or(exe).to_owned();
        let name = file_description(&path).and_then(|d| logic::label(&d)).unwrap_or(stem);
        if self.app_names.len() > 256 {
            self.app_names.clear();
        }
        self.app_names.insert(path, name.clone());
        name
    }

    // ── 浏览器网址 / 无痕(有上限、绝不展开网页内容) ──

    /// (网址, 读到没有, 无痕)。每个窗口第一次走一遍有上限的遍历,记住地址栏与无痕判定;之后只按地址栏快路重读。
    fn browser_lookup(&mut self, hwnd: isize) -> (Option<String>, bool, bool) {
        if !self.browser_windows.contains_key(&hwnd) {
            let walked = self.walk_browser(hwnd);
            if self.browser_windows.len() >= BROWSER_CACHE_CAP {
                self.browser_windows.clear();
            }
            self.browser_windows.insert(hwnd, walked);
        }
        let private = self.browser_windows.get(&hwnd).is_some_and(|w| w.private);
        if private {
            return (None, true, true);
        }
        let (url, resolved) = self.fast_url(hwnd);
        (url, resolved.unwrap_or(false), false)
    }

    /// 地址栏快路。返回 resolved = None:这个窗口没有记住的地址栏(判不了,不为此再走遍历)。
    fn fast_url(&mut self, hwnd: isize) -> (Option<String>, Option<bool>) {
        let Some(address) = self.browser_windows.get(&hwnd).and_then(|w| w.address.clone()) else {
            return (None, None);
        };
        match element_value(&address) {
            Ok(raw) => {
                let (url, resolved) = logic::address_bar_url(&raw);
                (url, Some(resolved))
            }
            Err(_) => {
                // 地址栏元素失效(窗口重建了工具栏):下次重新遍历。
                self.browser_windows.remove(&hwnd);
                (None, Some(false))
            }
        }
    }

    fn walk_browser(&self, hwnd: isize) -> BrowserWindow {
        let mut found = BrowserWindow { address: None, private: false };
        let deadline = Instant::now() + WALK_BUDGET;
        let Ok(cache) = (unsafe { self.uia.CreateCacheRequest() }) else { return found };
        for property in [UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_ClassNamePropertyId, UIA_AutomationIdPropertyId] {
            let _ = unsafe { cache.AddProperty(property) };
        }
        let Ok(condition) = (unsafe { self.uia.ControlViewCondition() }) else { return found };
        let Ok(root) = (unsafe { self.uia.ElementFromHandleBuildCache(HWND(hwnd as *mut _), &cache) }) else {
            return found;
        };
        let mut queue = std::collections::VecDeque::from([(root, 0usize)]);
        let mut nodes = 0usize;
        while let Some((node, depth)) = queue.pop_front() {
            if nodes >= WALK_NODE_CAP || Instant::now() >= deadline {
                break;
            }
            nodes += 1;
            let control_type = unsafe { node.CachedControlType() }.map(|c| c.0).unwrap_or(0);
            // 网页内容:绝不展开(会逼浏览器为整页建无障碍树)。
            if control_type == logic::CT_DOCUMENT {
                continue;
            }
            let name = unsafe { node.CachedName() }.map(|b| b.to_string()).unwrap_or_default();
            if matches!(control_type, logic::CT_BUTTON | logic::CT_SPLITBUTTON | logic::CT_MENUITEM)
                && logic::has_private_marker(&name)
            {
                found.private = true;
                found.address = None;
                return found;
            }
            if control_type == logic::CT_EDIT && found.address.is_none() {
                let class = unsafe { node.CachedClassName() }.map(|b| b.to_string()).unwrap_or_default();
                let automation_id = unsafe { node.CachedAutomationId() }.map(|b| b.to_string()).unwrap_or_default();
                if logic::is_address_field(&name, &class, &automation_id) {
                    found.address = Some(node.clone());
                }
            }
            if depth + 1 >= WALK_DEPTH_CAP {
                continue;
            }
            let Ok(children) = (unsafe { node.FindAllBuildCache(TreeScope_Children, &condition, &cache) }) else {
                continue;
            };
            let count = unsafe { children.Length() }.unwrap_or(0);
            for index in 0..count {
                if let Ok(child) = unsafe { children.GetElement(index) } {
                    queue.push_back((child, depth + 1));
                }
            }
        }
        found
    }

    // ── 焦点输入框与文本差分 ──

    fn focus_changed(&mut self) {
        if !self.running || self.suspended() {
            return;
        }
        // 焦点通知可能比前台 / 标题通知先到:先把情境对齐,再按新情境决定读不读。
        self.refresh_if_stale();
        let Some(context) = self.context.clone() else { return self.release_and_flush() };
        // 无痕 / 排除 / 只记标题 / 都不要文字的 App:连焦点元素都不取(不读控件名、不挂事件)。
        if context.hard_excluded || context.is_private || !self.text_wanted(&context.bundle_id) {
            return self.release_and_flush();
        }
        // 一次跨进程调用取齐判断要的属性(类型、密码框、进程、名字、两种模式可不可写)。
        let element = self.focus_cache.as_ref().and_then(|cache| unsafe { self.uia.GetFocusedElementBuildCache(cache) }.ok());
        self.set_focus(element, &context);
    }

    fn release_and_flush(&mut self) {
        self.flush_text();
        self.release_focus();
    }

    fn set_focus(&mut self, element: Option<IUIAutomationElement>, context: &Context) {
        if let (Some(element), Some(current)) = (&element, &self.focus) {
            let same = unsafe { self.uia.CompareElements(element, &current.element) }.is_ok_and(|b| b.as_bool());
            if same {
                // 同一个元素再次聚焦:网页可能已原地把它改成了密码框。复核一次,是就立刻撒手。
                if field_secure(element) {
                    self.drop_secure_field();
                }
                return;
            }
        }
        self.flush_text();
        self.release_focus();
        let Some(element) = element else { return };
        let pid = unsafe { element.CachedProcessId() }.unwrap_or(0) as u32;
        let control_type = unsafe { element.CachedControlType() }.map(|c| c.0).unwrap_or(0);
        // 查不到按密码框算(证明不了不是)。
        let is_password = unsafe { element.CachedIsPassword() }.map(|b| b.as_bool()).unwrap_or(true);
        self.focus_is_password = is_password;
        // 焦点在别的进程(浮层 / 系统输入框)里:不看。
        if pid != self.fg_pid || is_password {
            return;
        }
        let value_editable = (cached_bool(&element, UIA_IsValuePatternAvailablePropertyId) == Some(true))
            .then(|| cached_bool(&element, UIA_ValueIsReadOnlyPropertyId) == Some(false));
        let text_editable = (value_editable.is_none()
            && control_type != logic::CT_COMBOBOX
            && cached_bool(&element, UIA_IsTextPatternAvailablePropertyId) == Some(true))
        .then(|| text_range_editable(&element))
        .flatten();
        let Some(mode) = logic::text_mode(control_type, is_password, value_editable, text_editable) else { return };
        let registered = unsafe {
            match mode {
                TextMode::Value => self.uia.AddPropertyChangedEventHandlerNativeArray(
                    &element,
                    TreeScope_Element,
                    None,
                    &self.value_handler.property,
                    &[UIA_ValueValuePropertyId],
                ),
                TextMode::Text => self.uia.AddAutomationEventHandler(
                    UIA_Text_TextChangedEventId,
                    &element,
                    TreeScope_Element,
                    None,
                    &self.value_handler.event,
                ),
            }
        };
        // 挂不上值变化事件也照样跟踪(键盘活动信号兜底触发差分)。
        let _ = registered;
        let mut el = Map::new();
        el.insert("role".into(), json!(logic::control_type_name(control_type)));
        if let Some(label) = unsafe { element.CachedName() }.ok().and_then(|n| logic::label(&n.to_string())) {
            el.insert("label".into(), json!(label));
        }
        self.focus = Some(Focus { element, mode, el, sampling: false });
        if self.wants(Kind::Text, context) {
            self.prime_baseline();
        } else {
            self.baseline = None;
        }
    }

    fn release_focus(&mut self) {
        self.sample_deadline = None;
        if let Some(focus) = self.focus.take() {
            unsafe {
                match focus.mode {
                    TextMode::Value => {
                        let _ = self.uia.RemovePropertyChangedEventHandler(&focus.element, &self.value_handler.property);
                    }
                    TextMode::Text => {
                        let _ = self.uia.RemoveAutomationEventHandler(
                            UIA_Text_TextChangedEventId,
                            &focus.element,
                            &self.value_handler.event,
                        );
                    }
                }
            }
        }
        self.focus_is_password = false;
    }

    /// 聚焦时记下当前值作为差分基线(聚焦前就有的内容不算「打的字」)。
    fn prime_baseline(&mut self) {
        let Some(focus) = self.focus.as_mut() else { return };
        focus.sampling = false;
        match read_field(&focus.element, focus.mode) {
            FieldRead::Secure => self.drop_secure_field(),
            FieldRead::Big | FieldRead::Unreadable => self.baseline = None,
            FieldRead::Value(value) => {
                focus.sampling = value.chars().count() <= limit::SAMPLE_CHARS;
                self.baseline = Some(value);
            }
        }
    }

    fn value_changed(&mut self, agent: bool) {
        // 一段新输入的开头:先确认情境没过时(同一个输入框所在的标签页可能刚切到排除站点)。
        if self.pending.is_none() && self.context.as_ref().is_some_and(|c| self.wants(Kind::Text, c)) {
            self.refresh_if_stale();
        }
        let (Some(_), Some(context)) = (&self.focus, self.context.clone()) else { return };
        if !self.wants(Kind::Text, &context) {
            // 这段期间的值不能进下一次差分:丢掉待发与基线。
            self.pending = None;
            self.text_deadline = None;
            self.baseline = None;
            return;
        }
        let now = now_ms();
        match self.pending.as_mut() {
            Some(pending) => {
                pending.last_change = now;
                pending.agent |= agent;
            }
            None => {
                let el = self.focus.as_ref().map(|f| f.el.clone()).unwrap_or_default();
                self.pending = Some(Pending { context, el, last_change: now, agent, latest: None });
            }
        }
        self.text_deadline = Some(Instant::now() + TEXT_DEBOUNCE);
        if self.focus.as_ref().is_some_and(|f| f.sampling) && self.sample_deadline.is_none() {
            self.sample_deadline = Some(Instant::now() + SAMPLE_DELAY);
        }
    }

    /// 小输入框边打边采样(≤4 次/秒):抓住「发送后立刻被清空」之前的那一版。
    fn sample_text(&mut self) {
        self.sample_deadline = None;
        let (Some(focus), Some(pending), Some(live)) = (&self.focus, &self.pending, &self.context) else { return };
        if !self.wants(Kind::Text, &pending.context) || !self.wants(Kind::Text, live) {
            return;
        }
        let started = Instant::now();
        let read = read_field(&focus.element, focus.mode);
        let slow = started.elapsed().as_millis() > limit::SAMPLE_MS;
        let value = match read {
            FieldRead::Secure => return self.drop_secure_field(),
            FieldRead::Unreadable | FieldRead::Big => {
                if let Some(focus) = self.focus.as_mut() {
                    focus.sampling = false;
                }
                return;
            }
            FieldRead::Value(text) => text,
        };
        if slow || value.chars().count() > limit::SAMPLE_CHARS {
            if let Some(focus) = self.focus.as_mut() {
                focus.sampling = false;
            }
        }
        let latest = pending.latest.clone();
        if value.is_empty() && latest.as_deref().is_some_and(|l| !l.is_empty()) {
            // 输入框被清空(聊天框发送的典型形态):清空前那版立刻当作一段输入报出去,基线归零。
            self.refresh_if_stale();
            if self.pending.is_none() || self.focus.is_none() {
                return;
            }
            if self.focus.as_ref().is_some_and(|f| field_secure(&f.element)) {
                return self.drop_secure_field();
            }
            let pending = self.pending.take().expect("checked above");
            if let Some(diff) = self
                .baseline
                .as_deref()
                .and_then(|base| logic::settle_text(base, latest.as_deref(), &value))
                .filter(|d| !d.inserted.is_empty())
            {
                let mut fields = logic::text_fields(&diff);
                fields.insert("el".into(), Value::Object(pending.el.clone()));
                self.emit(Kind::Text, Some(&pending.context), Some(pending.last_change), fields, pending.agent, false);
            }
            self.baseline = Some(value);
            self.text_deadline = None;
            return;
        }
        if let Some(pending) = self.pending.as_mut() {
            pending.latest = Some(value);
        }
    }

    fn flush_text(&mut self) {
        self.text_deadline = None;
        self.sample_deadline = None;
        let Some(pending) = self.pending.take() else { return };
        let Some(focus) = &self.focus else {
            self.baseline = None;
            return;
        };
        let live_ok = self.context.as_ref().is_some_and(|c| self.wants(Kind::Text, c));
        if !self.wants(Kind::Text, &pending.context) || !live_ok {
            self.baseline = None;
            return;
        }
        let final_value = match read_field(&focus.element, focus.mode) {
            FieldRead::Secure => return self.drop_secure_field(),
            FieldRead::Big => {
                self.baseline = None;
                let mut fields = Map::new();
                fields.insert("el".into(), Value::Object(pending.el.clone()));
                fields.insert("bigEdit".into(), json!(true));
                return self.emit(Kind::Text, Some(&pending.context), Some(pending.last_change), fields, pending.agent, false);
            }
            // 元素没了 / 读不到:用最后一次采样兜底(有的聊天 App 发送后直接换掉输入框)。
            FieldRead::Unreadable => match pending.latest.clone() {
                Some(latest) => latest,
                None => return,
            },
            FieldRead::Value(text) => text,
        };
        // 没有基线(聚焦时读不到 / 刚从大文本缩回来):这次只建基线,不猜哪些是新打的。
        let Some(diff) = self
            .baseline
            .as_deref()
            .and_then(|base| logic::settle_text(base, pending.latest.as_deref(), &final_value))
        else {
            self.baseline = Some(final_value);
            return;
        };
        if field_secure(&focus.element) {
            return self.drop_secure_field();
        }
        self.baseline = Some(final_value);
        let mut fields = logic::text_fields(&diff);
        fields.insert("el".into(), Value::Object(pending.el.clone()));
        self.emit(Kind::Text, Some(&pending.context), Some(pending.last_change), fields, pending.agent, false);
    }

    /// 丢掉待发输入(不报),并作废基线 —— 只丢待发不清基线的话,下一次差分会把丢掉的字又带出来。
    fn drop_text(&mut self) {
        self.text_deadline = None;
        self.sample_deadline = None;
        self.pending = None;
        self.baseline = None;
    }

    /// 焦点框此刻是密码框:待发输入、基线、值变化事件全部立刻丢掉,不报。之后要等焦点换走再回来才会再看它。
    fn drop_secure_field(&mut self) {
        self.drop_text();
        self.release_focus();
        self.focus_is_password = true;
    }

    // ── 点击 / 快捷键 / 系统 ──

    fn clicked(&mut self, x: i32, y: i32, agent: bool) {
        if !self.context.as_ref().is_some_and(|c| self.wants(Kind::Click, c)) {
            return;
        }
        // 点的可能是刚打开的无痕窗口 / 刚切到的排除站点:先把情境对齐。
        self.refresh_if_stale();
        let Some(context) = self.context.clone() else { return };
        if !self.wants(Kind::Click, &context) {
            return;
        }
        // 点到别的 App 会先切前台;那一下不记。点在不抢前台的浮层(托盘、通知、开始菜单)上也不记。
        let point = POINT { x, y };
        let target = unsafe { GetAncestor(WindowFromPoint(point), GA_ROOT) };
        let Some((pid, _, _)) = window_app(target.0 as isize) else { return };
        if pid != self.fg_pid {
            return;
        }
        if self.pending.is_some() {
            self.flush_text();
        }
        let Ok(cache) = (unsafe { self.uia.CreateCacheRequest() }) else { return };
        for property in [UIA_ControlTypePropertyId, UIA_NamePropertyId, UIA_ProcessIdPropertyId] {
            let _ = unsafe { cache.AddProperty(property) };
        }
        let Ok(hit) = (unsafe { self.uia.ElementFromPointBuildCache(point, &cache) }) else { return };
        if unsafe { hit.CachedProcessId() }.unwrap_or(0) as u32 != self.fg_pid {
            return;
        }
        let control_type = unsafe { hit.CachedControlType() }.map(|c| c.0).unwrap_or(0);
        if control_type == 0 {
            return;
        }
        let mut el = Map::new();
        el.insert("role".into(), json!(logic::control_type_name(control_type)));
        if logic::click_label_allowed(control_type) {
            if let Some(label) = unsafe { hit.CachedName() }.ok().and_then(|n| logic::label(&n.to_string())) {
                el.insert("label".into(), json!(label));
            }
        }
        let mut fields = Map::new();
        fields.insert("el".into(), Value::Object(el));
        self.emit(Kind::Click, Some(&context), None, fields, agent, false);
    }

    fn keyed(&mut self, combo: String, agent: bool) {
        // 密码框里的组合键也不记(与 macOS 在 Secure Input 期间不报按键一致)。
        if self.focus_is_password || !self.context.as_ref().is_some_and(|c| self.wants(Kind::Key, c)) {
            return;
        }
        let fg = unsafe { GetForegroundWindow() }.0 as isize;
        if window_app(fg).map(|(pid, _, _)| pid) != Some(self.fg_pid) {
            return;
        }
        self.refresh_if_stale();
        let Some(context) = self.context.clone() else { return };
        if !self.wants(Kind::Key, &context) {
            return;
        }
        if self.pending.is_some() {
            self.flush_text();
        }
        let mut fields = Map::new();
        fields.insert("keys".into(), json!(combo));
        self.emit(Kind::Key, Some(&context), None, fields, agent, false);
    }

    fn system_event(&mut self, state: &'static str) {
        let was_suspended = self.suspended();
        match state {
            "locked" if self.locked => return,
            "unlocked" if !self.locked => return,
            "sleep" if self.asleep => return,
            "wake" if !self.asleep => return,
            "locked" => self.locked = true,
            "unlocked" => self.locked = false,
            "sleep" => self.asleep = true,
            "wake" => self.asleep = false,
            _ => return,
        }
        if self.suspended() && !was_suspended {
            self.flush_text();
            self.release_focus();
        }
        let mut fields = Map::new();
        fields.insert("state".into(), json!(state));
        self.emit(Kind::System, None, None, fields, false, false);
        if was_suspended && !self.suspended() {
            // 回来了:重新拍一次前台。只清去重键;「没记」的标记留着(锁屏前在无痕窗口,解锁后回到普通页面照样带 resumed)。
            for sub in &mut self.subs {
                sub.delivery.last_key = None;
            }
            self.fg_pid = 0;
            self.on_foreground(unsafe { GetForegroundWindow() }.0 as isize);
        }
    }
}

// ── UIA 读取小工具 ──

fn cached_bool(element: &IUIAutomationElement, property: UIA_PROPERTY_ID) -> Option<bool> {
    let value = unsafe { element.GetCachedPropertyValue(property) }.ok()?;
    bool::try_from(&value).ok()
}

/// TextPattern 文档区间的 IsReadOnly(网页正文是只读的,富文本编辑区不是)。查不到 → None(不当输入框)。
fn text_range_editable(element: &IUIAutomationElement) -> Option<bool> {
    unsafe {
        let pattern = element.GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId).ok()?;
        let read_only = pattern.DocumentRange().ok()?.GetAttributeValue(UIA_IsReadOnlyAttributeId).ok()?;
        bool::try_from(&read_only).ok().map(|read_only| !read_only)
    }
}

fn element_value(element: &IUIAutomationElement) -> windows::core::Result<String> {
    unsafe {
        let pattern = element.GetCurrentPatternAs::<IUIAutomationValuePattern>(UIA_ValuePatternId)?;
        Ok(pattern.CurrentValue()?.to_string())
    }
}

/// 报字 / 读值之前的复核:IsPassword 为真,或查不到(超时、App 不应答 —— 证明不了不是)→ 当密码框。
/// 元素已销毁不算(没东西可读了)。
fn field_secure(element: &IUIAutomationElement) -> bool {
    match unsafe { element.CurrentIsPassword() } {
        Ok(is_password) => is_password.as_bool(),
        Err(e) => e.code().0 != UIA_E_ELEMENTNOTAVAILABLE,
    }
}

fn read_field(element: &IUIAutomationElement, mode: TextMode) -> FieldRead {
    match unsafe { element.CurrentIsPassword() } {
        Ok(is_password) if is_password.as_bool() => return FieldRead::Secure,
        Ok(_) => {}
        Err(e) if e.code().0 == UIA_E_ELEMENTNOTAVAILABLE => return FieldRead::Unreadable,
        Err(_) => return FieldRead::Secure,
    }
    let value = match mode {
        TextMode::Value => element_value(element),
        TextMode::Text => unsafe {
            element
                .GetCurrentPatternAs::<IUIAutomationTextPattern>(UIA_TextPatternId)
                .and_then(|p| p.DocumentRange())
                .and_then(|r| r.GetText((limit::BIG_EDIT_CHARS + 1) as i32))
                .map(|b: BSTR| b.to_string())
        },
    };
    match value {
        Ok(text) if text.chars().count() > limit::BIG_EDIT_CHARS => FieldRead::Big,
        Ok(text) => FieldRead::Value(text),
        Err(_) => FieldRead::Unreadable,
    }
}

// ── 窗口 / 进程小工具 ──

fn window_text(hwnd: isize) -> String {
    let mut buffer = [0u16; 512];
    let len = unsafe { GetWindowTextW(HWND(hwnd as *mut _), &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

fn class_name(hwnd: HWND) -> String {
    let mut buffer = [0u16; 256];
    let len = unsafe { GetClassNameW(hwnd, &mut buffer) };
    String::from_utf16_lossy(&buffer[..len.max(0) as usize])
}

fn window_pid(hwnd: HWND) -> u32 {
    let mut pid = 0u32;
    unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
    pid
}

/// 前台窗口 → (App 进程 pid, exe 文件名, 前台窗口类名)。UWP App 的前台窗口属于 ApplicationFrameHost,
/// 真正的 App 是它里面的 Windows.UI.Core.CoreWindow 子窗口的进程。
fn window_app(hwnd: isize) -> Option<(u32, String, String)> {
    if hwnd == 0 {
        return None;
    }
    let handle = HWND(hwnd as *mut _);
    let class = class_name(handle);
    let mut pid = window_pid(handle);
    if pid == 0 {
        return None;
    }
    let mut exe = process_exe(pid)?;
    if exe.eq_ignore_ascii_case("applicationframehost.exe") {
        let core = unsafe { FindWindowExW(handle, None, &HSTRING::from("Windows.UI.Core.CoreWindow"), PCWSTR::null()) };
        if let Ok(core) = core {
            let inner = window_pid(core);
            if inner != 0 && inner != pid {
                if let Some(inner_exe) = process_exe(inner) {
                    pid = inner;
                    exe = inner_exe;
                }
            }
        }
    }
    Some((pid, exe, class))
}

fn process_path(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut buffer = [0u16; 1024];
        let mut size = buffer.len() as u32;
        let result = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(buffer.as_mut_ptr()), &mut size);
        let _ = CloseHandle(process);
        result.ok()?;
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }
}

fn process_exe(pid: u32) -> Option<String> {
    let path = process_path(pid)?;
    path.rsplit(['\\', '/']).next().map(str::to_owned)
}

/// 版本资源里的 FileDescription(「Google Chrome」「记事本」);取不到 → None。
fn file_description(path: &str) -> Option<String> {
    if path.is_empty() {
        return None;
    }
    let wide = HSTRING::from(path);
    unsafe {
        let size = GetFileVersionInfoSizeW(&wide, None);
        if size == 0 {
            return None;
        }
        let mut data = vec![0u8; size as usize];
        GetFileVersionInfoW(&wide, 0, size, data.as_mut_ptr() as *mut _).ok()?;
        let mut pointer: *mut core::ffi::c_void = std::ptr::null_mut();
        let mut len = 0u32;
        if !VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from("\\VarFileInfo\\Translation"), &mut pointer, &mut len).as_bool()
            || len < 4
        {
            return None;
        }
        let translation = *(pointer as *const [u16; 2]);
        let key = format!("\\StringFileInfo\\{:04x}{:04x}\\FileDescription", translation[0], translation[1]);
        if !VerQueryValueW(data.as_ptr() as *const _, &HSTRING::from(key), &mut pointer, &mut len).as_bool() || len == 0 {
            return None;
        }
        let text = std::slice::from_raw_parts(pointer as *const u16, len as usize);
        let end = text.iter().position(|&c| c == 0).unwrap_or(text.len());
        Some(String::from_utf16_lossy(&text[..end]))
    }
}

/// 开始订阅时会话是不是锁着:输入桌面打不开或不是 Default(锁屏 / UAC 安全桌面)。
fn session_locked() -> bool {
    unsafe {
        let Ok(desktop) = OpenInputDesktop(DESKTOP_CONTROL_FLAGS(0), false, DESKTOP_READOBJECTS) else { return true };
        let mut buffer = [0u16; 64];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            HANDLE(desktop.0),
            UOI_NAME,
            Some(buffer.as_mut_ptr() as *mut _),
            (buffer.len() * 2) as u32,
            Some(&mut needed),
        )
        .is_ok();
        let _ = CloseDesktop(desktop);
        if !ok {
            return true;
        }
        let end = buffer.iter().position(|&c| c == 0).unwrap_or(buffer.len());
        !String::from_utf16_lossy(&buffer[..end]).eq_ignore_ascii_case("Default")
    }
}

// ===========================================================================
// UIA 事件处理器(只投消息)
// ===========================================================================

#[implement(IUIAutomationFocusChangedEventHandler)]
struct FocusHandler;

impl IUIAutomationFocusChangedEventHandler_Impl for FocusHandler_Impl {
    fn HandleFocusChangedEvent(&self, _sender: Option<&IUIAutomationElement>) -> windows::core::Result<()> {
        post(Msg::FocusChanged);
        Ok(())
    }
}

#[implement(IUIAutomationPropertyChangedEventHandler, IUIAutomationEventHandler)]
struct ValueHandler;

impl IUIAutomationPropertyChangedEventHandler_Impl for ValueHandler_Impl {
    fn HandlePropertyChangedEvent(
        &self,
        _sender: Option<&IUIAutomationElement>,
        _property: UIA_PROPERTY_ID,
        _value: &VARIANT,
    ) -> windows::core::Result<()> {
        post(Msg::ValueChanged);
        Ok(())
    }
}

impl IUIAutomationEventHandler_Impl for ValueHandler_Impl {
    fn HandleAutomationEvent(&self, _sender: Option<&IUIAutomationElement>, _event: UIA_EVENT_ID) -> windows::core::Result<()> {
        post(Msg::ValueChanged);
        Ok(())
    }
}

// ===========================================================================
// 钩子线程(只泵消息、只转交)
// ===========================================================================

thread_local! {
    static NAME_HOOK: std::cell::Cell<(isize, u32)> = const { std::cell::Cell::new((0, 0)) };
}

fn start_hooks() -> Option<HookThread> {
    let (ready_tx, ready_rx) = mpsc::channel::<u32>();
    let join = thread::spawn(move || unsafe {
        let tid = GetCurrentThreadId();
        let module = GetModuleHandleW(None).unwrap_or_default();
        let instance = HINSTANCE(module.0);
        let mouse = SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_proc), instance, 0).ok();
        let keyboard = SetWindowsHookExW(WH_KEYBOARD_LL, Some(keyboard_proc), instance, 0).ok();
        let foreground = SetWinEventHook(
            EVENT_SYSTEM_FOREGROUND,
            EVENT_SYSTEM_FOREGROUND,
            None,
            Some(win_event_proc),
            0,
            0,
            WINEVENT_OUTOFCONTEXT | WINEVENT_SKIPOWNPROCESS,
        );
        let session_window = create_session_window(instance);
        if let Some(hwnd) = session_window {
            let _ = WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION);
        }
        let _ = ready_tx.send(tid);
        retarget_name_hook(window_pid(GetForegroundWindow()));
        let mut message = MSG::default();
        while GetMessageW(&mut message, None, 0, 0).0 > 0 {
            if message.hwnd.0.is_null() && message.message == WM_APP_RETARGET {
                retarget_name_hook(message.wParam.0 as u32);
                continue;
            }
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        let (name_hook, _) = NAME_HOOK.with(|h| h.get());
        if name_hook != 0 {
            let _ = UnhookWinEvent(HWINEVENTHOOK(name_hook as *mut _));
        }
        if !foreground.is_invalid() {
            let _ = UnhookWinEvent(foreground);
        }
        if let Some(hook) = mouse {
            let _ = UnhookWindowsHookEx(hook);
        }
        if let Some(hook) = keyboard {
            let _ = UnhookWindowsHookEx(hook);
        }
        if let Some(hwnd) = session_window {
            let _ = WTSUnRegisterSessionNotification(hwnd);
            let _ = DestroyWindow(hwnd);
        }
    });
    let tid = ready_rx.recv_timeout(Duration::from_secs(5)).ok()?;
    Some(HookThread { tid, join })
}

/// 标题变化只订前台窗口所在进程的(全系统订会把每个 App 里每个元素的改名都编组过来)。只在钩子线程上调用。
unsafe fn retarget_name_hook(pid: u32) {
    let (current, current_pid) = NAME_HOOK.with(|h| h.get());
    if pid == current_pid && current != 0 {
        return;
    }
    if current != 0 {
        let _ = UnhookWinEvent(HWINEVENTHOOK(current as *mut _));
    }
    let hook = if pid == 0 {
        HWINEVENTHOOK::default()
    } else {
        SetWinEventHook(EVENT_OBJECT_NAMECHANGE, EVENT_OBJECT_NAMECHANGE, None, Some(win_event_proc), pid, 0, WINEVENT_OUTOFCONTEXT)
    };
    NAME_HOOK.with(|h| h.set((hook.0 as isize, pid)));
}

unsafe extern "system" fn win_event_proc(
    _hook: HWINEVENTHOOK,
    event: u32,
    hwnd: HWND,
    object_id: i32,
    child_id: i32,
    _thread: u32,
    _time: u32,
) {
    if hwnd.0.is_null() {
        return;
    }
    if event == EVENT_SYSTEM_FOREGROUND {
        post(Msg::Foreground(hwnd.0 as isize));
        let _ = PostThreadMessageW(GetCurrentThreadId(), WM_APP_RETARGET, WPARAM(window_pid(hwnd) as usize), LPARAM(0));
    } else if event == EVENT_OBJECT_NAMECHANGE
        && object_id == OBJID_WINDOW.0
        && child_id == CHILDID_SELF as i32
        && GetAncestor(hwnd, GA_ROOT) == hwnd
    {
        post(Msg::NameChange(hwnd.0 as isize));
    }
}

fn key_down(vk: u16) -> bool {
    (unsafe { GetAsyncKeyState(vk as i32) }) < 0
}

unsafe extern "system" fn mouse_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 && wparam.0 as u32 == WM_LBUTTONDOWN {
        let info = &*(lparam.0 as *const MSLLHOOKSTRUCT);
        post(Msg::Click { x: info.pt.x, y: info.pt.y, agent: agent_marker::active() });
    }
    CallNextHookEx(None, code, wparam, lparam)
}

unsafe extern "system" fn keyboard_proc(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    let message = wparam.0 as u32;
    if code == HC_ACTION as i32 && (message == WM_KEYDOWN || message == WM_SYSKEYDOWN) {
        let info = &*(lparam.0 as *const KBDLLHOOKSTRUCT);
        let vk = info.vkCode;
        // 修饰键本身不算一次按键。
        let modifier = matches!(vk, 0x10..=0x12 | 0xA0..=0xA5 | 0x5B | 0x5C);
        if !modifier {
            let agent = agent_marker::active();
            let ctrl = key_down(VK_CONTROL.0);
            let win = key_down(VK_LWIN.0) || key_down(VK_RWIN.0);
            // AltGr = 左 Ctrl + 右 Alt:那是在打字符(德语键盘的 @ 等),不是快捷键,绝不按快捷键报出。
            let alt_gr = key_down(VK_RMENU.0) && !win;
            if (ctrl || win) && !alt_gr {
                let character = match vk {
                    0x30..=0x39 | 0x41..=0x5A | 0x08..=0x2E | 0x60..=0x87 => None,
                    _ => {
                        let mapped = MapVirtualKeyW(vk, MAPVK_VK_TO_CHAR);
                        // 高位 = 死键;不报。
                        (mapped & 0x8000_0000 == 0).then(|| char::from_u32(mapped & 0xFFFF)).flatten()
                    }
                };
                if let Some(combo) = logic::key_name(vk, character)
                    .and_then(|key| logic::key_combo(ctrl, key_down(VK_MENU.0), key_down(VK_SHIFT.0), win, &key))
                {
                    post(Msg::Key { combo, agent });
                }
            }
            // 只告诉 recorder「有输入」,不带键值:用来触发对焦点输入框的差分读取。
            post(Msg::KeyActivity { agent });
        }
    }
    CallNextHookEx(None, code, wparam, lparam)
}

// ── 会话锁屏 / 睡眠:隐藏的顶层窗口(WM_POWERBROADCAST 不发给仅消息窗口) ──

const WTS_CONSOLE_DISCONNECT: usize = 0x2;
const WTS_REMOTE_DISCONNECT: usize = 0x4;
const WTS_SESSION_LOCK: usize = 0x7;
const WTS_SESSION_UNLOCK: usize = 0x8;
const PBT_APMSUSPEND: usize = 0x4;
const PBT_APMRESUMESUSPEND: usize = 0x7;
const PBT_APMRESUMEAUTOMATIC: usize = 0x12;

fn create_session_window(instance: HINSTANCE) -> Option<HWND> {
    static REGISTERED: AtomicBool = AtomicBool::new(false);
    let class = HSTRING::from("TanguComputerHistorySession");
    unsafe {
        if !REGISTERED.swap(true, Ordering::AcqRel) {
            let wc = WNDCLASSW {
                lpfnWndProc: Some(session_window_proc),
                hInstance: instance,
                lpszClassName: PCWSTR(class.as_ptr()),
                ..Default::default()
            };
            RegisterClassW(&wc);
        }
        CreateWindowExW(
            WINDOW_EX_STYLE(0),
            &class,
            &HSTRING::from("Tangu Computer History"),
            WS_OVERLAPPED,
            0,
            0,
            0,
            0,
            None,
            None,
            instance,
            None,
        )
        .ok()
    }
}

unsafe extern "system" fn session_window_proc(hwnd: HWND, message: u32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    match message {
        WM_WTSSESSION_CHANGE => match wparam.0 {
            WTS_SESSION_LOCK | WTS_CONSOLE_DISCONNECT | WTS_REMOTE_DISCONNECT => post(Msg::System("locked")),
            WTS_SESSION_UNLOCK => post(Msg::System("unlocked")),
            _ => {}
        },
        WM_POWERBROADCAST => match wparam.0 {
            PBT_APMSUSPEND => post(Msg::System("sleep")),
            PBT_APMRESUMESUSPEND | PBT_APMRESUMEAUTOMATIC => post(Msg::System("wake")),
            _ => {}
        },
        _ => {}
    }
    DefWindowProcW(hwnd, message, wparam, lparam)
}
