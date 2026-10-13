use tauri::WebviewWindow;
use windows_sys::Win32::{
    Foundation::{GetLastError, SetLastError, E_INVALIDARG},
    Graphics::Dwm::{
        DwmSetWindowAttribute, DWMNCRP_DISABLED, DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE,
        DWMWA_NCRENDERING_POLICY,
    },
    UI::WindowsAndMessaging::{
        GetWindowLongPtrW, SetWindowLongPtrW, GWL_EXSTYLE, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
    },
};

pub fn set_overlay_style(window: &WebviewWindow, passive: bool) -> Result<(), String> {
    let hwnd = window.hwnd().map_err(|e| e.to_string())?.0 as _;
    unsafe {
        let style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        let style = if passive {
            style | WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize
        } else {
            style & !(WS_EX_NOACTIVATE as isize | WS_EX_TOOLWINDOW as isize)
        };
        SetLastError(0);
        if SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style) == 0 && GetLastError() != 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let border_result = DwmSetWindowAttribute(
            hwnd,
            DWMWA_BORDER_COLOR as u32,
            (&DWMWA_COLOR_NONE as *const u32).cast(),
            std::mem::size_of::<u32>() as u32,
        );
        // Windows 10 lacks the border-color attribute.
        let result = if border_result == E_INVALIDARG {
            DwmSetWindowAttribute(
                hwnd,
                DWMWA_NCRENDERING_POLICY as u32,
                (&DWMNCRP_DISABLED as *const i32).cast(),
                std::mem::size_of::<i32>() as u32,
            )
        } else {
            border_result
        };
        if result < 0 {
            return Err(format!(
                "Could not remove the overlay frame (HRESULT 0x{:08X}).",
                result as u32
            ));
        }
    }
    Ok(())
}
