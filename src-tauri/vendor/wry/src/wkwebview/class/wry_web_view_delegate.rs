// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::panic::AssertUnwindSafe;

use http::Request;
use objc2::{
  define_class, msg_send,
  rc::Retained,
  runtime::{NSObject, ProtocolObject},
  DeclaredClass, MainThreadOnly,
};
use objc2_foundation::{ns_string, MainThreadMarker, NSObjectProtocol, NSString};
use objc2_web_kit::{WKScriptMessage, WKScriptMessageHandler, WKUserContentController};

pub const IPC_MESSAGE_HANDLER_NAME: &str = "ipc";

pub struct WryWebViewDelegateIvars {
  pub controller: Retained<WKUserContentController>,
  pub ipc_handler: Box<dyn Fn(Request<String>)>,
}

define_class!(
  #[unsafe(super(NSObject))]
  #[thread_kind = MainThreadOnly]
  #[ivars = WryWebViewDelegateIvars]
  pub struct WryWebViewDelegate;

  unsafe impl NSObjectProtocol for WryWebViewDelegate {}

  unsafe impl WKScriptMessageHandler for WryWebViewDelegate {
    // Function for ipc handler
    #[unsafe(method(userContentController:didReceiveScriptMessage:))]
    fn did_receive(
      this: &WryWebViewDelegate,
      _controller: &WKUserContentController,
      msg: &WKScriptMessage,
    ) {
      // WebKit enters through Objective-C. A malformed/stale message or a
      // panicking application handler must never unwind over that ABI.
      let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _ = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
          #[cfg(feature = "tracing")]
          let _span = tracing::info_span!(parent: None, "wry::ipc::handle").entered();

          let ipc_handler = &this.ivars().ipc_handler;
          let body = msg.body();
          if let Ok(body) = body.downcast::<NSString>() {
            let frame_info = msg.frameInfo();
            let request = frame_info.request();
            if let Some(url) = request.URL().and_then(|url| url.absoluteString()) {
              let url = url.to_string();
              let js = body.to_string();
              if let Ok(r) = Request::builder().uri(&url).body(js.clone()) {
                ipc_handler(r);
              } else {
                #[cfg(feature = "tracing")]
                tracing::warn!("WebView received invalid IPC request: {}", js);
              }
              return;
            }
          }

          #[cfg(feature = "tracing")]
          tracing::warn!("WebView received invalid IPC call.");
        }));
      }));
    }
  }
);

impl WryWebViewDelegate {
  pub fn new(
    controller: Retained<WKUserContentController>,
    ipc_handler: Box<dyn Fn(Request<String>)>,
    mtm: MainThreadMarker,
  ) -> Retained<Self> {
    let delegate = mtm
      .alloc::<WryWebViewDelegate>()
      .set_ivars(WryWebViewDelegateIvars {
        ipc_handler,
        controller,
      });

    let delegate: Retained<Self> = unsafe { msg_send![super(delegate), init] };

    let proto_delegate = ProtocolObject::from_ref(&*delegate);
    unsafe {
      // this will increase the retain count of the delegate
      let _res = objc2::exception::catch(AssertUnwindSafe(|| {
        delegate
          .ivars()
          .controller
          .addScriptMessageHandler_name(proto_delegate, ns_string!(IPC_MESSAGE_HANDLER_NAME));
      }));
    }

    delegate
  }
}
