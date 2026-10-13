// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;

use futures::lock::Mutex;
use tauri::Manager;

mod transport;
use transport::commands::{transport_close, transport_send_data, ActiveConnection};

use transport::gatt::{gatt_connect, gatt_list_devices};
use transport::serial::{serial_connect, serial_list_devices};
mod keyboard_overlay;
mod viewer;
mod viewer_window;
#[cfg(windows)]
mod window_style;
use keyboard_overlay::{
    keyboard_overlay_get, keyboard_overlay_pressed, keyboard_overlay_set, KeyboardOverlayState,
};

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_cli::init())
        .manage(ActiveConnection {
            conn: Mutex::new(None),
        })
        .manage(KeyboardOverlayState::default())
        .manage(viewer::ViewerState::default())
        .manage(viewer_window::ViewerWindowState::default())
        .setup(viewer_window::setup)
        .on_window_event(|window, event| {
            viewer_window::window_event(window, event);
            if matches!(event, tauri::WindowEvent::Destroyed) {
                keyboard_overlay::window_destroyed(window.app_handle(), window.label());
                if window.label() == "main" {
                    if let Err(error) = window.app_handle().state::<viewer::ViewerState>().stop() {
                        eprintln!("Could not stop keyboard viewer: {error}");
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            transport_send_data,
            transport_close,
            gatt_list_devices,
            gatt_connect,
            serial_list_devices,
            serial_connect,
            keyboard_overlay_get,
            keyboard_overlay_pressed,
            keyboard_overlay_set,
            viewer::viewer_connect,
            viewer::viewer_disconnect,
            viewer_window::viewer_set_overlay,
            viewer_window::viewer_toggle_display,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
