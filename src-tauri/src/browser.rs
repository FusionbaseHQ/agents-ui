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

// Translate a DOM rect (getBoundingClientRect, origin = top-left of the web
// content) into the position to give the child webview.
//
// A child webview is positioned relative to its parent NSView, which is the
// window's *frame* view (top-left includes the title bar). The DOM, however, is
// rendered in the content view, inset below the title bar. So we work in screen
// space, which is unambiguous:
//   DOM (x,y) in screen px  = inner_position (content top-left on screen) + (x,y)*scale
//   child parent top-left   = outer_position (window frame top-left on screen)
//   child position (parent-relative) = DOM_screen - parent_screen
//                                    = (inner - outer) + (x,y)*scale
// (inner - outer) is the title-bar inset; on a borderless window it is (0,0).
fn child_physical_position(app: &AppHandle, dom_x: f64, dom_y: f64) -> PhysicalPosition<f64> {
    let window = app.get_window("main");
    let scale = window
        .as_ref()
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.0)
        .max(1.0);
    let (ox, oy) = window
        .as_ref()
        .and_then(|w| Some((w.inner_position().ok()?, w.outer_position().ok()?)))
        .map(|(inner, outer)| ((inner.x - outer.x) as f64, (inner.y - outer.y) as f64))
        .unwrap_or((0.0, 0.0));
    PhysicalPosition::new(ox + dom_x * scale, oy + dom_y * scale)
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
        let _ = webview.set_position(child_physical_position(&app, x, y));
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
