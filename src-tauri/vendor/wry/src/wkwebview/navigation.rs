use objc2::DeclaredClass;
use objc2_foundation::{NSObjectProtocol, NSString};
use objc2_web_kit::{
  WKNavigation, WKNavigationAction, WKNavigationActionPolicy, WKNavigationResponse,
  WKNavigationResponsePolicy,
};

#[cfg(target_os = "ios")]
use crate::wkwebview::ios::WKWebView::WKWebView;
#[cfg(target_os = "macos")]
use objc2_web_kit::WKWebView;

use crate::PageLoadEvent;
use std::panic::AssertUnwindSafe;

use super::class::wry_navigation_delegate::WryNavigationDelegate;

pub(crate) fn did_commit_navigation(
  this: &WryNavigationDelegate,
  webview: &WKWebView,
  _navigation: &WKNavigation,
) {
  unsafe {
    // Call on_load_handler
    if let Some(on_page_load) = &this.ivars().on_page_load_handler {
      on_page_load(PageLoadEvent::Started);
    }

    // Inject scripts
    let mut pending_scripts = this
      .ivars()
      .pending_scripts
      .lock()
      .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(scripts) = &*pending_scripts {
      for script in scripts {
        webview.evaluateJavaScript_completionHandler(&NSString::from_str(script), None);
      }
      *pending_scripts = None;
    }
  }
}

pub(crate) fn did_finish_navigation(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
  _navigation: &WKNavigation,
) {
  if let Some(on_page_load) = &this.ivars().on_page_load_handler {
    on_page_load(PageLoadEvent::Finished);
  }
}

// Navigation handler
pub(crate) fn navigation_policy(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
  action: &WKNavigationAction,
  handler: &block2::Block<dyn Fn(WKNavigationActionPolicy)>,
) {
  let decision = std::panic::catch_unwind(AssertUnwindSafe(|| {
    objc2::exception::catch(AssertUnwindSafe(|| unsafe {
      // <https://developer.apple.com/documentation/webkit/wknavigationaction/shouldperformdownload>
      // Available: macOS 11.3+, iOS 14.5+
      let can_download = action.respondsToSelector(objc2::sel!(shouldPerformDownload));
      let should_download = can_download && action.shouldPerformDownload();

      if should_download {
        if this.ivars().has_download_handler {
          WKNavigationActionPolicy::Download
        } else {
          WKNavigationActionPolicy::Cancel
        }
      } else {
        let Some(url) = action.request().URL().and_then(|url| url.absoluteString()) else {
          return WKNavigationActionPolicy::Cancel;
        };
        let function = &this.ivars().navigation_policy_function;
        if std::panic::catch_unwind(AssertUnwindSafe(|| function(url.to_string()))).unwrap_or(false)
        {
          WKNavigationActionPolicy::Allow
        } else {
          WKNavigationActionPolicy::Cancel
        }
      }
    }))
    .unwrap_or(WKNavigationActionPolicy::Cancel)
  }))
  .unwrap_or(WKNavigationActionPolicy::Cancel);

  // Resolve WebKit's one-shot decision exactly once. If the block itself is
  // pathological, contain it but never invoke it a second time.
  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    let _ = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
      (*handler).call((decision,));
    }));
  }));
}

// Navigation handler
pub(crate) fn navigation_policy_response(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
  response: &WKNavigationResponse,
  handler: &block2::Block<dyn Fn(WKNavigationResponsePolicy)>,
) {
  let decision = std::panic::catch_unwind(AssertUnwindSafe(|| {
    objc2::exception::catch(AssertUnwindSafe(|| unsafe {
      if !response.canShowMIMEType() && this.ivars().has_download_handler {
        WKNavigationResponsePolicy::Download
      } else {
        WKNavigationResponsePolicy::Allow
      }
    }))
    .unwrap_or(WKNavigationResponsePolicy::Cancel)
  }))
  .unwrap_or(WKNavigationResponsePolicy::Cancel);

  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    let _ = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
      (*handler).call((decision,));
    }));
  }));
}

pub(crate) fn web_content_process_did_terminate(
  this: &WryNavigationDelegate,
  _webview: &WKWebView,
) {
  if let Some(on_web_content_process_terminate) =
    &this.ivars().on_web_content_process_terminate_handler
  {
    on_web_content_process_terminate();
  }
}
