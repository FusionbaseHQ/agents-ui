// Embedded browser tabs: each is a child WKWebView added to the main window and
// positioned as a pixel overlay over a DOM rect by the frontend. The webview
// gets no app capabilities (see capabilities/default.json `webviews:["main"]`),
// so pages it loads cannot call any Tauri command.

use serde::Serialize;
use tauri::{
    webview::{PageLoadEvent, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, WebviewUrl,
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

// Translate a DOM rect (from getBoundingClientRect, origin = top-left of the web
// content) into the coordinate space the child webview is positioned in.
//
// The trick: the main app webview and the child browser webview are sibling
// views in the SAME coordinate space, and both are positioned via Tauri's
// Webview::position()/set_position(). DOM (0,0) is exactly the main webview's
// top-left. So the child's target is simply main_webview.position() + (x, y).
// This is self-calibrating — it needs no knowledge of title-bar height or which
// view space Tauri uses, because we read and write through the same API.
//
// Returns the physical position to place the child at.
fn child_physical_position(app: &AppHandle, dom_x: f64, dom_y: f64) -> PhysicalPosition<f64> {
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
    PhysicalPosition::new(origin.0 + dom_x * scale, origin.1 + dom_y * scale)
}

fn emit_debug(app: &AppHandle, msg: String) {
    eprintln!("[browser] {msg}");
    let _ = app.emit_to("main", "browser://debug", msg);
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
    let pos = child_physical_position(&app, x, y);
    // Already created: just reveal + reposition (keeps the current page).
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.set_position(pos);
        let _ = webview.set_size(LogicalSize::new(w, h));
        emit_debug(
            &app,
            format!(
                "reposition dom=({x:.0},{y:.0},{w:.0},{h:.0}) set_phys=({:.0},{:.0}) main_pos={:?} readback={:?}",
                pos.x,
                pos.y,
                app.get_webview("main").and_then(|m| m.position().ok()),
                webview.position().ok(),
            ),
        );
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
        .add_child(builder, pos, LogicalSize::new(w, h))
        .map_err(|e| format!("failed to create browser webview: {e}"))?;
    // The main webview may not be positioned yet at first paint; reposition once
    // more now that the child exists, using the main webview's actual origin.
    if let Some(webview) = app.get_webview(&label) {
        let pos2 = child_physical_position(&app, x, y);
        let _ = webview.set_position(pos2);
        emit_debug(
            &app,
            format!(
                "created dom=({x:.0},{y:.0},{w:.0},{h:.0}) set_phys=({:.0},{:.0}) main_pos={:?} readback={:?}",
                pos2.x,
                pos2.y,
                app.get_webview("main").and_then(|m| m.position().ok()),
                webview.position().ok(),
            ),
        );
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
) -> Result<(), String> {
    let Some(webview) = app.get_webview(&label) else {
        return Ok(());
    };
    let _ = webview.set_position(child_physical_position(&app, x, y));
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
