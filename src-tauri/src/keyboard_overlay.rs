use serde::{Deserialize, Serialize};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use tauri::{AppHandle, Emitter, Manager, State};

#[path = "keyboard_overlay/key_codes.rs"]
mod key_codes;
#[cfg(target_os = "windows")]
#[path = "keyboard_overlay/windows.rs"]
mod windows;

const WINDOW_LABEL: &str = "keyboard-overlay";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayKey {
    position: u32,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    r: f64,
    rx: f64,
    ry: f64,
    label: String,
    behavior: String,
    outputs: Vec<u32>,
    trainable: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayLayer {
    id: u32,
    name: String,
    keys: Vec<OverlayKey>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
enum LearningMode {
    FindKey,
    LayerDrill,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LearningRequest {
    session_id: String,
    mode: LearningMode,
    count: u32,
    hints: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OverlayConfiguration {
    #[serde(default)]
    revision: u64,
    #[serde(default = "default_size_percent")]
    size_percent: u32,
    device_name: String,
    layers: Vec<OverlayLayer>,
    displayed_layer_id: u32,
    learning: Option<LearningRequest>,
}

fn default_size_percent() -> u32 {
    120
}

#[derive(Default)]
pub struct KeyboardOverlayState {
    config: Mutex<Option<OverlayConfiguration>>,
    revision: AtomicU64,
    #[cfg(target_os = "windows")]
    monitor: Mutex<Option<windows::InputMonitor>>,
}

#[derive(Serialize)]
pub struct OutputKeyState {
    pressed: Vec<u32>,
    sequence: u64,
}

impl KeyboardOverlayState {
    fn stop_input(&self) -> Result<(), String> {
        *self.config.lock().map_err(|e| e.to_string())? = None;
        #[cfg(target_os = "windows")]
        {
            let mut monitor = self.monitor.lock().map_err(|e| e.to_string())?;
            if let Some(input) = monitor.as_mut() {
                input.stop()?;
            }
            *monitor = None;
        }
        Ok(())
    }

    pub fn stop(&self, app: &AppHandle) -> Result<(), String> {
        self.stop_input()?;
        if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
            window.close().map_err(|e| e.to_string())?;
        }
        Ok(())
    }
}

fn validate(config: &OverlayConfiguration) -> Result<(), String> {
    if config.size_percent < 10 || config.size_percent % 10 != 0 {
        return Err("Keyboard size must be at least 10%, in increments of 10%.".into());
    }
    if !config
        .layers
        .iter()
        .any(|l| l.id == config.displayed_layer_id)
    {
        return Err("Select an available layer before enabling the overlay.".into());
    }
    for layer in &config.layers {
        if layer.keys.is_empty() {
            return Err("The keyboard has no physical keys to display.".into());
        }
        for key in &layer.keys {
            if ![key.x, key.y, key.width, key.height, key.r, key.rx, key.ry]
                .iter()
                .all(|n| n.is_finite())
                || key.width <= 0.0
                || key.height <= 0.0
            {
                return Err("The keyboard layout has invalid key geometry.".into());
            }
        }
    }
    if let Some(learning) = &config.learning {
        if learning.count == 0 || learning.count > 100 {
            return Err("Learning sessions must contain between 1 and 100 prompts.".into());
        }
    }
    Ok(())
}

#[tauri::command]
pub fn keyboard_overlay_get(
    state: State<'_, KeyboardOverlayState>,
) -> Result<Option<OverlayConfiguration>, String> {
    Ok(state.config.lock().map_err(|e| e.to_string())?.clone())
}

#[tauri::command]
pub fn keyboard_overlay_pressed(
    state: State<'_, KeyboardOverlayState>,
) -> Result<OutputKeyState, String> {
    #[cfg(target_os = "windows")]
    {
        let monitor = state.monitor.lock().map_err(|e| e.to_string())?;
        match monitor.as_ref() {
            Some(input) => input.pressed(),
            None => Ok(OutputKeyState {
                pressed: Vec::new(),
                sequence: 0,
            }),
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = state;
        Err("Windows key observation is not available on this platform.".into())
    }
}

#[tauri::command]
pub async fn keyboard_overlay_set(
    app: AppHandle,
    state: State<'_, KeyboardOverlayState>,
    config: Option<OverlayConfiguration>,
) -> Result<(), String> {
    let Some(mut config) = config else {
        return state.stop(&app);
    };
    validate(&config)?;
    #[cfg(not(target_os = "windows"))]
    {
        Err("The desktop keyboard overlay is currently supported on Windows only.".into())
    }
    #[cfg(target_os = "windows")]
    {
        config.revision = state.revision.fetch_add(1, Ordering::SeqCst) + 1;
        *state.config.lock().map_err(|e| e.to_string())? = Some(config.clone());
        let enable = || -> Result<(), String> {
            let mut monitor = state.monitor.lock().map_err(|e| e.to_string())?;
            if monitor.is_none() {
                *monitor = Some(windows::InputMonitor::start(app.clone())?);
            }
            drop(monitor);
            windows::show_overlay(&app, config.size_percent)?;
            app.emit_to(WINDOW_LABEL, "keyboard-overlay-config", config)
                .map_err(|e| e.to_string())
        };
        if let Err(error) = enable() {
            return match state.stop(&app) {
                Ok(()) => Err(error),
                Err(cleanup) => Err(format!(
                    "{error}; disabling the overlay also failed: {cleanup}"
                )),
            };
        }
        Ok(())
    }
}

pub fn window_destroyed(app: &AppHandle, label: &str) {
    if label != "main" && label != WINDOW_LABEL {
        return;
    }
    let state = app.state::<KeyboardOverlayState>();
    let result = if label == WINDOW_LABEL {
        state.stop_input()
    } else {
        state.stop(app)
    };
    if let Err(error) = result {
        eprintln!("Could not stop keyboard overlay: {error}");
    }
    if label == WINDOW_LABEL {
        if let Err(error) = app.emit_to("main", "keyboard-overlay-closed", ()) {
            eprintln!("Could not notify Studio that the overlay closed: {error}");
        }
    }
}
