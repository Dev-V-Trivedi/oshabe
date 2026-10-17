//! Meeting notes: record a call (microphone plus computer audio), transcribe
//! it as it happens, and summarise it afterwards.
//!
//! Everything runs on the device. Only text is saved, never audio.

pub mod capture;
pub mod detect;
pub mod store;
pub mod summary;
pub mod tidy;

use crate::managers::transcription::TranscriptionManager;
use crate::settings::get_settings;
use capture::{CaptureHandle, Track, TARGET_RATE};
use log::{debug, error, info, warn};
use serde::Serialize;
use specta::Type;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use store::MeetingStore;
use tauri::{AppHandle, Emitter, Manager};

/// Shortest and longest piece of audio sent to the speech model at once.
const MIN_FLUSH_SECS: f32 = 6.0;
const MAX_FLUSH_SECS: f32 = 28.0;
/// Pieces shorter than this are not worth transcribing.
const MIN_SPEECH_SECS: f32 = 0.4;
/// A pause this long ends a piece early (computer audio is silent between talk).
const GAP_FLUSH: Duration = Duration::from_millis(1_500);
/// Length of trailing quiet that marks a natural break.
const QUIET_TAIL_SECS: f32 = 0.6;
/// Below this RMS level a piece is treated as silence.
const SILENCE_RMS: f32 = 0.0015;
/// How far back to look for the other side's words when removing echo.
const ECHO_WINDOW_MS: i64 = 40_000;

#[derive(Debug, Clone, Serialize, Type)]
pub struct ActiveMeeting {
    pub id: i64,
    pub started_at: i64,
    /// False when only the microphone is being recorded.
    pub system_audio: bool,
    /// Machine-readable note for the UI (`system_audio_unavailable: ...`,
    /// `microphone_unavailable: ...`), if something is degraded.
    pub warning: Option<String>,
    /// True while recording is paused.
    pub paused: bool,
}

/// Live input levels (0 to 1) sent to the UI so people can see the app hears them.
#[derive(Debug, Clone, Serialize)]
struct LevelEvent {
    you: f32,
    others: f32,
    paused: bool,
}

#[derive(Debug, Clone, Serialize)]
struct SegmentEvent {
    meeting_id: i64,
    track: String,
    start_ms: i64,
    text: String,
}

#[derive(Debug, Clone, Serialize)]
struct ErrorEvent {
    meeting_id: i64,
    message: String,
}

#[derive(Debug, Clone, Serialize)]
struct SummaryEvent {
    meeting_id: i64,
    ok: bool,
    message: String,
}

struct Running {
    info: ActiveMeeting,
    stop: Arc<AtomicBool>,
    captures: Vec<CaptureHandle>,
    worker: JoinHandle<usize>,
    paused: Arc<AtomicBool>,
    /// Total time spent paused, in milliseconds.
    paused_ms: Arc<AtomicI64>,
    pause_started: Option<Instant>,
}

pub struct MeetingManager {
    app: AppHandle,
    store: Arc<MeetingStore>,
    active: Mutex<Option<Running>>,
}

impl MeetingManager {
    pub fn new(app: &AppHandle) -> anyhow::Result<Self> {
        let dir = crate::portable::app_data_dir(app)?;
        std::fs::create_dir_all(&dir)?;
        let store = Arc::new(MeetingStore::open(&dir.join("meetings.db"))?);
        Ok(Self {
            app: app.clone(),
            store,
            active: Mutex::new(None),
        })
    }

    /// Apply the retention setting: remove finished meetings older than the
    /// chosen number of days. Does nothing when the setting is 0 (keep forever).
    pub fn purge_expired(&self) {
        let days = crate::settings::get_settings(&self.app).meeting_retention_days;
        if days == 0 {
            return;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let cutoff = now - i64::from(days) * 86_400;
        match self.store.purge_older_than(cutoff) {
            Ok(0) => {}
            Ok(n) => log::info!("Removed {} meetings older than {} days", n, days),
            Err(e) => log::warn!("Could not remove old meetings: {}", e),
        }
    }

    pub fn store(&self) -> Arc<MeetingStore> {
        Arc::clone(&self.store)
    }

    pub fn active(&self) -> Option<ActiveMeeting> {
        self.active.lock().ok().and_then(|a| {
            a.as_ref().map(|r| {
                let mut info = r.info.clone();
                info.paused = r.paused.load(Ordering::SeqCst);
                info
            })
        })
    }

    /// Stop listening for a while without ending the meeting.
    pub fn pause(&self) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        let r = active
            .as_mut()
            .ok_or_else(|| "No meeting is being recorded".to_string())?;
        if !r.paused.swap(true, Ordering::SeqCst) {
            r.pause_started = Some(Instant::now());
        }
        drop(active);
        let _ = self.app.emit("meeting-paused", true);
        crate::tray::sync_tray(&self.app);
        Ok(())
    }

    pub fn resume(&self) -> Result<(), String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        let r = active
            .as_mut()
            .ok_or_else(|| "No meeting is being recorded".to_string())?;
        if r.paused.swap(false, Ordering::SeqCst) {
            if let Some(t) = r.pause_started.take() {
                r.paused_ms
                    .fetch_add(t.elapsed().as_millis() as i64, Ordering::SeqCst);
            }
        }
        drop(active);
        let _ = self.app.emit("meeting-paused", false);
        crate::tray::sync_tray(&self.app);
        Ok(())
    }

    pub fn start(&self, title: Option<String>) -> Result<ActiveMeeting, String> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| "lock poisoned".to_string())?;
        if active.is_some() {
            return Err("A meeting is already being recorded".to_string());
        }

        let settings = get_settings(&self.app);
        if settings.selected_model.trim().is_empty() {
            return Err("no_model".to_string());
        }
        let tm = self.app.state::<Arc<TranscriptionManager>>();
        tm.initiate_model_load();

        let started_at = chrono::Utc::now().timestamp();
        let (title, is_default) = match title
            .map(|t| t.trim().to_string())
            .filter(|t| !t.is_empty())
        {
            Some(t) => (t, false),
            None => (
                format!("Meeting {}", chrono::Local::now().format("%Y-%m-%d %H:%M")),
                true,
            ),
        };
        let id = self
            .store
            .create(&title, is_default, started_at)
            .map_err(|e| e.to_string())?;

        let (tx, rx) = mpsc::channel();
        let mic = capture::start(Track::You, settings.selected_microphone.clone(), tx.clone());
        let system = capture::start(Track::Others, None, tx.clone());
        drop(tx);

        let mut captures = Vec::new();
        let mut warning = None;
        let mut system_audio = false;
        match mic {
            Ok(h) => captures.push(h),
            Err(e) => warning = Some(format!("microphone_unavailable: {e}")),
        }
        match system {
            Ok(h) => {
                captures.push(h);
                system_audio = true;
            }
            Err(e) => {
                warning.get_or_insert(format!("system_audio_unavailable: {e}"));
            }
        }
        if captures.is_empty() {
            let _ = self.store.delete(id);
            return Err(warning.unwrap_or_else(|| "Could not start recording".to_string()));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let paused_ms = Arc::new(AtomicI64::new(0));
        let worker = {
            let paused = Arc::clone(&paused);
            let paused_ms = Arc::clone(&paused_ms);
            let app = self.app.clone();
            let store = Arc::clone(&self.store);
            let stop = Arc::clone(&stop);
            std::thread::Builder::new()
                .name("meeting-worker".to_string())
                .spawn(move || {
                    run_worker(app, store, id, rx, stop, paused, paused_ms, Instant::now())
                })
                .map_err(|e| e.to_string())?
        };

        let info = ActiveMeeting {
            id,
            started_at,
            system_audio,
            warning,
            paused: false,
        };
        info!(
            "Meeting {} started (system audio: {}, warning: {:?})",
            id, info.system_audio, info.warning
        );
        *active = Some(Running {
            info: info.clone(),
            stop,
            captures,
            worker,
            paused,
            paused_ms,
            pause_started: None,
        });
        let _ = self.app.emit("meeting-status", true);
        crate::tray::sync_tray(&self.app);
        Ok(info)
    }

    /// Stop recording, wait for the last piece to be transcribed and return the
    /// meeting id. Blocking: call from a blocking thread.
    pub fn stop(&self) -> Result<i64, String> {
        let running = self
            .active
            .lock()
            .map_err(|_| "lock poisoned".to_string())?
            .take()
            .ok_or_else(|| "No meeting is being recorded".to_string())?;
        let id = running.info.id;

        running.stop.store(true, Ordering::SeqCst);
        for capture in running.captures {
            capture.stop();
        }
        let segments = match running.worker.join() {
            Ok(n) => n,
            Err(_) => {
                error!("Meeting worker panicked");
                0
            }
        };
        if segments == 0 {
            let _ = self.app.emit(
                "meeting-error",
                ErrorEvent {
                    meeting_id: id,
                    message: "no_speech".to_string(),
                },
            );
        }
        if let Err(e) = self.store.finish(id, chrono::Utc::now().timestamp()) {
            error!("Failed to close meeting {}: {}", id, e);
        }
        let _ = self.app.emit("meeting-status", false);
        crate::tray::sync_tray(&self.app);
        info!("Meeting {} stopped", id);
        Ok(id)
    }

    /// Make the summary in the background and tell the UI when it is done.
    pub fn summarize_in_background(&self, id: i64) {
        let app = self.app.clone();
        let store = Arc::clone(&self.store);
        tauri::async_runtime::spawn(async move {
            let event = match summary::summarize(&app, &store, id).await {
                Ok(()) => SummaryEvent {
                    meeting_id: id,
                    ok: true,
                    message: String::new(),
                },
                Err(message) => {
                    debug!("Meeting {} summary not made: {}", id, message);
                    SummaryEvent {
                        meeting_id: id,
                        ok: false,
                        message,
                    }
                }
            };
            let _ = app.emit("meeting-summary", event);
        });
    }
}

/// Audio waiting to be transcribed for one track.
struct TrackBuf {
    track: Track,
    samples: Vec<f32>,
    /// Meeting time of the first sample, in milliseconds.
    start_ms: i64,
    last_arrival: Instant,
}

impl TrackBuf {
    fn new(track: Track) -> Self {
        Self {
            track,
            samples: Vec::new(),
            start_ms: 0,
            last_arrival: Instant::now(),
        }
    }

    fn push(&mut self, chunk: Vec<f32>, elapsed_ms: i64) {
        if self.samples.is_empty() {
            let chunk_ms = (chunk.len() as f64 * 1000.0 / TARGET_RATE as f64) as i64;
            self.start_ms = (elapsed_ms - chunk_ms).max(0);
        }
        self.samples.extend(chunk);
        self.last_arrival = Instant::now();
    }

    fn secs(&self) -> f32 {
        self.samples.len() as f32 / TARGET_RATE as f32
    }

    fn should_flush(&self, now: Instant) -> bool {
        if self.samples.is_empty() {
            return false;
        }
        let secs = self.secs();
        secs >= MAX_FLUSH_SECS
            || now.duration_since(self.last_arrival) >= GAP_FLUSH
            || (secs >= MIN_FLUSH_SECS && tail_is_quiet(&self.samples))
    }
}

fn rms(samples: &[f32]) -> f32 {
    if samples.is_empty() {
        return 0.0;
    }
    (samples.iter().map(|s| s * s).sum::<f32>() / samples.len() as f32).sqrt()
}

fn tail_is_quiet(samples: &[f32]) -> bool {
    let n = (QUIET_TAIL_SECS * TARGET_RATE as f32) as usize;
    if samples.len() < n {
        return false;
    }
    rms(&samples[samples.len() - n..]) < SILENCE_RMS
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// Without headphones the microphone hears the other side through the
/// speakers. Drop a "You" line whose words are almost all in what "Others"
/// just said.
fn is_echo(you_text: &str, recent_others: &[(i64, String)], start_ms: i64) -> bool {
    let you = words(you_text);
    if you.len() < 3 {
        return false;
    }
    let mut pool: Vec<String> = Vec::new();
    for (ms, text) in recent_others {
        if (start_ms - ms).abs() <= ECHO_WINDOW_MS {
            pool.extend(words(text));
        }
    }
    if pool.is_empty() {
        return false;
    }
    let hits = you.iter().filter(|w| pool.contains(w)).count();
    hits as f32 / you.len() as f32 >= 0.75
}

struct Worker {
    app: AppHandle,
    store: Arc<MeetingStore>,
    meeting_id: i64,
    recent_others: Vec<(i64, String)>,
    error_reported: bool,
    saved: usize,
    /// Pieces in a row that took longer to transcribe than they lasted.
    slow_streak: u32,
    slow_reported: bool,
}

/// After stopping, the worker keeps transcribing what is still queued. When the
/// model is slower than real time that queue can take minutes, so give up on
/// the rest after this long and keep what is already saved.
const STOP_DRAIN_BUDGET: Duration = Duration::from_secs(90);
/// A piece is "slow" when transcribing it took this many times its length.
const SLOW_FACTOR: f32 = 1.2;

/// Did transcribing `audio_secs` of speech in `took_secs` fall behind real time?
fn is_slow(audio_secs: f32, took_secs: f32) -> bool {
    audio_secs > 0.0 && took_secs > audio_secs * SLOW_FACTOR
}

impl Worker {
    /// Log how fast the model is and warn once when it cannot keep up.
    fn note_speed(&mut self, audio_secs: f32, took_secs: f32) {
        info!(
            "Meeting {}: transcribed {:.1}s of audio in {:.1}s",
            self.meeting_id, audio_secs, took_secs
        );
        if is_slow(audio_secs, took_secs) {
            self.slow_streak += 1;
        } else {
            self.slow_streak = 0;
        }
        if self.slow_streak >= 2 && !self.slow_reported {
            self.slow_reported = true;
            let _ = self.app.emit(
                "meeting-error",
                ErrorEvent {
                    meeting_id: self.meeting_id,
                    message: "too_slow".to_string(),
                },
            );
        }
    }

    /// Wait for the model to finish loading, up to `deadline` if one is given
    /// (shutdown's own drain budget already bounds how long this may run), or
    /// 120s otherwise.
    fn wait_for_model(&self, tm: &TranscriptionManager, deadline: Option<Instant>) -> bool {
        if tm.is_model_loaded() {
            return true;
        }
        tm.initiate_model_load();
        let max_wait = deadline
            .map(|d| d.saturating_duration_since(Instant::now()))
            .unwrap_or(Duration::from_secs(120));
        let attempts = max_wait.as_millis() / 500;
        for _ in 0..attempts {
            if tm.is_model_loaded() {
                return true;
            }
            std::thread::sleep(Duration::from_millis(500));
        }
        tm.is_model_loaded()
    }

    fn flush(&mut self, buf: &mut TrackBuf, deadline: Option<Instant>) {
        let samples = std::mem::take(&mut buf.samples);
        if (samples.len() as f32 / TARGET_RATE as f32) < MIN_SPEECH_SECS
            || rms(&samples) < SILENCE_RMS
        {
            return;
        }

        let tm = self.app.state::<Arc<TranscriptionManager>>();
        if !self.wait_for_model(&tm, deadline) {
            self.report("The speech model is not loaded".to_string());
            return;
        }

        let audio_secs = samples.len() as f32 / TARGET_RATE as f32;
        let started = Instant::now();
        let result = tm.transcribe(samples);
        self.note_speed(audio_secs, started.elapsed().as_secs_f32());
        let text = match result {
            Ok(t) => t.trim().to_string(),
            Err(e) => {
                warn!("Meeting chunk failed: {}", e);
                self.report(e.to_string());
                return;
            }
        };
        if text.chars().filter(|c| c.is_alphanumeric()).count() < 2 {
            return;
        }

        match buf.track {
            Track::Others => {
                self.recent_others.push((buf.start_ms, text.clone()));
                let cutoff = buf.start_ms - ECHO_WINDOW_MS * 2;
                self.recent_others.retain(|(ms, _)| *ms >= cutoff);
            }
            Track::You => {
                if is_echo(&text, &self.recent_others, buf.start_ms) {
                    debug!("Dropped echo from microphone: {}", text);
                    return;
                }
            }
        }

        if let Err(e) =
            self.store
                .add_segment(self.meeting_id, buf.track.as_str(), buf.start_ms, &text)
        {
            error!("Failed to save meeting segment: {}", e);
        } else {
            self.saved += 1;
        }
        let _ = self.app.emit(
            "meeting-segment",
            SegmentEvent {
                meeting_id: self.meeting_id,
                track: buf.track.as_str().to_string(),
                start_ms: buf.start_ms,
                text,
            },
        );
    }

    fn report(&mut self, message: String) {
        if self.error_reported {
            return;
        }
        self.error_reported = true;
        let _ = self.app.emit(
            "meeting-error",
            ErrorEvent {
                meeting_id: self.meeting_id,
                message,
            },
        );
    }
}

#[allow(clippy::too_many_arguments)]
fn run_worker(
    app: AppHandle,
    store: Arc<MeetingStore>,
    meeting_id: i64,
    rx: Receiver<(Track, Vec<f32>)>,
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    paused_ms: Arc<AtomicI64>,
    started: Instant,
) -> usize {
    let mut worker = Worker {
        app,
        store,
        meeting_id,
        recent_others: Vec::new(),
        error_reported: false,
        saved: 0,
        slow_streak: 0,
        slow_reported: false,
    };
    let mut bufs = [TrackBuf::new(Track::You), TrackBuf::new(Track::Others)];
    let mut level = [0.0f32; 2];
    let mut last_level_emit = Instant::now();
    let mut was_paused = false;
    let mut stop_seen_at: Option<Instant> = None;
    let mut gave_up = false;

    loop {
        if stop.load(Ordering::SeqCst) {
            let since = *stop_seen_at.get_or_insert_with(Instant::now);
            if since.elapsed() > STOP_DRAIN_BUDGET {
                warn!(
                    "Meeting {}: transcription is behind, dropping the queued audio",
                    meeting_id
                );
                gave_up = true;
                break;
            }
        }
        let is_paused = paused.load(Ordering::SeqCst);
        if is_paused && !was_paused {
            // Transcribe what was said before the pause.
            for buf in bufs.iter_mut() {
                worker.flush(buf, None);
            }
        }
        was_paused = is_paused;

        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok((track, chunk)) => {
                let idx = if track == Track::You { 0 } else { 1 };
                level[idx] = level[idx].max(rms(&chunk));
                if !is_paused {
                    let elapsed =
                        started.elapsed().as_millis() as i64 - paused_ms.load(Ordering::SeqCst);
                    bufs[idx].push(chunk, elapsed);
                }
            }
            Err(RecvTimeoutError::Timeout) => {}
            // Every capture has stopped and the queue is drained.
            Err(RecvTimeoutError::Disconnected) => break,
        }

        let now = Instant::now();
        if now.duration_since(last_level_emit) >= Duration::from_millis(300) {
            last_level_emit = now;
            // Speech sits around 0.01 to 0.2 RMS; scale so normal talking fills the bar.
            let scale = |v: f32| (v * 8.0).min(1.0);
            let _ = worker.app.emit(
                "meeting-levels",
                LevelEvent {
                    you: scale(level[0]),
                    others: scale(level[1]),
                    paused: is_paused,
                },
            );
            level = [0.0; 2];
        }
        if !is_paused {
            for buf in bufs.iter_mut() {
                if buf.should_flush(now) {
                    worker.flush(buf, None);
                }
            }
        }
    }

    if gave_up {
        let _ = worker.app.emit(
            "meeting-error",
            ErrorEvent {
                meeting_id,
                message: "stopped_early".to_string(),
            },
        );
    } else {
        // Shutting down: cap the model wait to what's left of the drain
        // budget, not a fresh 120s.
        let deadline = stop_seen_at.map(|t| t + STOP_DRAIN_BUDGET);
        for buf in bufs.iter_mut() {
            worker.flush(buf, deadline);
        }
    }
    debug!("Meeting {} worker finished", meeting_id);
    worker.saved
}

/// Start meeting notes if idle, otherwise stop and summarise. Used by the
/// keyboard shortcut and the tray menu, so it never needs the window open.
pub fn toggle(app: &AppHandle) {
    use crate::audio_feedback::{play_feedback_sound, SoundType};
    let Some(manager) = app
        .try_state::<Arc<MeetingManager>>()
        .map(|s| Arc::clone(&s))
    else {
        return;
    };
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if manager.active().is_some() {
            let stopper = Arc::clone(&manager);
            match tauri::async_runtime::spawn_blocking(move || stopper.stop()).await {
                Ok(Ok(id)) => {
                    play_feedback_sound(&app, SoundType::Stop);
                    manager.purge_expired();
                    manager.summarize_in_background(id);
                }
                Ok(Err(e)) => {
                    let _ = app.emit("meeting-error", e);
                }
                Err(e) => error!("Meeting stop task failed: {}", e),
            }
        } else {
            let starter = Arc::clone(&manager);
            match tauri::async_runtime::spawn_blocking(move || starter.start(None)).await {
                Ok(Ok(_)) => play_feedback_sound(&app, SoundType::Start),
                Ok(Err(e)) => {
                    let _ = app.emit("meeting-error", e);
                }
                Err(e) => error!("Meeting start task failed: {}", e),
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn echo_is_detected_when_words_match() {
        let others = vec![(
            10_000,
            "we should ship the update on friday morning".to_string(),
        )];
        assert!(is_echo("ship the update on friday", &others, 12_000));
    }

    #[test]
    fn real_replies_are_not_echo() {
        let others = vec![(
            10_000,
            "we should ship the update on friday morning".to_string(),
        )];
        assert!(!is_echo(
            "sounds good i will prepare the release notes",
            &others,
            12_000
        ));
    }

    #[test]
    fn short_replies_and_old_context_are_kept() {
        let others = vec![(10_000, "okay thanks".to_string())];
        assert!(!is_echo("okay thanks", &others, 12_000)); // too short to judge
        let old = vec![(0, "we should ship the update on friday".to_string())];
        assert!(!is_echo("ship the update on friday", &old, 200_000));
    }

    #[test]
    fn slow_detection_compares_against_real_time() {
        assert!(is_slow(10.0, 30.0));
        assert!(!is_slow(10.0, 8.0));
        assert!(!is_slow(10.0, 11.0)); // a little over is still fine
        assert!(!is_slow(0.0, 5.0));
    }

    #[test]
    fn silence_detection() {
        let mut s = vec![0.2f32; 16_000 * 11];
        s.extend(vec![0.0f32; 16_000]);
        assert!(tail_is_quiet(&s));
        assert!(!tail_is_quiet(&vec![0.2f32; 16_000]));
        assert!(rms(&[0.0; 100]) < SILENCE_RMS);
    }

    #[test]
    fn buffers_flush_on_length_and_gap() {
        let mut b = TrackBuf::new(Track::Others);
        assert!(!b.should_flush(Instant::now()));
        b.push(vec![0.3; 16_000], 5_000);
        assert_eq!(b.start_ms, 4_000);
        assert!(!b.should_flush(Instant::now()));
        assert!(b.should_flush(Instant::now() + Duration::from_secs(2)));
        let mut long = TrackBuf::new(Track::You);
        long.push(vec![0.3; (16_000.0 * MAX_FLUSH_SECS) as usize + 10], 40_000);
        assert!(long.should_flush(Instant::now()));
    }
}
