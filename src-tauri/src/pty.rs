use crate::api_bridge::ApiEventBus;
use crate::api_types::StateChangeNotification;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

pub(crate) const AGENTS_UI_ZELLIJ_PREFIX: &str = "agents-ui-";
// A fresh renderer can reconstruct the recent terminal stream after WebKit
// replaces its content process. This is deliberately a byte bound rather than
// a line bound: VT output need not contain newlines, and a runaway process must
// never turn renderer recovery into unbounded native memory growth.
const PTY_REPLAY_MAX_BYTES: usize = 512 * 1024;
// A renderer can disappear while many PTYs are exiting. Retain at most one
// terminal-sized tombstone per backend session, with an explicit global cap so
// API-driven create/exit loops cannot grow native memory without bound.
const PTY_EXIT_TOMBSTONE_MAX_SESSIONS: usize = 256;
// Fixed global memory for persist IDs whose full tombstone/replay was evicted.
// The filter has no false negatives: an evicted command is never rerun by
// renderer restore. False positives are safety-biased and vanishingly rare at
// realistic session counts (1 MiB, three independent bit positions).
const PTY_EVICTED_EXIT_FILTER_BITS: usize = 8 * 1024 * 1024;
const PTY_EVICTED_EXIT_FILTER_WORDS: usize = PTY_EVICTED_EXIT_FILTER_BITS / u64::BITS as usize;
const RENDERER_CANCELED_ID_MAX: usize = 128;
const RENDERER_TICKET_MAX: usize = 128;
#[cfg(target_family = "unix")]
const AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE: &str = "/tmp/agents-ui-zellij";

#[derive(Default)]
struct EvictedPersistFilter {
    words: Vec<u64>,
}

impl EvictedPersistFilter {
    fn hash(value: &str, seed: u64) -> u64 {
        let mut hash = 0xcbf29ce484222325u64 ^ seed;
        for byte in value.as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x100000001b3);
        }
        hash
    }

    fn bit_indexes(value: &str) -> [usize; 3] {
        let first = Self::hash(value, 0x9e3779b97f4a7c15);
        let step = Self::hash(value, 0xd6e8feb86659fd93) | 1;
        [0u64, 1, 2].map(|offset| {
            first
                .wrapping_add(step.wrapping_mul(offset))
                .wrapping_rem(PTY_EVICTED_EXIT_FILTER_BITS as u64) as usize
        })
    }

    fn insert(&mut self, persist_id: &str) {
        if self.words.len() != PTY_EVICTED_EXIT_FILTER_WORDS {
            self.words.resize(PTY_EVICTED_EXIT_FILTER_WORDS, 0);
        }
        for bit in Self::bit_indexes(persist_id) {
            self.words[bit / u64::BITS as usize] |= 1u64 << (bit % u64::BITS as usize);
        }
    }

    fn contains(&self, persist_id: &str) -> bool {
        self.words.len() == PTY_EVICTED_EXIT_FILTER_WORDS
            && Self::bit_indexes(persist_id).iter().all(|bit| {
                self.words[*bit / u64::BITS as usize] & (1u64 << (*bit % u64::BITS as usize)) != 0
            })
    }
}

#[derive(Default)]
struct RendererDeliveryState {
    listener_id: Option<String>,
    // Live exit events stay here until the frontend explicitly discards the
    // exited tab. A native renderer-termination notification atomically
    // promotes every retained entry into recovery tombstones.
    pending_live_exits: VecDeque<SessionExitTombstone>,
    exit_tombstones: VecDeque<SessionExitTombstone>,
    exit_tombstones_truncated: bool,
    evicted_exit_persist_ids: EvictedPersistFilter,
    canceled_renderer_ids: VecDeque<String>,
    content_generation: u64,
    renderer_tickets: VecDeque<(String, u64)>,
}

// Output emitters and the listener-ready handshake take this mutex before
// deciding whether to emit. The handshake snapshots every replay buffer while
// holding it, then enables delivery. Consequently, every output chunk is
// either present in the returned snapshot or emitted to the installed listener
// (and may harmlessly be in both; sequence numbers let the frontend dedupe).
static RENDERER_DELIVERY: Mutex<RendererDeliveryState> = Mutex::new(RendererDeliveryState {
    listener_id: None,
    pending_live_exits: VecDeque::new(),
    exit_tombstones: VecDeque::new(),
    exit_tombstones_truncated: false,
    evicted_exit_persist_ids: EvictedPersistFilter { words: Vec::new() },
    canceled_renderer_ids: VecDeque::new(),
    content_generation: 0,
    renderer_tickets: VecDeque::new(),
});

#[cfg(target_os = "macos")]
#[derive(Default)]
struct LoginPathCache {
    initialized: bool,
    shell: Option<String>,
    path: Option<String>,
}

#[derive(Default)]
struct AppStateInner {
    next_id: AtomicU64,
    sessions: Mutex<HashMap<String, PtySession>>,
    creating_persist_ids: Mutex<HashSet<String>>,
    session_created: Condvar,
    #[cfg(target_os = "macos")]
    login_path_cache: Mutex<LoginPathCache>,
    #[cfg(target_family = "unix")]
    shells_cache: Mutex<Option<Vec<ShellInfo>>>,
}

#[derive(Clone, Default)]
pub struct AppState {
    inner: Arc<AppStateInner>,
}

impl AppState {
    /// (launch command, child pid) for every live session. The auto-caffeinate
    /// watcher derives SSH activity from this PTY-table ground truth rather
    /// than trusting frontend session state.
    pub fn ssh_activity_snapshot(&self) -> Vec<(String, Option<u32>)> {
        match self.inner.sessions.lock() {
            Ok(sessions) => sessions
                .values()
                .map(|s| (s.command.clone(), s.child_pid))
                .collect(),
            Err(_) => Vec::new(),
        }
    }
}

struct PtySession {
    persist_id: Option<String>,
    name: String,
    command: String,
    cwd: Option<String>,
    io: PtySessionIo,
    child_pid: Option<u32>,
    replay: Arc<Mutex<PtyReplayBuffer>>,
}

#[derive(Clone)]
struct PtySessionIo {
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    child: Arc<Mutex<Box<dyn portable_pty::Child + Send>>>,
    killer: Arc<Mutex<Box<dyn ChildKiller + Send + Sync>>>,
    recording: Arc<Mutex<Option<SessionRecording>>>,
    closing: Arc<AtomicBool>,
}

struct SessionRecording {
    id: String,
    writer: BufWriter<std::fs::File>,
    started_at: Instant,
    last_flush: Instant,
    unflushed_bytes: usize,
    input_buffer: String,
    json_buf: Vec<u8>,
    enc_key: Option<[u8; 32]>,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub persist_id: Option<String>,
    pub name: String,
    pub command: String,
    pub cwd: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PtyOutput {
    id: Arc<str>,
    persist_id: Option<Arc<str>>,
    sequence: u64,
    data: String,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PtyReplayChunk {
    pub sequence: u64,
    pub data: String,
}

#[derive(Default)]
struct PtyReplayBuffer {
    chunks: VecDeque<PtyReplayChunk>,
    total_bytes: usize,
    last_sequence: u64,
    truncated: bool,
}

impl PtyReplayBuffer {
    fn append(&mut self, data: &str) -> u64 {
        self.append_with_limit(data, PTY_REPLAY_MAX_BYTES)
    }

    fn append_with_limit(&mut self, data: &str, max_bytes: usize) -> u64 {
        self.last_sequence = self.last_sequence.wrapping_add(1).max(1);
        let sequence = self.last_sequence;
        self.total_bytes = self.total_bytes.saturating_add(data.len());
        self.chunks.push_back(PtyReplayChunk {
            sequence,
            data: data.to_string(),
        });

        while self.total_bytes > max_bytes {
            let Some(removed) = self.chunks.pop_front() else {
                self.total_bytes = 0;
                break;
            };
            self.total_bytes = self.total_bytes.saturating_sub(removed.data.len());
            self.truncated = true;
        }
        sequence
    }

    fn snapshot(&self) -> (Vec<PtyReplayChunk>, u64, bool) {
        (
            self.chunks.iter().cloned().collect(),
            self.last_sequence,
            self.truncated,
        )
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionReplaySnapshot {
    pub id: String,
    pub persist_id: Option<String>,
    pub replay: Vec<PtyReplayChunk>,
    pub replay_through_sequence: u64,
    pub replay_truncated: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionAttachResult {
    #[serde(flatten)]
    pub session: SessionInfo,
    pub adopted: bool,
    pub exited: bool,
    pub exit_code: Option<u32>,
    pub replay: Vec<PtyReplayChunk>,
    pub replay_through_sequence: u64,
    pub replay_truncated: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SessionExitTombstone {
    #[serde(flatten)]
    pub session: SessionInfo,
    pub exit_code: Option<u32>,
    pub replay: Vec<PtyReplayChunk>,
    pub replay_through_sequence: u64,
    pub replay_truncated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RendererListenerReady {
    pub renderer_id: String,
    pub sessions: Vec<SessionReplaySnapshot>,
    pub exits: Vec<SessionExitTombstone>,
    pub exits_truncated: bool,
}

#[derive(Debug, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RendererListenerTicket {
    pub renderer_id: String,
    pub content_generation: u64,
}

#[derive(Serialize, Clone)]
struct PtyExit {
    id: String,
    exit_code: Option<u32>,
    renderer_recovery: bool,
}

fn session_info(id: &str, session: &PtySession) -> SessionInfo {
    SessionInfo {
        id: id.to_string(),
        persist_id: session.persist_id.clone(),
        name: session.name.clone(),
        command: session.command.clone(),
        cwd: session.cwd.clone(),
    }
}

fn session_io(inner: &AppStateInner, id: &str) -> Result<PtySessionIo, String> {
    let sessions = inner
        .sessions
        .lock()
        .map_err(|_| "state poisoned".to_string())?;
    sessions
        .get(id)
        .map(|session| session.io.clone())
        .ok_or_else(|| "unknown session".to_string())
}

fn try_claim_session_closing(closing: &AtomicBool) -> bool {
    !closing.swap(true, Ordering::AcqRel)
}

fn replay_snapshot(id: &str, session: &PtySession) -> SessionReplaySnapshot {
    let replay = session
        .replay
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let (chunks, through_sequence, truncated) = replay.snapshot();
    SessionReplaySnapshot {
        id: id.to_string(),
        persist_id: session.persist_id.clone(),
        replay: chunks,
        replay_through_sequence: through_sequence,
        replay_truncated: truncated,
    }
}

fn session_attach_result(id: &str, session: &PtySession, adopted: bool) -> SessionAttachResult {
    let snapshot = replay_snapshot(id, session);
    SessionAttachResult {
        session: session_info(id, session),
        adopted,
        exited: false,
        exit_code: None,
        replay: snapshot.replay,
        replay_through_sequence: snapshot.replay_through_sequence,
        replay_truncated: snapshot.replay_truncated,
    }
}

fn session_exit_tombstone(
    id: &str,
    session: &PtySession,
    exit_code: Option<u32>,
) -> SessionExitTombstone {
    let snapshot = replay_snapshot(id, session);
    SessionExitTombstone {
        session: session_info(id, session),
        exit_code,
        replay: snapshot.replay,
        replay_through_sequence: snapshot.replay_through_sequence,
        replay_truncated: snapshot.replay_truncated,
    }
}

fn tombstone_attach_result(tombstone: &SessionExitTombstone) -> SessionAttachResult {
    SessionAttachResult {
        session: tombstone.session.clone(),
        adopted: true,
        exited: true,
        exit_code: tombstone.exit_code,
        replay: tombstone.replay.clone(),
        replay_through_sequence: tombstone.replay_through_sequence,
        replay_truncated: tombstone.replay_truncated,
    }
}

fn truncated_exit_attach_result(
    persist_id: &str,
    name: Option<&str>,
    command: Option<&str>,
    cwd: Option<&str>,
) -> SessionAttachResult {
    SessionAttachResult {
        session: SessionInfo {
            id: format!("exited-{persist_id}"),
            persist_id: Some(persist_id.to_string()),
            name: name.unwrap_or("session").to_string(),
            command: command.unwrap_or_default().to_string(),
            cwd: cwd.map(str::to_string),
        },
        adopted: true,
        exited: true,
        exit_code: None,
        replay: Vec::new(),
        replay_through_sequence: 0,
        replay_truncated: true,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DeliveryTarget {
    RendererAndNativeApi,
    NativeApiOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RetainedExitLocation {
    PendingLive,
    RecoveryTombstone,
}

impl RendererDeliveryState {
    fn push_retained_exit(
        &mut self,
        location: RetainedExitLocation,
        tombstone: SessionExitTombstone,
    ) {
        // A session can move from the live-listener queue into the recovery
        // queue, but it must never consume a slot in both. Keeping this
        // de-duplication global also makes the bound below a true aggregate
        // cap rather than two independent per-queue caps.
        self.pending_live_exits
            .retain(|existing| existing.session.id != tombstone.session.id);
        self.exit_tombstones
            .retain(|existing| existing.session.id != tombstone.session.id);
        match location {
            RetainedExitLocation::PendingLive => self.pending_live_exits.push_back(tombstone),
            RetainedExitLocation::RecoveryTombstone => self.exit_tombstones.push_back(tombstone),
        }

        while self.pending_live_exits.len() + self.exit_tombstones.len()
            > PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        {
            // Pending entries back direct events that the current renderer may
            // not yet have consumed. Prefer evicting an older recovery entry;
            // either kind is still recorded in the fixed-memory persist-ID
            // filter so restore can never rerun an evicted command.
            let evicted = self
                .exit_tombstones
                .pop_front()
                .or_else(|| self.pending_live_exits.pop_front());
            if let Some(evicted) = evicted {
                self.remember_evicted_exit(evicted);
            } else {
                break;
            }
        }
        debug_assert!(
            self.pending_live_exits.len() + self.exit_tombstones.len()
                <= PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        );
    }

    fn remember_evicted_exit(&mut self, tombstone: SessionExitTombstone) {
        self.exit_tombstones_truncated = true;
        if let Some(persist_id) = tombstone.session.persist_id.as_deref() {
            self.evicted_exit_persist_ids.insert(persist_id);
        }
    }

    fn delivery_target(&self) -> DeliveryTarget {
        if self.listener_id.is_some() {
            DeliveryTarget::RendererAndNativeApi
        } else {
            DeliveryTarget::NativeApiOnly
        }
    }

    /// Returns true when the installed renderer must receive the normal direct
    /// exit event. Such events remain pending until JS acknowledges them, so a
    /// content-process termination racing event delivery can promote them to
    /// recovery tombstones without rerunning the command.
    fn classify_exit(&mut self, tombstone: Option<SessionExitTombstone>) -> bool {
        let renderer_live = self.listener_id.is_some();
        if let Some(tombstone) = tombstone {
            let location = if renderer_live {
                RetainedExitLocation::PendingLive
            } else {
                RetainedExitLocation::RecoveryTombstone
            };
            self.push_retained_exit(location, tombstone);
        }
        renderer_live
    }

    fn promote_pending_exits(&mut self) {
        while let Some(pending) = self.pending_live_exits.pop_front() {
            self.push_retained_exit(RetainedExitLocation::RecoveryTombstone, pending);
        }
    }

    fn mark_unavailable(&mut self) {
        self.listener_id = None;
        self.promote_pending_exits();
    }

    fn mark_unavailable_if_listener(&mut self, renderer_id: &str) -> bool {
        if self.listener_id.as_deref() != Some(renderer_id) {
            return false;
        }
        self.mark_unavailable();
        true
    }

    fn remember_canceled_renderer(&mut self, renderer_id: &str) {
        self.canceled_renderer_ids
            .retain(|existing| existing != renderer_id);
        self.canceled_renderer_ids
            .push_back(renderer_id.to_string());
        while self.canceled_renderer_ids.len() > RENDERER_CANCELED_ID_MAX {
            self.canceled_renderer_ids.pop_front();
        }
    }

    fn cancel_renderer(&mut self, renderer_id: &str) {
        self.remember_canceled_renderer(renderer_id);
        self.renderer_tickets
            .retain(|(ticket_id, _)| ticket_id != renderer_id);
        self.mark_unavailable_if_listener(renderer_id);
    }

    fn cancel_current_renderer(&mut self) {
        if let Some(renderer_id) = self.listener_id.clone() {
            self.remember_canceled_renderer(&renderer_id);
            self.renderer_tickets
                .retain(|(ticket_id, _)| ticket_id != &renderer_id);
        }
        self.mark_unavailable();
    }

    fn terminate_content_generation(&mut self) {
        self.content_generation = self.content_generation.wrapping_add(1);
        // A ticket is issued only after JavaScript has awaited the native
        // response. Clearing every ticket therefore invalidates all ready
        // invokes that an abruptly terminated content process could have
        // queued, including the no-current-listener window.
        self.renderer_tickets.clear();
        self.cancel_current_renderer();
    }

    fn renderer_was_canceled(&self, renderer_id: &str) -> bool {
        self.canceled_renderer_ids
            .iter()
            .any(|existing| existing == renderer_id)
    }

    fn issue_renderer_ticket(
        &mut self,
        renderer_id: String,
    ) -> Result<RendererListenerTicket, &'static str> {
        if self.renderer_was_canceled(&renderer_id) {
            return Err("renderer listener registration was canceled");
        }
        self.renderer_tickets
            .retain(|(ticket_id, _)| ticket_id != &renderer_id);
        let content_generation = self.content_generation;
        self.renderer_tickets
            .push_back((renderer_id.clone(), content_generation));
        while self.renderer_tickets.len() > RENDERER_TICKET_MAX {
            self.renderer_tickets.pop_front();
        }
        Ok(RendererListenerTicket {
            renderer_id,
            content_generation,
        })
    }

    fn validate_renderer_ticket(
        &self,
        renderer_id: &str,
        content_generation: u64,
    ) -> Result<(), &'static str> {
        if self.renderer_was_canceled(renderer_id) {
            return Err("renderer listener registration was canceled");
        }
        if content_generation != self.content_generation
            || !self.renderer_tickets.iter().any(|(ticket_id, generation)| {
                ticket_id == renderer_id && *generation == content_generation
            })
        {
            return Err("renderer content generation expired");
        }
        Ok(())
    }

    fn try_enable_renderer(
        &mut self,
        renderer_id: String,
        content_generation: u64,
    ) -> Result<(Vec<SessionExitTombstone>, bool), &'static str> {
        self.validate_renderer_ticket(&renderer_id, content_generation)?;
        self.renderer_tickets.retain(|(ticket_id, generation)| {
            ticket_id != &renderer_id || *generation != content_generation
        });
        Ok(self.enable_renderer(renderer_id))
    }

    /// Completes an already-published exit without creating new retained state.
    /// A deliberate respawn/close can remove the placeholder while child.wait()
    /// is in progress; in that case this must remain a no-op.
    fn update_retained_exit_code(
        &mut self,
        id: &str,
        exit_code: Option<u32>,
    ) -> Option<RetainedExitLocation> {
        if let Some(exit) = self
            .pending_live_exits
            .iter_mut()
            .find(|exit| exit.session.id == id)
        {
            exit.exit_code = exit_code;
            return Some(RetainedExitLocation::PendingLive);
        }
        if let Some(exit) = self
            .exit_tombstones
            .iter_mut()
            .find(|exit| exit.session.id == id)
        {
            exit.exit_code = exit_code;
            return Some(RetainedExitLocation::RecoveryTombstone);
        }
        None
    }

    fn retained_exit_for_create(
        &self,
        persist_id: &str,
        respawn: bool,
    ) -> Option<SessionAttachResult> {
        if respawn {
            return None;
        }
        self.exit_tombstones
            .iter()
            .rev()
            .chain(self.pending_live_exits.iter().rev())
            .find(|tombstone| tombstone.session.persist_id.as_deref() == Some(persist_id))
            .map(tombstone_attach_result)
    }

    fn evicted_exit_for_create(
        &self,
        persist_id: &str,
        restore_existing: bool,
        name: Option<&str>,
        command: Option<&str>,
        cwd: Option<&str>,
    ) -> Option<SessionAttachResult> {
        self.evicted_exit_persist_ids.contains(persist_id).then(|| {
            // Startup restore has authoritative saved metadata. Other
            // idempotent calls remain suppressed too, but use a neutral label;
            // only explicit `respawn: true` may rerun the command.
            truncated_exit_attach_result(
                persist_id,
                restore_existing.then_some(name).flatten(),
                restore_existing.then_some(command).flatten(),
                restore_existing.then_some(cwd).flatten(),
            )
        })
    }

    fn enable_renderer(&mut self, renderer_id: String) -> (Vec<SessionExitTombstone>, bool) {
        // A ready handshake from a different content process supersedes the old
        // listener even if its cleanup/termination callback has not arrived.
        // Its unacknowledged direct exits now belong in the new renderer's
        // recovery snapshot, not in an invisible old-listener pending set.
        if self.listener_id.as_deref() != Some(renderer_id.as_str()) {
            self.promote_pending_exits();
        }
        let exits = self.exit_tombstones.iter().cloned().collect();
        let exits_truncated = self.exit_tombstones_truncated;
        self.listener_id = Some(renderer_id);
        (exits, exits_truncated)
    }

    fn remove_exit_by_id(&mut self, id: &str) {
        self.pending_live_exits
            .retain(|tombstone| tombstone.session.id != id);
        self.exit_tombstones
            .retain(|tombstone| tombstone.session.id != id);
    }

    fn remove_exits_by_persist_id(&mut self, persist_id: &str) {
        self.pending_live_exits
            .retain(|tombstone| tombstone.session.persist_id.as_deref() != Some(persist_id));
        self.exit_tombstones
            .retain(|tombstone| tombstone.session.persist_id.as_deref() != Some(persist_id));
    }
}

struct SessionCreationReservation<'a> {
    inner: &'a AppStateInner,
    persist_id: String,
}

impl Drop for SessionCreationReservation<'_> {
    fn drop(&mut self) {
        let mut creating = self
            .inner
            .creating_persist_ids
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        creating.remove(&self.persist_id);
        self.inner.session_created.notify_all();
    }
}

enum SessionCreationStart<'a> {
    Adopted(SessionAttachResult),
    Reserved(SessionCreationReservation<'a>),
}

fn reserve_or_adopt_session<'a>(
    inner: &'a AppStateInner,
    persist_id: &str,
) -> Result<SessionCreationStart<'a>, String> {
    let mut creating = inner
        .creating_persist_ids
        .lock()
        .map_err(|_| "session creation state poisoned".to_string())?;

    loop {
        let adopted = {
            let sessions = inner
                .sessions
                .lock()
                .map_err(|_| "state poisoned".to_string())?;
            sessions
                .iter()
                .filter(|(_, session)| {
                    !session.io.closing.load(Ordering::Acquire)
                        && session.persist_id.as_deref() == Some(persist_id)
                })
                // Prefer the oldest backend ID if an older build already left
                // duplicate attachments behind. New creation is serialized, so
                // this compatibility branch is not reached for new sessions.
                .min_by_key(|(id, _)| id.parse::<u64>().unwrap_or(u64::MAX))
                .map(|(id, session)| session_attach_result(id, session, true))
        };
        if let Some(adopted) = adopted {
            return Ok(SessionCreationStart::Adopted(adopted));
        }

        if creating.insert(persist_id.to_string()) {
            return Ok(SessionCreationStart::Reserved(SessionCreationReservation {
                inner,
                persist_id: persist_id.to_string(),
            }));
        }

        creating = inner
            .session_created
            .wait(creating)
            .map_err(|_| "session creation state poisoned".to_string())?;
    }
}

fn normalized_renderer_id(renderer_id: String) -> Result<String, String> {
    let renderer_id = renderer_id.trim();
    if renderer_id.is_empty() {
        return Err("rendererId is required".to_string());
    }
    if renderer_id.len() > 128 {
        return Err("rendererId is too long".to_string());
    }
    Ok(renderer_id.to_string())
}

fn notify_native_api(app: &AppHandle, event: &str, data: serde_json::Value) {
    let Some(event_bus) = app.try_state::<ApiEventBus>() else {
        return;
    };
    let _ = event_bus.sender().send(StateChangeNotification {
        event: event.to_string(),
        data,
    });
}

fn notify_native_api_output(app: &AppHandle, id: &str, data: &str) {
    notify_native_api(
        app,
        "sessions.output",
        serde_json::json!({
            "sessionId": id,
            "output": data,
        }),
    );
}

fn notify_native_api_exit(app: &AppHandle, id: &str, exit_code: Option<u32>) {
    notify_native_api(
        app,
        "sessions.exit",
        serde_json::json!({
            "sessionId": id,
            "exitCode": exit_code,
        }),
    );
}

/// Stops PTY output from being serialized into JavaScript while the main
/// WebContent process is absent. The native lifecycle hook can call this
/// directly; output continues to enter each bounded replay buffer.
pub fn mark_renderer_unavailable() {
    let mut delivery = RENDERER_DELIVERY
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    delivery.terminate_content_generation();
}

/// Issues a content-generation ticket before JavaScript installs listeners.
/// The caller must await this response; an abrupt WebContent termination then
/// invalidates the ticket before any late ready invoke can be queued.
#[tauri::command]
pub fn renderer_listener_ticket(renderer_id: String) -> Result<RendererListenerTicket, String> {
    let renderer_id = normalized_renderer_id(renderer_id)?;
    let mut delivery = RENDERER_DELIVERY
        .lock()
        .map_err(|_| "renderer delivery state poisoned".to_string())?;
    delivery
        .issue_renderer_ticket(renderer_id)
        .map_err(str::to_string)
}

/// React cleanup uses a renderer-scoped ID so a late cleanup from an older
/// StrictMode mount cannot disable a newer listener that is already ready.
#[tauri::command]
pub fn renderer_listener_unavailable(renderer_id: String) -> Result<(), String> {
    let renderer_id = normalized_renderer_id(renderer_id)?;
    let mut delivery = RENDERER_DELIVERY
        .lock()
        .map_err(|_| "renderer delivery state poisoned".to_string())?;
    delivery.cancel_renderer(&renderer_id);
    Ok(())
}

/// Atomically snapshots retained output and enables future live events. The JS
/// caller must install both output and exit listeners before invoking this.
#[tauri::command]
pub fn renderer_listener_ready(
    state: State<'_, AppState>,
    renderer_id: String,
    content_generation: u64,
) -> Result<RendererListenerReady, String> {
    let renderer_id = normalized_renderer_id(renderer_id)?;
    let mut delivery = RENDERER_DELIVERY
        .lock()
        .map_err(|_| "renderer delivery state poisoned".to_string())?;
    // Reject stale content before cloning any potentially large replay state.
    // The same delivery lock remains held until the listener is enabled, so a
    // native termination cannot invalidate this check between the two steps.
    delivery
        .validate_renderer_ticket(&renderer_id, content_generation)
        .map_err(str::to_string)?;
    let replay_sources = {
        let sessions = state
            .inner
            .sessions
            .lock()
            .map_err(|_| "state poisoned".to_string())?;
        sessions
            .iter()
            .filter(|(_, session)| !session.io.closing.load(Ordering::Acquire))
            .map(|(id, session)| {
                (
                    id.clone(),
                    session.persist_id.clone(),
                    session.replay.clone(),
                )
            })
            .collect::<Vec<_>>()
    };

    let mut snapshots = Vec::with_capacity(replay_sources.len());
    for (id, persist_id, replay) in replay_sources {
        let replay = replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let (chunks, through_sequence, truncated) = replay.snapshot();
        snapshots.push(SessionReplaySnapshot {
            id,
            persist_id,
            replay: chunks,
            replay_through_sequence: through_sequence,
            replay_truncated: truncated,
        });
    }
    snapshots.sort_by(|a, b| a.id.cmp(&b.id));
    let (mut exits, exits_truncated) = delivery
        .try_enable_renderer(renderer_id.clone(), content_generation)
        .map_err(str::to_string)?;
    exits.sort_by(|a, b| a.session.id.cmp(&b.session.id));
    // main.rs marks PTY delivery unavailable before it marks display recovery
    // unavailable. Calling this while still holding the delivery lock preserves
    // that ordering if WebContent terminates concurrently with a successful
    // ready command: termination will invalidate delivery and then set the
    // display flag after this call, never the other way around.
    crate::display_recovery::renderer_listener_ready();
    drop(delivery);
    Ok(RendererListenerReady {
        renderer_id,
        sessions: snapshots,
        exits,
        exits_truncated,
    })
}

/// Emitted when a session's requested shell couldn't be launched and we fell
/// back to the default. The UI surfaces `message` as a non-fatal toast.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ShellFallbackEvent {
    session_id: String,
    message: String,
}

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(target_family = "unix")]
fn agents_ui_zellij_session_name(persist_id: &str) -> String {
    let mut out = String::with_capacity(AGENTS_UI_ZELLIJ_PREFIX.len() + persist_id.len());
    out.push_str(AGENTS_UI_ZELLIJ_PREFIX);
    for ch in persist_id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('_');
        }
    }
    if out == AGENTS_UI_ZELLIJ_PREFIX {
        out.push_str("session");
    }
    out
}

#[cfg(target_family = "unix")]
fn find_bundled_zellij() -> Option<PathBuf> {
    let sidecar = sidecar_path("zellij").filter(|p| p.is_file());
    if sidecar.is_some() {
        return sidecar;
    }
    #[cfg(debug_assertions)]
    {
        let dev = dev_sidecar_path("zellij").filter(|p| p.is_file());
        if dev.is_some() {
            return dev;
        }
    }
    None
}

fn valid_env_key(key: &str) -> bool {
    let trimmed = key.trim();
    let mut chars = trimmed.chars();
    let first = match chars.next() {
        Some(c) => c,
        None => return false,
    };
    if !(first == '_' || first.is_ascii_alphabetic()) {
        return false;
    }
    for c in chars {
        if !(c == '_' || c.is_ascii_alphanumeric()) {
            return false;
        }
    }
    true
}

fn capture_original_env(cmd: &mut CommandBuilder, name: &str, present_key: &str, value_key: &str) {
    match std::env::var_os(name) {
        Some(v) => {
            cmd.env(present_key, "1");
            cmd.env(value_key, v);
        }
        None => {
            cmd.env(present_key, "0");
            cmd.env(value_key, "");
        }
    }
}

fn validated_shell_path(shell: &str) -> Option<String> {
    let path = Path::new(shell);
    (path.is_absolute() && is_executable_file(path)).then(|| shell.to_string())
}

#[cfg(target_family = "unix")]
fn shell_from_passwd() -> Option<String> {
    let user = std::env::var("USER")
        .or_else(|_| std::env::var("LOGNAME"))
        .ok()?;
    let prefix = format!("{user}:");
    let contents = fs::read_to_string("/etc/passwd").ok()?;
    for line in contents.lines() {
        if !line.starts_with(&prefix) {
            continue;
        }
        let shell = line.split(':').last()?;
        return validated_shell_path(shell);
    }
    None
}

fn default_user_shell() -> String {
    if let Ok(shell) = std::env::var("SHELL") {
        if let Some(shell) = validated_shell_path(&shell) {
            return shell;
        }
    }

    #[cfg(target_family = "unix")]
    if let Some(shell) = shell_from_passwd() {
        return shell;
    }

    #[cfg(target_os = "macos")]
    {
        return "/bin/zsh".to_string();
    }

    #[cfg(not(target_os = "macos"))]
    {
        if Path::new("/bin/bash").is_file() {
            return "/bin/bash".to_string();
        }
        return "/bin/sh".to_string();
    }
}

fn run_command_output_with_timeout(
    cmd: Command,
    timeout: Duration,
    label: &str,
) -> Result<std::process::Output, String> {
    run_command_output_with_timeout_bounded(cmd, timeout, label, 256 * 1024, 256 * 1024)
}

fn read_pipe_bounded(mut reader: impl Read, limit: usize) -> (Vec<u8>, bool) {
    let mut output = Vec::with_capacity(limit.min(8192));
    let mut chunk = [0u8; 8192];
    let mut exceeded = false;
    loop {
        match reader.read(&mut chunk) {
            Ok(0) => break,
            Ok(read) => {
                let remaining = limit.saturating_sub(output.len());
                let keep = read.min(remaining);
                output.extend_from_slice(&chunk[..keep]);
                exceeded |= keep < read;
            }
            Err(_) => break,
        }
    }
    (output, exceeded)
}

fn run_command_output_with_timeout_bounded(
    mut cmd: Command,
    timeout: Duration,
    label: &str,
    stdout_limit: usize,
    stderr_limit: usize,
) -> Result<std::process::Output, String> {
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("{label} failed: {e}"))?;

    let stdout_pipe = child
        .stdout
        .take()
        .ok_or_else(|| format!("{label} failed: missing stdout pipe"))?;
    let stderr_pipe = child
        .stderr
        .take()
        .ok_or_else(|| format!("{label} failed: missing stderr pipe"))?;

    let (stdout_tx, stdout_rx) = mpsc::channel::<(Vec<u8>, bool)>();
    let (stderr_tx, stderr_rx) = mpsc::channel::<(Vec<u8>, bool)>();
    std::thread::spawn(move || {
        let _ = stdout_tx.send(read_pipe_bounded(stdout_pipe, stdout_limit));
    });
    std::thread::spawn(move || {
        let _ = stderr_tx.send(read_pipe_bounded(stderr_pipe, stderr_limit));
    });

    let started = Instant::now();
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(format!("{label} timed out after {}ms", timeout.as_millis()));
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(format!("{label} failed: {e}")),
        }
    };

    let (stdout, stdout_exceeded) = stdout_rx
        .recv_timeout(Duration::from_millis(200))
        .unwrap_or_else(|_| (Vec::new(), true));
    let (stderr, stderr_exceeded) = stderr_rx
        .recv_timeout(Duration::from_millis(200))
        .unwrap_or_else(|_| (Vec::new(), true));
    if stdout_exceeded || stderr_exceeded {
        return Err(format!("{label} exceeded its bounded output limit"));
    }

    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn unique_nul_marker(output: &[u8], marker: &[u8]) -> Option<usize> {
    if marker.is_empty() {
        return None;
    }
    let mut found = None;
    for (index, window) in output.windows(marker.len() + 1).enumerate() {
        if &window[..marker.len()] == marker && window[marker.len()] == 0 {
            if found.replace(index).is_some() {
                return None;
            }
        }
    }
    found
}

fn extract_nul_framed_utf8(
    output: &[u8],
    magic: &[u8],
    trailer: &[u8],
    output_limit: usize,
    value_limit: usize,
) -> Option<String> {
    if output.len() > output_limit || magic.is_empty() || trailer.is_empty() {
        return None;
    }
    let magic_end = unique_nul_marker(output, magic)? + magic.len();
    let trailer_start = unique_nul_marker(output, trailer)?;
    let value_start = magic_end + 1;
    let value_end = output[value_start..]
        .iter()
        .position(|byte| *byte == 0)?
        + value_start;
    let value = &output[value_start..value_end];
    if value.is_empty() || value.len() > value_limit {
        return None;
    }
    if value_end + 1 != trailer_start {
        return None;
    }
    std::str::from_utf8(value).ok().map(str::to_owned)
}

fn has_complete_nul_frame(output: &[u8], magic: &[u8], trailer: &[u8]) -> bool {
    let Some(magic_end) = unique_nul_marker(output, magic).map(|start| start + magic.len()) else {
        return false;
    };
    let value_start = magic_end + 1;
    let Some(value_end) = output[value_start..]
        .iter()
        .position(|byte| *byte == 0)
        .map(|offset| value_start + offset)
    else {
        return false;
    };
    unique_nul_marker(output, trailer).is_some_and(|start| start == value_end + 1)
}

fn random_frame_token(label: &str) -> Result<String, String> {
    let mut nonce = [0u8; 16];
    OsRng
        .try_fill_bytes(&mut nonce)
        .map_err(|error| format!("generate login-shell PATH frame nonce failed: {error}"))?;
    let nonce = nonce
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(format!("__AGENTS_UI_{label}_{}__", nonce))
}

fn path_to_utf8_string(path: &Path, context: &str) -> Result<String, String> {
    path.to_str()
        .map(str::to_owned)
        .ok_or_else(|| format!("{context} is not valid UTF-8"))
}

#[cfg(target_os = "macos")]
fn push_exact_absolute_path_entry(path_entries: &mut Vec<String>, value: &str) {
    // Shell startup scripts can pollute PATH with diagnostic text. Reject
    // malformed entries, but never turn one path into another by trimming it.
    if value.is_empty()
        || !value.starts_with('/')
        || value.contains('\n')
        || value.contains('\r')
    {
        return;
    }
    if !path_entries.iter().any(|path| path == value) {
        path_entries.push(value.to_string());
    }
}

#[cfg(target_os = "macos")]
fn login_shell_path(shell: &str, base_path: &str) -> Option<String> {
    let shell_name = Path::new(shell)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    const CAPTURE_MAX_BYTES: usize = 64 * 1024;
    const PATH_MAX_BYTES: usize = 32 * 1024;
    let magic = random_frame_token("PATH_V2").ok()?;
    let trailer = random_frame_token("PATH_DONE_V2").ok()?;

    let (script, arg_sets): (String, Vec<Vec<&str>>) =
        if shell_name.contains("zsh") || shell_name.contains("bash") {
            (
                format!("printf '%s\\0%s\\0%s\\0' '{magic}' \"$PATH\" '{trailer}'"),
                vec![vec!["-i", "-l", "-c"]],
            )
        } else if shell_name == "fish" {
            (
                format!(
                    "printf '%s\\0%s\\0%s\\0' '{magic}' (string join ':' $PATH) '{trailer}'"
                ),
                vec![vec!["-i", "-l", "-c"], vec!["-l", "-c"]],
            )
        } else if shell_name == "nu" || shell_name == "nushell" {
            (
                format!(
                    "print --no-newline $\"{magic}(char --integer 0)($env.PATH | str join ':')(char --integer 0){trailer}(char --integer 0)\""
                ),
                vec![vec!["-l", "-c"], vec!["-i", "-l", "-c"]],
            )
        } else {
            return None;
        };

    let run_with_pty = |args: &[&str]| -> Option<Vec<u8>> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .ok()?;

        let mut cmd = CommandBuilder::new(shell);
        cmd.args(args);
        cmd.arg(&script);
        cmd.env("PATH", base_path);
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
        cmd.env("SHELL", shell);

        let mut child = pair.slave.spawn_command(cmd).ok()?;
        let mut reader = pair.master.try_clone_reader().ok()?;
        let reader_magic = magic.as_bytes().to_vec();
        let reader_trailer = trailer.as_bytes().to_vec();
        let (tx, rx) = mpsc::channel::<Option<Vec<u8>>>();
        std::thread::spawn(move || {
            let mut buf = [0u8; 4096];
            let mut output = Vec::new();
            let mut valid = true;

            loop {
                match reader.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        let remaining = CAPTURE_MAX_BYTES.saturating_sub(output.len());
                        let keep = n.min(remaining);
                        output.extend_from_slice(&buf[..keep]);
                        if has_complete_nul_frame(
                            &output,
                            &reader_magic,
                            &reader_trailer,
                        ) {
                            break;
                        }
                        if keep < n {
                            valid = false;
                            break;
                        }
                    }
                    Err(_) => {
                        valid = false;
                        break;
                    }
                }
            }

            let _ = tx.send(valid.then_some(output));
        });

        let output = match rx.recv_timeout(Duration::from_millis(2000)) {
            Ok(data) => data,
            Err(RecvTimeoutError::Timeout) | Err(RecvTimeoutError::Disconnected) => None,
        };

        let _ = child.kill();
        let _ = child.wait();

        output
    };

    for args in &arg_sets {
        if let Some(stdout) = run_with_pty(args.as_slice()) {
            if let Some(path) = extract_nul_framed_utf8(
                &stdout,
                magic.as_bytes(),
                trailer.as_bytes(),
                CAPTURE_MAX_BYTES,
                PATH_MAX_BYTES,
            ) {
                return Some(path);
            }
        }
    }

    for args in arg_sets {
        let mut cmd = Command::new(shell);
        cmd.args(&args)
            .arg(&script)
            .env("PATH", base_path)
            .env("TERM", "xterm-256color")
            .env("COLORTERM", "truecolor")
            .env("SHELL", shell);
        let out = match run_command_output_with_timeout_bounded(
            cmd,
            Duration::from_millis(2000),
            "login shell PATH probe",
            CAPTURE_MAX_BYTES,
            CAPTURE_MAX_BYTES,
        ) {
            Ok(out) => out,
            Err(_) => continue,
        };

        if let Some(path) = extract_nul_framed_utf8(
            &out.stdout,
            magic.as_bytes(),
            trailer.as_bytes(),
            CAPTURE_MAX_BYTES,
            PATH_MAX_BYTES,
        ) {
            return Some(path);
        }
    }

    None
}

#[cfg(target_family = "unix")]
struct ShellXdgPaths {
    config_home: PathBuf,
    data_home: PathBuf,
    cache_home: PathBuf,
    runtime_dir: PathBuf,
}

#[cfg(target_family = "unix")]
fn ensure_shell_xdg_paths(app: &AppHandle) -> Option<ShellXdgPaths> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell");
    let config_home = base.join("xdg-config");
    let data_home = base.join("xdg-data");
    let cache_home = base.join("xdg-cache");
    let runtime_dir = base.join("xdg-runtime");

    fs::create_dir_all(&config_home).ok()?;
    fs::create_dir_all(&data_home).ok()?;
    fs::create_dir_all(&cache_home).ok()?;
    fs::create_dir_all(&runtime_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&runtime_dir, fs::Permissions::from_mode(0o700));
    }

    Some(ShellXdgPaths {
        config_home,
        data_home,
        cache_home,
        runtime_dir,
    })
}

#[cfg(target_family = "unix")]
struct ZellijPaths {
    home_dir: PathBuf,
    socket_dir: PathBuf,
}

#[cfg(target_family = "unix")]
fn ensure_preferred_zellij_socket_dir(app: &AppHandle) -> Option<PathBuf> {
    let home = app.path().home_dir().ok()?;
    let base = home.join(".agents-ui-zellij");
    fs::create_dir_all(&base).ok()?;
    let socket_dir = base.join("sockets");
    fs::create_dir_all(&socket_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&base, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
    }

    Some(socket_dir)
}

#[cfg(target_family = "unix")]
fn legacy_zellij_socket_dir() -> PathBuf {
    PathBuf::from(AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE).join("sockets")
}

#[cfg(target_family = "unix")]
fn existing_legacy_zellij_socket_dir() -> Option<PathBuf> {
    let socket_dir = legacy_zellij_socket_dir();
    if socket_dir.is_dir() {
        Some(socket_dir)
    } else {
        None
    }
}

#[cfg(target_family = "unix")]
fn ensure_legacy_zellij_socket_dir() -> Option<PathBuf> {
    let socket_base = PathBuf::from(AGENTS_UI_ZELLIJ_LEGACY_SOCKET_BASE);
    fs::create_dir_all(&socket_base).ok()?;
    let socket_dir = socket_base.join("sockets");
    fs::create_dir_all(&socket_dir).ok()?;

    #[cfg(target_family = "unix")]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&socket_base, fs::Permissions::from_mode(0o700));
        let _ = fs::set_permissions(&socket_dir, fs::Permissions::from_mode(0o700));
    }

    Some(socket_dir)
}

#[cfg(target_family = "unix")]
fn zellij_socket_dir_candidates(preferred: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    out.push(preferred.to_path_buf());

    if let Some(legacy) = existing_legacy_zellij_socket_dir() {
        if legacy != preferred {
            out.push(legacy);
        }
    }

    out
}

#[cfg(target_family = "unix")]
fn ensure_zellij_paths(app: &AppHandle) -> Option<ZellijPaths> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("zellij");
    fs::create_dir_all(&base).ok()?;

    // Store sockets in a stable per-user path so sessions survive app restarts without relying on /tmp.
    // Fallback to the legacy /tmp dir if we cannot create the preferred location (or in older installs).
    let socket_dir =
        ensure_preferred_zellij_socket_dir(app).or_else(|| ensure_legacy_zellij_socket_dir())?;

    Some(ZellijPaths {
        home_dir: base,
        socket_dir,
    })
}

#[cfg(target_family = "unix")]
fn zellij_list_sessions(
    zellij: &Path,
    zellij_home: &Path,
    socket_dir: &Path,
) -> Result<Vec<String>, String> {
    let mut cmd = Command::new(zellij);
    cmd.args(["list-sessions", "--short", "--no-formatting"])
        .env("HOME", zellij_home)
        .env("ZELLIJ_SOCKET_DIR", socket_dir);
    let out = run_command_output_with_timeout(
        cmd,
        Duration::from_millis(2000),
        "bundled zellij list-sessions",
    )?;

    if out.status.success() {
        let stdout = String::from_utf8_lossy(&out.stdout);
        let mut sessions = Vec::new();
        for line in stdout.lines() {
            let name = line.trim();
            if !name.is_empty() {
                sessions.push(name.to_string());
            }
        }
        return Ok(sessions);
    }

    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let combined = format!("{stdout}\n{stderr}");
    if out.status.code() == Some(1) && combined.contains("No active zellij sessions found") {
        return Ok(Vec::new());
    }

    let msg = if !stderr.is_empty() {
        stderr
    } else if !stdout.is_empty() {
        stdout
    } else {
        "zellij list-sessions failed".to_string()
    };
    Err(msg)
}

#[cfg(target_family = "unix")]
fn ensure_zellij_config(app: &AppHandle) -> Option<PathBuf> {
    let zellij_paths = ensure_zellij_paths(app)?;
    let config_dir = zellij_paths.home_dir.join(".config").join("zellij");
    fs::create_dir_all(&config_dir).ok()?;
    let config_path = config_dir.join("config.kdl");

    // Minimal config tuned for embedded terminals (xterm.js) to avoid feature probes that can hang.
    let contents = r#"// Agents UI managed Zellij config
// This is stored in an app-private HOME so it won't affect system zellij installs.

simplified_ui true
support_kitty_keyboard_protocol false
show_startup_tips false
show_release_notes false
"#;

    let needs_write = match fs::read_to_string(&config_path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&config_path, contents).ok()?;
    }

    Some(config_path)
}

#[cfg(target_family = "unix")]
fn ensure_zellij_shell_wrapper(app: &AppHandle) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell");
    fs::create_dir_all(&base).ok()?;

    let path = base.join("zellij-shell-wrapper.sh");
    let contents = r#"#!/bin/sh
set -e

restore() {
  name="$1"
  present="$2"
  value="$3"
  if [ "$present" = "1" ]; then
    export "$name=$value"
  else
    unset "$name"
  fi
}

restore HOME "${AGENTS_UI_ORIG_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_HOME:-}"

if [ "${AGENTS_UI_ZELLIJ_RESTORE_XDG:-0}" = "1" ]; then
  restore XDG_CONFIG_HOME "${AGENTS_UI_ORIG_XDG_CONFIG_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_CONFIG_HOME:-}"
  restore XDG_DATA_HOME "${AGENTS_UI_ORIG_XDG_DATA_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_DATA_HOME:-}"
  restore XDG_CACHE_HOME "${AGENTS_UI_ORIG_XDG_CACHE_HOME_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_CACHE_HOME:-}"
  restore XDG_RUNTIME_DIR "${AGENTS_UI_ORIG_XDG_RUNTIME_DIR_PRESENT:-0}" "${AGENTS_UI_ORIG_XDG_RUNTIME_DIR:-}"
fi

shell="${AGENTS_UI_ZELLIJ_REAL_SHELL:-/bin/sh}"
if [ "${AGENTS_UI_ZELLIJ_LOGIN:-1}" = "1" ]; then
  exec "$shell" -l "$@"
fi
exec "$shell" "$@"
"#;

    let needs_write = match fs::read_to_string(&path) {
        Ok(existing) => existing != contents,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&path, contents).ok()?;
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&path, fs::Permissions::from_mode(0o755));
        }
    }

    Some(path)
}

#[cfg(target_family = "unix")]
fn zsh_zdotdir_path(app: &AppHandle, key: &str) -> Option<PathBuf> {
    let app_data = app.path().app_data_dir().ok()?;
    let base = app_data.join("shell").join("zsh");
    fs::create_dir_all(&base).ok()?;
    let safe = agents_ui_zellij_session_name(key);
    let dir = base.join(format!("zdotdir-{safe}"));
    fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PersistentSessionInfo {
    pub persist_id: String,
    pub session_name: String,
}

#[tauri::command]
pub fn list_persistent_sessions(app: AppHandle) -> Result<Vec<PersistentSessionInfo>, String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = app;
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij =
            find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths =
            ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;
        let mut sessions: Vec<PersistentSessionInfo> = Vec::new();
        let mut list_errors: Vec<String> = Vec::new();

        for socket_dir in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            match zellij_list_sessions(&zellij, &zellij_paths.home_dir, &socket_dir) {
                Ok(list) => {
                    for session_name in list {
                        if !session_name.starts_with(AGENTS_UI_ZELLIJ_PREFIX) {
                            continue;
                        }
                        let persist_id = session_name
                            .strip_prefix(AGENTS_UI_ZELLIJ_PREFIX)
                            .unwrap_or("")
                            .to_string();
                        sessions.push(PersistentSessionInfo {
                            persist_id,
                            session_name,
                        });
                    }
                }
                Err(err) => list_errors.push(err),
            }
        }

        if sessions.is_empty() && !list_errors.is_empty() {
            return Err(list_errors.remove(0));
        }

        sessions.sort_by(|a, b| a.persist_id.cmp(&b.persist_id));
        sessions.dedup_by(|a, b| a.session_name == b.session_name);
        Ok(sessions)
    }
}

#[tauri::command]
pub fn kill_persistent_session(app: AppHandle, persist_id: String) -> Result<(), String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = (app, persist_id);
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let zellij =
            find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let zellij_paths =
            ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;
        let trimmed = persist_id.trim();
        if trimmed.is_empty() {
            return Err("missing persist id".to_string());
        }
        let session_name = agents_ui_zellij_session_name(trimmed);
        if !session_name.starts_with(AGENTS_UI_ZELLIJ_PREFIX) {
            return Err("refusing to kill non agents-ui session".to_string());
        }

        let mut last_err: Option<String> = None;

        for socket_dir in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            let out = Command::new(&zellij)
                .args(["kill-session", &session_name])
                .env("HOME", &zellij_paths.home_dir)
                .env("ZELLIJ_SOCKET_DIR", &socket_dir)
                .output()
                .map_err(|e| format!("failed to run bundled zellij: {e}"))?;
            if out.status.success() {
                return Ok(());
            }

            let fallback = Command::new(&zellij)
                .args(["delete-session", "--force", &session_name])
                .env("HOME", &zellij_paths.home_dir)
                .env("ZELLIJ_SOCKET_DIR", &socket_dir)
                .output()
                .ok();
            if let Some(out) = fallback {
                if out.status.success() {
                    return Ok(());
                }
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = Some(stderr);
                }
            } else {
                let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
                if !stderr.is_empty() {
                    last_err = Some(stderr);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| format!("failed to kill zellij session {session_name}")))
    }
}

fn write_recording_event(rec: &mut SessionRecording, t: u64, data: &str) -> Result<(), String> {
    let data = match rec.enc_key.as_ref() {
        Some(key) => crate::secure::encrypt_string_with_key(
            key,
            crate::secure::SecretContext::Recording,
            data,
        )?,
        None => data.to_string(),
    };
    let line =
        crate::recording::RecordingLineV1::Input(crate::recording::RecordingEventV1 { t, data });
    rec.json_buf.clear();
    serde_json::to_writer(&mut rec.json_buf, &line)
        .map_err(|e| format!("serialize failed: {e}"))?;
    rec.writer
        .write_all(&rec.json_buf)
        .map_err(|e| format!("write failed: {e}"))?;
    rec.writer
        .write_all(b"\n")
        .map_err(|e| format!("write failed: {e}"))?;
    rec.unflushed_bytes += rec.json_buf.len() + 1;
    Ok(())
}

fn skip_csi(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        // CSI sequence terminator is any byte in 0x40..=0x7E.
        if ('@'..='~').contains(&ch) {
            break;
        }
    }
}

fn skip_until_st(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        if ch == '\u{1b}' {
            if let Some('\\') = iter.peek().copied() {
                iter.next();
                break;
            }
        }
    }
}

fn skip_osc(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    while let Some(ch) = iter.next() {
        if ch == '\u{7}' {
            break;
        }
        if ch == '\u{1b}' {
            if let Some('\\') = iter.peek().copied() {
                iter.next();
                break;
            }
        }
    }
}

fn skip_escape_sequence(iter: &mut std::iter::Peekable<std::str::Chars<'_>>) {
    match iter.peek().copied() {
        Some('[') => {
            iter.next();
            skip_csi(iter);
        }
        Some(']') => {
            iter.next();
            skip_osc(iter);
        }
        Some('P') | Some('^') | Some('_') => {
            iter.next();
            skip_until_st(iter);
        }
        Some(_) => {
            // Unknown single-char escape sequence.
            iter.next();
        }
        None => {}
    }
}

fn record_user_input(rec: &mut SessionRecording, data: &str) -> Result<(), String> {
    let t = rec.started_at.elapsed().as_millis() as u64;
    let mut wrote_any = false;

    let mut iter = data.chars().peekable();
    while let Some(ch) = iter.next() {
        match ch {
            '\r' => {
                // Treat CRLF as a single enter.
                if iter.peek().copied() == Some('\n') {
                    iter.next();
                }
                let mut line = std::mem::take(&mut rec.input_buffer);
                line.push('\r');
                write_recording_event(rec, t, &line)?;
                wrote_any = true;
            }
            '\n' => {
                let mut line = std::mem::take(&mut rec.input_buffer);
                line.push('\n');
                write_recording_event(rec, t, &line)?;
                wrote_any = true;
            }
            '\u{7f}' | '\u{8}' => {
                rec.input_buffer.pop();
            }
            '\u{15}' => {
                rec.input_buffer.clear();
            }
            '\t' => {}
            '\u{1b}' => skip_escape_sequence(&mut iter),
            c if c.is_control() => {}
            c => rec.input_buffer.push(c),
        }
    }

    let should_flush = wrote_any
        || rec.unflushed_bytes >= 16 * 1024
        || rec.last_flush.elapsed().as_millis() >= 1500;
    if should_flush {
        rec.writer
            .flush()
            .map_err(|e| format!("flush failed: {e}"))?;
        rec.last_flush = Instant::now();
        rec.unflushed_bytes = 0;
    }
    Ok(())
}

fn unique_name(existing: &HashMap<String, PtySession>, base: &str) -> String {
    let taken: std::collections::HashSet<&str> =
        existing.values().map(|s| s.name.as_str()).collect();
    if !taken.contains(base) {
        return base.to_string();
    }
    let mut n = 2;
    loop {
        let candidate = format!("{base}-{n}");
        if !taken.contains(candidate.as_str()) {
            return candidate;
        }
        n += 1;
    }
}

fn decode_utf8_stream(carry: &mut Vec<u8>, chunk: &[u8]) -> String {
    if chunk.is_empty() {
        return String::new();
    }

    // Fast path: no leftover bytes from previous call — validate chunk directly
    // without copying into carry, avoiding re-validation of already-processed data.
    if carry.is_empty() {
        match std::str::from_utf8(chunk) {
            Ok(s) => return s.to_string(),
            Err(e) => {
                let valid = e.valid_up_to();
                let mut out = String::with_capacity(chunk.len());
                if valid > 0 {
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&chunk[..valid]) });
                }
                match e.error_len() {
                    None => {
                        // Incomplete multi-byte at end — stash tail in carry
                        carry.extend_from_slice(&chunk[valid..]);
                        return out;
                    }
                    Some(len) => {
                        out.push('\u{FFFD}');
                        // Fall through to slow path for remaining bytes
                        carry.extend_from_slice(&chunk[valid + len..]);
                    }
                }
                if carry.is_empty() {
                    return out;
                }
                // Remaining bytes after the error — process via slow path
                let rest = std::mem::take(carry);
                let tail = decode_utf8_stream(carry, &rest);
                out.push_str(&tail);
                return out;
            }
        }
    }

    // Slow path: carry has leftover bytes from a previous incomplete sequence.
    // Typically only 1-3 bytes, so re-validating the full buffer is cheap.
    carry.extend_from_slice(chunk);

    let mut out = String::with_capacity(carry.len());
    let mut idx = 0usize;
    while idx < carry.len() {
        match std::str::from_utf8(&carry[idx..]) {
            Ok(s) => {
                out.push_str(s);
                idx = carry.len();
                break;
            }
            Err(e) => {
                let valid = e.valid_up_to();
                if valid > 0 {
                    let end = idx + valid;
                    out.push_str(unsafe { std::str::from_utf8_unchecked(&carry[idx..end]) });
                    idx = end;
                }

                match e.error_len() {
                    None => break,
                    Some(len) => {
                        out.push('\u{FFFD}');
                        idx = (idx + len).min(carry.len());
                    }
                }
            }
        }
    }

    if idx > 0 {
        carry.drain(..idx);
    }
    out
}

#[cfg(target_family = "unix")]
fn sh_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for ch in s.chars() {
        if ch == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(ch);
        }
    }
    out.push('\'');
    out
}

#[cfg(target_family = "unix")]
fn write_zsh_startup_files(temp_dir: &Path, orig_dir: &Path) -> Result<(), String> {
    let zshenv = temp_dir.join(".zshenv");
    let zprofile = temp_dir.join(".zprofile");
    let zlogin = temp_dir.join(".zlogin");
    let zshrc = temp_dir.join(".zshrc");

    let orig_zshenv = orig_dir.join(".zshenv");
    let orig_zprofile = orig_dir.join(".zprofile");
    let orig_zlogin = orig_dir.join(".zlogin");
    let orig_zshrc = orig_dir.join(".zshrc");

    let orig_dir_str = path_to_utf8_string(orig_dir, "shell startup directory")?;

    let source_if_exists = |path: &Path| -> Result<String, String> {
        let path_str = path_to_utf8_string(path, "shell startup file")?;
        Ok(format!(
            "if [ -f {q} ]; then source {q}; fi\n",
            q = sh_single_quote(&path_str)
        ))
    };

    let orig_dir_quoted = sh_single_quote(&orig_dir_str);

    let wrap_source = |orig_file: &Path, restore_to_temp: bool| -> Result<String, String> {
        let mut out = String::new();
        out.push_str("typeset -g __agents_ui_temp_zdotdir=\"$ZDOTDIR\"\n");
        out.push_str(&format!("export ZDOTDIR={orig_dir_quoted}\n"));
        out.push_str(&source_if_exists(orig_file)?);
        if restore_to_temp {
            out.push_str("export ZDOTDIR=\"$__agents_ui_temp_zdotdir\"\n");
        }
        out.push_str("unset __agents_ui_temp_zdotdir\n");
        Ok(out)
    };

    fs::write(&zshenv, wrap_source(&orig_zshenv, true)?).map_err(|e| e.to_string())?;
    fs::write(&zprofile, wrap_source(&orig_zprofile, true)?).map_err(|e| e.to_string())?;
    fs::write(&zlogin, wrap_source(&orig_zlogin, false)?).map_err(|e| e.to_string())?;

    let mut zshrc_contents = wrap_source(&orig_zshrc, false)?;
    zshrc_contents.push_str(
        r#"
__agents_ui_emit_cwd() {
  printf '\033]1337;CurrentDir=%s\007' "$PWD"
  printf '\033]1337;Command=\007'
}

__agents_ui_emit_command() { printf '\033]1337;Command=%s\007' "$1"; }

typeset -ga precmd_functions preexec_functions
precmd_functions+=__agents_ui_emit_cwd
preexec_functions+=__agents_ui_emit_command
__agents_ui_emit_cwd

# OSC 133 shell integration (installed after the user's zshrc so prompt
# config there cannot clobber the hooks).
if [[ -z "$__AGENTS_UI_SHELL_INTEGRATION" ]]; then
  __AGENTS_UI_SHELL_INTEGRATION=1

  __agents_ui_osc133_precmd() {
    local exit_code=$?
    # D marker for the previous command, then A marker for the new prompt.
    print -Pn "\e]133;D;${exit_code}\a\e]133;A\a"
  }

  __agents_ui_osc133_preexec() {
    # C marker when the command begins executing.
    print -Pn '\e]133;C\a'
  }

  # PREPEND to precmd so we capture $? before other hooks can modify it.
  precmd_functions=(__agents_ui_osc133_precmd "${precmd_functions[@]}")
  preexec_functions+=__agents_ui_osc133_preexec

  # B marker at the end of the prompt (prompt end = input start). $'...' turns
  # \e/\a into real bytes — zsh prompt expansion does not process backslash
  # escapes; %{...%} marks the sequence as zero-width.
  PS1=$PS1$'%{\e]133;B\a%}'
fi
"#,
    );
    fs::write(&zshrc, zshrc_contents).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(target_family = "unix")]
fn sidecar_path(name: &str) -> Option<PathBuf> {
    std::env::current_exe().ok()?.parent().map(|p| p.join(name))
}

#[cfg(all(target_family = "unix", debug_assertions))]
fn dev_sidecar_path(name: &str) -> Option<PathBuf> {
    let triple = if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "aarch64-apple-darwin"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "x86_64") {
        "x86_64-apple-darwin"
    } else {
        return None;
    };
    Some(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("bin")
            .join(format!("{name}-{triple}")),
    )
}

#[cfg(target_family = "unix")]
fn find_bundled_nu() -> Option<PathBuf> {
    let sidecar = sidecar_path("nu").filter(|p| p.is_file());
    if sidecar.is_some() {
        return sidecar;
    }
    #[cfg(debug_assertions)]
    {
        let dev = dev_sidecar_path("nu").filter(|p| p.is_file());
        if dev.is_some() {
            return dev;
        }
    }
    None
}

#[cfg(target_family = "unix")]
fn find_bundled_agsh() -> Option<PathBuf> {
    let sidecar = sidecar_path("agsh").filter(|p| p.is_file());
    if sidecar.is_some() {
        return sidecar;
    }
    #[cfg(debug_assertions)]
    {
        let dev = dev_sidecar_path("agsh").filter(|p| p.is_file());
        if dev.is_some() {
            return dev;
        }
    }
    None
}

// ───────────────────────── Bring-your-own-shell ─────────────────────────
//
// The app bundles two shells — agsh (the default interactive shell) and
// Nushell — and this block lets a user instead launch one of their own
// installed shells (zsh / bash / fish / …) per project or per session.
// Detection is advisory and never blocks a launch: if a chosen shell is
// missing at spawn time `resolve_shell` falls back to the default.

/// A shell selection passed from the frontend to `create_session`.
/// `kind == "bundled-agsh"` (or `None`) keeps the default bundled agsh;
/// `kind == "bundled-nu"` launches the bundled Nushell sidecar;
/// `kind == "system"` launches `path` (an installed shell binary).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellChoice {
    pub kind: String,
    #[serde(default)]
    pub path: Option<String>,
    // The frontend also sends `family` (for its own display); we re-derive the
    // family from the path at spawn time, so any extra fields are ignored here.
}

/// One detected shell offered in the picker.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    /// Stable key: canonical path, or "bundled-nu" / "bundled-agsh" for built-ins.
    pub id: String,
    /// "bundled-nu" | "bundled-agsh" | "system"
    pub kind: String,
    /// "nu" | "agsh" | "zsh" | "bash" | "fish" | "sh" | "dash" | "ksh" | …
    pub family: String,
    pub display_name: String,
    /// Absolute launch path; empty for the bundled shell (resolved at spawn).
    pub path: String,
    pub version: Option<String>,
    /// Liveness probe succeeded (we got a version string).
    pub verified: bool,
    /// This is the user's login shell ($SHELL / passwd).
    pub is_login_default: bool,
    /// We provide PATH-import + OSC shell-integration for this family.
    pub supports_integration: bool,
}

fn shell_family_from_name(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    if n == "nu" || n == "nushell" {
        "nu"
    } else if n.contains("agsh") {
        "agsh"
    } else if n.contains("pwsh") || n.contains("powershell") {
        "pwsh"
    } else if n.contains("fish") {
        "fish"
    } else if n.contains("zsh") {
        "zsh"
    } else if n.contains("bash") {
        "bash"
    } else if n.contains("xonsh") {
        "xonsh"
    } else if n.contains("elvish") {
        "elvish"
    } else if n.contains("tcsh") {
        "tcsh"
    } else if n.contains("dash") {
        "dash"
    } else if n.contains("ksh") {
        "ksh"
    } else if n.contains("csh") {
        "csh"
    } else if n == "sh" {
        "sh"
    } else {
        "other"
    }
}

fn shell_display_name(family: &str, file_name: &str) -> String {
    match family {
        "nu" => "Nushell".to_string(),
        "agsh" => "agsh".to_string(),
        "zsh" => "Zsh".to_string(),
        "bash" => "Bash".to_string(),
        "fish" => "Fish".to_string(),
        "sh" => "sh".to_string(),
        "dash" => "Dash".to_string(),
        "ksh" => "Ksh".to_string(),
        "tcsh" => "Tcsh".to_string(),
        "csh" => "Csh".to_string(),
        "pwsh" => "PowerShell".to_string(),
        "xonsh" => "Xonsh".to_string(),
        "elvish" => "Elvish".to_string(),
        _ => file_name.to_string(),
    }
}

fn file_name_of(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string()
}

fn shell_supports_integration(family: &str) -> bool {
    matches!(family, "nu" | "zsh" | "bash" | "fish")
}

fn is_executable_file(path: &Path) -> bool {
    #[cfg(target_family = "unix")]
    {
    use std::os::unix::fs::PermissionsExt;
    return match fs::metadata(path) {
        // `fs::metadata` follows symlinks, so /usr/local/bin/zsh → /bin/zsh works.
        Ok(m) => m.is_file() && (m.permissions().mode() & 0o111 != 0),
        Err(_) => false,
    };
    }
    #[cfg(not(target_family = "unix"))]
    {
        path.is_file()
    }
}

/// Best-effort version string. Only shells known to accept `--version` and exit
/// promptly are probed; everything is timeout- and stdin-guarded so a hostile or
/// hanging binary can never wedge detection.
#[cfg(target_family = "unix")]
fn probe_shell_version(path: &str, family: &str) -> Option<String> {
    if !matches!(family, "nu" | "agsh" | "zsh" | "bash" | "fish" | "pwsh") {
        return None;
    }
    let mut cmd = Command::new(path);
    cmd.arg("--version");
    cmd.stdin(Stdio::null());
    cmd.env("TERM", "dumb");
    let out =
        run_command_output_with_timeout(cmd, Duration::from_millis(1500), "shell version probe")
            .ok()?;
    let text = String::from_utf8_lossy(&out.stdout);
    let line = text.lines().find(|l| !l.trim().is_empty())?.trim();
    if line.is_empty() {
        None
    } else {
        Some(line.chars().take(120).collect())
    }
}

#[cfg(target_family = "unix")]
fn push_unique_exact_path(paths: &mut Vec<String>, path: &str) {
    if !path.is_empty() && !paths.iter().any(|existing| existing == path) {
        paths.push(path.to_string());
    }
}

/// Union of candidate shell paths from several independent sources, so one
/// failing source can never blank the list.
#[cfg(target_family = "unix")]
fn shell_candidate_paths() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();

    // 1. /etc/shells — canonical login-approved shells on macOS.
    if let Ok(contents) = fs::read_to_string("/etc/shells") {
        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            push_unique_exact_path(&mut out, line);
        }
    }

    // 2. $SHELL — the user's configured login shell.
    if let Ok(s) = std::env::var("SHELL") {
        if let Some(s) = validated_shell_path(&s) {
            push_unique_exact_path(&mut out, &s);
        }
    }

    // 3. passwd entry.
    if let Some(s) = shell_from_passwd() {
        push_unique_exact_path(&mut out, &s);
    }

    // 4. Well-known absolute paths.
    const NAMES: [&str; 11] = [
        "zsh", "bash", "fish", "nu", "agsh", "pwsh", "dash", "ksh", "tcsh", "elvish", "xonsh",
    ];
    const DIRS: [&str; 5] = [
        "/bin",
        "/usr/bin",
        "/usr/local/bin",
        "/opt/homebrew/bin",
        "/run/current-system/sw/bin",
    ];
    for d in DIRS {
        for n in NAMES {
            let p = format!("{d}/{n}");
            if Path::new(&p).exists() {
                push_unique_exact_path(&mut out, &p);
            }
        }
    }

    // 5. PATH lookup — catches nonstandard prefixes (nix, asdf, custom).
    if let Ok(path_var) = std::env::var("PATH") {
        for dir in path_var.split(':') {
            if dir.is_empty() {
                continue;
            }
            for n in NAMES {
                let p = format!("{dir}/{n}");
                if Path::new(&p).exists() {
                    push_unique_exact_path(&mut out, &p);
                }
            }
        }
    }

    out
}

#[cfg(target_family = "unix")]
fn detect_shells_uncached() -> Vec<ShellInfo> {
    let login_default = default_user_shell();
    let login_default_canon = fs::canonicalize(&login_default)
        .unwrap_or_else(|_| PathBuf::from(&login_default));

    let mut seen: Vec<PathBuf> = Vec::new();
    let mut shells: Vec<ShellInfo> = Vec::new();

    // Bundled shells come first: agsh (the app default), then Nushell. Both
    // ship inside the app bundle, so `path` stays empty and is resolved at
    // spawn time — a stored choice survives the app being moved or updated.
    if find_bundled_agsh().is_some() {
        shells.push(ShellInfo {
            id: "bundled-agsh".to_string(),
            kind: "bundled-agsh".to_string(),
            family: "agsh".to_string(),
            display_name: "Bundled agsh".to_string(),
            path: String::new(),
            version: None,
            verified: true,
            is_login_default: false,
            supports_integration: false,
        });
    }
    if find_bundled_nu().is_some() {
        shells.push(ShellInfo {
            id: "bundled-nu".to_string(),
            kind: "bundled-nu".to_string(),
            family: "nu".to_string(),
            display_name: "Bundled Nushell".to_string(),
            path: String::new(),
            version: None,
            verified: true,
            is_login_default: false,
            supports_integration: true,
        });
    }

    for cand in shell_candidate_paths() {
        if !is_executable_file(Path::new(&cand)) {
            continue;
        }
        // Dedupe by canonical (symlink-resolved) path.
        let canon = fs::canonicalize(&cand).unwrap_or_else(|_| PathBuf::from(&cand));
        if seen.iter().any(|s| s == &canon) {
            continue;
        }
        seen.push(canon.clone());

        let fname = file_name_of(&cand);
        let family = shell_family_from_name(&fname).to_string();
        let version = probe_shell_version(&cand, &family);
        let is_login_default = canon == login_default_canon;
        // ShellInfo is serialized as UTF-8. If a canonical symlink target is
        // not representable, keep the exact user-visible launch path as the ID
        // instead of substituting replacement characters.
        let id = canon
            .to_str()
            .map(str::to_owned)
            .unwrap_or_else(|| cand.clone());
        shells.push(ShellInfo {
            id,
            kind: "system".to_string(),
            display_name: shell_display_name(&family, &fname),
            supports_integration: shell_supports_integration(&family),
            family,
            path: cand,
            verified: version.is_some(),
            version,
            is_login_default,
        });
    }

    shells
}

/// Enumerate installed shells for the picker. Cached; pass `refresh = true`
/// (the "Rescan" affordance) to force a re-detect. Never errors on Unix and
/// always includes the bundled shell, so the picker is never empty.
#[tauri::command]
pub fn detect_shells(
    state: State<'_, AppState>,
    refresh: Option<bool>,
) -> Result<Vec<ShellInfo>, String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = (state, refresh);
        Ok(Vec::new())
    }
    #[cfg(target_family = "unix")]
    {
        let refresh = refresh.unwrap_or(false);
        if !refresh {
            if let Ok(cache) = state.inner.shells_cache.lock() {
                if let Some(cached) = cache.as_ref() {
                    return Ok(cached.clone());
                }
            }
        }
        let shells = detect_shells_uncached();
        if let Ok(mut cache) = state.inner.shells_cache.lock() {
            *cache = Some(shells.clone());
        }
        Ok(shells)
    }
}

/// The interactive shell a session will actually launch.
#[cfg(target_family = "unix")]
enum ResolvedShell {
    /// Bundled Nushell. Carries the resolved `nu` binary path.
    BundledNu(PathBuf),
    /// Bundled agsh (the default). Carries the resolved `agsh` binary path.
    BundledAgsh(PathBuf),
    /// A user-installed shell at this absolute path.
    System(String),
}

/// Resolve a frontend `ShellChoice` into a concrete shell, falling back to the
/// default (bundled agsh, else bundled nu, else `$SHELL`) when a chosen shell
/// is missing. Returns an optional warning describing any fallback.
#[cfg(target_family = "unix")]
fn resolve_shell(
    choice: Option<&ShellChoice>,
    default_shell: &str,
) -> (ResolvedShell, Option<String>) {
    let default_resolved = || match find_bundled_agsh() {
        Some(agsh) => ResolvedShell::BundledAgsh(agsh),
        None => match find_bundled_nu() {
            Some(nu) => ResolvedShell::BundledNu(nu),
            None => ResolvedShell::System(default_shell.to_string()),
        },
    };

    match choice {
        Some(c) if c.kind == "system" => match c.path.as_deref() {
            Some(p) if validated_shell_path(p).is_some() => {
                (ResolvedShell::System(p.to_string()), None)
            }
            Some(p) => (
                default_resolved(),
                Some(format!(
                    "Selected shell \"{p}\" was not found; started the default shell instead."
                )),
            ),
            None => (default_resolved(), None),
        },
        Some(c) if c.kind == "bundled-nu" => match find_bundled_nu() {
            Some(nu) => (ResolvedShell::BundledNu(nu), None),
            None => (
                default_resolved(),
                Some(
                    "Bundled Nushell is missing in this build; started the default shell instead."
                        .to_string(),
                ),
            ),
        },
        // `None` / "bundled-agsh" (and anything unrecognized) ⇒ the app default.
        _ => (default_resolved(), None),
    }
}

#[cfg(target_family = "unix")]
fn interactive_login_args(path: &str) -> Vec<String> {
    match shell_family_from_name(&file_name_of(path)) {
        // fish only enters interactive mode reliably with an explicit -i.
        "fish" => vec!["-l".to_string(), "-i".to_string()],
        // agsh has no login/interactive flags; bare invocation is interactive.
        "agsh" => Vec::new(),
        _ => vec!["-l".to_string()],
    }
}

/// Whether this shell accepts `-l` (used by the zellij wrapper's login exec).
#[cfg(target_family = "unix")]
fn shell_accepts_login_flag(path: &str) -> bool {
    shell_family_from_name(&file_name_of(path)) != "agsh"
}

#[cfg(target_family = "unix")]
fn ensure_nu_config(
    app: &AppHandle,
    env_keys: &[String],
) -> Option<(String, String, String, String)> {
    let xdg = ensure_shell_xdg_paths(app)?;
    let config_home = xdg.config_home;
    let data_home = xdg.data_home;
    let cache_home = xdg.cache_home;
    let runtime_dir = xdg.runtime_dir;

    let nu_config_dir = config_home.join("nushell");
    let nu_data_dir = data_home.join("nushell");
    let nu_cache_dir = cache_home.join("nushell");

    fs::create_dir_all(&nu_config_dir).ok()?;
    fs::create_dir_all(&nu_data_dir).ok()?;
    fs::create_dir_all(&nu_cache_dir).ok()?;

    let config_path = nu_config_dir.join("config.nu");
    let mut config = String::new();
    config.push_str("# Agents UI managed Nushell config\n\n");
    config.push_str("$env.config = ($env.config | upsert show_banner false)\n\n");
    config.push_str(
        "# Shell integration: emit OSC 133 prompt/command marks (A/B/C/D) so the\n# frontend can build command blocks.\n$env.config = ($env.config | upsert shell_integration.osc133 true)\n\n",
    );
    config.push_str(
        r#"# Completion UX (standalone)
$env.config = ($env.config | upsert completions.algorithm "fuzzy")

$env.config = ($env.config | upsert menus [
  {
    name: completion_menu
    only_buffer_difference: false
    marker: "| "
    type: {
      layout: columnar
      columns: 4
      col_width: 20
      col_padding: 2
    }
    style: {
      text: green
      selected_text: green_reverse
      description_text: yellow
    }
  }
  {
    name: history_menu
    only_buffer_difference: true
    marker: "? "
    type: {
      layout: list
      page_size: 12
    }
    style: {
      text: green
      selected_text: green_reverse
      description_text: yellow
    }
  }
])

$env.config = ($env.config | upsert keybindings [
  {
    name: completion_menu
    modifier: none
    keycode: tab
    mode: [emacs vi_normal vi_insert]
    event: { send: menu name: completion_menu }
  }
  {
    name: history_menu
    modifier: none
    keycode: f7
    mode: [emacs vi_normal vi_insert]
    event: { send: menu name: history_menu }
  }
])

"#,
    );
    config.push_str(
        r#"# Conda compatibility for bundled Nu.
# Conda currently does not provide a native Nushell hook; emulate activate/deactivate
# by parsing `conda shell.posix` output and applying env mutations in-session.
def --env __agents_ui_conda_apply_record [key: string, value: string] {
  if $key == "PATH" {
    let path_list = if (($value | str trim) == "") { [] } else { $value | split row ":" }
    load-env { PATH: $path_list }
  } else {
    load-env ({} | upsert $key $value)
  }
}

def __agents_ui_conda_error [out: record] {
  let stderr = ($out.stderr | default "" | str trim)
  let stdout = ($out.stdout | default "" | str trim)
  let msg = if $stderr != "" {
    $stderr
  } else if $stdout != "" {
    $stdout
  } else {
    "conda command failed"
  }
  error make { msg: $msg }
}

def --env __agents_ui_conda_apply [...shell_args: string] {
  let out = (^conda shell.posix ...$shell_args | complete)
  if ($out.exit_code != 0) {
    __agents_ui_conda_error $out
  }

  mut skipped_hook_count = 0
  for raw_line in ($out.stdout | lines) {
    let line = ($raw_line | str trim)
    if $line == "" {
      continue
    }

    let unset_match = ($line | parse -r '^unset +(?<key>[A-Za-z_][A-Za-z0-9_]*)$')
    if (($unset_match | length) > 0) {
      let key = ($unset_match | get 0.key)
      do -i { hide-env $key }
      continue
    }

    let export_single = ($line | parse -r "^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)='(?<value>.*)'$")
    if (($export_single | length) > 0) {
      let key = ($export_single | get 0.key)
      let value = ($export_single | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let export_double = ($line | parse -r '^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)="(?<value>.*)"$')
    if (($export_double | length) > 0) {
      let key = ($export_double | get 0.key)
      let value = ($export_double | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let export_raw = ($line | parse -r '^export +(?<key>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$')
    if (($export_raw | length) > 0) {
      let key = ($export_raw | get 0.key)
      let value = ($export_raw | get 0.value)
      __agents_ui_conda_apply_record $key $value
      continue
    }

    let hook_match = ($line | parse -r '^\. +"(?<path>.+)"$')
    if (($hook_match | length) > 0) {
      $skipped_hook_count = $skipped_hook_count + 1
      continue
    }
  }

  if $skipped_hook_count > 0 {
    print $"[agents-ui] conda hook scripts were skipped in Nushell: ($skipped_hook_count) hook lines."
  }
}

def --wrapped --env conda [...args: string] {
  let subcmd = ($args | get 0? | default "")
  if $subcmd in [activate deactivate reactivate] {
    __agents_ui_conda_apply ...$args
    return
  }

  ^conda ...$args
}

$env.config = ($env.config | upsert hooks.pre_execution [
  {||
    let cleaned = (commandline | str trim | str replace --all (char newline) " ")
    let osc = (char --integer 27) + "]1337;Command=" + $cleaned + (char --integer 7)
    print --no-newline $osc
  }
])

$env.config = ($env.config | upsert hooks.pre_prompt [
  {||
    let osc = (char --integer 27) + "]1337;Command=" + (char --integer 7)
    print --no-newline $osc
  }
])

$env.PROMPT_COMMAND = {||
  let cwd = $env.PWD
  let osc = (char --integer 27) + "]1337;CurrentDir=" + $cwd + (char --integer 7)
  let dir = ($cwd | path basename)
  let conda_prefix = ($env.CONDA_PROMPT_MODIFIER? | default "")
  $osc + $conda_prefix + (ansi cyan) + $dir + (ansi reset) + " "
}

$env.PROMPT_INDICATOR = {|| "❯ " }
$env.PROMPT_MULTILINE_INDICATOR = {|| "… " }
"#,
    );

    let mut keys: Vec<String> = env_keys
        .iter()
        .map(|k| k.trim().to_string())
        .filter(|k| valid_env_key(k))
        .collect();
    keys.sort();
    keys.dedup();
    if !keys.is_empty() {
        config.push_str("\n# Agents UI injected env vars as variables\n");
        for key in keys {
            config.push_str(&format!(
                "let {key} = ($env.{key}? | default \"\")\n",
                key = key
            ));
        }
    }

    let needs_write = match fs::read_to_string(&config_path) {
        Ok(existing) => existing != config,
        Err(_) => true,
    };
    if needs_write {
        fs::write(&config_path, config).ok()?;
    }

    Some((
        config_home.to_str()?.to_string(),
        data_home.to_str()?.to_string(),
        cache_home.to_str()?.to_string(),
        runtime_dir.to_str()?.to_string(),
    ))
}

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionInfo>, String> {
    let sessions = state.inner.sessions.lock().map_err(|_| "state poisoned")?;
    Ok(sessions
        .iter()
        .map(|(id, session)| session_info(id, session))
        .collect())
}

fn exact_existing_directory(path: String) -> Option<String> {
    (!path.is_empty() && Path::new(&path).is_dir()).then_some(path)
}

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    name: Option<String>,
    command: Option<String>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env_vars: Option<HashMap<String, String>>,
    persistent: Option<bool>,
    persist_id: Option<String>,
    respawn: Option<bool>,
    restore_existing: Option<bool>,
    shell_choice: Option<ShellChoice>,
) -> Result<SessionAttachResult, String> {
    let persist_id = persist_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let respawn = respawn.unwrap_or(false);
    let restore_existing = restore_existing.unwrap_or(false);
    if let Some(persist_id) = persist_id.as_deref() {
        let delivery = RENDERER_DELIVERY
            .lock()
            .map_err(|_| "renderer delivery state poisoned".to_string())?;
        if let Some(tombstone) = delivery.retained_exit_for_create(persist_id, respawn) {
            return Ok(tombstone);
        }
    }
    let creation_reservation = if let Some(persist_id) = persist_id.as_deref() {
        match reserve_or_adopt_session(state.inner.as_ref(), persist_id)? {
            SessionCreationStart::Adopted(session) => return Ok(session),
            SessionCreationStart::Reserved(reservation) => Some(reservation),
        }
    } else {
        None
    };
    if !respawn {
        if let Some(persist_id) = persist_id.as_deref() {
            // An exit can remove the live session and publish its tombstone
            // between the optimistic lookup above and the creation reservation.
            // Recheck under the delivery lock before any spawn side effect.
            let delivery = RENDERER_DELIVERY
                .lock()
                .map_err(|_| "renderer delivery state poisoned".to_string())?;
            if let Some(tombstone) = delivery.retained_exit_for_create(persist_id, false) {
                return Ok(tombstone);
            }
            if let Some(evicted) = delivery.evicted_exit_for_create(
                persist_id,
                restore_existing,
                name.as_deref(),
                command.as_deref(),
                cwd.as_deref(),
            ) {
                return Ok(evicted);
            }
        }
    }

    #[cfg(not(target_family = "unix"))]
    let _ = &shell_choice;

    #[cfg(target_family = "unix")]
    let shell = default_user_shell();
    #[cfg(not(target_family = "unix"))]
    let shell = std::env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_string());

    // Resolve the requested shell up front. `None`/`bundled-agsh` keeps the
    // default (bundled agsh); `bundled-nu` launches bundled Nushell; a `system`
    // choice launches the user's own shell, with a graceful fallback if it has
    // gone missing.
    #[cfg(target_family = "unix")]
    let (resolved_shell, shell_warning) = resolve_shell(shell_choice.as_ref(), &shell);
    #[cfg(target_family = "unix")]
    let effective_shell = match &resolved_shell {
        ResolvedShell::System(p) => p.clone(),
        // Bundled shells keep $SHELL / PATH-import pointed at the user's login
        // shell: their profile config lives there, and a SHELL that points into
        // the .app bundle would break if the app moves.
        ResolvedShell::BundledNu(_) | ResolvedShell::BundledAgsh(_) => shell.clone(),
    };

    let persistent = persistent.unwrap_or(false);
    let persist_id = persist_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    #[cfg(not(target_family = "unix"))]
    if persistent {
        return Err("persistent sessions are only supported on Unix".to_string());
    }

    let command = command.unwrap_or_default().trim().to_string();
    if persistent && !command.is_empty() {
        return Err("persistent sessions currently require an empty command (run commands inside the session)".to_string());
    }
    let is_shell = command.is_empty();
    if persistent && !is_shell {
        return Err("persistent sessions currently require an empty command (run commands inside the session)".to_string());
    }

    #[cfg(target_family = "unix")]
    if persistent && persist_id.is_none() {
        return Err("persistId is required for persistent sessions".to_string());
    }

    let cwd = cwd
        .and_then(exact_existing_directory)
        .or_else(|| {
            #[cfg(target_family = "unix")]
            {
                std::env::var("HOME").ok().filter(|s| Path::new(s).is_dir())
            }
            #[cfg(not(target_family = "unix"))]
            {
                std::env::var("USERPROFILE")
                    .ok()
                    .filter(|s| Path::new(s).is_dir())
            }
        });

    #[cfg(target_family = "unix")]
    let mut persistent_zellij_env: Option<(String, String)> = None;

    #[cfg(target_family = "unix")]
    let (program, args, shown_command, use_nu, inner_shell) = if persistent {
        let zellij =
            find_bundled_zellij().ok_or("bundled zellij missing in this build".to_string())?;
        let persist_id = persist_id
            .clone()
            .ok_or("persistId is required for persistent sessions")?;
        let zellij_session = agents_ui_zellij_session_name(&persist_id);
        let zellij_config = ensure_zellij_config(&app)
            .map(|path| path_to_utf8_string(&path, "zellij config path"))
            .transpose()?;
        let zellij_paths =
            ensure_zellij_paths(&app).ok_or("unable to determine app data dir".to_string())?;

        let (inner_shell, inner_use_nu) = match &resolved_shell {
            ResolvedShell::BundledNu(nu) => {
                (path_to_utf8_string(nu, "bundled Nushell path")?, true)
            }
            ResolvedShell::BundledAgsh(agsh) => {
                (path_to_utf8_string(agsh, "bundled agsh path")?, false)
            }
            ResolvedShell::System(p) => (p.clone(), false),
        };

        let mut socket_dir = zellij_paths.socket_dir.clone();
        for candidate in zellij_socket_dir_candidates(&zellij_paths.socket_dir) {
            if let Ok(existing) = zellij_list_sessions(&zellij, &zellij_paths.home_dir, &candidate)
            {
                if existing.iter().any(|s| s == &zellij_session) {
                    socket_dir = candidate;
                    break;
                }
            }
        }
        persistent_zellij_env = Some((
            path_to_utf8_string(&zellij_paths.home_dir, "zellij home path")?,
            path_to_utf8_string(&socket_dir, "zellij socket path")?,
        ));

        let mut zellij_args: Vec<String> = Vec::new();
        if let Some(cfg) = &zellij_config {
            zellij_args.push("--config".to_string());
            zellij_args.push(cfg.clone());
        }
        zellij_args.push("attach".to_string());
        zellij_args.push("-c".to_string());
        zellij_args.push(zellij_session.clone());

        let shown_command = if let Some(cfg) = zellij_config {
            format!("zellij --config {cfg} attach -c {zellij_session}")
        } else {
            format!("zellij attach -c {zellij_session}")
        };

        (
            path_to_utf8_string(&zellij, "bundled zellij path")?,
            zellij_args,
            shown_command,
            inner_use_nu,
            inner_shell,
        )
    } else if is_shell {
        match &resolved_shell {
            ResolvedShell::BundledNu(nu) => (
                path_to_utf8_string(nu, "bundled Nushell path")?,
                Vec::new(),
                "nu".to_string(),
                true,
                shell.clone(),
            ),
            // inner_shell is the agsh path (not $SHELL) so the zsh/bash
            // integration blocks below don't fire for an agsh session.
            ResolvedShell::BundledAgsh(agsh) => (
                path_to_utf8_string(agsh, "bundled agsh path")?,
                Vec::new(),
                "agsh".to_string(),
                false,
                path_to_utf8_string(agsh, "bundled agsh path")?,
            ),
            ResolvedShell::System(p) => {
                let args = interactive_login_args(p);
                let shown = format!("{p} {}", args.join(" "));
                (p.clone(), args, shown, false, p.clone())
            }
        }
    } else {
        // Run-a-command sessions (agent quick-starts like claude/codex). Bundled
        // shells are not used as the command runner; those paths keep `$SHELL -lc`,
        // while an explicitly chosen system shell runs `<shell> -l -c <command>`
        // (agsh takes no `-l`, so it gets a plain `-c`).
        match &resolved_shell {
            ResolvedShell::System(p) => {
                let mut args: Vec<String> = Vec::new();
                if shell_accepts_login_flag(p) {
                    args.push("-l".to_string());
                }
                args.push("-c".to_string());
                args.push(command.clone());
                let shown = format!(
                    "{p} {} {command}",
                    if shell_accepts_login_flag(p) {
                        "-l -c"
                    } else {
                        "-c"
                    }
                );
                (p.clone(), args, shown, false, p.clone())
            }
            ResolvedShell::BundledNu(_) | ResolvedShell::BundledAgsh(_) => (
                shell.clone(),
                vec!["-lc".to_string(), command.clone()],
                format!("{shell} -lc {command}"),
                false,
                shell.clone(),
            ),
        }
    };

    #[cfg(not(target_family = "unix"))]
    let (program, args, shown_command) = if is_shell {
        (shell.clone(), Vec::new(), shell.clone())
    } else {
        (
            shell.clone(),
            vec!["/C".to_string(), command.clone()],
            format!("{shell} /C {command}"),
        )
    };

    #[cfg(not(target_family = "unix"))]
    let use_nu = false;

    let size = PtySize {
        rows: rows.unwrap_or(24),
        cols: cols.unwrap_or(80),
        pixel_width: 0,
        pixel_height: 0,
    };

    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size)
        .map_err(|e| format!("openpty failed: {e}"))?;

    let id = state
        .inner
        .next_id
        .fetch_add(1, Ordering::Relaxed)
        .to_string();

    let mut cmd = CommandBuilder::new(program);
    cmd.args(args);
    let env_keys: Vec<String> = env_vars
        .as_ref()
        .map(|vars| vars.keys().map(|k| k.trim().to_string()).collect())
        .unwrap_or_default();
    let frontend_set_path = env_vars
        .as_ref()
        .map(|vars| vars.contains_key("PATH"))
        .unwrap_or(false);

    if let Some(vars) = env_vars {
        for (k, v) in vars {
            let key = k.trim();
            if !valid_env_key(key) {
                continue;
            }
            cmd.env(key, v);
        }
    }
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // MCP bearer token: CLIs registered with --bearer-token-env-var (Codex)
    // read it from the session environment to authenticate against /mcp.
    cmd.env(
        crate::mcp_server::MCP_TOKEN_ENV_VAR,
        crate::mcp_server::get_or_init_auth_token(),
    );
    #[cfg(target_family = "unix")]
    if cmd.get_env("SHELL").is_none() {
        cmd.env("SHELL", effective_shell.clone());
    }
    #[cfg(target_family = "unix")]
    if persistent {
        if let Some((zellij_home, zellij_socket_dir)) = persistent_zellij_env.as_ref() {
            cmd.env("HOME", zellij_home.clone());
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_socket_dir.clone());
        } else if let Some(zellij_paths) = ensure_zellij_paths(&app) {
            cmd.env("HOME", zellij_paths.home_dir);
            cmd.env("ZELLIJ_SOCKET_DIR", zellij_paths.socket_dir);
        }

        if let Some(wrapper) = ensure_zellij_shell_wrapper(&app) {
            cmd.env("SHELL", wrapper);
            cmd.env("AGENTS_UI_ZELLIJ_REAL_SHELL", inner_shell.clone());
            // agsh takes no `-l`; the wrapper execs the real shell bare then.
            cmd.env(
                "AGENTS_UI_ZELLIJ_LOGIN",
                if shell_accepts_login_flag(&inner_shell) {
                    "1"
                } else {
                    "0"
                },
            );
            cmd.env(
                "AGENTS_UI_ZELLIJ_RESTORE_XDG",
                if use_nu { "0" } else { "1" },
            );

            capture_original_env(
                &mut cmd,
                "HOME",
                "AGENTS_UI_ORIG_HOME_PRESENT",
                "AGENTS_UI_ORIG_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_CONFIG_HOME",
                "AGENTS_UI_ORIG_XDG_CONFIG_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_CONFIG_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_DATA_HOME",
                "AGENTS_UI_ORIG_XDG_DATA_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_DATA_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_CACHE_HOME",
                "AGENTS_UI_ORIG_XDG_CACHE_HOME_PRESENT",
                "AGENTS_UI_ORIG_XDG_CACHE_HOME",
            );
            capture_original_env(
                &mut cmd,
                "XDG_RUNTIME_DIR",
                "AGENTS_UI_ORIG_XDG_RUNTIME_DIR_PRESENT",
                "AGENTS_UI_ORIG_XDG_RUNTIME_DIR",
            );
        } else {
            cmd.env("SHELL", inner_shell.clone());
        }
    }

    #[cfg(target_os = "macos")]
    {
        // Always construct a clean PATH on macOS. Don't check cmd.get_env("PATH")
        // because CommandBuilder inherits the parent environment which may be corrupted.
        // Only skip if frontend explicitly passed PATH in env_vars.
        if !frontend_set_path {
            let mut fallback_entries: Vec<String> = std::env::var("PATH")
                .unwrap_or_default()
                .split(':')
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .collect();

            if let Ok(home) = std::env::var("HOME") {
                for candidate in [
                    format!("{home}/.cargo/bin"),
                    format!("{home}/.local/bin"),
                    format!("{home}/bin"),
                ] {
                    if Path::new(&candidate).is_dir()
                        && !fallback_entries.iter().any(|p| p == &candidate)
                    {
                        fallback_entries.insert(0, candidate);
                    }
                }
            }

            for candidate in [
                "/opt/homebrew/bin",
                "/opt/homebrew/sbin",
                "/usr/local/bin",
                "/usr/local/sbin",
            ] {
                if Path::new(candidate).is_dir() && !fallback_entries.iter().any(|p| p == candidate)
                {
                    fallback_entries.insert(0, candidate.to_string());
                }
            }

            for candidate in ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"] {
                if Path::new(candidate).is_dir() && !fallback_entries.iter().any(|p| p == candidate)
                {
                    fallback_entries.push(candidate.to_string());
                }
            }

            let fallback_path = fallback_entries.join(":");
            // Import PATH from the shell that will actually run, so a user whose
            // PATH is configured in their chosen shell's profile gets it. The
            // cache is keyed by that shell, so different shells don't collide.
            let imported_path = if let Ok(mut cache) = state.inner.login_path_cache.lock() {
                if cache.initialized && cache.shell.as_deref() == Some(effective_shell.as_str()) {
                    cache.path.clone()
                } else {
                    let computed = login_shell_path(&effective_shell, &fallback_path);
                    cache.initialized = true;
                    cache.shell = Some(effective_shell.clone());
                    cache.path = computed.clone();
                    computed
                }
            } else {
                login_shell_path(&effective_shell, &fallback_path)
            };

            let mut path_entries: Vec<String> = Vec::new();

            if let Some(ref imported) = imported_path {
                for entry in imported.split(':') {
                    push_exact_absolute_path_entry(&mut path_entries, entry);
                }
            }

            for entry in &fallback_entries {
                push_exact_absolute_path_entry(&mut path_entries, entry);
            }

            if !path_entries.is_empty() {
                cmd.env("PATH", path_entries.join(":"));
            }
        }
    }

    if cmd.get_env("PATH").is_none() {
        if let Ok(path) = std::env::var("PATH") {
            if !path.is_empty() {
                cmd.env("PATH", path);
            }
        }
    }

    #[cfg(target_family = "unix")]
    if use_nu {
        if let Some((xdg_config_home, xdg_data_home, xdg_cache_home, xdg_runtime_dir)) =
            ensure_nu_config(&app, &env_keys)
        {
            cmd.env("XDG_CONFIG_HOME", xdg_config_home);
            cmd.env("XDG_DATA_HOME", xdg_data_home);
            cmd.env("XDG_CACHE_HOME", xdg_cache_home);
            cmd.env("XDG_RUNTIME_DIR", xdg_runtime_dir);
        }
    } else if persistent {
        if let Some(xdg) = ensure_shell_xdg_paths(&app) {
            cmd.env("XDG_CONFIG_HOME", xdg.config_home);
            cmd.env("XDG_DATA_HOME", xdg.data_home);
            cmd.env("XDG_CACHE_HOME", xdg.cache_home);
            cmd.env("XDG_RUNTIME_DIR", xdg.runtime_dir);
        }
    }
    if let Some(ref cwd) = cwd {
        cmd.cwd(cwd);
    }

    #[cfg(target_family = "unix")]
    {
        let shell_name = Path::new(&inner_shell)
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if is_shell && shell_name.contains("bash") && !use_nu {
            let orig_prompt = cmd
                .get_env("PROMPT_COMMAND")
                .and_then(|v| v.to_str())
                .map(|s| s.to_string());
            if let Some(orig) = orig_prompt {
                cmd.env("AGENTS_UI_ORIG_PROMPT_COMMAND", orig);
            }
            // OSC 133 + 1337 shell integration via PROMPT_COMMAND:
            // - exit code is captured FIRST (before anything else can clobber $?),
            //   then D;<exit> for the previous command + A for the new prompt;
            // - the user's original PROMPT_COMMAND is chained afterwards;
            // - PS1 gets a trailing B marker (prompt end = input start) and PS0 a
            //   leading C marker (pre-execution; bash >= 4.4), (re)appended after
            //   the user's PROMPT_COMMAND runs so prompt rewrites can't drop them.
            cmd.env(
                "PROMPT_COMMAND",
                "__agents_ui_ec=$?; printf '\\033]133;D;%s\\007\\033]133;A\\007' \"$__agents_ui_ec\"; printf '\\033]1337;CurrentDir=%s\\007' \"$PWD\"; if [ -n \"$AGENTS_UI_ORIG_PROMPT_COMMAND\" ]; then eval \"$AGENTS_UI_ORIG_PROMPT_COMMAND\"; fi; case $PS1 in *']133;B'*) ;; *) PS1=\"${PS1}\\[\\e]133;B\\a\\]\";; esac; case $PS0 in *']133;C'*) ;; *) PS0=\"\\e]133;C\\a${PS0}\";; esac",
            );
        }

        if is_shell && shell_name.contains("zsh") && !use_nu {
            let orig_dotdir = std::env::var("ZDOTDIR")
                .ok()
                .filter(|s| Path::new(s).is_dir())
                .or_else(|| std::env::var("HOME").ok().filter(|s| Path::new(s).is_dir()));

            if let Some(orig_dotdir) = orig_dotdir {
                let dotdir = if persistent {
                    persist_id
                        .as_deref()
                        .and_then(|pid| zsh_zdotdir_path(&app, pid))
                } else {
                    Some(std::env::temp_dir().join(format!("agents-ui-zdotdir-{id}")))
                };

                if let Some(dotdir) = dotdir {
                    if fs::create_dir_all(&dotdir).is_ok()
                        && write_zsh_startup_files(&dotdir, Path::new(&orig_dotdir)).is_ok()
                    {
                        cmd.env("ZDOTDIR", dotdir);
                    }
                }
            }
        }
    }

    let child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|e| format!("spawn failed: {e}"))?;

    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|e| format!("clone reader failed: {e}"))?;

    let writer = pair
        .master
        .take_writer()
        .map_err(|e| format!("take writer failed: {e}"))?;
    let child_pid = child.process_id();
    let killer = child.clone_killer();
    let io = PtySessionIo {
        master: Arc::new(Mutex::new(pair.master)),
        writer: Arc::new(Mutex::new(writer)),
        child: Arc::new(Mutex::new(child)),
        killer: Arc::new(Mutex::new(killer)),
        recording: Arc::new(Mutex::new(None)),
        closing: Arc::new(AtomicBool::new(false)),
    };

    // Publish a deliberate tombstone replacement atomically with removing the
    // retained exit. renderer_listener_ready takes the same delivery→sessions
    // lock order, so it can never observe neither (or both) as authoritative.
    let mut delivery = RENDERER_DELIVERY
        .lock()
        .map_err(|_| "renderer delivery state poisoned")?;
    let mut sessions = state.inner.sessions.lock().map_err(|_| "state poisoned")?;

    let base_name = name.unwrap_or_else(|| (if is_shell { "shell" } else { "agent" }).to_string());
    // Session names are display labels, not filesystem paths. Keep intentional
    // blank-label normalization separate from the exact cwd/PATH handling.
    let base_trimmed = base_name.trim();
    let base_trimmed = if base_trimmed.is_empty() {
        "session"
    } else {
        base_trimmed
    };
    let final_name = unique_name(&sessions, base_trimmed);
    let replay = Arc::new(Mutex::new(PtyReplayBuffer::default()));

    sessions.insert(
        id.clone(),
        PtySession {
            persist_id: persist_id.clone(),
            name: final_name.clone(),
            command: shown_command.clone(),
            cwd: cwd.clone(),
            io,
            child_pid,
            replay: replay.clone(),
        },
    );
    if respawn {
        if let Some(persist_id) = persist_id.as_deref() {
            delivery.remove_exits_by_persist_id(persist_id);
        }
    }
    drop(sessions);
    drop(delivery);
    // Publish the fully constructed session before waking another concurrent
    // create_session call for the same logical ID. That caller will atomically
    // adopt this backend entry instead of spawning a second PTY.
    drop(creation_reservation);

    // Re-evaluate promptly so the sleep assertion engages as soon as an SSH
    // session opens. Deliberately no poke on exit/close: release goes through
    // the watcher's grace period so a reconnect dip can't let the Mac sleep.
    crate::power_assertion::poke();

    // Tell the UI if the requested shell couldn't be launched and we fell back.
    #[cfg(target_family = "unix")]
    if let Some(message) = shell_warning {
        let _ = app.emit_to(
            "main",
            "shell-fallback",
            ShellFallbackEvent {
                session_id: id.clone(),
                message,
            },
        );
    }

    let id_for_reader = id.clone();
    let id_for_emitter: Arc<str> = Arc::from(id.as_str());
    let persist_id_for_emitter = persist_id.as_deref().map(Arc::<str>::from);
    let replay_for_emitter = replay.clone();
    let state_for_emitter = state.inner().clone();
    let app_for_emitter = app.clone();
    // Bounded channel so a flooding child can't grow the queue without limit:
    // when the emitter falls behind, send() blocks the reader, the kernel PTY
    // buffer fills, and the child throttles on write — the same backpressure a
    // real terminal applies. No output is ever dropped. 256 slots × ≤64 KiB
    // reads gives ample burst absorption before that kicks in.
    let (tx, rx) = mpsc::sync_channel::<String>(256);

    // Reader thread: reads from PTY, decodes UTF-8, sends strings to channel.
    // Blocking reader.read() is isolated here so the emitter can flush on timeout.
    std::thread::spawn(move || {
        // 64 KiB read buffer: read() returns as soon as data is available (so
        // interactive echo latency is unaffected by the size), but a larger
        // buffer means far fewer read syscalls + channel sends when a program
        // floods output, which keeps the pipeline ahead of the producer.
        let mut buf = [0u8; 65536];
        let mut utf8_carry: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let data = decode_utf8_stream(&mut utf8_carry, &buf[..n]);
                    if !data.is_empty() {
                        if tx.send(data).is_err() {
                            break;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        if !utf8_carry.is_empty() {
            let data = String::from_utf8_lossy(&utf8_carry).to_string();
            if !data.is_empty() {
                let _ = tx.send(data);
            }
        }
        // tx dropped here → emitter receives Disconnected
    });

    // Emitter thread: coalesces reader chunks into batched pty-output events.
    //
    // Strategy: leading-edge emit + trailing coalesce. The first chunk of every
    // burst is emitted immediately (after a non-blocking drain of anything else
    // already queued), so interactive keystroke echo reaches the UI with the
    // lowest possible latency instead of waiting out a batching interval.
    // Remaining chunks of the same burst are then coalesced for up to
    // OUTPUT_EMIT_INTERVAL, and flushed early whenever the buffer reaches
    // OUTPUT_EMIT_BYTES — so heavy output still collapses into a few large IPC
    // messages. When a burst goes idle we flush the tail and block until the
    // next chunk, so the thread parks at ~0 wakeups when nothing is happening.
    std::thread::spawn(move || {
        const OUTPUT_EMIT_BYTES: usize = 32 * 1024;
        const OUTPUT_EMIT_INTERVAL: Duration = Duration::from_millis(8);

        let mut output_buffer = String::new();

        let emit_buffered_output = |buffer: &mut String| {
            if buffer.is_empty() {
                return;
            }
            let data = std::mem::take(buffer);
            let delivery = RENDERER_DELIVERY
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let sequence = replay_for_emitter
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .append(&data);
            match delivery.delivery_target() {
                DeliveryTarget::RendererAndNativeApi => {
                    // api_server's native Tauri listener forwards this same
                    // event to ApiEventBus while the renderer is healthy.
                    let _ = app_for_emitter.emit_to(
                        "main",
                        "pty-output",
                        PtyOutput {
                            id: id_for_emitter.clone(),
                            persist_id: persist_id_for_emitter.clone(),
                            sequence,
                            data,
                        },
                    );
                }
                DeliveryTarget::NativeApiOnly => {
                    // Never enqueue into a dead WKWebView. Native API/MCP
                    // subscribers still receive the live stream exactly once.
                    notify_native_api_output(&app_for_emitter, &id_for_emitter, &data);
                }
            }
        };

        // Pull everything already waiting in the channel into the buffer without
        // blocking, stopping once we have a full batch's worth of bytes.
        let drain_available = |buffer: &mut String| {
            while buffer.len() < OUTPUT_EMIT_BYTES {
                match rx.try_recv() {
                    Ok(data) => buffer.push_str(&data),
                    Err(_) => break,
                }
            }
        };

        'bursts: loop {
            // Block until the first chunk of a new burst arrives.
            match rx.recv() {
                Ok(data) => output_buffer.push_str(&data),
                Err(_) => break, // reader disconnected
            }
            // Leading edge: grab anything else already queued, then emit at once.
            drain_available(&mut output_buffer);
            emit_buffered_output(&mut output_buffer);

            // Trailing coalesce: keep batching while the burst continues.
            loop {
                match rx.recv_timeout(OUTPUT_EMIT_INTERVAL) {
                    Ok(data) => {
                        output_buffer.push_str(&data);
                        drain_available(&mut output_buffer);
                        if output_buffer.len() >= OUTPUT_EMIT_BYTES {
                            emit_buffered_output(&mut output_buffer);
                        }
                    }
                    Err(RecvTimeoutError::Timeout) => {
                        // Burst idled — flush the tail and wait for the next one.
                        emit_buffered_output(&mut output_buffer);
                        continue 'bursts;
                    }
                    Err(RecvTimeoutError::Disconnected) => {
                        emit_buffered_output(&mut output_buffer);
                        break 'bursts;
                    }
                }
            }
        }

        // Publish exit presence in the same delivery→sessions critical section
        // that removes the live entry. renderer_listener_ready and create_session
        // therefore cannot observe an absent live session and absent tombstone.
        // Child wait may take arbitrarily long, so publish with an unknown code
        // first and fill it in afterward.
        let mut session = {
            let mut delivery = RENDERER_DELIVERY
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let mut sessions = state_for_emitter
                .inner
                .sessions
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let session = sessions.remove(&id_for_reader);
            let placeholder = session.as_ref().and_then(|session| {
                // Removal is the lifecycle boundary for every cloned I/O
                // handle. Publish it before releasing the registry so a
                // command that was waiting on a per-session lock cannot start
                // new work against an already-exited backend.
                let claimed_exit = try_claim_session_closing(&session.io.closing);
                (claimed_exit && session.persist_id.is_some())
                    .then(|| session_exit_tombstone(&id_for_reader, session, None))
            });
            delivery.classify_exit(placeholder);
            session
        };

        let exit_code = session.as_mut().and_then(|session| {
            session
                .io
                .child
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .wait()
                .ok()
                .map(|status| status.exit_code())
        });

        let mut delivery = RENDERER_DELIVERY
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        // Update only if the placeholder still exists. Explicit respawn/close
        // removes it and must not be undone by this late child status.
        let retained_location = delivery.update_retained_exit_code(&id_for_reader, exit_code);
        let renderer_recovery = matches!(
            retained_location,
            Some(RetainedExitLocation::RecoveryTombstone)
        );
        match delivery.delivery_target() {
            DeliveryTarget::RendererAndNativeApi => {
                let _ = app_for_emitter.emit_to(
                    "main",
                    "pty-exit",
                    PtyExit {
                        id: id_for_reader,
                        exit_code,
                        renderer_recovery,
                    },
                );
            }
            DeliveryTarget::NativeApiOnly => {
                notify_native_api_exit(&app_for_emitter, &id_for_reader, exit_code);
            }
        }
    });

    let (replay, replay_through_sequence, replay_truncated) = replay
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .snapshot();
    Ok(SessionAttachResult {
        session: SessionInfo {
            id,
            persist_id,
            name: final_name,
            command: shown_command,
            cwd,
        },
        adopted: false,
        exited: false,
        exit_code: None,
        replay,
        replay_through_sequence,
        replay_truncated,
    })
}

#[tauri::command]
pub fn start_session_recording(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    recording_id: String,
    recording_name: Option<String>,
    encrypt: Option<bool>,
    project_id: String,
    session_persist_id: String,
    cwd: Option<String>,
    effect_id: Option<String>,
    bootstrap_command: Option<String>,
) -> Result<String, String> {
    let safe_id = crate::recording::sanitize_recording_id(&recording_id);
    let encrypt_enabled = encrypt.unwrap_or(true);
    let enc_key = if encrypt_enabled {
        Some(crate::secure::get_or_create_master_key(&app)?)
    } else {
        None
    };

    let io = session_io(state.inner.as_ref(), &id)?;
    if io.closing.load(Ordering::Acquire) {
        return Err("session is closing".to_string());
    }
    let mut recording = io
        .recording
        .lock()
        .map_err(|_| "recording state poisoned")?;
    if io.closing.load(Ordering::Acquire) {
        return Err("session is closing".to_string());
    }
    if recording.is_some() {
        return Err("already recording".to_string());
    }

    let path = crate::recording::recording_file_path(&app, &safe_id)?;
    let dir = path.parent().ok_or("invalid recording path")?;
    fs::create_dir_all(dir).map_err(|e| format!("create dir failed: {e}"))?;

    let file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&path)
        .map_err(|e| format!("open failed: {e}"))?;

    let mut writer = BufWriter::new(file);
    let recording_name = recording_name
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|s| s.chars().take(120).collect());
    let effect_id = effect_id
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let bootstrap_command = bootstrap_command
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    let meta = crate::recording::RecordingMetaV1 {
        schema_version: 1,
        created_at: now_epoch_ms(),
        name: recording_name,
        project_id,
        session_persist_id,
        cwd,
        effect_id,
        bootstrap_command,
        encrypted: Some(encrypt_enabled),
    };
    let line = crate::recording::RecordingLineV1::Meta(meta);
    let json = serde_json::to_string(&line).map_err(|e| format!("serialize failed: {e}"))?;
    writer
        .write_all(json.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer
        .write_all(b"\n")
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().map_err(|e| format!("flush failed: {e}"))?;

    *recording = Some(SessionRecording {
        id: safe_id.clone(),
        writer,
        started_at: Instant::now(),
        last_flush: Instant::now(),
        unflushed_bytes: 0,
        input_buffer: String::new(),
        json_buf: Vec::with_capacity(256),
        enc_key,
    });

    Ok(safe_id)
}

#[tauri::command]
pub fn stop_session_recording(
    state: State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let io = session_io(state.inner.as_ref(), &id)?;
    let mut rec = match io
        .recording
        .lock()
        .map_err(|_| "recording state poisoned")?
        .take()
    {
        Some(r) => r,
        None => return Ok(None),
    };
    rec.writer
        .flush()
        .map_err(|e| format!("flush failed: {e}"))?;
    Ok(Some(rec.id))
}

#[tauri::command]
pub fn write_to_session(
    state: State<'_, AppState>,
    id: String,
    data: String,
    source: Option<String>,
) -> Result<(), String> {
    let io = session_io(state.inner.as_ref(), &id)?;
    if io.closing.load(Ordering::Acquire) {
        return Ok(());
    }

    // Unescape common terminal escape sequences (e.g. \r, \n, \t) that
    // MCP tool callers send as literal backslash-letter pairs.
    let data = unescape_terminal_sequences(&data);

    let mut writer = io.writer.lock().map_err(|_| "session writer poisoned")?;
    if io.closing.load(Ordering::Acquire) {
        return Ok(());
    }
    writer
        .write_all(data.as_bytes())
        .map_err(|e| format!("write failed: {e}"))?;
    writer.flush().ok();

    // Keep the per-session writer guard through recording so concurrent input
    // is recorded in exactly the same order in which it reached the PTY. This
    // lock is deliberately session-local; no registry/delivery lock is held.
    let is_user = source.as_deref() == Some("user");
    if is_user {
        let mut recording = io
            .recording
            .lock()
            .map_err(|_| "recording state poisoned")?;
        let mut rec_err: Option<String> = None;
        if let Some(rec) = recording.as_mut() {
            if let Err(e) = record_user_input(rec, &data) {
                rec_err = Some(e);
            }
        }
        if let Some(err) = rec_err {
            eprintln!("Failed to write recording event: {err}");
            *recording = None;
        }
    }
    Ok(())
}

/// Unescape common terminal escape sequences that arrive as literal
/// backslash-letter pairs from MCP tool callers (e.g. `\r` → CR, `\n` → LF).
fn unescape_terminal_sequences(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('r') => out.push('\r'),
                Some('n') => out.push('\n'),
                Some('t') => out.push('\t'),
                Some('\\') => out.push('\\'),
                Some('x') => {
                    // Handle \x1b style hex escapes (e.g. for ESC)
                    let h: String = chars.by_ref().take(2).collect();
                    if let Ok(byte) = u8::from_str_radix(&h, 16) {
                        out.push(byte as char);
                    } else {
                        out.push('\\');
                        out.push('x');
                        out.push_str(&h);
                    }
                }
                Some(other) => {
                    out.push('\\');
                    out.push(other);
                }
                None => out.push('\\'),
            }
        } else {
            out.push(c);
        }
    }
    out
}

#[tauri::command]
pub fn resize_session(
    state: State<'_, AppState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let io = session_io(state.inner.as_ref(), &id)?;
    if io.closing.load(Ordering::Acquire) {
        return Ok(());
    }
    let master = io.master.lock().map_err(|_| "session PTY state poisoned")?;
    if io.closing.load(Ordering::Acquire) {
        return Ok(());
    }
    master
        .resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|e| format!("resize failed: {e}"))?;
    Ok(())
}

#[tauri::command]
pub fn rename_session(state: State<'_, AppState>, id: String, name: String) -> Result<(), String> {
    let mut sessions = state.inner.sessions.lock().map_err(|_| "state poisoned")?;
    let session = sessions
        .get_mut(&id)
        .ok_or_else(|| "Session not found".to_string())?;
    session.name = name;
    Ok(())
}

#[tauri::command]
pub fn close_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    // Claim the lifecycle while the entry is still protected by the registry.
    // The exit path holds delivery→sessions while removing that same entry and
    // publishing its placeholder. Consequently close either wins here (and
    // exit observes `closing`) or observes the entry missing and waits for the
    // already-in-progress publication before removing it below.
    let io = {
        let sessions = state.inner.sessions.lock().map_err(|_| "state poisoned")?;
        sessions.get(&id).and_then(|session| {
            try_claim_session_closing(&session.io.closing).then(|| session.io.clone())
        })
    };
    let Some(io) = io else {
        let mut delivery = RENDERER_DELIVERY
            .lock()
            .map_err(|_| "renderer delivery state poisoned")?;
        delivery.remove_exit_by_id(&id);
        return Ok(());
    };

    // Flush any buffered recording tail now rather than relying on BufWriter's
    // silent Drop flush when the emitter thread removes the session.
    if let Ok(mut recording) = io.recording.lock() {
        if let Some(rec) = recording.as_mut() {
            let _ = rec.writer.flush();
        }
    }
    if let Ok(mut killer) = io.killer.lock() {
        let _ = killer.kill();
    }
    Ok(())
}

/// Best-effort cleanup at app exit: process exit does not run destructors for
/// managed state, so buffered recording tails would be lost and children would
/// only learn of the exit via PTY EOF. Flush every recording and kill children.
pub fn shutdown_flush_all(state: &AppState) {
    let Ok(sessions) = state.inner.sessions.lock() else {
        return;
    };
    let handles = sessions
        .values()
        .map(|session| session.io.clone())
        .collect::<Vec<_>>();
    drop(sessions);
    for io in handles {
        io.closing.store(true, Ordering::Release);
        if let Ok(mut recording) = io.recording.lock() {
            if let Some(rec) = recording.as_mut() {
                let _ = rec.writer.flush();
            }
        }
        if let Ok(mut killer) = io.killer.lock() {
            let _ = killer.kill();
        }
    }
}

#[tauri::command]
pub fn detach_session(state: State<'_, AppState>, id: String) -> Result<(), String> {
    #[cfg(not(target_family = "unix"))]
    {
        let _ = state;
        let _ = id;
        return Err("detach is only supported on Unix".to_string());
    }

    #[cfg(target_family = "unix")]
    {
        let io = match session_io(state.inner.as_ref(), &id) {
            Ok(io) => io,
            Err(_) => return Ok(()),
        };
        if io.closing.load(Ordering::Acquire) {
            return Ok(());
        }

        // Default zellij detach: Ctrl+o then d.
        let mut writer = io.writer.lock().map_err(|_| "session writer poisoned")?;
        if io.closing.load(Ordering::Acquire) {
            return Ok(());
        }
        writer
            .write_all(&[0x0f, b'd'])
            .map_err(|e| format!("write failed: {e}"))?;
        writer.flush().ok();
        Ok(())
    }
}

#[cfg(test)]
mod path_identity_tests {
    use super::{
        exact_existing_directory, extract_nul_framed_utf8, has_complete_nul_frame,
        validated_shell_path,
    };

    struct TestDirectory(std::path::PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory(label: &str) -> TestDirectory {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock after epoch")
            .as_nanos();
        let path = std::env::temp_dir().join(format!(
            "agents-ui-pty-{label}-{}-{unique}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("create pty test directory");
        TestDirectory(path)
    }

    #[test]
    fn framed_path_value_preserves_edge_whitespace() {
        let output = "noise<magic>\0 /bin:/tmp/目录/bin \0<trailer>\0noise".as_bytes();
        assert_eq!(
            extract_nul_framed_utf8(output, b"<magic>", b"<trailer>", 1024, 512),
            Some(" /bin:/tmp/目录/bin ".to_string())
        );
        assert_eq!(
            extract_nul_framed_utf8(b"<m>\0\0<t>\0", b"<m>", b"<t>", 32, 16),
            None
        );
    }

    #[test]
    fn framed_path_rejects_invalid_utf8_without_replacement() {
        assert_eq!(
            extract_nul_framed_utf8(
                b"noise<m>\0/tmp/\xff/bin\0<t>\0",
                b"<m>",
                b"<t>",
                128,
                64,
            ),
            None
        );
        assert_eq!(
            extract_nul_framed_utf8(
                b"\xff<m>\0/tmp/exact\0<t>\0\xfe",
                b"<m>",
                b"<t>",
                128,
                64,
            ),
            Some("/tmp/exact".to_string())
        );
    }

    #[test]
    fn framed_path_rejects_bad_framing_and_bounds() {
        assert!(!has_complete_nul_frame(
            b"<t><m>\0value",
            b"<m>",
            b"<t>"
        ));
        assert!(has_complete_nul_frame(
            b"noise<m>\0value\0<t>\0",
            b"<m>",
            b"<t>"
        ));
        for output in [
            b"<m>unterminated".as_slice(),
            b"<m>\0unterminated".as_slice(),
            b"<t><m>\0value".as_slice(),
            b"<m>\0value\0wrong-trailer\0".as_slice(),
        ] {
            assert_eq!(
                extract_nul_framed_utf8(output, b"<m>", b"<t>", 128, 64),
                None
            );
        }
        assert_eq!(
            extract_nul_framed_utf8(b"<m>\0value\0<t>\0", b"<m>", b"<t>", 10, 64),
            None
        );
        assert_eq!(
            extract_nul_framed_utf8(b"<m>\0value\0<t>\0", b"<m>", b"<t>", 64, 4),
            None
        );
    }

    #[test]
    fn textual_trailer_substring_inside_path_is_unambiguous() {
        let exact = "/tmp/__AGENTS_UI_PATH_DONE_V1_7C9D4E21__/bin";
        let mut output = b"<m>\0".to_vec();
        output.extend_from_slice(exact.as_bytes());
        output.extend_from_slice(b"\0<t>\0");
        assert_eq!(
            extract_nul_framed_utf8(&output, b"<m>", b"<t>", 256, 128),
            Some(exact.to_string())
        );
    }

    #[test]
    fn multiple_complete_path_frames_are_rejected_as_ambiguous() {
        let output = b"<m>\0/first\0<t>\0noise<m>\0/second\0<t>\0";
        assert_eq!(
            extract_nul_framed_utf8(output, b"<m>", b"<t>", 128, 64),
            None
        );
    }

    #[test]
    fn cwd_validation_preserves_exact_unicode_path() {
        let parent = test_directory("cwd");
        let exact = parent.0.join("  lowerCase-目录-🚀  ");
        std::fs::create_dir_all(&exact).expect("create exact cwd");
        let exact_string = exact.to_str().expect("test path is UTF-8").to_string();

        assert_eq!(
            exact_existing_directory(exact_string.clone()),
            Some(exact_string)
        );
    }

    #[test]
    fn shell_validation_preserves_only_an_absolute_executable_path() {
        let root = test_directory("shell");
        let shell = root.0.join("  shell runner-目录  ");
        std::fs::write(&shell, "#!/bin/sh\n").expect("write test shell");
        #[cfg(target_family = "unix")]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shell, std::fs::Permissions::from_mode(0o755))
                .expect("make test shell executable");
        }
        let exact = shell.to_str().expect("test path is UTF-8").to_string();

        assert_eq!(validated_shell_path(&exact), Some(exact));
        assert_eq!(validated_shell_path("relative-shell"), None);
        assert_eq!(validated_shell_path(root.0.to_str().unwrap()), None);
        assert_eq!(validated_shell_path("/definitely/missing/agents-ui-shell"), None);
    }

    #[cfg(target_family = "unix")]
    #[test]
    fn shell_candidate_dedup_preserves_literal_path() {
        let mut paths = Vec::new();
        super::push_unique_exact_path(&mut paths, " /tmp/lowerCase-目录 ");
        super::push_unique_exact_path(&mut paths, " /tmp/lowerCase-目录 ");
        assert_eq!(paths, vec![" /tmp/lowerCase-目录 "]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn imported_path_entries_are_validated_without_trimming() {
        let mut paths = Vec::new();
        super::push_exact_absolute_path_entry(&mut paths, "/tmp/lowerCase-目录 ");
        super::push_exact_absolute_path_entry(&mut paths, " /tmp/would-change-if-trimmed");
        assert_eq!(paths, vec!["/tmp/lowerCase-目录 "]);
    }
}

#[cfg(test)]
mod renderer_recovery_tests {
    use super::{
        normalized_renderer_id, try_claim_session_closing, DeliveryTarget, PtyReplayBuffer,
        PtyReplayChunk, RendererDeliveryState, RetainedExitLocation, SessionExitTombstone,
        SessionInfo, PTY_EXIT_TOMBSTONE_MAX_SESSIONS, PTY_REPLAY_MAX_BYTES,
        RENDERER_CANCELED_ID_MAX, RENDERER_TICKET_MAX,
    };

    fn exit_tombstone(id: &str, persist_id: &str) -> SessionExitTombstone {
        SessionExitTombstone {
            session: SessionInfo {
                id: id.to_string(),
                persist_id: Some(persist_id.to_string()),
                name: "saved".to_string(),
                command: "agent --dangerous-to-repeat".to_string(),
                cwd: Some("/tmp/project".to_string()),
            },
            exit_code: Some(23),
            replay: vec![PtyReplayChunk {
                sequence: 1,
                data: "retained output".to_string(),
            }],
            replay_through_sequence: 1,
            replay_truncated: false,
        }
    }

    #[test]
    fn replay_buffer_preserves_order_and_monotonic_sequences() {
        let mut replay = PtyReplayBuffer::default();
        assert_eq!(replay.append_with_limit("one", 64), 1);
        assert_eq!(replay.append_with_limit("two", 64), 2);
        assert_eq!(replay.append_with_limit("three", 64), 3);

        let (chunks, through, truncated) = replay.snapshot();
        assert_eq!(through, 3);
        assert!(!truncated);
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| (chunk.sequence, chunk.data.as_str()))
                .collect::<Vec<_>>(),
            vec![(1, "one"), (2, "two"), (3, "three")]
        );
    }

    #[test]
    fn replay_buffer_evicts_oldest_chunks_and_reports_truncation() {
        let mut replay = PtyReplayBuffer::default();
        replay.append_with_limit("1234", 8);
        replay.append_with_limit("5678", 8);
        replay.append_with_limit("90", 8);

        let (chunks, through, truncated) = replay.snapshot();
        assert_eq!(through, 3);
        assert!(truncated);
        assert_eq!(
            chunks
                .iter()
                .map(|chunk| (chunk.sequence, chunk.data.as_str()))
                .collect::<Vec<_>>(),
            vec![(2, "5678"), (3, "90")]
        );
        assert!(chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>() <= 8);
    }

    #[test]
    fn oversized_chunk_stays_bounded_and_advances_watermark() {
        let mut replay = PtyReplayBuffer::default();
        replay.append_with_limit("larger-than-limit", 4);
        let (chunks, through, truncated) = replay.snapshot();
        assert!(chunks.is_empty());
        assert_eq!(through, 1);
        assert!(truncated);
    }

    #[test]
    fn production_replay_cap_is_512_kib_per_session() {
        assert_eq!(PTY_REPLAY_MAX_BYTES, 512 * 1024);
        let mut replay = PtyReplayBuffer::default();
        for _ in 0..513 {
            replay.append(&"x".repeat(1024));
        }

        let (chunks, through, truncated) = replay.snapshot();
        assert_eq!(through, 513);
        assert!(truncated);
        assert_eq!(chunks.len(), 512);
        assert_eq!(chunks.first().map(|chunk| chunk.sequence), Some(2));
        assert!(chunks.iter().map(|chunk| chunk.data.len()).sum::<usize>() <= PTY_REPLAY_MAX_BYTES);
    }

    #[test]
    fn renderer_ids_are_nonempty_and_bounded() {
        assert_eq!(
            normalized_renderer_id(" renderer-1 ".into()).unwrap(),
            "renderer-1"
        );
        assert!(normalized_renderer_id("  ".into()).is_err());
        assert!(normalized_renderer_id("x".repeat(129)).is_err());
    }

    #[test]
    fn listener_ready_and_exit_classification_have_no_delivery_gap() {
        let mut delivery = RendererDeliveryState::default();
        assert_eq!(delivery.delivery_target(), DeliveryTarget::NativeApiOnly);

        // Exit wins the mutex race: it is retained, and the same critical
        // section that enables the renderer returns it to the listener.
        assert!(!delivery.classify_exit(Some(exit_tombstone("1", "persist-1"))));
        let (exits, truncated) = delivery.enable_renderer("renderer-1".to_string());
        assert!(!truncated);
        assert_eq!(exits.len(), 1);
        assert_eq!(exits[0].session.id, "1");

        // Listener-ready wins the race: the exit takes the normal event path
        // and cannot also become a tombstone/API duplicate.
        assert_eq!(
            delivery.delivery_target(),
            DeliveryTarget::RendererAndNativeApi
        );
        assert!(delivery.classify_exit(Some(exit_tombstone("2", "persist-2"))));
        assert_eq!(delivery.exit_tombstones.len(), 1);
        assert_eq!(delivery.pending_live_exits.len(), 1);
        assert_eq!(
            delivery.update_retained_exit_code("2", Some(24)),
            Some(RetainedExitLocation::PendingLive)
        );

        // If WebContent terminates before JS acknowledges that direct event,
        // mark_renderer_unavailable takes the same lock and promotes it. A new
        // ready handshake therefore cannot miss the exit even if emit_to won
        // the original race.
        delivery.terminate_content_generation();
        assert!(delivery.pending_live_exits.is_empty());
        let (exits, truncated) = delivery.enable_renderer("renderer-2".to_string());
        assert!(!truncated);
        assert_eq!(exits.len(), 2);
        assert!(exits.iter().any(|exit| exit.session.id == "2"));

        // Explicit tab close (or a successful respawn by persistId) removes
        // either pending or promoted state. Merely rendering the exit does not:
        // a later WebContent crash must still be able to recover it.
        delivery.remove_exit_by_id("2");
        assert!(delivery
            .exit_tombstones
            .iter()
            .all(|exit| exit.session.id != "2"));
    }

    #[test]
    fn live_removal_publishes_placeholder_before_ready_can_observe_state() {
        use std::collections::HashSet;

        let id = "atomic-exit";
        let mut live_ids = HashSet::from([id.to_string()]);
        let mut delivery = RendererDeliveryState::default();
        let (initial_exits, _) = delivery.enable_renderer("renderer-before-exit".to_string());
        assert!(initial_exits.is_empty());
        let is_observably_present = |live: &HashSet<String>, state: &RendererDeliveryState| {
            live.contains(id)
                || state
                    .pending_live_exits
                    .iter()
                    .chain(state.exit_tombstones.iter())
                    .any(|exit| exit.session.id == id)
        };
        assert!(is_observably_present(&live_ids, &delivery));

        // Production performs these mutations while holding delivery→sessions;
        // an observer can see only the state before or after this model step.
        assert!(live_ids.remove(id));
        let mut placeholder = exit_tombstone(id, "persist-atomic");
        placeholder.exit_code = None;
        assert!(delivery.classify_exit(Some(placeholder)));
        assert!(is_observably_present(&live_ids, &delivery));
        let create_view = delivery
            .retained_exit_for_create("persist-atomic", false)
            .expect("create must observe the pending placeholder");
        assert!(create_view.exited);
        assert_eq!(create_view.exit_code, None);

        // Ready may win before child.wait() supplies the final status. It gets
        // the placeholder immediately, and the retained copy is updated later.
        let (ready_before_code, truncated) = delivery.enable_renderer("renderer-ready".to_string());
        assert!(!truncated);
        assert_eq!(ready_before_code.len(), 1);
        assert_eq!(ready_before_code[0].exit_code, None);
        assert_eq!(
            delivery.update_retained_exit_code(id, Some(41)),
            Some(RetainedExitLocation::RecoveryTombstone)
        );
        assert_eq!(delivery.exit_tombstones[0].exit_code, Some(41));

        // A deliberate respawn can remove the placeholder while wait is still
        // running; the late code update is update-only and cannot resurrect it.
        delivery.remove_exits_by_persist_id("persist-atomic");
        assert_eq!(delivery.update_retained_exit_code(id, Some(42)), None);
        assert!(delivery.exit_tombstones.is_empty());
    }

    #[test]
    fn replacement_renderer_adopts_old_listener_pending_exits_atomically() {
        let mut delivery = RendererDeliveryState::default();
        let (initial, _) = delivery.enable_renderer("renderer-old".to_string());
        assert!(initial.is_empty());
        let mut pending = exit_tombstone("old-pending", "persist-old-pending");
        pending.exit_code = None;
        assert!(delivery.classify_exit(Some(pending)));
        assert_eq!(delivery.pending_live_exits.len(), 1);

        // No unavailable callback is required: a distinct ready ID promotes
        // old-listener pending state before taking ownership.
        let (replacement_exits, truncated) = delivery.enable_renderer("renderer-new".to_string());
        assert!(!truncated);
        assert!(delivery.pending_live_exits.is_empty());
        assert_eq!(replacement_exits.len(), 1);
        assert_eq!(replacement_exits[0].exit_code, None);
        assert_eq!(delivery.listener_id.as_deref(), Some("renderer-new"));

        // Late StrictMode cleanup from the superseded renderer is harmless.
        delivery.cancel_renderer("renderer-old");
        assert!(delivery.renderer_was_canceled("renderer-old"));
        assert_eq!(delivery.listener_id.as_deref(), Some("renderer-new"));
        assert_eq!(
            delivery.update_retained_exit_code("old-pending", Some(9)),
            Some(RetainedExitLocation::RecoveryTombstone)
        );
        assert_eq!(delivery.exit_tombstones[0].exit_code, Some(9));
        assert_eq!(
            delivery.delivery_target(),
            DeliveryTarget::RendererAndNativeApi
        );
    }

    #[test]
    fn canceled_stale_ready_cannot_supersede_new_renderer() {
        let mut delivery = RendererDeliveryState::default();

        // StrictMode can unmount the first async setup before its ready invoke
        // reaches Rust. Remembering the ID makes that eventual invoke inert.
        let stale_ticket = delivery
            .issue_renderer_ticket("renderer-stale".to_string())
            .expect("initial ticket");
        delivery.cancel_renderer("renderer-stale");
        assert!(delivery.renderer_was_canceled("renderer-stale"));

        let current_ticket = delivery
            .issue_renderer_ticket("renderer-current".to_string())
            .expect("replacement ticket");
        let (exits, truncated) = delivery
            .try_enable_renderer(
                "renderer-current".to_string(),
                current_ticket.content_generation,
            )
            .expect("the replacement listener should become current");
        assert!(exits.is_empty());
        assert!(!truncated);
        assert_eq!(delivery.listener_id.as_deref(), Some("renderer-current"));

        assert!(delivery
            .try_enable_renderer(
                "renderer-stale".to_string(),
                stale_ticket.content_generation,
            )
            .is_err());
        assert_eq!(delivery.listener_id.as_deref(), Some("renderer-current"));

        // A duplicate late cleanup is also ID-guarded and cannot turn off the
        // listener that won the ready handshake.
        delivery.cancel_renderer("renderer-stale");
        assert_eq!(delivery.listener_id.as_deref(), Some("renderer-current"));
    }

    #[test]
    fn abrupt_termination_invalidates_no_listener_late_ready() {
        let mut delivery = RendererDeliveryState::default();
        let stale_ticket = delivery
            .issue_renderer_ticket("terminated-content".to_string())
            .expect("old content ticket");
        assert!(delivery.listener_id.is_none());

        // Exact critical race: native termination fires before the queued old
        // ready acquires delivery, while no listener ID exists to cancel.
        delivery.terminate_content_generation();
        assert!(delivery.listener_id.is_none());
        assert!(delivery
            .try_enable_renderer(stale_ticket.renderer_id, stale_ticket.content_generation,)
            .is_err());
        assert!(delivery.listener_id.is_none());

        let replacement_ticket = delivery
            .issue_renderer_ticket("replacement-content".to_string())
            .expect("replacement content ticket");
        let (exits, truncated) = delivery
            .try_enable_renderer(
                replacement_ticket.renderer_id.clone(),
                replacement_ticket.content_generation,
            )
            .expect("current-generation ready must succeed");
        assert!(exits.is_empty());
        assert!(!truncated);
        assert_eq!(
            delivery.listener_id.as_deref(),
            Some(replacement_ticket.renderer_id.as_str())
        );
    }

    #[test]
    fn canceled_renderer_memory_is_bounded_and_deduplicated() {
        let mut delivery = RendererDeliveryState::default();
        for index in 0..=RENDERER_CANCELED_ID_MAX {
            delivery.cancel_renderer(&format!("renderer-{index}"));
        }
        assert_eq!(
            delivery.canceled_renderer_ids.len(),
            RENDERER_CANCELED_ID_MAX
        );
        assert!(!delivery.renderer_was_canceled("renderer-0"));
        assert!(delivery.renderer_was_canceled(&format!("renderer-{RENDERER_CANCELED_ID_MAX}")));

        delivery.cancel_renderer("renderer-1");
        assert_eq!(
            delivery
                .canceled_renderer_ids
                .iter()
                .filter(|id| id.as_str() == "renderer-1")
                .count(),
            1
        );
    }

    #[test]
    fn renderer_ticket_memory_is_bounded() {
        let mut delivery = RendererDeliveryState::default();
        for index in 0..=RENDERER_TICKET_MAX {
            delivery
                .issue_renderer_ticket(format!("ticket-{index}"))
                .expect("ticket registration");
        }
        assert_eq!(delivery.renderer_tickets.len(), RENDERER_TICKET_MAX);
        assert!(delivery
            .validate_renderer_ticket("ticket-0", delivery.content_generation)
            .is_err());
        assert!(delivery
            .validate_renderer_ticket(
                &format!("ticket-{RENDERER_TICKET_MAX}"),
                delivery.content_generation,
            )
            .is_ok());
    }

    #[test]
    fn blocked_session_io_cannot_block_delivery_registry_snapshot() {
        use std::collections::HashMap;
        use std::sync::{mpsc, Arc, Mutex};
        use std::thread;
        use std::time::Duration;

        // This models the production ownership split: a command clones its
        // per-session handle while briefly holding the registry, drops the
        // registry, and only then enters potentially blocking PTY/file I/O.
        // Listener-ready takes delivery -> registry but never the I/O lock.
        for iteration in 0..32 {
            let io_lock = Arc::new(Mutex::new(()));
            let registry = Arc::new(Mutex::new(HashMap::from([(
                "session".to_string(),
                io_lock,
            )])));
            let delivery = Arc::new(Mutex::new(()));
            let (io_locked_tx, io_locked_rx) = mpsc::channel();
            let (release_io_tx, release_io_rx) = mpsc::channel();

            let writer_registry = Arc::clone(&registry);
            let writer = thread::spawn(move || {
                let io = writer_registry
                    .lock()
                    .expect("registry lock")
                    .get("session")
                    .expect("session handle")
                    .clone();
                let _io_guard = io.lock().expect("I/O lock");
                io_locked_tx.send(()).expect("announce blocked I/O");
                release_io_rx.recv().expect("release blocked I/O");
            });
            io_locked_rx
                .recv_timeout(Duration::from_secs(1))
                .expect("writer should hold only the per-session I/O lock");

            let ready_registry = Arc::clone(&registry);
            let ready_delivery = Arc::clone(&delivery);
            let (ready_tx, ready_rx) = mpsc::channel();
            let ready = thread::spawn(move || {
                let _delivery_guard = ready_delivery.lock().expect("delivery lock");
                let session_count = ready_registry.lock().expect("registry lock").len();
                ready_tx.send(session_count).expect("ready snapshot result");
            });

            let snapshot = ready_rx.recv_timeout(Duration::from_secs(1));
            release_io_tx.send(()).expect("release writer");
            writer.join().expect("writer thread");
            ready.join().expect("ready thread");
            assert_eq!(
                snapshot.unwrap_or_else(|_| panic!(
                    "listener-ready blocked behind session I/O in iteration {iteration}"
                )),
                1
            );
        }
    }

    #[test]
    fn close_losing_atomic_exit_removal_clears_the_published_tombstone() {
        use std::collections::HashMap;
        use std::sync::atomic::AtomicBool;
        use std::sync::{mpsc, Arc, Barrier, Mutex};
        use std::thread;
        use std::time::Duration;

        // Deterministically model the production locks and lifecycle flag. The
        // emitter owns delivery→sessions, removes the live entry, claims exit,
        // and publishes a placeholder. Close then observes the missing entry,
        // releases sessions, waits for delivery, and removes that placeholder.
        let sessions = Arc::new(Mutex::new(HashMap::from([(
            "race".to_string(),
            Arc::new(AtomicBool::new(false)),
        )])));
        let delivery = Arc::new(Mutex::new(RendererDeliveryState::default()));
        let published = Arc::new(Barrier::new(2));
        let release_emitter = Arc::new(Barrier::new(2));
        let (missing_tx, missing_rx) = mpsc::channel();

        let emitter_sessions = Arc::clone(&sessions);
        let emitter_delivery = Arc::clone(&delivery);
        let emitter_published = Arc::clone(&published);
        let emitter_release = Arc::clone(&release_emitter);
        let emitter = thread::spawn(move || {
            let mut delivery = emitter_delivery.lock().expect("delivery lock");
            let closing = emitter_sessions
                .lock()
                .expect("sessions lock")
                .remove("race")
                .expect("live session");
            assert!(try_claim_session_closing(&closing));
            let mut placeholder = exit_tombstone("race", "persist-race");
            placeholder.exit_code = None;
            assert!(!delivery.classify_exit(Some(placeholder)));
            emitter_published.wait();
            emitter_release.wait();
        });

        let close_sessions = Arc::clone(&sessions);
        let close_delivery = Arc::clone(&delivery);
        let close_published = Arc::clone(&published);
        let close = thread::spawn(move || {
            close_published.wait();
            let claimed = {
                let sessions = close_sessions.lock().expect("sessions lock");
                sessions.get("race").and_then(|closing| {
                    try_claim_session_closing(closing).then(|| Arc::clone(closing))
                })
            };
            assert!(claimed.is_none());
            missing_tx.send(()).expect("close observed missing entry");

            // Production takes delivery only after releasing sessions. This
            // blocks until the emitter's placeholder publication is complete.
            close_delivery
                .lock()
                .expect("delivery lock")
                .remove_exit_by_id("race");
        });

        let observed_missing = missing_rx.recv_timeout(Duration::from_secs(1));
        // Always release the emitter before asserting so a failed test cannot
        // leave a blocked helper thread behind.
        release_emitter.wait();
        observed_missing.expect("close should observe the atomic exit removal");
        emitter.join().expect("emitter thread");
        close.join().expect("close thread");

        let delivery = delivery.lock().expect("delivery lock");
        assert!(delivery.pending_live_exits.is_empty());
        assert!(delivery.exit_tombstones.is_empty());
    }

    #[test]
    fn retained_exit_blocks_restore_respawn_until_explicit_reconnect() {
        let mut delivery = RendererDeliveryState::default();
        assert!(!delivery.classify_exit(Some(exit_tombstone("7", "persist-7"))));

        let restored = delivery
            .retained_exit_for_create("persist-7", false)
            .expect("normal restore must adopt the exit tombstone");
        assert!(restored.adopted);
        assert!(restored.exited);
        assert_eq!(restored.exit_code, Some(23));
        assert_eq!(restored.replay[0].data, "retained output");

        // Only the explicit reconnect/respawn input may proceed to PTY spawn.
        assert!(delivery
            .retained_exit_for_create("persist-7", true)
            .is_none());
    }

    #[test]
    fn exit_tombstones_are_one_per_session_and_globally_bounded() {
        let mut delivery = RendererDeliveryState::default();
        assert!(!delivery.classify_exit(Some(exit_tombstone("same", "persist-old"))));
        assert!(!delivery.classify_exit(Some(exit_tombstone("same", "persist-new"))));
        assert_eq!(delivery.exit_tombstones.len(), 1);
        assert_eq!(
            delivery.exit_tombstones[0].session.persist_id.as_deref(),
            Some("persist-new")
        );

        for index in 0..=PTY_EXIT_TOMBSTONE_MAX_SESSIONS {
            let id = format!("bounded-{index}");
            assert!(!delivery.classify_exit(Some(exit_tombstone(&id, &id))));
        }
        assert_eq!(
            delivery.exit_tombstones.len(),
            PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        );
        assert!(delivery.exit_tombstones_truncated);

        // The oldest full tombstone was evicted into a fixed-memory, scoped
        // persist-ID filter. It remains non-runnable, including through a
        // later renderer reload, without poisoning unrelated restore IDs.
        let overflow_restore = delivery
            .evicted_exit_for_create(
                "persist-new",
                true,
                Some("saved command"),
                Some("must-not-run"),
                Some("/tmp/project"),
            )
            .expect("the evicted persist ID must never rerun");
        assert!(overflow_restore.adopted);
        assert!(overflow_restore.exited);
        assert!(overflow_restore.replay_truncated);
        assert_eq!(overflow_restore.replay_through_sequence, 0);

        // Normal tombstone cleanup does not turn the historical global
        // overflow bit into a permanent poison for unrelated sessions.
        delivery.remove_exits_by_persist_id("bounded-256");
        assert!(delivery
            .evicted_exit_for_create(
                "unrelated-after-cleanup",
                true,
                Some("safe to restore"),
                Some("new-command"),
                Some("/tmp/other"),
            )
            .is_none());
        assert!(delivery
            .evicted_exit_for_create("persist-new", false, None, None, None)
            .is_some());
    }

    #[test]
    fn pending_and_recovery_exits_share_one_global_cap_without_false_negatives() {
        let mut delivery = RendererDeliveryState::default();
        let recovery_count = PTY_EXIT_TOMBSTONE_MAX_SESSIONS / 2;
        for index in 0..recovery_count {
            let id = format!("recovery-{index}");
            assert!(!delivery.classify_exit(Some(exit_tombstone(&id, &id))));
        }

        let (initial_recovery, truncated) = delivery.enable_renderer("renderer-live".to_string());
        assert_eq!(initial_recovery.len(), recovery_count);
        assert!(!truncated);

        // More than one queue's worth of live exits forces eviction first from
        // older recovery entries and eventually from the oldest pending entry.
        for index in 0..=PTY_EXIT_TOMBSTONE_MAX_SESSIONS {
            let id = format!("pending-{index}");
            assert!(delivery.classify_exit(Some(exit_tombstone(&id, &id))));
        }
        assert_eq!(
            delivery.pending_live_exits.len() + delivery.exit_tombstones.len(),
            PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        );
        assert!(delivery.exit_tombstones.is_empty());
        assert_eq!(
            delivery.pending_live_exits.len(),
            PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        );
        assert!(delivery.exit_tombstones_truncated);

        // Both an evicted recovery entry and an evicted pending entry remain
        // authoritative through the fixed-memory filter, so neither command
        // can be rerun implicitly after its full replay is discarded.
        assert!(delivery
            .evicted_exit_for_create("recovery-0", true, None, None, None)
            .is_some());
        assert!(delivery
            .evicted_exit_for_create("pending-0", true, None, None, None)
            .is_some());
        assert!(delivery
            .retained_exit_for_create("pending-256", false)
            .is_some());

        delivery.terminate_content_generation();
        assert!(delivery.pending_live_exits.is_empty());
        assert_eq!(
            delivery.exit_tombstones.len(),
            PTY_EXIT_TOMBSTONE_MAX_SESSIONS
        );
    }
}
