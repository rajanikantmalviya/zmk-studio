use blocking::unblock;
use futures::channel::mpsc::{channel, Receiver};
use futures::StreamExt;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_serial::{available_ports, SerialPort, SerialPortBuilderExt, SerialPortType};

use tauri::{command, AppHandle, State};
use tauri_plugin_cli::CliExt;

const READ_BUF_SIZE: usize = 1024;

async fn read_packet<R: AsyncRead + Unpin>(
    reader: &mut R,
    buffer: &mut [u8; READ_BUF_SIZE],
) -> std::io::Result<usize> {
    loop {
        let size = reader.read(buffer).await?;
        if size > 0 {
            return Ok(size);
        }
        // Windows CDC can complete an idle read with zero bytes; this is not EOF.
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
}

async fn write_packets<W: AsyncWrite + Unpin>(
    mut writer: W,
    mut receiver: Receiver<Vec<u8>>,
) -> std::io::Result<()> {
    while let Some(data) = receiver.next().await {
        writer.write_all(&data).await?;
    }
    Ok(())
}

#[command]
pub async fn serial_connect(
    id: String,
    app_handle: AppHandle,
    state: State<'_, super::commands::ActiveConnection<'_>>,
) -> Result<bool, String> {
    match tokio_serial::new(id, 9600).open_native_async() {
        Ok(mut port) => {
            port.write_data_terminal_ready(true)
                .map_err(|error| format!("Could not enable Studio USB port: {error}"))?;
            #[cfg(unix)]
            port.set_exclusive(false)
                .expect("Unable to set serial port exclusive to false");

            let (mut reader, writer) = tokio::io::split(port);

            let ahc = app_handle.clone();
            let (send, recv) = channel(5);
            *state.conn.lock().await = Some(Box::new(send));

            let read_process = tauri::async_runtime::spawn(async move {
                use tauri::Emitter;
                use tauri::Manager;

                let mut buffer = [0; READ_BUF_SIZE];
                let error = loop {
                    match read_packet(&mut reader, &mut buffer).await {
                        Ok(size) => {
                            if let Err(error) = app_handle.emit("connection_data", &buffer[..size])
                            {
                                break Some(format!("Could not deliver Studio USB data: {error}"));
                            }
                        }
                        Err(error) => break Some(format!("Studio USB read failed: {error}")),
                    }
                };

                let state = app_handle.state::<super::commands::ActiveConnection>();
                *state.conn.lock().await = None;

                if let Err(error) = app_handle.emit("connection_disconnected", error) {
                    eprintln!("Could not report Studio USB disconnect: {error}");
                }
            });

            tauri::async_runtime::spawn(async move {
                use tauri::Manager;

                if let Err(error) = write_packets(writer, recv).await {
                    use tauri::Emitter;
                    let message = format!("Studio USB write failed: {error}");
                    if let Err(error) = ahc.emit("connection_disconnected", Some(message)) {
                        eprintln!("Could not report Studio USB write failure: {error}");
                    }
                }

                let state = ahc.state::<super::commands::ActiveConnection>();
                read_process.abort();
                *state.conn.lock().await = None;
            });

            Ok(true)
        }
        Err(e) => Err(format!("Failed to open the serial port: {}", e.description)),
    }
}

#[command]
pub async fn serial_list_devices(
    app_handle: AppHandle,
) -> Result<Vec<super::commands::AvailableDevice>, String> {
    let ports = unblock(|| available_ports())
        .await
        .map_err(|error| format!("Could not list USB serial devices: {error}"))?;

    let mut candidates = ports
        .into_iter()
        .filter_map(|pi| {
            if let SerialPortType::UsbPort(u) = pi.port_type {
                Some(super::commands::AvailableDevice {
                    id: pi.port_name,
                    label: u.product.unwrap_or("Unnamed device".to_string()),
                })
            } else {
                None
            }
        })
        .collect::<Vec<_>>();

    match app_handle.cli().matches() {
        Ok(m) => {
            if let Some(p) = m.args.get("serial-port") {
                if let serde_json::Value::String(path) = &p.value {
                    candidates.push(super::commands::AvailableDevice {
                        id: path.to_string(),
                        label: format!("CLI Port: {path}").to_string(),
                    })
                }
            }
        }
        Err(_) => {}
    }

    Ok(candidates)
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::SinkExt;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::io::AsyncReadExt;

    struct IdleThenData {
        idle_reads: u8,
        fail: bool,
    }

    impl AsyncRead for IdleThenData {
        fn poll_read(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            buffer: &mut tokio::io::ReadBuf<'_>,
        ) -> Poll<std::io::Result<()>> {
            if self.idle_reads > 0 {
                self.idle_reads -= 1;
                return Poll::Ready(Ok(()));
            }
            if self.fail {
                return Poll::Ready(Err(std::io::Error::new(
                    std::io::ErrorKind::BrokenPipe,
                    "disconnected",
                )));
            }
            buffer.put_slice(&[1, 2, 3]);
            Poll::Ready(Ok(()))
        }
    }

    #[test]
    fn idle_zero_byte_reads_do_not_close_serial_rpc() {
        tauri::async_runtime::block_on(async {
            let mut reader = IdleThenData {
                idle_reads: 2,
                fail: false,
            };
            let mut buffer = [0; READ_BUF_SIZE];
            assert_eq!(read_packet(&mut reader, &mut buffer).await.unwrap(), 3);
            assert_eq!(&buffer[..3], &[1, 2, 3]);
        });
    }

    #[test]
    fn serial_read_failures_after_idle_propagate() {
        tauri::async_runtime::block_on(async {
            let mut reader = IdleThenData {
                idle_reads: 1,
                fail: true,
            };
            let mut buffer = [0; READ_BUF_SIZE];
            assert_eq!(
                read_packet(&mut reader, &mut buffer)
                    .await
                    .unwrap_err()
                    .kind(),
                std::io::ErrorKind::BrokenPipe,
            );
        });
    }

    #[test]
    fn packets_survive_partial_serial_writes() {
        tauri::async_runtime::block_on(async {
            let (writer, mut reader) = tokio::io::duplex(3);
            let (mut sender, receiver) = channel(5);
            sender.send(vec![1, 2, 3, 4, 5]).await.unwrap();
            sender.send(vec![6, 7, 8, 9]).await.unwrap();
            drop(sender);
            let task = tauri::async_runtime::spawn(write_packets(writer, receiver));
            let mut bytes = Vec::new();
            reader.read_to_end(&mut bytes).await.unwrap();
            task.await.unwrap().unwrap();
            assert_eq!(bytes, vec![1, 2, 3, 4, 5, 6, 7, 8, 9]);
        });
    }

    #[test]
    fn serial_write_failures_propagate() {
        tauri::async_runtime::block_on(async {
            let (writer, reader) = tokio::io::duplex(3);
            drop(reader);
            let (mut sender, receiver) = channel(5);
            sender.send(vec![1]).await.unwrap();
            drop(sender);
            assert!(write_packets(writer, receiver).await.is_err());
        });
    }
}
