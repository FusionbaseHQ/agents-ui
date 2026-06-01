// Embedded browser tabs: each is a child WKWebView added to the main window and
// positioned as a pixel overlay over a DOM rect by the frontend. The webview
// gets no app capabilities (see capabilities/default.json `webviews:["main"]`),
// so pages it loads cannot call any Tauri command.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Serialize;
use std::{fs, process::Command, time::{SystemTime, UNIX_EPOCH}};
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

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserScreenshot {
    mime_type: &'static str,
    data: String,
    width: u32,
    height: u32,
    source_width: u32,
    source_height: u32,
    target: &'static str,
    captured_element: &'static str,
    capture_method: &'static str,
}

#[allow(dead_code)]
const SCREEN_RECORDING_PERMISSION_REQUIRED: &str =
    "SCREEN_RECORDING_PERMISSION_REQUIRED: macOS Screen Recording permission is required to capture the embedded browser. Open System Settings > Privacy & Security > Screen Recording, enable Agents UI (or the terminal/editor that launched the app in dev mode), then restart the app.";

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
pub async fn browser_capture_screenshot(app: AppHandle, label: String) -> Result<BrowserScreenshot, String> {
    let webview = app
        .get_webview(&label)
        .ok_or_else(|| "browser not found".to_string())?;

    let child_position = webview
        .position()
        .map_err(|e| format!("browser position unavailable: {e}"))?;
    if child_position.x < -10_000 || child_position.y < -10_000 {
        return Err("browser tab is not visible yet; focus it and retry".to_string());
    }
    let child_size = webview
        .size()
        .map_err(|e| format!("browser size unavailable: {e}"))?;
    if child_size.width < 2 || child_size.height < 2 {
        return Err("browser tab has no visible capture area".to_string());
    }

    #[cfg(target_os = "macos")]
    {
        return macos_browser_capture::capture(webview).await;
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = webview;
        Err("embedded browser screenshot capture is currently implemented for macOS only".to_string())
    }
}

#[tauri::command]
pub fn open_screen_recording_settings() -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let status = Command::new("open")
            .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
            .status()
            .map_err(|e| format!("failed to open System Settings: {e}"))?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("failed to open System Settings: exit status {status}"))
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err("Screen Recording permission settings are only available on macOS".to_string())
    }
}

#[tauri::command]
pub fn browser_close(app: AppHandle, label: String) -> Result<(), String> {
    if let Some(webview) = app.get_webview(&label) {
        let _ = webview.close();
    }
    Ok(())
}

#[allow(dead_code)]
fn capture_region(x: i32, y: i32, width: u32, height: u32) -> Result<BrowserScreenshot, String> {
    #[cfg(target_os = "macos")]
    {
        let path = temp_screenshot_path();
        let region = format!("{x},{y},{width},{height}");
        let output = Command::new("/usr/sbin/screencapture")
            .arg("-x")
            .arg("-R")
            .arg(&region)
            .arg(&path)
            .output()
            .map_err(|e| format!("failed to run screencapture: {e}"))?;

        let bytes = fs::read(&path).unwrap_or_default();
        let _ = fs::remove_file(&path);
        if !output.status.success() || bytes.len() < 32 {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let detail = stderr.trim();
            if detail.is_empty() {
                return Err(SCREEN_RECORDING_PERMISSION_REQUIRED.to_string());
            }
            return Err(format!("{SCREEN_RECORDING_PERMISSION_REQUIRED} screencapture said: {detail}"));
        }

        let (png_width, png_height) = png_dimensions(&bytes)
            .ok_or_else(|| "screencapture did not produce a valid PNG".to_string())?;
        Ok(BrowserScreenshot {
            mime_type: "image/png",
            data: BASE64.encode(bytes),
            width: png_width,
            height: png_height,
            source_width: png_width,
            source_height: png_height,
            target: "browser",
            captured_element: "browser_webview",
            capture_method: "screencapture_region",
        })
    }

    #[cfg(not(target_os = "macos"))]
    {
        let _ = (x, y, width, height);
        Err("embedded browser screenshot capture is currently implemented for macOS only".to_string())
    }
}

#[cfg(target_os = "macos")]
mod macos_browser_capture {
    use super::{png_dimensions, BrowserScreenshot, BASE64};
    use base64::Engine;
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage};
    use objc2_foundation::{NSDictionary, NSError};
    use objc2_web_kit::WKWebView;
    use std::{
        sync::{mpsc, Mutex},
        time::Duration,
    };
    use tauri::Webview;

    const SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(3);

    pub async fn capture(webview: Webview) -> Result<BrowserScreenshot, String> {
        let (tx, rx) = mpsc::channel::<Result<BrowserScreenshot, String>>();
        webview
            .with_webview(move |platform| {
                let inner = platform.inner();
                if inner.is_null() {
                    let _ = tx.send(Err(
                        "BROWSER_SNAPSHOT_FAILED: native WKWebView handle is null".to_string(),
                    ));
                    return;
                }

                let sender = Mutex::new(Some(tx));
                let completion = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                    let result = unsafe { snapshot_callback_result(image, error) };
                    if let Ok(mut sender) = sender.lock() {
                        if let Some(sender) = sender.take() {
                            let _ = sender.send(result);
                        }
                    }
                });

                unsafe {
                    let wk_webview = &*(inner as *mut WKWebView);
                    wk_webview.takeSnapshotWithConfiguration_completionHandler(None, &completion);
                }
            })
            .map_err(|e| format!("BROWSER_SNAPSHOT_FAILED: unable to access native WKWebView: {e}"))?;

        let received = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(SNAPSHOT_TIMEOUT))
            .await
            .map_err(|e| format!("BROWSER_SNAPSHOT_FAILED: snapshot wait failed: {e}"))?;

        match received {
            Ok(result) => result,
            Err(mpsc::RecvTimeoutError::Timeout) => {
                Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot timed out".to_string())
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot callback was dropped".to_string())
            }
        }
    }

    unsafe fn snapshot_callback_result(
        image: *mut NSImage,
        error: *mut NSError,
    ) -> Result<BrowserScreenshot, String> {
        if !error.is_null() {
            return Err(format!("BROWSER_SNAPSHOT_FAILED: {}", unsafe { &*error }));
        }

        let bytes = unsafe { image_to_png_bytes(image) }?;
        let (png_width, png_height) = png_dimensions(&bytes)
            .ok_or_else(|| "BROWSER_SNAPSHOT_FAILED: WKWebView did not produce a valid PNG".to_string())?;

        Ok(BrowserScreenshot {
            mime_type: "image/png",
            data: BASE64.encode(bytes),
            width: png_width,
            height: png_height,
            source_width: png_width,
            source_height: png_height,
            target: "browser",
            captured_element: "browser_webview",
            capture_method: "wkwebview_snapshot",
        })
    }

    unsafe fn image_to_png_bytes(image: *mut NSImage) -> Result<Vec<u8>, String> {
        let image = unsafe { image.as_ref() }
            .ok_or_else(|| "BROWSER_SNAPSHOT_FAILED: WKWebView returned no snapshot image".to_string())?;
        let tiff = image
            .TIFFRepresentation()
            .ok_or_else(|| "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be converted to TIFF".to_string())?;
        let bitmap = NSBitmapImageRep::imageRepWithData(&tiff)
            .ok_or_else(|| "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be converted to a bitmap".to_string())?;
        let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::dictionary();
        let png = unsafe { bitmap.representationUsingType_properties(NSBitmapImageFileType::PNG, &properties) }
            .ok_or_else(|| "BROWSER_SNAPSHOT_FAILED: WKWebView snapshot could not be encoded as PNG".to_string())?;
        let bytes = png.to_vec();
        if bytes.is_empty() {
            return Err("BROWSER_SNAPSHOT_FAILED: WKWebView snapshot PNG was empty".to_string());
        }
        Ok(bytes)
    }
}

#[allow(dead_code)]
fn temp_screenshot_path() -> std::path::PathBuf {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("agents-ui-browser-screenshot-{}-{nanos}.png", std::process::id()))
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    const PNG_SIG: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
    if bytes.len() < 24 || &bytes[..8] != PNG_SIG {
        return None;
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().ok()?);
    let height = u32::from_be_bytes(bytes[20..24].try_into().ok()?);
    if width == 0 || height == 0 {
        return None;
    }
    Some((width, height))
}
