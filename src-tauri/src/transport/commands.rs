use futures::lock::Mutex;
use futures::Sink;
use futures::SinkExt;

use futures::channel::mpsc::SendError;

use serde::{Deserialize, Serialize};

use tauri::ipc::InvokeBody;
use tauri::{command, ipc::Request, State};

#[derive(Debug, Serialize, Deserialize)]
pub struct AvailableDevice {
    pub label: String,
    pub id: String,
}

#[derive(Debug, Default)]
pub struct ActiveConnection<'a> {
    pub conn: Mutex<Option<Box<dyn Sink<Vec<u8>, Error = SendError> + Unpin + Send + 'a>>>,
}

#[command]
pub async fn transport_send_data(
    req: Request<'_>,
    state: State<'_, ActiveConnection<'_>>,
) -> Result<(), String> {
    if let InvokeBody::Raw(data) = req.body() {
        let mut lock = state.conn.lock().await;

        let sink = lock.as_mut().ok_or("No active keyboard transport.")?;
        sink.send(data.clone())
            .await
            .map_err(|error| error.to_string())?;
        Ok(())
    } else {
        Err("Keyboard transport requires a binary payload.".into())
    }
}

#[command]
pub async fn transport_close(state: State<'_, ActiveConnection<'_>>) -> Result<(), ()> {
    *state.conn.lock().await = None;

    Ok(())
}
