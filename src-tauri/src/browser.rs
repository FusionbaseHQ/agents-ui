// Embedded browser tabs: each is a child WKWebView added to the main window and
// positioned as a pixel overlay over a DOM rect by the frontend. The webview
// gets no app capabilities (see capabilities/default.json `webviews:["main"]`),
// so pages it loads cannot call any Tauri command.

use serde::Serialize;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Rect, WebviewUrl,
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

// Translate a DOM rect (getBoundingClientRect, origin = top-left of the main
// webview's CSS viewport) into the child webview's native bounds.
//
// The main app webview and browser child webviews are native siblings. The DOM
// rect is relative to the main webview, so anchor it to the main webview's real
// native origin instead of assuming the main webview starts at the window origin.
fn child_bounds(app: &AppHandle, dom_x: f64, dom_y: f64, width: f64, height: f64, y_offset: f64) -> Rect {
    let scale = app
        .get_window("main")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
        .max(1.0);
    let origin = app
        .get_webview("main")
        .and_then(|w| w.position().ok())
        .map(|p| (p.x as f64, p.y as f64))
        .unwrap_or((0.0, 0.0));

    Rect {
        position: PhysicalPosition::new(origin.0 + dom_x * scale, origin.1 + (dom_y + y_offset.max(0.0)) * scale).into(),
        size: LogicalSize::new(width.max(1.0), height.max(1.0)).into(),
    }
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
    y_offset: Option<f64>,
) -> Result<(), String> {
    let bounds = child_bounds(&app, x, y, width, height, y_offset.unwrap_or(0.0));
    // Already created: just reveal + reposition (keeps the current page).
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_bounds(bounds);
        return Ok(());
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "main window not found".to_string())?;
    let target = normalize_url(&url)?;

    let load_app = app.clone();
    let load_label = label.clone();

    let builder = WebviewBuilder::new(&label, WebviewUrl::External(target)).on_page_load(move |_webview, payload| {
        let loading = matches!(payload.event(), PageLoadEvent::Started);
        emit_nav(&load_app, &load_label, payload.url().as_str(), loading);
    });

    window
        .add_child(
            builder,
            bounds.position,
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    // The main webview may not be positioned yet at first paint; reposition once
    // more now that the child exists.
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_bounds(bounds);
    }
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
    y_offset: Option<f64>,
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    let _ = webview.set_bounds(child_bounds(&app, x, y, width, height, y_offset.unwrap_or(0.0)));
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
