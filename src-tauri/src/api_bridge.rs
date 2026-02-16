use crate::api_types::{BridgeResponse, StateChangeNotification};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::oneshot;

pub struct BridgeResult {
    pub result: Option<serde_json::Value>,
    pub error: Option<String>,
}

struct PendingInner {
    pending: Mutex<HashMap<String, oneshot::Sender<BridgeResult>>>,
}

#[derive(Clone)]
pub struct ApiPendingRequests {
    inner: Arc<PendingInner>,
}

impl Default for ApiPendingRequests {
    fn default() -> Self {
        Self {
            inner: Arc::new(PendingInner {
                pending: Mutex::new(HashMap::new()),
            }),
        }
    }
}

impl ApiPendingRequests {
    pub fn insert(&self, request_id: String, tx: oneshot::Sender<BridgeResult>) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.insert(request_id, tx);
        }
    }

    pub fn resolve(&self, request_id: &str, result: BridgeResult) -> bool {
        if let Ok(mut pending) = self.inner.pending.lock() {
            if let Some(tx) = pending.remove(request_id) {
                let _ = tx.send(result);
                return true;
            }
        }
        false
    }

    pub fn cancel(&self, request_id: &str) {
        if let Ok(mut pending) = self.inner.pending.lock() {
            pending.remove(request_id);
        }
    }
}

#[derive(Clone)]
pub struct ApiEventBus {
    inner: Arc<ApiEventBusInner>,
}

struct ApiEventBusInner {
    sender: tokio::sync::broadcast::Sender<StateChangeNotification>,
}

impl Default for ApiEventBus {
    fn default() -> Self {
        let (sender, _) = tokio::sync::broadcast::channel(256);
        Self {
            inner: Arc::new(ApiEventBusInner { sender }),
        }
    }
}

impl ApiEventBus {
    pub fn sender(&self) -> &tokio::sync::broadcast::Sender<StateChangeNotification> {
        &self.inner.sender
    }
}

// ── Tauri commands called by the frontend bridge ──

#[tauri::command]
pub fn api_respond(
    state: tauri::State<'_, ApiPendingRequests>,
    response: BridgeResponse,
) {
    state.resolve(
        &response.request_id,
        BridgeResult {
            result: response.result,
            error: response.error,
        },
    );
}

#[tauri::command]
pub fn api_notify_state_change(
    state: tauri::State<'_, ApiEventBus>,
    notification: StateChangeNotification,
) {
    let _ = state.sender().send(notification);
}
