use std::{collections::HashSet, sync::Mutex};

pub(crate) fn record_early_web_content_termination<T>(
  pending: &Mutex<HashSet<String>>,
  label: &str,
  get_published_webview: impl FnOnce() -> Option<T>,
) -> Option<T> {
  // This lock must be acquired before the manager's webview-map lock. The
  // publication path uses the same order, making observe-none + record-pending
  // atomic with insert + consume-pending.
  let mut pending = pending
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  match get_published_webview() {
    Some(webview) => {
      pending.remove(label);
      Some(webview)
    }
    None => {
      pending.insert(label.to_string());
      None
    }
  }
}

pub(crate) fn publish_webview_and_take_early_termination(
  pending: &Mutex<HashSet<String>>,
  label: &str,
  publish: impl FnOnce(),
) -> bool {
  let mut pending = pending
    .lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner());
  publish();
  pending.remove(label)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::{
    sync::{
      atomic::{AtomicBool, Ordering},
      mpsc, Arc,
    },
    time::Duration,
  };

  #[test]
  fn termination_cannot_fall_between_publication_and_pending_handoff() {
    let pending = Arc::new(Mutex::new(HashSet::new()));
    let published = Arc::new(AtomicBool::new(false));
    let (observed_tx, observed_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();

    let callback_pending = pending.clone();
    let callback_published = published.clone();
    let callback = std::thread::spawn(move || {
      let webview = record_early_web_content_termination(&callback_pending, "child", || {
        observed_tx.send(()).unwrap();
        release_rx.recv().unwrap();
        callback_published.load(Ordering::Acquire).then_some(())
      });
      assert!(webview.is_none());
    });

    observed_rx.recv().unwrap();
    let publication_pending = pending.clone();
    let publication_published = published.clone();
    let (started_tx, started_rx) = mpsc::channel();
    let (finished_tx, finished_rx) = mpsc::channel();
    let publication = std::thread::spawn(move || {
      started_tx.send(()).unwrap();
      let terminated =
        publish_webview_and_take_early_termination(&publication_pending, "child", || {
          publication_published.store(true, Ordering::Release)
        });
      finished_tx.send(terminated).unwrap();
    });

    started_rx.recv().unwrap();
    assert!(finished_rx.recv_timeout(Duration::from_millis(20)).is_err());
    release_tx.send(()).unwrap();
    callback.join().unwrap();
    assert!(finished_rx.recv().unwrap());
    publication.join().unwrap();
    assert!(pending.lock().unwrap().is_empty());
    assert!(published.load(Ordering::Acquire));
  }
}
