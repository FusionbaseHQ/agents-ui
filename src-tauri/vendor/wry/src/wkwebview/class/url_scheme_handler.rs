// Copyright 2020-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use std::{
  borrow::Cow,
  collections::HashMap,
  ffi::{c_char, c_void, CStr},
  mem::ManuallyDrop,
  panic::AssertUnwindSafe,
  ptr::NonNull,
  sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
  },
};

use http::{
  header::{CONTENT_LENGTH, CONTENT_TYPE},
  Request, Response as HttpResponse, StatusCode,
};
use objc2::{
  rc::Retained,
  runtime::{AnyClass, AnyObject, ClassBuilder, ProtocolObject},
  AllocAnyThread, ClassType, Message,
};
use objc2_foundation::{
  MainThreadMarker, NSData, NSError, NSHTTPURLResponse, NSMutableDictionary, NSObject, NSString,
  NSURL,
};
use objc2_web_kit::WKURLSchemeTask;
use once_cell::sync::Lazy;

use crate::{wkwebview::WEBVIEW_STATE, RequestAsyncResponder, WryWebView};

#[repr(C)]
struct DispatchQueue {
  _opaque: [u8; 0],
}

#[link(name = "System", kind = "dylib")]
unsafe extern "C" {
  #[link_name = "_dispatch_main_q"]
  static DISPATCH_MAIN_QUEUE: DispatchQueue;

  fn dispatch_async_f(
    queue: *const DispatchQueue,
    context: *mut c_void,
    work: extern "C" fn(*mut c_void),
  );
}

extern "C" fn invoke_main_queue_job<F: FnOnce()>(context: *mut c_void) {
  // Rebuild, invoke, and destroy the closure inside the unwind boundary and
  // therefore on the main queue. Neither Rust nor Objective-C unwinding may
  // cross this libdispatch C callback, including during captured-value Drop.
  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    let _ = objc2::exception::catch(AssertUnwindSafe(|| {
      let job = unsafe { Box::from_raw(context.cast::<F>()) };
      job();
    }));
  }));
}

/// Runs native WebKit work on Apple's main queue.
///
/// `dispatch_async_f` has no enqueue-failure result. Once the raw context is
/// handed to libdispatch it is intentionally owned by the process main queue;
/// if the process exits before servicing it, leaking the context is safer than
/// releasing main-thread-only Objective-C objects on a worker thread.
fn dispatch_main_async<F>(job: F)
where
  F: FnOnce() + Send + 'static,
{
  // Always enqueue, even when called from main, to avoid re-entering WebKit
  // while it is invoking startURLSchemeTask/stopURLSchemeTask.
  let context = Box::into_raw(Box::new(job)).cast::<c_void>();
  unsafe {
    dispatch_async_f(
      std::ptr::addr_of!(DISPATCH_MAIN_QUEUE),
      context,
      invoke_main_queue_job::<F>,
    );
  }
}

static NEXT_CUSTOM_PROTOCOL_TASK_TOKEN: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
struct TaskKey {
  handler: usize,
  webview: usize,
  task: usize,
}

static CUSTOM_PROTOCOL_TASKS: Lazy<Mutex<HashMap<TaskKey, u64>>> = Lazy::new(Default::default);

fn next_task_token() -> u64 {
  loop {
    let token = NEXT_CUSTOM_PROTOCOL_TASK_TOKEN.fetch_add(1, Ordering::Relaxed);
    if token != 0 {
      return token;
    }
  }
}

fn register_task(task_key: TaskKey) -> u64 {
  let token = next_task_token();
  CUSTOM_PROTOCOL_TASKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .insert(task_key, token);
  token
}

fn task_is_current(task_key: TaskKey, token: u64) -> bool {
  CUSTOM_PROTOCOL_TASKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .get(&task_key)
    .is_some_and(|current| *current == token)
}

fn cancel_task(task_key: TaskKey) {
  CUSTOM_PROTOCOL_TASKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .remove(&task_key);
}

fn remove_task_if_current(task_key: TaskKey, token: u64) -> bool {
  let mut tasks = CUSTOM_PROTOCOL_TASKS
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  if tasks
    .get(&task_key)
    .is_some_and(|current| *current == token)
  {
    tasks.remove(&task_key);
    true
  } else {
    false
  }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamReadProgress {
  End,
  Data(usize),
  Invalid,
}

fn checked_stream_read_progress(
  current_len: usize,
  capacity: usize,
  requested: usize,
  count: isize,
) -> StreamReadProgress {
  if count < 0 {
    return StreamReadProgress::Invalid;
  }
  let Ok(count) = usize::try_from(count) else {
    return StreamReadProgress::Invalid;
  };
  if count == 0 {
    return StreamReadProgress::End;
  }
  let Some(new_len) = current_len.checked_add(count) else {
    return StreamReadProgress::Invalid;
  };
  if count > requested || new_len > capacity {
    StreamReadProgress::Invalid
  } else {
    StreamReadProgress::Data(new_len)
  }
}

fn check_webview_generation(webview_id: &str, generation: u64) -> crate::Result<()> {
  if !WEBVIEW_STATE
    .read()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
    .get(webview_id)
    .is_some_and(|state| state.generation == generation)
  {
    return Err(crate::Error::CustomProtocolTaskInvalid);
  }
  Ok(())
}

fn task_key(
  handler: &AnyObject,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) -> TaskKey {
  // NSObject's `hash` is neither collision-free nor safe to message during a
  // teardown callback. Pure pointer identity names the callback triplet; the
  // separate token prevents an old response from matching reused addresses.
  TaskKey {
    handler: handler as *const AnyObject as usize,
    webview: webview as *const WryWebView as usize,
    task: task as *const ProtocolObject<dyn WKURLSchemeTask> as *const () as usize,
  }
}

/// Objective-C state that may only be accessed or released on the main thread.
/// The webview itself is deliberately not retained: its normal main-thread
/// owner must be free to complete teardown before this task is resolved.
struct SchemeTaskInner {
  task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
  url: Option<Retained<NSURL>>,
}

/// A one-way transport for moving retained Objective-C state to the main
/// queue. `ManuallyDrop` makes an unserviced queue item an intentional leak at
/// process exit instead of allowing a worker-thread WebKit deallocation.
struct SchemeTaskTransport {
  inner: ManuallyDrop<SchemeTaskInner>,
  _not_sync: std::marker::PhantomData<std::cell::Cell<()>>,
}

// SAFETY: the retained objects are inaccessible while transported and are
// extracted only by presenting a MainThreadMarker. Dropping the wrapper alone
// does not release them.
unsafe impl Send for SchemeTaskTransport {}

impl SchemeTaskTransport {
  fn new(
    task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
    _main_thread: MainThreadMarker,
  ) -> Self {
    Self {
      inner: ManuallyDrop::new(SchemeTaskInner { task, url: None }),
      _not_sync: Default::default(),
    }
  }

  fn set_url(&mut self, url: Retained<NSURL>, _main_thread: MainThreadMarker) {
    self.inner.url = Some(url);
  }

  fn into_inner(mut self, _main_thread: MainThreadMarker) -> SchemeTaskInner {
    // SAFETY: ownership is transferred exactly once, and the marker proves
    // that eventual Retained destruction occurs on the main thread.
    unsafe { ManuallyDrop::take(&mut self.inner) }
  }
}

struct PendingSchemeTaskState {
  transport: SchemeTaskTransport,
  task_key: TaskKey,
  token: u64,
  webview_id: String,
  webview_generation: u64,
}

impl PendingSchemeTaskState {
  fn into_main(self, main_thread: MainThreadMarker) -> MainThreadSchemeTask {
    MainThreadSchemeTask {
      inner: self.transport.into_inner(main_thread),
      task_key: self.task_key,
      token: self.token,
      webview_id: self.webview_id,
      webview_generation: self.webview_generation,
      terminal: false,
      _main_thread: main_thread,
    }
  }
}

/// Owns a live scheme task between WebKit's start callback and the user
/// responder. Dropping an unused responder schedules its terminal failure on
/// the main queue; no Objective-C object is touched or released by the worker.
struct PendingSchemeTask {
  state: Option<PendingSchemeTaskState>,
}

impl PendingSchemeTask {
  fn new(
    task: Retained<ProtocolObject<dyn WKURLSchemeTask>>,
    task_key: TaskKey,
    webview_id: String,
    webview_generation: u64,
    main_thread: MainThreadMarker,
  ) -> Self {
    let transport = SchemeTaskTransport::new(task, main_thread);
    let token = register_task(task_key);
    Self {
      state: Some(PendingSchemeTaskState {
        transport,
        task_key,
        token,
        webview_id,
        webview_generation,
      }),
    }
  }

  fn set_url(&mut self, url: Retained<NSURL>, main_thread: MainThreadMarker) {
    if let Some(state) = self.state.as_mut() {
      state.transport.set_url(url, main_thread);
    }
  }

  fn into_state(mut self) -> Option<PendingSchemeTaskState> {
    self.state.take()
  }
}

impl Drop for PendingSchemeTask {
  fn drop(&mut self) {
    let Some(state) = self.state.take() else {
      return;
    };

    dispatch_main_async(move || {
      let Some(main_thread) = MainThreadMarker::new() else {
        // The dispatch main queue contract should make this unreachable. Keep
        // native state sealed in the transport if that contract is violated.
        remove_task_if_current(state.task_key, state.token);
        return;
      };
      drop(state.into_main(main_thread));
    });
  }
}

/// A live custom-scheme task after its native state has returned to main.
/// This type is deliberately !Send through its Objective-C fields and marker.
struct MainThreadSchemeTask {
  inner: SchemeTaskInner,
  task_key: TaskKey,
  token: u64,
  webview_id: String,
  webview_generation: u64,
  terminal: bool,
  _main_thread: MainThreadMarker,
}

impl MainThreadSchemeTask {
  fn validate(&self) -> crate::Result<()> {
    if !task_is_current(self.task_key, self.token) {
      return Err(crate::Error::CustomProtocolTaskInvalid);
    }
    check_webview_generation(&self.webview_id, self.webview_generation)
  }

  fn claim_terminal(&mut self) -> bool {
    if self.terminal {
      return false;
    }
    self.terminal = true;
    remove_task_if_current(self.task_key, self.token)
  }

  fn finish_before_callback(&mut self) -> bool {
    // Claim the terminal transition before calling WebKit. If the native call
    // throws after partially succeeding, Drop must not attempt didFail too.
    self.claim_terminal()
  }

  fn fail_if_live(&mut self) {
    if self.terminal {
      return;
    }

    let webview_is_current =
      check_webview_generation(&self.webview_id, self.webview_generation).is_ok();
    // Atomically claim the registry token before the terminal callback. A
    // concurrent stop callback wins by removing the token first.
    let claimed = self.claim_terminal();
    if !claimed || !webview_is_current {
      return;
    }

    let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
      let _ = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        let error_domain = NSString::from_str("NSURLErrorDomain");
        let error = NSError::errorWithDomain_code_userInfo(&error_domain, -1000, None);
        self.inner.task.didFailWithError(&error);
      }));
    }));
  }
}

impl Drop for MainThreadSchemeTask {
  fn drop(&mut self) {
    self.fail_if_live();
    // `inner` releases its task/url retains here on the main thread after the
    // terminal transition.
  }
}

pub fn create(name: &str) -> &AnyClass {
  unsafe {
    // Include the address of WEBVIEW_STATE in the class name so that each dylib in the process
    // gets its own ObjC class with method pointers into its own code and data segments.
    let unique_id = std::ptr::addr_of!(WEBVIEW_STATE) as usize;
    let scheme_name = format!("{name}URLSchemeHandler_{unique_id:x}\0");
    let scheme_name = CStr::from_bytes_with_nul(scheme_name.as_bytes()).unwrap();
    let cls = ClassBuilder::new(scheme_name, NSObject::class());
    match cls {
      Some(mut cls) => {
        cls.add_ivar::<*mut c_char>(c"webview_id");
        cls.add_ivar::<usize>(c"protocol_index");
        cls.add_method(
          objc2::sel!(webView:startURLSchemeTask:),
          start_task as extern "C" fn(_, _, _, _),
        );
        cls.add_method(
          objc2::sel!(webView:stopURLSchemeTask:),
          stop_task as extern "C" fn(_, _, _, _),
        );
        cls.register()
      }
      None => AnyClass::get(scheme_name).expect("Failed to get the class definition"),
    }
  }
}

// Task handler for custom protocol
extern "C" fn start_task(
  this: &AnyObject,
  _sel: objc2::runtime::Sel,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  // This is a raw Objective-C entry point. Contain both Rust panics and native
  // exceptions so malformed or wake-delayed protocol work cannot abort the
  // process by unwinding across the ABI.
  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    let _ = objc2::exception::catch(AssertUnwindSafe(|| unsafe {
      start_task_inner(this, webview, task);
    }));
  }));
}

unsafe fn start_task_inner(
  this: &AnyObject,
  webview: &WryWebView,
  task: &ProtocolObject<dyn WKURLSchemeTask>,
) {
  unsafe {
    #[cfg(feature = "tracing")]
    let span = tracing::info_span!(parent: None, "wry::custom_protocol::handle", uri = tracing::field::Empty)
      .entered();

    let Some(main_thread) = MainThreadMarker::new() else {
      return;
    };

    let Some(ivar) = this.class().instance_variable(c"webview_id") else {
      return;
    };
    let webview_id_ptr: *mut c_char = *ivar.load(this);
    if webview_id_ptr.is_null() {
      return;
    }
    let Ok(webview_id) = CStr::from_ptr(webview_id_ptr).to_str() else {
      return;
    };
    // Own the id before the responder can leave this callback. The ivar's C
    // string is released with its handler and must never be borrowed async.
    let webview_id = webview_id.to_owned();

    let Some(ivar) = this.class().instance_variable(c"protocol_index") else {
      return;
    };
    let protocol_index: usize = *ivar.load(this);

    let (webview_generation, function) = {
      let state = WEBVIEW_STATE
        .read()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
      let Some(state) = state.get(&webview_id) else {
        return;
      };
      (
        state.generation,
        state.protocol_ptrs.get(protocol_index).cloned(),
      )
    };
    let mut pending = PendingSchemeTask::new(
      task.retain(),
      task_key(this, webview, task),
      webview_id.clone(),
      webview_generation,
      main_thread,
    );

    if let Some(function) = function {
      // Get url request
      let request = task.request();
      let Some(url) = request.URL() else {
        return;
      };
      let Some(absolute_url) = url.absoluteString() else {
        return;
      };
      let uri = absolute_url.to_string();
      pending.set_url(url, main_thread);

      #[cfg(feature = "tracing")]
      span.record("uri", uri.clone());

      // Get request method (GET, POST, PUT etc...)
      let method = request
        .HTTPMethod()
        .map(|method| method.to_string())
        .unwrap_or_else(|| "GET".to_string());

      // Prepare our HttpRequest
      let mut http_request = Request::builder().uri(uri).method(method.as_str());

      // Get body
      let mut sent_form_body = Vec::new();
      let body = request.HTTPBody();
      let body_stream = request.HTTPBodyStream();
      if let Some(body) = body {
        sent_form_body = body.to_vec();
      } else if let Some(body_stream) = body_stream {
        body_stream.open();

        while body_stream.hasBytesAvailable() {
          sent_form_body.reserve(128);
          let p = sent_form_body.as_mut_ptr().add(sent_form_body.len());
          let read_length = sent_form_body.capacity() - sent_form_body.len();
          let count = body_stream.read_maxLength(NonNull::new(p).unwrap(), read_length);
          match checked_stream_read_progress(
            sent_form_body.len(),
            sent_form_body.capacity(),
            read_length,
            count,
          ) {
            StreamReadProgress::Data(new_len) => sent_form_body.set_len(new_len),
            StreamReadProgress::End => break,
            StreamReadProgress::Invalid => {
              body_stream.close();
              return;
            }
          }
        }

        body_stream.close();
      }

      // Extract all headers fields
      let all_headers = request.allHTTPHeaderFields();

      // get all our headers values and inject them in our request
      if let Some(all_headers) = all_headers {
        for current_header in all_headers.allKeys().iter() {
          if let Some(header_value) = all_headers.valueForKey(&current_header) {
            // inject the header into the request
            http_request =
              http_request.header(current_header.to_string(), header_value.to_string());
          }
        }
      }

      // send response
      match http_request.body(sent_form_body) {
        Ok(final_request) => {
          let responder: Box<dyn FnOnce(HttpResponse<Cow<'static, [u8]>>)> =
            Box::new(move |sent_response| {
              queue_scheme_response(pending, sent_response);
            });

          #[cfg(feature = "tracing")]
          let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

          function(
            webview_id.as_str(),
            final_request,
            RequestAsyncResponder { responder },
          );
        }
        Err(_) => {
          let mut not_found = HttpResponse::new(Cow::Borrowed(&[] as &'static [u8]));
          *not_found.status_mut() = StatusCode::NOT_FOUND;
          queue_scheme_response(pending, not_found);
        }
      };
    } else {
      #[cfg(feature = "tracing")]
      tracing::warn!(
        "Either WebView or WebContext instance is dropped! This handler shouldn't be called."
      );
    };
  }
}

fn queue_scheme_response(
  pending: PendingSchemeTask,
  sent_response: HttpResponse<Cow<'static, [u8]>>,
) {
  let Some(state) = pending.into_state() else {
    return;
  };
  dispatch_main_async(move || {
    let Some(main_thread) = MainThreadMarker::new() else {
      remove_task_if_current(state.task_key, state.token);
      return;
    };
    let mut task = state.into_main(main_thread);

    #[cfg(feature = "tracing")]
    let _span = tracing::info_span!("wry::custom_protocol::call_handler").entered();

    let result = std::panic::catch_unwind(AssertUnwindSafe(|| {
      objc2::exception::catch(AssertUnwindSafe(|| unsafe {
        deliver_scheme_response(&mut task, sent_response)
      }))
      .map_err(|_| crate::Error::CustomProtocolTaskInvalid)
      .and_then(|result| result)
    }))
    .map_err(|_| crate::Error::CustomProtocolTaskInvalid)
    .and_then(|result| result);

    if let Err(_error) = result {
      #[cfg(feature = "tracing")]
      tracing::error!("Error responding to task: {:?}", _error);
    }
  });
}

unsafe fn deliver_scheme_response(
  task: &mut MainThreadSchemeTask,
  sent_response: HttpResponse<Cow<'static, [u8]>>,
) -> crate::Result<()> {
  unsafe {
    task.validate()?;

    let Some(url) = task.inner.url.as_ref() else {
      return Err(crate::Error::CustomProtocolTaskInvalid);
    };
    let content = sent_response.body();
    let wanted_status_code = sent_response.status().as_u16();
    let wanted_version = format!("{:#?}", sent_response.version());

    let headers = NSMutableDictionary::new();
    if let Some(mime) = sent_response
      .headers()
      .get(CONTENT_TYPE)
      .and_then(|mime| mime.to_str().ok())
    {
      headers.insert(
        &*NSString::from_str(CONTENT_TYPE.as_str()),
        &*NSString::from_str(mime),
      );
    }
    headers.insert(
      &*NSString::from_str(CONTENT_LENGTH.as_str()),
      &*NSString::from_str(&content.len().to_string()),
    );
    for (name, value) in sent_response.headers() {
      if let Ok(value) = value.to_str() {
        headers.insert(
          &*NSString::from_str(name.as_str()),
          &*NSString::from_str(value),
        );
      }
    }

    let response = NSHTTPURLResponse::initWithURL_statusCode_HTTPVersion_headerFields(
      NSHTTPURLResponse::alloc(),
      url,
      wanted_status_code as isize,
      Some(&NSString::from_str(&wanted_version)),
      Some(&headers),
    )
    .ok_or(crate::Error::CustomProtocolTaskInvalid)?;

    task.validate()?;
    task.inner.task.didReceiveResponse(&response);

    let data = NSData::initWithBytes_length(
      NSData::alloc(),
      content.as_ptr() as *mut c_void,
      content.len(),
    );
    task.validate()?;
    task.inner.task.didReceiveData(&data);

    task.validate()?;
    if !task.finish_before_callback() {
      return Err(crate::Error::CustomProtocolTaskInvalid);
    }
    task.inner.task.didFinish();
    Ok(())
  }
}

extern "C" fn stop_task(
  this: *mut AnyObject,
  _sel: objc2::runtime::Sel,
  webview: *mut AnyObject,
  task: *mut AnyObject,
) {
  // Big Sur can invoke this callback with already-released Objective-C
  // arguments during WKWebView teardown. Never form references, retain,
  // release, dereference, or message either pointer here.
  let _ = std::panic::catch_unwind(AssertUnwindSafe(|| {
    cancel_task(TaskKey {
      handler: this.cast::<()>() as usize,
      webview: webview.cast::<()>() as usize,
      task: task.cast::<()>() as usize,
    });
  }));
}

#[cfg(test)]
mod tests {
  use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc,
  };

  use objc2::runtime::AnyObject;

  use super::{
    cancel_task, check_webview_generation, checked_stream_read_progress, invoke_main_queue_job,
    next_task_token, register_task, remove_task_if_current, stop_task, task_is_current,
    SchemeTaskTransport, StreamReadProgress, TaskKey,
  };
  use crate::wkwebview::{WebViewState, WEBVIEW_STATE};

  static NEXT_TEST_KEY: AtomicUsize = AtomicUsize::new(usize::MAX / 2);

  fn test_key() -> TaskKey {
    let base = NEXT_TEST_KEY.fetch_add(4, Ordering::Relaxed);
    TaskKey {
      handler: base,
      webview: base + 1,
      task: base + 2,
    }
  }

  #[test]
  fn stream_length_validation_rejects_negative_and_oversized_reads() {
    assert_eq!(
      checked_stream_read_progress(4, 16, 12, -1),
      StreamReadProgress::Invalid
    );
    assert_eq!(
      checked_stream_read_progress(4, 16, 12, 13),
      StreamReadProgress::Invalid
    );
    assert_eq!(
      checked_stream_read_progress(usize::MAX - 1, usize::MAX, 2, 2),
      StreamReadProgress::Invalid
    );
  }

  #[test]
  fn stream_length_validation_distinguishes_eof_and_valid_data() {
    assert_eq!(
      checked_stream_read_progress(4, 16, 12, 0),
      StreamReadProgress::End
    );
    assert_eq!(
      checked_stream_read_progress(4, 16, 12, 8),
      StreamReadProgress::Data(12)
    );
  }

  #[test]
  fn task_tokens_reject_pointer_reuse_and_stale_cleanup() {
    let key = test_key();
    let first = register_task(key);
    let second = register_task(key);

    assert_ne!(first, second);
    assert!(!task_is_current(key, first));
    assert!(task_is_current(key, second));
    assert!(!remove_task_if_current(key, first));
    assert!(task_is_current(key, second));
    assert!(remove_task_if_current(key, second));
    assert!(!task_is_current(key, second));
  }

  #[test]
  fn raw_stop_callback_cancels_without_dereferencing_arguments() {
    let key = test_key();
    let token = register_task(key);
    assert!(task_is_current(key, token));

    // The object pointers are deliberately invalid. The callback may only
    // convert the task address back to an integer registry key.
    stop_task(
      key.handler as *mut AnyObject,
      objc2::sel!(webView:stopURLSchemeTask:),
      key.webview as *mut AnyObject,
      key.task as *mut AnyObject,
    );
    assert!(!task_is_current(key, token));
  }

  #[test]
  fn raw_stop_is_namespaced_to_its_handler_and_webview() {
    let stopped_key = test_key();
    let surviving_key = TaskKey {
      handler: stopped_key.handler + 10,
      webview: stopped_key.webview + 10,
      task: stopped_key.task,
    };
    let stopped_token = register_task(stopped_key);
    let surviving_token = register_task(surviving_key);

    stop_task(
      stopped_key.handler as *mut AnyObject,
      objc2::sel!(webView:stopURLSchemeTask:),
      stopped_key.webview as *mut AnyObject,
      stopped_key.task as *mut AnyObject,
    );

    assert!(!task_is_current(stopped_key, stopped_token));
    assert!(task_is_current(surviving_key, surviving_token));
    assert!(remove_task_if_current(surviving_key, surviving_token));
  }

  #[test]
  fn webview_generation_rejects_same_label_reopen() {
    let generation = next_task_token();
    let replacement_generation = next_task_token();
    let label = format!("wry-generation-test-{generation}");

    WEBVIEW_STATE
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .insert(
        label.clone(),
        WebViewState {
          generation,
          protocol_ptrs: Vec::new(),
        },
      );
    assert!(check_webview_generation(&label, generation).is_ok());

    WEBVIEW_STATE
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .insert(
        label.clone(),
        WebViewState {
          generation: replacement_generation,
          protocol_ptrs: Vec::new(),
        },
      );
    assert!(check_webview_generation(&label, generation).is_err());
    assert!(check_webview_generation(&label, replacement_generation).is_ok());

    WEBVIEW_STATE
      .write()
      .unwrap_or_else(|poisoned| poisoned.into_inner())
      .remove(&label);
  }

  #[test]
  fn main_queue_trampoline_invokes_once_and_contains_panics() {
    fn invoke<F: FnOnce()>(job: F) {
      let context = Box::into_raw(Box::new(job)).cast();
      invoke_main_queue_job::<F>(context);
    }

    let invocations = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&invocations);
    invoke(move || {
      count.fetch_add(1, Ordering::SeqCst);
      panic!("contained test panic");
    });
    assert_eq!(invocations.load(Ordering::SeqCst), 1);
  }

  #[test]
  fn only_opaque_native_transport_crosses_threads() {
    fn assert_send<T: Send>() {}
    assert_send::<SchemeTaskTransport>();
  }

  #[test]
  fn cancellation_and_terminal_claim_are_idempotent() {
    let key = test_key();
    let token = register_task(key);
    cancel_task(key);
    cancel_task(key);
    assert!(!task_is_current(key, token));
    assert!(!remove_task_if_current(key, token));
  }
}
