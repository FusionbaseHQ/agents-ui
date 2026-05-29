// Embedded browser tabs: each is a child WKWebView added to the main window and
// positioned as a pixel overlay over a DOM rect by the frontend. The webview
// gets no app capabilities (see capabilities/default.json `webviews:["main"]`),
// so pages it loads cannot call any Tauri command.

use serde::Serialize;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl,
};

// Parked far off-screen instead of destroyed, so switching tabs keeps page state.
const OFFSCREEN: f64 = -32000.0;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct BrowserNavEvent {
    label: String,
    url: String,
    loading: bool,
}

fn normalize_url(input: &str) -> Result<tauri::Url, String> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err("empty url".to_string());
    }
    let candidate = if trimmed.contains("://") || trimmed.starts_with("about:") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    tauri::Url::parse(&candidate).map_err(|e| format!("invalid url: {e}"))
}

fn emit_nav(app: &AppHandle, label: &str, url: &str, loading: bool) {
    let _ = app.emit_to(
        "main",
        "browser://event",
        BrowserNavEvent {
            label: label.to_string(),
            url: url.to_string(),
            loading,
        },
    );
}

#[tauri::command]
pub fn browser_open(
    app: AppHandle,
    label: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let w = width.max(1.0);
    let h = height.max(1.0);
    // Already created: just reveal + reposition (keeps the current page).
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_position(LogicalPosition::new(x, y));
        let _ = webview.set_size(LogicalSize::new(w, h));
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let target = normalize_url(&url)?;

    let nav_app = app.clone();
    let nav_label = label.clone();
    let load_app = app.clone();
    let load_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target))
        .on_navigation(move |u| {
            emit_nav(&nav_app, &nav_label, u.as_str(), true);
            true
        })
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), PageLoadEvent::Started);
            emit_nav(&load_app, &load_label, payload.url().as_str(), loading);
        });

    window
        .add_child(builder, LogicalPosition::new(x, y), LogicalSize::new(w, h))
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn browser_set_bounds(
    app: AppHandle,
    label: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    let _ = webview.set_position(LogicalPosition::new(x, y));
    let _ = webview.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)));
    Ok(())
}

#[tauri::command]
pub fn browser_hide(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_position(LogicalPosition::new(OFFSCREEN, OFFSCREEN));
    }
    Ok(())
}

#[tauri::command]
pub fn browser_navigate(app: AppHandle, label: String, url: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;
    webview
        .navigate(normalize_url(&url)?)
        .map_err(|e| format!("navigate failed: {e}"))
}

#[tauri::command]
pub fn browser_action(app: AppHandle, label: String, action: String) -> Result<(), String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;
    let script = match action.as_str() {
        "back" => "history.back()",
        "forward" => "history.forward()",
        "reload" => "location.reload()",
        _ => return Err(format!("unknown browser action: {action}")),
    };
    webview.eval(script).map_err(|e| format!("action failed: {e}"))
}

#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    Ok(())
}
