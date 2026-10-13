use super::{key_codes, OutputKeyState, WINDOW_LABEL};
use serde::Serialize;
use std::{
    cell::RefCell,
    collections::HashSet,
    ptr,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use windows_sys::Win32::{
    Foundation::{LPARAM, LRESULT, WPARAM},
    Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    System::{LibraryLoader::GetModuleHandleW, Threading::GetCurrentThreadId},
    UI::Input::KeyboardAndMouse::{GetAsyncKeyState, MapVirtualKeyW, MAPVK_VK_TO_VSC_EX},
    UI::WindowsAndMessaging::{
        CallNextHookEx, DispatchMessageW, GetMessageW, PeekMessageW, PostThreadMessageW,
        SetWindowsHookExW, ShowWindow, TranslateMessage, UnhookWindowsHookEx, HC_ACTION,
        KBDLLHOOKSTRUCT, LLKHF_EXTENDED, LLKHF_INJECTED, MSG, PM_NOREMOVE, SW_SHOWNOACTIVATE,
        WH_KEYBOARD_LL, WM_KEYDOWN, WM_KEYUP, WM_QUIT, WM_SYSKEYDOWN, WM_SYSKEYUP,
    },
};

#[derive(Default)]
struct InputState {
    pressed: HashSet<u32>,
    sequence: u64,
}

struct HookContext {
    app: AppHandle,
    enabled: Arc<AtomicBool>,
    input: Arc<Mutex<InputState>>,
}

thread_local! {
    static HOOK_CONTEXT: RefCell<Option<HookContext>> = const { RefCell::new(None) };
}

#[derive(Clone, Serialize)]
struct OutputKeyEvent {
    usage: u32,
    pressed: bool,
    sequence: u64,
}

fn report_error(app: &AppHandle, message: String) {
    eprintln!("Keyboard overlay: {message}");
    if let Err(error) = app.emit_to("main", "keyboard-overlay-error", message) {
        eprintln!("Could not notify Studio of overlay failure: {error}");
    }
}

unsafe extern "system" fn keyboard_hook(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
    if code == HC_ACTION as i32 {
        let data = &*(lparam as *const KBDLLHOOKSTRUCT);
        let message = wparam as u32;
        if data.flags & LLKHF_INJECTED == 0
            && matches!(message, WM_KEYDOWN | WM_KEYUP | WM_SYSKEYDOWN | WM_SYSKEYUP)
        {
            if let Some(usage) = key_codes::usage_from_windows_key(
                data.vkCode,
                data.scanCode,
                data.flags & LLKHF_EXTENDED != 0,
            ) {
                HOOK_CONTEXT.with(|context| {
                    let mut context = context.borrow_mut();
                    if let Some(context) = context.as_mut() {
                        if !context.enabled.load(Ordering::Acquire) {
                            return;
                        }
                        let pressed = message == WM_KEYDOWN || message == WM_SYSKEYDOWN;
                        let mut input = match context.input.lock() {
                            Ok(input) => input,
                            Err(error) => {
                                context.enabled.store(false, Ordering::Release);
                                report_error(&context.app, format!("Input state failed: {error}"));
                                return;
                            }
                        };
                        if !context.enabled.load(Ordering::Acquire) {
                            return;
                        }
                        if pressed {
                            if !input.pressed.insert(usage) {
                                return;
                            }
                        } else {
                            input.pressed.remove(&usage);
                        }
                        input.sequence += 1;
                        let sequence = input.sequence;
                        drop(input);
                        if let Err(error) = context.app.emit_to(
                            WINDOW_LABEL,
                            "keyboard-overlay-key",
                            OutputKeyEvent {
                                usage,
                                pressed,
                                sequence,
                            },
                        ) {
                            context.enabled.store(false, Ordering::Release);
                            report_error(
                                &context.app,
                                format!("Could not update keyboard highlights: {error}"),
                            );
                        }
                    }
                });
            }
        }
    }
    // Observation only: never consume or modify input destined for other apps.
    CallNextHookEx(ptr::null_mut(), code, wparam, lparam)
}

pub struct InputMonitor {
    thread_id: u32,
    enabled: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
    input: Arc<Mutex<InputState>>,
}

impl InputMonitor {
    pub fn start(app: AppHandle) -> Result<Self, String> {
        let (ready, started) = mpsc::channel();
        let enabled = Arc::new(AtomicBool::new(true));
        let alive = Arc::new(AtomicBool::new(true));
        let thread_enabled = enabled.clone();
        let thread_alive = alive.clone();
        let input = Arc::new(Mutex::new(InputState::default()));
        let thread_input = input.clone();
        let thread = thread::Builder::new()
            .name("zmk-overlay-input".into())
            .spawn(move || unsafe {
                let thread_id = GetCurrentThreadId();
                let mut message: MSG = std::mem::zeroed();
                PeekMessageW(&mut message, ptr::null_mut(), 0, 0, PM_NOREMOVE);
                HOOK_CONTEXT.with(|context| {
                    *context.borrow_mut() = Some(HookContext {
                        app: app.clone(),
                        enabled: thread_enabled,
                        input: thread_input.clone(),
                    });
                });
                let hook = SetWindowsHookExW(
                    WH_KEYBOARD_LL,
                    Some(keyboard_hook),
                    GetModuleHandleW(ptr::null()),
                    0,
                );
                if hook.is_null() {
                    let error = std::io::Error::last_os_error().to_string();
                    if ready.send(Err(error.clone())).is_err() {
                        report_error(&app, error);
                    }
                    thread_alive.store(false, Ordering::Release);
                    HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
                    return;
                }
                if let Ok(mut input) = thread_input.lock() {
                    for virtual_key in 8..=255 {
                        if matches!(virtual_key, 0x10 | 0x11 | 0x12)
                            || GetAsyncKeyState(virtual_key as i32) >= 0
                        {
                            continue;
                        }
                        let scan = MapVirtualKeyW(virtual_key, MAPVK_VK_TO_VSC_EX);
                        if let Some(usage) = key_codes::usage_from_windows_key(
                            virtual_key,
                            scan & 0xff,
                            scan & 0xff00 == 0xe000,
                        ) {
                            input.pressed.insert(usage);
                        }
                    }
                } else {
                    report_error(&app, "Could not initialize pressed-key state.".into());
                }
                if ready.send(Ok(thread_id)).is_ok() {
                    loop {
                        let result = GetMessageW(&mut message, ptr::null_mut(), 0, 0);
                        if result == 0 {
                            break;
                        }
                        if result == -1 {
                            report_error(
                                &app,
                                format!(
                                    "Input monitor failed: {}",
                                    std::io::Error::last_os_error()
                                ),
                            );
                            break;
                        }
                        TranslateMessage(&message);
                        DispatchMessageW(&message);
                    }
                }
                if UnhookWindowsHookEx(hook) == 0 {
                    report_error(
                        &app,
                        format!(
                            "Could not remove input monitor: {}",
                            std::io::Error::last_os_error()
                        ),
                    );
                }
                HOOK_CONTEXT.with(|context| *context.borrow_mut() = None);
                thread_alive.store(false, Ordering::Release);
            })
            .map_err(|e| e.to_string())?;
        match started.recv() {
            Ok(Ok(thread_id)) => Ok(Self {
                thread_id,
                enabled,
                alive,
                thread: Some(thread),
                input,
            }),
            result => {
                thread
                    .join()
                    .map_err(|_| "Input monitor startup panicked.".to_string())?;
                Err(match result {
                    Ok(Err(error)) => error,
                    Err(error) => error.to_string(),
                    Ok(Ok(_)) => unreachable!(),
                })
            }
        }
    }

    pub fn stop(&mut self) -> Result<(), String> {
        // Disabling observation precedes teardown, even if posting WM_QUIT fails.
        self.enabled.store(false, Ordering::Release);
        self.input
            .lock()
            .map_err(|e| e.to_string())?
            .pressed
            .clear();
        if self.alive.load(Ordering::Acquire)
            && unsafe { PostThreadMessageW(self.thread_id, WM_QUIT, 0, 0) } == 0
            && self.alive.load(Ordering::Acquire)
        {
            return Err(format!(
                "Could not stop input monitor: {}",
                std::io::Error::last_os_error()
            ));
        }
        if let Some(thread) = self.thread.take() {
            thread
                .join()
                .map_err(|_| "Input monitor stopped unexpectedly.".to_string())?;
        }
        Ok(())
    }

    pub fn pressed(&self) -> Result<OutputKeyState, String> {
        let input = self.input.lock().map_err(|e| e.to_string())?;
        Ok(OutputKeyState {
            pressed: input.pressed.iter().copied().collect(),
            sequence: input.sequence,
        })
    }
}

fn overlay_dimensions(
    size_percent: u32,
    scale: f64,
    available_width: i32,
    available_height: i32,
) -> (u32, u32) {
    let max_width = (available_width as f64 - 24.0 * scale).floor().max(1.0);
    let max_height = (available_height as f64 - 24.0 * scale).floor().max(1.0);
    let zoom = (size_percent as f64 / 100.0)
        .min(max_width / (1000.0 * scale))
        .min(max_height / (330.0 * scale));
    (
        (1000.0 * scale * zoom).round().max(1.0) as u32,
        (330.0 * scale * zoom).round().max(1.0) as u32,
    )
}

pub fn show_overlay(app: &AppHandle, size_percent: u32) -> Result<(), String> {
    let main = app
        .get_webview_window("main")
        .ok_or("Studio window is unavailable.")?;
    let scale = main.scale_factor().map_err(|e| e.to_string())?;
    let main_hwnd = main.hwnd().map_err(|e| e.to_string())?.0 as _;
    let mut monitor: MONITORINFO = unsafe { std::mem::zeroed() };
    monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe {
        GetMonitorInfoW(
            MonitorFromWindow(main_hwnd, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let available_width = monitor.rcWork.right - monitor.rcWork.left;
    let available_height = monitor.rcWork.bottom - monitor.rcWork.top;
    let (width, height) =
        overlay_dimensions(size_percent, scale, available_width, available_height);
    let existing = app.get_webview_window(WINDOW_LABEL);
    let created = existing.is_none();
    let window = match existing {
        Some(window) => window,
        None => {
            WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::App("overlay.html".into()))
                .title("ZMK Keyboard Overlay")
                .transparent(true)
                .decorations(false)
                .shadow(false)
                .resizable(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .visible(false)
                .build()
                .map_err(|e| e.to_string())?
        }
    };
    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            monitor.rcWork.left + (available_width - width as i32) / 2,
            monitor.rcWork.bottom - height as i32 - (12.0 * scale) as i32,
        ))
        .map_err(|e| e.to_string())?;
    if !created {
        return Ok(());
    }
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    crate::window_style::set_overlay_style(&window, true)?;
    unsafe {
        ShowWindow(hwnd, SW_SHOWNOACTIVATE);
    }
    Ok(())
}

#[cfg(test)]
mod size_tests {
    use super::overlay_dimensions;

    #[test]
    fn default_is_twenty_percent_larger_and_steps_are_ten_percent() {
        assert_eq!(overlay_dimensions(100, 1.0, 4000, 2000), (1000, 330));
        assert_eq!(overlay_dimensions(110, 1.0, 4000, 2000), (1100, 363));
        assert_eq!(overlay_dimensions(120, 1.0, 4000, 2000), (1200, 396));
        assert_eq!(overlay_dimensions(130, 1.0, 4000, 2000), (1300, 429));
        assert_eq!(overlay_dimensions(120, 1.5, 4000, 2000), (1800, 594));
    }

    #[test]
    fn screen_limits_preserve_keyboard_proportions() {
        assert_eq!(overlay_dimensions(200, 1.0, 1024, 768), (1000, 330));
        assert_eq!(overlay_dimensions(200, 1.0, 4000, 354), (1000, 330));
        assert_eq!(overlay_dimensions(200, 1.0, 1, 1), (1, 1));
    }
}
