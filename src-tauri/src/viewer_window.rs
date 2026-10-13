use std::sync::Mutex;
#[cfg(windows)]
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter,
};
use tauri::{App, LogicalSize, Manager, PhysicalPosition, PhysicalSize, State, WebviewWindow};

struct ControlsWindow {
    position: PhysicalPosition<i32>,
    size: PhysicalSize<u32>,
    on_top: bool,
}

#[derive(Default)]
pub struct ViewerWindowState {
    controls: Mutex<Option<ControlsWindow>>,
}

fn overlay_dimensions(
    width: f64,
    height: f64,
    scale: f64,
    available_width: f64,
    available_height: f64,
    combos_height: f64,
) -> Result<PhysicalSize<u32>, String> {
    if !combos_height.is_finite() || combos_height < 0.0 {
        return Err("Invalid viewer combo panel dimensions.".into());
    }
    if ![width, height, scale, available_width, available_height]
        .iter()
        .all(|value| value.is_finite() && *value > 0.0)
    {
        return Err("Invalid viewer overlay dimensions.".into());
    }
    let padding_width = 24.0 * scale;
    let padding_height = (52.0 + combos_height) * scale;
    if width <= 24.0
        || height <= 52.0 + combos_height
        || available_width <= padding_width
        || available_height <= padding_height
    {
        return Err("Viewer overlay has no space for the keyboard.".into());
    }
    let keyboard_width = (width - 24.0) * scale;
    let keyboard_height = (height - 52.0 - combos_height) * scale;
    if !keyboard_width.is_finite() || !keyboard_height.is_finite() {
        return Err("Invalid viewer overlay dimensions.".into());
    }
    let fit = ((available_width - padding_width) / keyboard_width)
        .min((available_height - padding_height) / keyboard_height)
        .min(1.0);
    Ok(PhysicalSize::new(
        (keyboard_width * fit + padding_width).ceil() as u32,
        (keyboard_height * fit + padding_height).ceil() as u32,
    ))
}

fn restore_controls(window: &WebviewWindow, state: &ViewerWindowState) -> Result<(), String> {
    window
        .set_ignore_cursor_events(false)
        .map_err(|e| e.to_string())?;
    #[cfg(windows)]
    crate::window_style::set_overlay_style(window, false)?;
    let mut saved = state.controls.lock().map_err(|e| e.to_string())?;
    if let Some(controls) = saved.as_ref() {
        window.set_resizable(true).map_err(|e| e.to_string())?;
        window
            .set_min_size(Some(LogicalSize::new(500.0, 250.0)))
            .map_err(|e| e.to_string())?;
        window.set_size(controls.size).map_err(|e| e.to_string())?;
        window
            .set_position(controls.position)
            .map_err(|e| e.to_string())?;
        window
            .set_always_on_top(controls.on_top)
            .map_err(|e| e.to_string())?;
        *saved = None;
    }
    Ok(())
}

#[cfg(windows)]
fn enable_overlay(
    window: &WebviewWindow,
    state: &ViewerWindowState,
    width: f64,
    height: f64,
    pixel_ratio: f64,
    combos_height: f64,
) -> Result<(), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GWL_EXSTYLE, WS_EX_TOPMOST,
    };
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    let mut monitor: MONITORINFO = unsafe { std::mem::zeroed() };
    monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
    if unsafe {
        GetMonitorInfoW(
            MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST),
            &mut monitor,
        )
    } == 0
    {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let margin = (12.0 * scale).round() as i32;
    let available_width = monitor.rcWork.right - monitor.rcWork.left;
    let available_height = monitor.rcWork.bottom - monitor.rcWork.top;
    let size = overlay_dimensions(
        width,
        height,
        pixel_ratio,
        (available_width - margin * 2) as f64,
        (available_height - margin * 2) as f64,
        combos_height,
    )?;
    let mut saved = state.controls.lock().map_err(|e| e.to_string())?;
    if saved.is_none() {
        *saved = Some(ControlsWindow {
            position: window.outer_position().map_err(|e| e.to_string())?,
            size: window.inner_size().map_err(|e| e.to_string())?,
            on_top: unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) & WS_EX_TOPMOST as isize != 0 },
        });
    }
    window
        .set_min_size(None::<LogicalSize<f64>>)
        .map_err(|e| e.to_string())?;
    window.set_resizable(false).map_err(|e| e.to_string())?;
    window.set_always_on_top(true).map_err(|e| e.to_string())?;
    window.set_size(size).map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(
            monitor.rcWork.left + (available_width - size.width as i32) / 2,
            monitor.rcWork.bottom - size.height as i32 - margin,
        ))
        .map_err(|e| e.to_string())?;
    window
        .set_ignore_cursor_events(true)
        .map_err(|e| e.to_string())?;
    // Tauri's window setters can rewrite extended styles, so apply this last.
    crate::window_style::set_overlay_style(window, true)?;
    Ok(())
}

#[tauri::command]
pub fn viewer_set_overlay(
    window: WebviewWindow,
    state: State<'_, ViewerWindowState>,
    enabled: bool,
    width: f64,
    height: f64,
    pixel_ratio: f64,
    combos_height: f64,
) -> Result<(), String> {
    if window.app_handle().config().identifier != "dev.zmk.keyboard-viewer" {
        return Err("Typing overlay is only available in the standalone viewer.".into());
    }
    if !enabled {
        return restore_controls(&window, &state);
    }
    #[cfg(not(windows))]
    return Err("The typing overlay is currently supported on Windows only.".into());
    #[cfg(windows)]
    if let Err(error) = enable_overlay(&window, &state, width, height, pixel_ratio, combos_height) {
        return match restore_controls(&window, &state) {
            Ok(()) => Err(error),
            Err(cleanup) => Err(format!(
                "{error}; restoring viewer controls also failed: {cleanup}"
            )),
        };
    }
    #[cfg(windows)]
    Ok(())
}

#[tauri::command]
pub fn viewer_toggle_display(window: WebviewWindow) -> Result<(), String> {
    if window.app_handle().config().identifier != "dev.zmk.keyboard-viewer" {
        return Err("Display shortcuts are only available in the standalone viewer.".into());
    }
    if window.is_visible().map_err(|e| e.to_string())? {
        return window.hide().map_err(|e| e.to_string());
    }
    #[cfg(windows)]
    {
        window
            .emit("viewer-display", ())
            .map_err(|e| e.to_string())?;
        // Keep Tauri's visibility state in sync; the overlay's NOACTIVATE style preserves focus.
        window.show().map_err(|e| e.to_string())
    }
    #[cfg(not(windows))]
    window.show().map_err(|e| e.to_string())
}

pub fn window_event(window: &tauri::Window, event: &tauri::WindowEvent) {
    #[cfg(windows)]
    if window.label() == "main"
        && window.app_handle().config().identifier == "dev.zmk.keyboard-viewer"
    {
        if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Err(error) = window.hide() {
                report_error(window.app_handle(), error.to_string());
            }
        }
    }
}

#[cfg(windows)]
fn report_error(app: &AppHandle, error: String) {
    eprintln!("Keyboard viewer window: {error}");
    if let Err(emit_error) = app.emit("viewer-window-error", error) {
        eprintln!("Could not report viewer window error: {emit_error}");
    }
}

#[cfg(windows)]
fn show_controls(app: &AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Viewer window is unavailable.")?;
    restore_controls(&window, &app.state::<ViewerWindowState>())?;
    window
        .emit("viewer-controls", ())
        .map_err(|e| e.to_string())?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

pub fn setup(app: &mut App) -> Result<(), Box<dyn std::error::Error>> {
    if app.config().identifier != "dev.zmk.keyboard-viewer" {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let controls =
            MenuItem::with_id(app, "viewer-controls", "Show controls", true, None::<&str>)?;
        let quit = MenuItem::with_id(app, "viewer-quit", "Exit viewer", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&controls, &quit])?;
        let icon = app
            .default_window_icon()
            .ok_or("Viewer tray icon is unavailable.")?
            .clone();
        TrayIconBuilder::with_id("keyboard-viewer")
            .icon(icon)
            .tooltip("ZMK Keyboard Viewer - right-click for controls")
            .menu(&menu)
            .menu_on_left_click(false)
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    if let Err(error) = show_controls(tray.app_handle()) {
                        report_error(tray.app_handle(), error);
                    }
                }
            })
            .on_menu_event(|app, event| {
                let result = match event.id.as_ref() {
                    "viewer-controls" => show_controls(app),
                    "viewer-quit" => {
                        app.exit(0);
                        Ok(())
                    }
                    _ => return,
                };
                if let Err(error) = result {
                    report_error(app, error);
                }
            })
            .build(app)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overlay_size_preserves_zoom_and_fits_work_area_at_high_dpi() {
        assert_eq!(
            overlay_dimensions(824.0, 352.0, 1.0, 1920.0, 1080.0, 0.0).unwrap(),
            PhysicalSize::new(824, 352)
        );
        assert_eq!(
            overlay_dimensions(824.0, 352.0, 1.5, 1920.0, 1080.0, 0.0).unwrap(),
            PhysicalSize::new(1236, 528)
        );
        assert_eq!(
            overlay_dimensions(1624.0, 652.0, 1.5, 1236.0, 800.0, 0.0).unwrap(),
            PhysicalSize::new(1236, 528)
        );
        assert_eq!(
            overlay_dimensions(824.0, 652.0, 1.0, 1920.0, 352.0, 0.0).unwrap(),
            PhysicalSize::new(424, 352)
        );
        assert_eq!(
            overlay_dimensions(824.0, 352.0, 1.875, 1920.0, 1080.0, 0.0).unwrap(),
            PhysicalSize::new(1545, 660)
        );
    }

    #[test]
    fn invalid_sizes_are_rejected() {
        for width in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(overlay_dimensions(width, 300.0, 1.0, 1920.0, 1080.0, 0.0).is_err());
        }
        assert!(overlay_dimensions(800.0, 300.0, 1.0, 0.0, 1080.0, 0.0).is_err());
        assert!(overlay_dimensions(1e308, 300.0, 1e308, 1920.0, 1080.0, 0.0).is_err());
        assert!(overlay_dimensions(800.0, 300.0, 1.0, 1920.0, 1080.0, -1.0).is_err());
    }

    #[test]
    fn combo_panel_keeps_keyboard_aspect_ratio_when_fitting() {
        assert_eq!(
            overlay_dimensions(824.0, 552.0, 1.0, 1920.0, 1080.0, 200.0).unwrap(),
            PhysicalSize::new(824, 552)
        );
        assert_eq!(
            overlay_dimensions(824.0, 552.0, 1.0, 1920.0, 402.0, 200.0).unwrap(),
            PhysicalSize::new(424, 402)
        );
    }
}
