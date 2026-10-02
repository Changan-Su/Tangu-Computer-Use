//! Tangu 新增:跨进程的「agent 正在操作」标记,给电脑历史的事件打 `origin:"agent"`。
//!
//! macOS 上动作与采集在同一个 helper 进程里,一个深度计数就够;Windows 上执行动作的是引擎拉起的 stdio 助手,
//! 采集的是桌面拉起的 `serve` 进程,所以用一个会话内的命名互斥量当标记:stdio 助手执行 act 等命令期间(以及结束后
//! 750ms —— UIA 事件与输入是异步到的)持有它的句柄,采集器只探它在不在(OpenMutexW),从不创建。
//! 非 Windows 平台全是空操作。

#[cfg(windows)]
use std::sync::Mutex;

#[cfg(windows)]
const MARKER_NAME: &str = "Local\\tangu-computer-use-agent-active";
#[cfg(windows)]
const GRACE_MS: u64 = 750;

#[cfg(windows)]
#[derive(Default)]
struct MarkerState {
    depth: u32,
    /// 互斥量句柄(isize:HANDLE 不是 Send)。
    handle: Option<isize>,
    generation: u64,
}

#[cfg(windows)]
fn state() -> &'static Mutex<MarkerState> {
    static STATE: std::sync::OnceLock<Mutex<MarkerState>> = std::sync::OnceLock::new();
    STATE.get_or_init(|| Mutex::new(MarkerState::default()))
}

/// 持有期间标记亮着;drop 后再亮 750ms。
pub struct AgentGuard(());

pub fn enter() -> AgentGuard {
    #[cfg(windows)]
    if let Ok(mut s) = state().lock() {
        s.depth += 1;
        if s.handle.is_none() {
            use windows::core::HSTRING;
            use windows::Win32::System::Threading::CreateMutexW;
            if let Ok(h) = unsafe { CreateMutexW(None, false, &HSTRING::from(MARKER_NAME)) } {
                s.handle = Some(h.0 as isize);
            }
        }
    }
    AgentGuard(())
}

impl Drop for AgentGuard {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            let generation = match state().lock() {
                Ok(mut s) if s.depth > 0 => {
                    s.depth -= 1;
                    if s.depth > 0 {
                        return;
                    }
                    s.generation += 1;
                    s.generation
                }
                _ => return,
            };
            std::thread::spawn(move || {
                std::thread::sleep(std::time::Duration::from_millis(GRACE_MS));
                let Ok(mut s) = state().lock() else { return };
                if s.depth == 0 && s.generation == generation {
                    if let Some(raw) = s.handle.take() {
                        use windows::Win32::Foundation::{CloseHandle, HANDLE};
                        let _ = unsafe { CloseHandle(HANDLE(raw as *mut _)) };
                    }
                }
            });
        }
    }
}

/// 别的进程(或本进程)此刻是否亮着标记。只探不建。
pub fn active() -> bool {
    #[cfg(windows)]
    {
        use windows::core::HSTRING;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_SYNCHRONIZE};
        match unsafe { OpenMutexW(SYNCHRONIZATION_SYNCHRONIZE, false, &HSTRING::from(MARKER_NAME)) } {
            Ok(h) => {
                let _ = unsafe { CloseHandle(h) };
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        false
    }
}
