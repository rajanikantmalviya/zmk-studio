use bluest::{Adapter, Characteristic, DeviceId};
use futures::StreamExt;
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
use tokio::io::{
    AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWriteExt, BufReader, WriteHalf,
};
use tokio_serial::{SerialPort, SerialPortBuilderExt};
use uuid::Uuid;

const VIEWER_SERVICE: Uuid = Uuid::from_u128(0x00000010_0196_6107_c967_c5cfb1c2482a);
const VIEWER_COMMAND: Uuid = Uuid::from_u128(0x00000011_0196_6107_c967_c5cfb1c2482a);
const VIEWER_DATA: Uuid = Uuid::from_u128(0x00000012_0196_6107_c967_c5cfb1c2482a);

enum ViewerWriter {
    Serial(WriteHalf<tokio_serial::SerialStream>),
    Bluetooth(Characteristic),
}

impl ViewerWriter {
    async fn command(&mut self, command: &[u8]) -> Result<(), String> {
        match self {
            Self::Serial(writer) => writer
                .write_all(command)
                .await
                .map_err(|error| format!("Could not write viewer USB command: {error}")),
            Self::Bluetooth(characteristic) => {
                tokio::time::timeout(Duration::from_secs(10), characteristic.write(command))
                    .await
                    .map_err(|_| "Bluetooth viewer command timed out.".to_string())?
                    .map_err(|error| format!("Could not write viewer Bluetooth command: {error}"))
            }
        }
    }
}

struct NotificationPump(tauri::async_runtime::JoinHandle<()>);

impl Drop for NotificationPump {
    fn drop(&mut self) {
        self.0.abort();
    }
}

struct ViewerConnection {
    reader: Box<dyn AsyncBufRead + Send + Unpin>,
    writer: ViewerWriter,
    pump: Option<NotificationPump>,
    wireless: bool,
}

#[derive(Serialize)]
pub struct ViewerDevice {
    id: String,
    label: String,
}

#[tauri::command]
pub async fn viewer_ble_list_devices() -> Result<Vec<ViewerDevice>, String> {
    tokio::time::timeout(Duration::from_secs(10), async {
        let adapter = Adapter::default()
            .await
            .ok_or("No Bluetooth adapter is available.")?;
        tokio::time::timeout(Duration::from_secs(5), adapter.wait_available())
            .await
            .map_err(|_| "Bluetooth adapter did not become available.".to_string())?
            .map_err(|error| format!("Could not access Bluetooth: {error}"))?;
        // Connected HID keyboards may not advertise the optional viewer service.
        // Bluest's Windows discover_devices path requires a nonempty service filter.
        let devices = adapter
            .connected_devices()
            .await
            .map_err(|error| format!("Could not discover Bluetooth keyboards: {error}"))?;
        let mut available = Vec::new();
        for device in devices {
            if !device.is_connected().await {
                continue;
            }
            let label = device
                .name_async()
                .await
                .map_err(|error| format!("Could not read Bluetooth device name: {error}"))?;
            let id = serde_json::to_string(&device.id()).map_err(|error| error.to_string())?;
            if !available.iter().any(|entry: &ViewerDevice| entry.id == id) {
                available.push(ViewerDevice { id, label });
            }
        }
        Ok(available)
    })
    .await
    .map_err(|_| "Bluetooth keyboard discovery timed out.".to_string())?
}

async fn open_bluetooth(
    id: &str,
    app: AppHandle,
    connection_id: u64,
) -> Result<ViewerConnection, String> {
    let adapter = Adapter::default()
        .await
        .ok_or("No Bluetooth adapter is available.")?;
    tokio::time::timeout(Duration::from_secs(5), adapter.wait_available())
        .await
        .map_err(|_| "Bluetooth adapter did not become available.".to_string())?
        .map_err(|error| format!("Could not access Bluetooth: {error}"))?;
    let id: DeviceId = serde_json::from_str(id)
        .map_err(|error| format!("Invalid Bluetooth viewer device: {error}"))?;
    let device = adapter
        .open_device(&id)
        .await
        .map_err(|error| format!("Could not open Bluetooth keyboard: {error}"))?;
    if !device.is_connected().await {
        tokio::time::timeout(Duration::from_secs(10), adapter.connect_device(&device))
            .await
            .map_err(|_| "Bluetooth keyboard connection timed out.".to_string())?
            .map_err(|error| format!("Could not connect Bluetooth keyboard: {error}"))?;
    }
    let service = tokio::time::timeout(Duration::from_secs(10), device.discover_services_with_uuid(VIEWER_SERVICE)).await
        .map_err(|_| "Bluetooth viewer service discovery timed out.".to_string())?
        .map_err(|error| format!("Could not discover Bluetooth viewer service: {error}"))?
        .into_iter().next().ok_or("Keyboard has no Bluetooth viewer service. Flash viewer-enabled BLE firmware and refresh Windows' Bluetooth service cache.")?;
    let command = service
        .discover_characteristics_with_uuid(VIEWER_COMMAND)
        .await
        .map_err(|error| format!("Could not discover viewer command characteristic: {error}"))?
        .into_iter()
        .next()
        .ok_or("Bluetooth viewer command characteristic is missing.")?;
    let data = service
        .discover_characteristics_with_uuid(VIEWER_DATA)
        .await
        .map_err(|error| format!("Could not discover viewer data characteristic: {error}"))?
        .into_iter()
        .next()
        .ok_or("Bluetooth viewer data characteristic is missing.")?;
    let (reader, mut incoming) = tokio::io::duplex(32768);
    let (ready, subscribed) = tokio::sync::oneshot::channel();
    let task = tauri::async_runtime::spawn(async move {
        // Keep the adapter and subscription alive without disconnecting the shared HID link.
        let _adapter = adapter;
        let result: Result<(), String> = async {
            let mut notifications = match data.notify().await {
                Ok(stream) => stream,
                Err(error) => {
                    let message = format!("Could not subscribe to Bluetooth viewer: {error}");
                    let _ = ready.send(Err(message.clone()));
                    return Err(message);
                }
            };
            if ready.send(Ok(())).is_err() {
                return Ok(());
            }
            while let Some(bytes) = notifications.next().await {
                let bytes = bytes
                    .map_err(|error| format!("Bluetooth viewer notifications failed: {error}"))?;
                incoming
                    .write_all(&bytes)
                    .await
                    .map_err(|error| format!("Could not buffer Bluetooth viewer data: {error}"))?;
            }
            Err("Bluetooth viewer notification stream closed.".into())
        }
        .await;
        if let Err(error) = result {
            eprintln!("Keyboard viewer: {error}");
            if let Err(emit_error) = app.emit(
                "viewer-disconnected",
                ViewerDisconnected {
                    connection_id,
                    error,
                },
            ) {
                eprintln!("Could not report Bluetooth viewer error: {emit_error}");
            }
        }
    });
    let pump = NotificationPump(task);
    tokio::time::timeout(Duration::from_secs(10), subscribed)
        .await
        .map_err(|_| "Bluetooth viewer subscription timed out.".to_string())?
        .map_err(|error| format!("Bluetooth viewer subscription canceled: {error}"))??;
    Ok(ViewerConnection {
        reader: Box::new(BufReader::new(reader)),
        writer: ViewerWriter::Bluetooth(command),
        pump: Some(pump),
        wireless: true,
    })
}

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

#[derive(Clone, Serialize)]
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
    read_frame_with_timeout(reader, Some(Duration::from_secs(10))).await
}

async fn read_frame_with_timeout<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    timeout: Option<Duration>,
) -> Result<Value, String> {
    let mut bytes = Vec::new();
    let mut limited = (&mut *reader).take(8193);
    let read = limited.read_until(b'\n', &mut bytes);
    let size = if let Some(duration) = timeout {
        tokio::time::timeout(duration, read).await.map_err(|_| {
            "Viewer response timed out. Select the viewer interface and flash matching firmware.".to_string()
        })?
    } else {
        read.await
    }.map_err(|e| format!("Could not read viewer interface: {e}"))?;
    if size == 0 {
        return Err("Keyboard viewer connection closed.".into());
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

async fn read_stream_frame<R, F>(
    reader: &mut R,
    heartbeat: F,
    idle_timeout: Duration,
) -> Result<Value, String>
where
    R: AsyncBufRead + Unpin,
    F: std::future::Future<Output = Result<(), String>>,
{
    // Keep a partially received frame alive while checking a quiet BLE session.
    let read = read_frame_with_timeout(reader, None);
    tokio::pin!(read);
    let idle = tokio::time::sleep(idle_timeout);
    tokio::pin!(idle);
    match futures::future::select(&mut read, &mut idle).await {
        futures::future::Either::Left((result, _)) => result,
        futures::future::Either::Right(_) => {
            heartbeat.await?;
            tokio::time::timeout(Duration::from_secs(3), &mut read)
                .await
                .map_err(|_| "Bluetooth viewer stopped responding. Reconnect the keyboard.".to_string())?
        }
    }
}

async fn read_configuration<R: AsyncBufRead + Unpin>(reader: &mut R) -> Result<Vec<Value>, String> {
    tokio::time::timeout(Duration::from_secs(30), read_configuration_frames(reader))
        .await
        .map_err(|_| "Viewer configuration transfer timed out.".to_string())?
}

async fn read_configuration_frames<R: AsyncBufRead + Unpin>(
    reader: &mut R,
) -> Result<Vec<Value>, String> {
    let mut frames = Vec::new();
    let mut total = 0;
    loop {
        let frame = read_frame(reader).await?;
        total += frame.to_string().len();
        if frames.len() >= 512 || total > 131072 {
            return Err("Viewer configuration exceeds supported size.".into());
        }
        let ready = frame["type"] == "ready";
        // In-flight BLE state notifications may precede a newly requested configuration.
        if frame["type"] != "state" {
            frames.push(frame);
        }
        if ready {
            return Ok(frames);
        }
    }
}

fn configuration_revision(frames: &[Value], state: &Value) -> Value {
    frames
        .iter()
        .find(|frame| frame["type"] == "capabilities" && !frame["configRevision"].is_null())
        .map(|frame| frame["configRevision"].clone())
        .unwrap_or_else(|| state["configRevision"].clone())
}

#[tauri::command]
pub fn viewer_disconnect(state: State<'_, ViewerState>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
pub async fn viewer_connect(
    id: String,
    transport: Option<String>,
    app: AppHandle,
    state: State<'_, ViewerState>,
) -> Result<ViewerHandshake, String> {
    state.stop()?;
    let connection_id = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let connection = match transport.as_deref().unwrap_or("usb") {
        "usb" => {
            let port = open_viewer_port(&id).await?;
            let (reader, writer) = tokio::io::split(port);
            ViewerConnection {
                reader: Box::new(BufReader::new(reader)),
                writer: ViewerWriter::Serial(writer),
                pump: None,
                wireless: false,
            }
        }
        "ble" => open_bluetooth(&id, app.clone(), connection_id).await?,
        _ => return Err("Unknown viewer transport.".into()),
    };
    let ViewerConnection {
        mut reader,
        mut writer,
        pump,
        wireless,
    } = connection;
    writer.command(b"C").await?;
    let frames = read_configuration(&mut reader).await?;
    writer.command(b"S").await?;
    let initial_state = read_frame(&mut reader).await?;
    if initial_state["type"] != "state" {
        return Err("Unexpected initial keyboard viewer state.".into());
    }
    let revision = configuration_revision(&frames, &initial_state);
    if wireless {
        let streaming = frames
            .iter()
            .any(|frame| frame["type"] == "capabilities" && frame["bleStreaming"] == true);
        if !streaming {
            return Err(
                "Bluetooth viewer firmware does not support event-driven streaming.".into(),
            );
        }
        writer.command(b"E").await?;
    }
    let mut active_task = state.task.lock().map_err(|e| e.to_string())?;
    if state.generation.load(Ordering::SeqCst) != connection_id {
        return Err("Viewer connection was canceled.".into());
    }
    let initial_snapshot = initial_state.clone();
    let task = tauri::async_runtime::spawn(async move {
        let _pump = pump;
        let mut previous = Value::Null;
        let mut revision = revision;
        let mut pending_snapshot = Some(initial_snapshot);
        let result: Result<(), String> = async {
            loop {
                let mut snapshot = if let Some(snapshot) = pending_snapshot.take() {
                    snapshot
                } else {
                    if !wireless {
                        writer.command(b"S").await?;
                    }
                    if wireless {
                        read_stream_frame(
                            &mut reader,
                            async { writer.command(b"E").await },
                            Duration::from_secs(5),
                        )
                        .await?
                    } else {
                        read_frame_with_timeout(&mut reader, Some(Duration::from_secs(3))).await?
                    }
                };
                if snapshot["type"] != "state" {
                    return Err("Unexpected keyboard viewer state response.".into());
                }
                if !snapshot["configRevision"].is_null() && snapshot["configRevision"] != revision {
                    writer.command(b"C").await?;
                    let frames = read_configuration(&mut reader).await?;
                    writer.command(b"S").await?;
                    snapshot = read_frame(&mut reader).await?;
                    if snapshot["type"] != "state" {
                        return Err("Unexpected refreshed keyboard viewer state.".into());
                    }
                    revision = configuration_revision(&frames, &snapshot);
                    if !snapshot["configRevision"].is_null()
                        && snapshot["configRevision"] != revision
                    {
                        pending_snapshot = Some(snapshot.clone());
                    }
                    app.emit(
                        "viewer-configuration",
                        ViewerHandshake {
                            connection_id,
                            frames,
                            initial_state: snapshot.clone(),
                        },
                    )
                    .map_err(|error| format!("Could not refresh viewer configuration: {error}"))?;
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
                if !wireless {
                    tokio::time::sleep(Duration::from_millis(25)).await;
                }
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
    fn revision_tracks_configuration_not_a_newer_state() {
        let frames = vec![
            serde_json::json!({"type":"capabilities","configRevision":4}),
            serde_json::json!({"type":"ready"}),
        ];
        let state = serde_json::json!({"type":"state","configRevision":5});
        assert_eq!(configuration_revision(&frames, &state), 4);
        assert_ne!(
            configuration_revision(&frames, &state),
            state["configRevision"]
        );
        let refreshed = vec![serde_json::json!({"type":"capabilities","configRevision":5})];
        assert_eq!(
            configuration_revision(&refreshed, &state),
            state["configRevision"]
        );
    }

    #[test]
    fn legacy_revision_falls_back_to_state_and_keeps_zero() {
        let state = serde_json::json!({"type":"state","configRevision":5});
        assert_eq!(configuration_revision(&[], &state), 5);
        let frames = vec![serde_json::json!({"type":"capabilities","configRevision":0})];
        assert_eq!(configuration_revision(&frames, &state), 0);
        assert!(configuration_revision(&[], &serde_json::json!({"type":"state"})).is_null());
    }

    #[test]
    fn bluetooth_fragments_preserve_frames_and_skip_inflight_states_during_reload() {
        tauri::async_runtime::block_on(async {
            let (reader, mut writer) = tokio::io::duplex(64);
            let task = tauri::async_runtime::spawn(async move {
                for bytes in [
                    &b"{\"type\":\"state\",\"sequence\":1}\n{\"ty"[..],
                    &b"pe\":\"hello\",\"version\":1}\n{\"type\":\"ready\"}\n"[..],
                ] {
                    writer.write_all(bytes).await.unwrap();
                }
            });
            let frames = read_configuration(&mut BufReader::new(reader))
                .await
                .unwrap();
            assert_eq!(frames.len(), 2);
            assert_eq!(frames[0]["type"], "hello");
            assert_eq!(frames[1]["type"], "ready");
            task.await.unwrap();
        });
    }

    #[test]
    fn quiet_bluetooth_stream_does_not_trigger_a_polling_timeout() {
        tauri::async_runtime::block_on(async {
            let (reader, mut writer) = tokio::io::duplex(128);
            let task = tauri::async_runtime::spawn(async move {
                tokio::time::sleep(Duration::from_millis(30)).await;
                writer
                    .write_all(b"{\"type\":\"state\",\"sequence\":2}\n")
                    .await
                    .unwrap();
            });
            let frame = read_frame_with_timeout(&mut BufReader::new(reader), None)
                .await
                .unwrap();
            assert_eq!(frame["sequence"], 2);
            task.await.unwrap();
        });
    }

    #[test]
    fn active_stream_does_not_send_a_heartbeat() {
        tauri::async_runtime::block_on(async {
            let mut reader = &b"{\"type\":\"state\",\"sequence\":3}\n"[..];
            let frame = read_stream_frame(
                &mut reader,
                async { panic!("Active streams must remain event-driven") },
                Duration::from_millis(10),
            )
            .await
            .unwrap();
            assert_eq!(frame["sequence"], 3);
        });
    }

    #[test]
    fn quiet_stream_heartbeat_recovers_without_losing_partial_frames() {
        tauri::async_runtime::block_on(async {
            let (reader, mut writer) = tokio::io::duplex(128);
            writer.write_all(b"{\"type\":\"state\",\"seq").await.unwrap();
            let frame = read_stream_frame(
                &mut BufReader::new(reader),
                async {
                    writer.write_all(b"uence\":4}\n").await.unwrap();
                    Ok(())
                },
                Duration::from_millis(10),
            )
            .await
            .unwrap();
            assert_eq!(frame["sequence"], 4);
        });
    }

    #[test]
    fn quiet_stream_reports_failed_heartbeat() {
        tauri::async_runtime::block_on(async {
            let (reader, _writer) = tokio::io::duplex(128);
            let error = read_stream_frame(
                &mut BufReader::new(reader),
                async { Err("Keyboard disconnected".to_string()) },
                Duration::from_millis(10),
            )
            .await
            .unwrap_err();
            assert_eq!(error, "Keyboard disconnected");
        });
    }

    #[test]
    fn stalled_frame_reads_are_explicit_errors() {
        tauri::async_runtime::block_on(async {
            let (reader, _writer) = tokio::io::duplex(128);
            assert!(read_frame_with_timeout(
                &mut BufReader::new(reader),
                Some(Duration::from_millis(10)),
            )
            .await
            .unwrap_err()
            .contains("timed out"));
        });
    }

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
