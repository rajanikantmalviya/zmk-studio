use serde::Serialize;
use serde_json::Value;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio_serial::{SerialPort, SerialPortBuilderExt};

#[derive(Default)]
pub struct ViewerState {
    task: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
    generation: AtomicU64,
}

impl ViewerState {
    pub fn stop(&self) -> Result<(), String> {
        let mut active_task = self.task.lock().map_err(|e| e.to_string())?;
        self.generation.fetch_add(1, Ordering::SeqCst);
        if let Some(task) = active_task.take() {
            task.abort();
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewerHandshake {
    connection_id: u64,
    frames: Vec<Value>,
    initial_state: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerEvent {
    connection_id: u64,
    state: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewerDisconnected {
    connection_id: u64,
    error: String,
}

async fn discard_stale_input<R: AsyncRead + Unpin>(reader: &mut R) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(3), async {
        let mut buffer = [0; 1024];
        let mut total = 0;
        loop {
            match tokio::time::timeout(Duration::from_millis(50), reader.read(&mut buffer)).await {
                Err(_) => return Ok(()),
                Ok(Err(error)) => return Err(format!("Could not drain viewer port: {error}")),
                Ok(Ok(0)) => return Ok(()),
                Ok(Ok(size)) => {
                    total += size;
                    if total > 131072 {
                        return Err("Viewer input did not settle before connecting.".into());
                    }
                }
            }
        }
    })
    .await
    .map_err(|_| "Viewer input did not settle before connecting.".to_string())?
}

async fn open_viewer_port(id: &str) -> Result<tokio_serial::SerialStream, String> {
    let mut port = tokio_serial::new(id, 115200)
        .open_native_async()
        .map_err(|e| format!("Could not open {id}: {e}"))?;
    port.write_data_terminal_ready(true)
        .map_err(|e| format!("Could not enable viewer port: {e}"))?;
    // Read stale bytes instead of clearing: Windows PurgeComm cancels pending async reads.
    discard_stale_input(&mut port).await?;
    Ok(port)
}

async fn read_frame<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let size = tokio::time::timeout(
        Duration::from_secs(3),
        (&mut *reader).take(8193).read_until(b'\n', &mut bytes),
    )
    .await
    .map_err(|_| {
        "Viewer response timed out. Select the viewer USB port and flash viewer-enabled firmware."
            .to_string()
    })?
    .map_err(|e| format!("Could not read viewer port: {e}"))?;
    if size == 0 {
        return Err("Keyboard viewer USB connection closed.".into());
    }
    if size > 8192 || bytes.last() != Some(&b'\n') {
        return Err("Invalid or oversized viewer response.".into());
    }
    let value: Value =
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid viewer response: {e}"))?;
    if value["type"] == "error" {
        return Err(value["message"]
            .as_str()
            .unwrap_or("Firmware reported a viewer error.")
            .into());
    }
    Ok(value)
}

#[tauri::command]
pub fn viewer_disconnect(state: State<'_, ViewerState>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
pub async fn viewer_connect(
    id: String,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<ViewerHandshake, String> {
    state.stop()?;
    let connection_id = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let port = open_viewer_port(&id).await?;
    let (reader, mut writer) = tokio::io::split(port);
    let mut reader = BufReader::new(reader);
    writer.write_all(b"C").await.map_err(|e| e.to_string())?;
    let mut frames = Vec::new();
    let mut total = 0;
    loop {
        let frame = read_frame(&mut reader).await?;
        if frame["type"] == "ready" {
            frames.push(frame);
            break;
        }
        total += frame.to_string().len();
        if frames.len() >= 512 || total > 131072 {
            return Err("Viewer configuration exceeds supported size.".into());
        }
        frames.push(frame);
    }
    writer.write_all(b"S").await.map_err(|e| e.to_string())?;
    let initial_state = read_frame(&mut reader).await?;
    if initial_state["type"] != "state" {
        return Err("Unexpected initial keyboard viewer state.".into());
    }
    let mut active_task = state.task.lock().map_err(|e| e.to_string())?;
    if state.generation.load(Ordering::SeqCst) != connection_id {
        return Err("Viewer connection was canceled.".into());
    }
    let task = tauri::async_runtime::spawn(async move {
        let mut previous = Value::Null;
        let result: Result<(), String> = async {
            loop {
                writer.write_all(b"S").await.map_err(|e| e.to_string())?;
                let snapshot = read_frame(&mut reader).await?;
                if snapshot["type"] != "state" {
                    return Err("Unexpected keyboard viewer state response.".into());
                }
                if snapshot != previous {
                    app.emit(
                        "viewer-state",
                        ViewerEvent {
                            connection_id,
                            state: snapshot.clone(),
                        },
                    )
                    .map_err(|e| format!("Could not update viewer: {e}"))?;
                    previous = snapshot;
                }
                tokio::time::sleep(Duration::from_millis(25)).await;
            }
        }
        .await;
        if let Err(error) = result {
            eprintln!("Keyboard viewer: {error}");
            if let Err(e) = app.emit(
                "viewer-disconnected",
                ViewerDisconnected {
                    connection_id,
                    error,
                },
            ) {
                eprintln!("Could not report viewer disconnect: {e}");
            }
        }
    });
    *active_task = Some(task);
    Ok(ViewerHandshake {
        connection_id,
        frames,
        initial_state,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_drains_stale_bytes_without_consuming_new_responses() {
        tauri::async_runtime::block_on(async {
            let (mut reader, mut writer) = tokio::io::duplex(1024);
            writer.write_all(b"partial stale response\n").await.unwrap();
            discard_stale_input(&mut reader).await.unwrap();
            writer.write_all(b"{\"type\":\"ready\"}\n").await.unwrap();
            assert_eq!(
                read_frame(&mut BufReader::new(reader)).await.unwrap()["type"],
                "ready"
            );

            let bytes = vec![b'x'; 131073];
            assert!(discard_stale_input(&mut bytes.as_slice())
                .await
                .unwrap_err()
                .contains("did not settle"));
            discard_stale_input(&mut &b""[..]).await.unwrap();
        });
    }

    #[test]
    #[ignore = "Requires viewer-enabled hardware and ZMK_VIEWER_PORT"]
    fn hardware_handshake_polling_and_reconnect() {
        let id = std::env::var("ZMK_VIEWER_PORT").expect("Set ZMK_VIEWER_PORT to the viewer port");
        tauri::async_runtime::block_on(async {
            for _ in 0..3 {
                {
                    let port = open_viewer_port(&id).await.unwrap();
                    let (reader, mut writer) = tokio::io::split(port);
                    let mut reader = BufReader::new(reader);
                    writer.write_all(b"C").await.unwrap();
                    let mut frames = Vec::new();
                    loop {
                        let frame = read_frame(&mut reader).await.unwrap();
                        let ready = frame["type"] == "ready";
                        frames.push(frame);
                        assert!(frames.len() <= 512, "Configuration did not finish");
                        if ready {
                            break;
                        }
                    }
                    assert_eq!(frames[0]["type"], "hello");
                    assert_eq!(frames[0]["version"], 1);
                    assert!(frames.iter().any(|frame| frame["type"] == "key"));
                    assert!(frames.iter().any(|frame| frame["type"] == "layer"));
                    for _ in 0..4 {
                        writer.write_all(b"S").await.unwrap();
                        let snapshot = read_frame(&mut reader).await.unwrap();
                        assert_eq!(snapshot["type"], "state");
                        tokio::time::sleep(Duration::from_millis(25)).await;
                    }
                }
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
        });
    }

    #[test]
    fn frames_are_bounded_and_preserve_following_responses() {
        tauri::async_runtime::block_on(async {
            let mut reader =
                BufReader::new(&b"{\"type\":\"ready\"}\n{\"type\":\"state\",\"sequence\":2}\n"[..]);
            assert_eq!(read_frame(&mut reader).await.unwrap()["type"], "ready");
            assert_eq!(read_frame(&mut reader).await.unwrap()["sequence"], 2);
            assert!(read_frame(&mut reader)
                .await
                .unwrap_err()
                .contains("closed"));
            let bytes = vec![b'x'; 8193];
            let mut oversized = BufReader::new(bytes.as_slice());
            assert!(read_frame(&mut oversized)
                .await
                .unwrap_err()
                .contains("oversized"));
        });
    }

    #[test]
    fn malformed_and_firmware_error_responses_are_explicit_errors() {
        tauri::async_runtime::block_on(async {
            let mut malformed = BufReader::new(&b"not json\n"[..]);
            assert!(read_frame(&mut malformed)
                .await
                .unwrap_err()
                .contains("Invalid"));
            let mut locked =
                BufReader::new(&b"{\"type\":\"error\",\"message\":\"Unlock the keyboard\"}\n"[..]);
            assert_eq!(
                read_frame(&mut locked).await.unwrap_err(),
                "Unlock the keyboard"
            );
            let mut truncated = BufReader::new(&b"{\"type\":\"state\"}"[..]);
            assert!(read_frame(&mut truncated)
                .await
                .unwrap_err()
                .contains("Invalid"));
        });
    }
}
