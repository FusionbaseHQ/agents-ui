use crate::api_bridge::ApiEventBus;
use crate::api_discovery;
use crate::api_handlers::HandlerContext;
use crate::api_types::*;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use tauri::{Listener, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixListener;
use tokio::sync::{broadcast, mpsc, Mutex};

const MAX_CONNECTIONS: usize = 10;
const MAX_SUBSCRIPTIONS_PER_CONN: usize = 20;

// Rate limit buckets
const READ_RATE: u64 = 100;
const READ_BURST: u64 = 200;
const WRITE_RATE: u64 = 30;
const WRITE_BURST: u64 = 60;
const TERMINAL_RATE: u64 = 500;
const TERMINAL_BURST: u64 = 1000;

struct RateLimiter {
    tokens: f64,
    max_tokens: f64,
    refill_rate: f64,
    last_refill: Instant,
}

impl RateLimiter {
    fn new(rate: u64, burst: u64) -> Self {
        Self {
            tokens: burst as f64,
            max_tokens: burst as f64,
            refill_rate: rate as f64,
            last_refill: Instant::now(),
        }
    }

    fn try_consume(&mut self) -> bool {
        let now = Instant::now();
        let elapsed = now.duration_since(self.last_refill).as_secs_f64();
        self.tokens = (self.tokens + elapsed * self.refill_rate).min(self.max_tokens);
        self.last_refill = now;

        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
}

struct ConnectionState {
    authenticated: bool,
    session_id: String,
    auth_failures: u32,
    subscriptions: HashMap<String, Subscription>,
    rate_read: RateLimiter,
    rate_write: RateLimiter,
    rate_terminal: RateLimiter,
}

impl ConnectionState {
    fn new() -> Self {
        Self {
            authenticated: false,
            session_id: String::new(),
            auth_failures: 0,
            subscriptions: HashMap::new(),
            rate_read: RateLimiter::new(READ_RATE, READ_BURST),
            rate_write: RateLimiter::new(WRITE_RATE, WRITE_BURST),
            rate_terminal: RateLimiter::new(TERMINAL_RATE, TERMINAL_BURST),
        }
    }

    fn check_rate(&mut self, category: RateCategory) -> bool {
        match category {
            RateCategory::Read => self.rate_read.try_consume(),
            RateCategory::Write => self.rate_write.try_consume(),
            RateCategory::TerminalIO => self.rate_terminal.try_consume(),
        }
    }
}

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);
static ACTIVE_CONNECTIONS: AtomicU64 = AtomicU64::new(0);

pub async fn start_api_server(app_handle: tauri::AppHandle) {
    let token = api_discovery::generate_token();

    // Clean up stale socket/discovery from a previous crashed instance BEFORE writing ours
    let _ = api_discovery::cleanup_stale_socket();

    let sock_path = match api_discovery::socket_path() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[api] socket path error: {e}");
            return;
        }
    };
    let _ = std::fs::remove_file(&sock_path);

    // Write discovery file before starting listener so clients can find us
    match api_discovery::write_discovery_file(&token) {
        Ok(path) => eprintln!("[api] discovery file: {}", path.display()),
        Err(e) => {
            eprintln!("[api] failed to write discovery file: {e}");
            return;
        }
    }

    if let Err(e) = run_server(app_handle, token, sock_path).await {
        eprintln!("[api] server error: {e}");
    }
}

async fn run_server(app_handle: tauri::AppHandle, token: String, sock_path: std::path::PathBuf) -> Result<(), String> {

    let listener = UnixListener::bind(&sock_path)
        .map_err(|e| format!("bind failed: {e}"))?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&sock_path, std::fs::Permissions::from_mode(0o600));
    }

    eprintln!("[api] listening on {}", sock_path.display());

    let token = Arc::new(token);
    let ctx = Arc::new(HandlerContext::new(app_handle.clone()));

    // Event bus: subscribe to pty-output and pty-exit Tauri events and forward them
    let event_bus = app_handle.state::<ApiEventBus>().inner().clone();
    let event_sender = event_bus.sender().clone();

    // Forward pty-output events to the event bus
    let sender_clone = event_sender.clone();
    app_handle.listen("pty-output", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let notification = StateChangeNotification {
                event: "sessions.output".to_string(),
                data: serde_json::json!({
                    "sessionId": payload.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "output": payload.get("data").and_then(|v| v.as_str()).unwrap_or(""),
                }),
            };
            let _ = sender_clone.send(notification);
        }
    });

    // Forward pty-exit events to the event bus
    let sender_clone = event_sender.clone();
    app_handle.listen("pty-exit", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let notification = StateChangeNotification {
                event: "sessions.exit".to_string(),
                data: serde_json::json!({
                    "sessionId": payload.get("id").and_then(|v| v.as_str()).unwrap_or(""),
                    "exitCode": payload.get("exit_code"),
                }),
            };
            let _ = sender_clone.send(notification);
        }
    });

    loop {
        let (stream, _addr) = listener.accept().await
            .map_err(|e| format!("accept failed: {e}"))?;

        if ACTIVE_CONNECTIONS.load(Ordering::Relaxed) >= MAX_CONNECTIONS as u64 {
            // Drop connection immediately
            drop(stream);
            continue;
        }

        ACTIVE_CONNECTIONS.fetch_add(1, Ordering::Relaxed);

        let token = token.clone();
        let ctx = ctx.clone();
        let event_rx = event_sender.subscribe();

        tokio::spawn(async move {
            handle_connection(stream, token, ctx, event_rx).await;
            ACTIVE_CONNECTIONS.fetch_sub(1, Ordering::Relaxed);
        });
    }
}

async fn handle_connection(
    stream: tokio::net::UnixStream,
    token: Arc<String>,
    ctx: Arc<HandlerContext>,
    mut event_rx: broadcast::Receiver<StateChangeNotification>,
) {
    let _conn_id = CONN_COUNTER.fetch_add(1, Ordering::Relaxed);
    let (reader, writer) = stream.into_split();
    let reader = BufReader::new(reader);
    let writer = Arc::new(Mutex::new(writer));

    let state = Arc::new(Mutex::new(ConnectionState::new()));

    // Channel for sending responses/notifications to the writer task
    let (out_tx, mut out_rx) = mpsc::channel::<Vec<u8>>(256);

    // Writer task: serializes all writes to the socket
    let writer_clone = writer.clone();
    let writer_task = tokio::spawn(async move {
        while let Some(data) = out_rx.recv().await {
            let mut w = writer_clone.lock().await;
            if w.write_all(&data).await.is_err() {
                break;
            }
            if w.flush().await.is_err() {
                break;
            }
        }
    });

    // Event forwarder task: matches subscriptions and sends events
    let state_clone = state.clone();
    let out_tx_events = out_tx.clone();
    let event_task = tokio::spawn(async move {
        loop {
            match event_rx.recv().await {
                Ok(notification) => {
                    let state = state_clone.lock().await;
                    if !state.authenticated {
                        continue;
                    }

                    // Extract session_id from event data for filtering
                    let session_id = notification.data.get("sessionId")
                        .and_then(|v| v.as_str())
                        .map(String::from);

                    for sub in state.subscriptions.values() {
                        if sub.matches(&notification.event, session_id.as_deref()) {
                            let payload = EventPayload {
                                subscription_id: sub.id.clone(),
                                event: notification.event.clone(),
                                data: notification.data.clone(),
                            };
                            let notif = JsonRpcNotification::new(
                                "event",
                                serde_json::to_value(&payload).unwrap_or_default(),
                            );
                            if let Ok(mut bytes) = serde_json::to_vec(&notif) {
                                bytes.push(b'\n');
                                if out_tx_events.try_send(bytes).is_err() {
                                    // Channel full — client not reading fast enough, drop event
                                }
                            }
                        }
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    // Missed some events — continue
                }
                Err(broadcast::error::RecvError::Closed) => {
                    break;
                }
            }
        }
    });

    // Read loop: process JSON-RPC requests line by line
    let mut lines = reader.lines();
    loop {
        let line = match lines.next_line().await {
            Ok(Some(line)) => line,
            Ok(None) => break,
            Err(_) => break,
        };

        let line = line.trim().to_string();
        if line.is_empty() {
            continue;
        }

        let request: JsonRpcRequest = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(_) => {
                let resp = JsonRpcResponse::error(None, PARSE_ERROR, "Parse error");
                send_response(&out_tx, &resp).await;
                continue;
            }
        };

        if request.jsonrpc != "2.0" {
            let resp = JsonRpcResponse::error(request.id, INVALID_REQUEST, "Invalid JSON-RPC version");
            send_response(&out_tx, &resp).await;
            continue;
        }

        let response = process_request(&request, &token, &ctx, &state).await;
        send_response(&out_tx, &response).await;

        // Close connection after too many auth failures
        let s = state.lock().await;
        if s.auth_failures >= 3 {
            break;
        }
    }

    // Clean up
    drop(out_tx);
    event_task.abort();
    let _ = writer_task.await;
}

async fn process_request(
    request: &JsonRpcRequest,
    token: &str,
    ctx: &HandlerContext,
    state: &Arc<Mutex<ConnectionState>>,
) -> JsonRpcResponse {
    let method = &request.method;

    // Auth check
    if method == "auth.authenticate" {
        return handle_auth(request, token, ctx, state).await;
    }

    let mut s = state.lock().await;
    if !s.authenticated {
        return JsonRpcResponse::error(
            request.id.clone(),
            AUTH_REQUIRED,
            "Authentication required",
        );
    }

    // Subscription management
    if method == "app.subscribe" {
        return handle_subscribe(request, &mut s);
    }
    if method == "app.unsubscribe" {
        return handle_unsubscribe(request, &mut s);
    }

    // Rate limiting
    let category = rate_category(method);
    if !s.check_rate(category) {
        return JsonRpcResponse::error(
            request.id.clone(),
            RATE_LIMITED,
            "Rate limit exceeded",
        );
    }
    drop(s);

    // Method not found check
    let catalog = method_catalog();
    if !catalog.iter().any(|m| m.name == *method) {
        return JsonRpcResponse::error(
            request.id.clone(),
            METHOD_NOT_FOUND,
            format!("Unknown method: {method}"),
        );
    }

    // Dispatch
    match crate::api_handlers::dispatch(ctx, method, request.params.clone()).await {
        Ok(result) => JsonRpcResponse::success(request.id.clone(), result),
        Err(err) => JsonRpcResponse {
            jsonrpc: "2.0".to_string(),
            id: request.id.clone(),
            result: None,
            error: Some(err),
        },
    }
}

async fn handle_auth(
    request: &JsonRpcRequest,
    token: &str,
    ctx: &HandlerContext,
    state: &Arc<Mutex<ConnectionState>>,
) -> JsonRpcResponse {
    let params: AuthParams = match serde_json::from_value(request.params.clone()) {
        Ok(p) => p,
        Err(_) => {
            return JsonRpcResponse::error(
                request.id.clone(),
                INVALID_PARAMS,
                "Invalid auth params",
            );
        }
    };

    let mut s = state.lock().await;

    if params.token != token {
        s.auth_failures += 1;
        return JsonRpcResponse::error(
            request.id.clone(),
            AUTH_INVALID,
            "Invalid token",
        );
    }

    let session_id = format!("conn-{}", CONN_COUNTER.load(Ordering::Relaxed));
    s.authenticated = true;
    s.session_id = session_id.clone();

    let result = AuthResult {
        session_id,
        server_version: ctx.app_version.clone(),
        capabilities: vec![
            "sessions".into(),
            "projects".into(),
            "prompts".into(),
            "environments".into(),
            "assets".into(),
            "recordings".into(),
            "files".into(),
            "ssh".into(),
            "subscriptions".into(),
        ],
    };

    JsonRpcResponse::success(
        request.id.clone(),
        serde_json::to_value(result).unwrap_or_default(),
    )
}

fn handle_subscribe(
    request: &JsonRpcRequest,
    state: &mut ConnectionState,
) -> JsonRpcResponse {
    let params: SubscribeParams = match serde_json::from_value(request.params.clone()) {
        Ok(p) => p,
        Err(_) => {
            return JsonRpcResponse::error(
                request.id.clone(),
                INVALID_PARAMS,
                "Invalid subscribe params",
            );
        }
    };

    if state.subscriptions.len() >= MAX_SUBSCRIPTIONS_PER_CONN {
        return JsonRpcResponse::error(
            request.id.clone(),
            RATE_LIMITED,
            format!("Max {MAX_SUBSCRIPTIONS_PER_CONN} subscriptions per connection"),
        );
    }

    let sub_id = format!("sub-{}", rand_id());
    let subscription = Subscription {
        id: sub_id.clone(),
        events: params.events,
        filter: params.filter,
    };

    state.subscriptions.insert(sub_id.clone(), subscription);

    JsonRpcResponse::success(
        request.id.clone(),
        serde_json::to_value(SubscribeResult {
            subscription_id: sub_id,
        })
        .unwrap_or_default(),
    )
}

fn handle_unsubscribe(
    request: &JsonRpcRequest,
    state: &mut ConnectionState,
) -> JsonRpcResponse {
    let params: UnsubscribeParams = match serde_json::from_value(request.params.clone()) {
        Ok(p) => p,
        Err(_) => {
            return JsonRpcResponse::error(
                request.id.clone(),
                INVALID_PARAMS,
                "Invalid unsubscribe params",
            );
        }
    };

    state.subscriptions.remove(&params.subscription_id);
    JsonRpcResponse::success(request.id.clone(), serde_json::Value::Null)
}

async fn send_response(tx: &mpsc::Sender<Vec<u8>>, response: &JsonRpcResponse) {
    if let Ok(mut bytes) = serde_json::to_vec(response) {
        bytes.push(b'\n');
        let _ = tx.send(bytes).await;
    }
}

fn rand_id() -> String {
    use rand_core::{OsRng, RngCore};
    let mut bytes = [0u8; 8];
    OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
