#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
use crate::apple_intelligence;
use crate::audio_feedback::{play_feedback_sound, play_feedback_sound_blocking, SoundType};
use crate::audio_toolkit::VadPolicy;
use crate::managers::audio::{recording_error_type, AudioRecordingManager};
use crate::managers::history::HistoryManager;
use crate::managers::model::ModelManager;
use crate::managers::transcription::StreamWorkKind;
use crate::managers::transcription::TranscriptionManager;
use crate::settings::{get_settings, AppSettings, OverlayStyle, APPLE_INTELLIGENCE_PROVIDER_ID};
use crate::shortcut;
use crate::tray::{set_tray_state, TrayIconState};
use crate::utils::{
    self, show_processing_overlay, show_recording_overlay, show_transcribing_overlay,
};
use crate::TranscriptionCoordinator;
use log::{debug, error, warn};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri::{AppHandle, Emitter};

const CANCELLATION_POLL_INTERVAL: Duration = Duration::from_millis(25);
// Safety net for a transcription call that never returns (a wedged native
// engine, a pathological input). Without this the overlay stays on
// "Processing" forever with no way out but killing the app. Generous enough
// that a slow CPU-only/emulated run on a long recording still finishes
// normally.
const TRANSCRIPTION_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Clone, serde::Serialize)]
struct RecordingErrorEvent {
    error_type: String,
    detail: Option<String>,
}

/// Drop guard that finishes the transcription pipeline, including immediate
/// model unloading on early exits.
struct FinishGuard(AppHandle, Arc<TranscriptionManager>);
impl Drop for FinishGuard {
    fn drop(&mut self) {
        self.1.maybe_unload_immediately("transcription session");
        if let Some(c) = self.0.try_state::<TranscriptionCoordinator>() {
            c.notify_processing_finished();
        }
        // The pipeline just freed its large transient buffers (captured PCM,
        // WAV copy, engine scratch); hand the cached pages back to the OS so
        // they don't sit in malloc arenas until they get swapped out (#1792).
        crate::memory::trim_freed_memory();
    }
}

// Shortcut Action Trait
pub trait ShortcutAction: Send + Sync {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str);
}

// Transcribe Action
struct TranscribeAction {
    post_process: bool,
}

/// Field name for structured output JSON schema
const TRANSCRIPTION_FIELD: &str = "transcription";

/// Strip invisible Unicode characters that some LLMs may insert
fn strip_invisible_chars(s: &str) -> String {
    s.replace(['\u{200B}', '\u{200C}', '\u{200D}', '\u{FEFF}'], "")
}

/// Strip a leading `<think>...</think>` block. Some endpoints can't disable
/// reasoning, and some local servers put the reasoning text into `content`
/// instead of a separate field — without this the user would get the model's
/// chain of thought pasted along with the cleaned transcription.
fn strip_think_block(s: &str) -> &str {
    if let Some(rest) = s.trim_start().strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            return rest[end + "</think>".len()..].trim_start();
        }
    }
    s
}

/// Build a system prompt from the user's prompt template.
/// Removes `${output}` placeholder since the transcription is sent as the user message.
fn build_system_prompt(prompt_template: &str) -> String {
    prompt_template.replace("${output}", "").trim().to_string()
}

/// Returns `true` when a transcription has no meaningful content to
/// post-process (empty or whitespace-only). Used to skip the post-processing
/// LLM call when nothing was actually transcribed, which would otherwise make
/// the model reply with an error message such as "you need to provide the
/// transcription".
fn is_blank_transcription(transcription: &str) -> bool {
    transcription.trim().is_empty()
}

/// Minimum number of back-to-back repeats of the same short word-sequence
/// before a transcript is treated as degenerate rather than real speech.
/// 2 (not 3) because a dictionary entry pasted twice in a row is already a
/// clean, confirmed symptom of prompt echo, not something worth waiting on
/// a third repeat to confirm.
const REPETITION_MIN_REPEATS: usize = 2;
/// Minimum fraction of the transcript the repeating sequence must cover.
const REPETITION_MIN_COVERAGE: f32 = 0.75;

/// Detects a transcript dominated by one short word-sequence repeating back
/// to back — the shape Whisper's initial-prompt echo takes on unclear or
/// silent audio (the model regurgitates the custom-word dictionary prompt
/// instead of admitting it heard nothing), rather than real speech.
fn is_degenerate_repetition(transcription: &str) -> bool {
    let words: Vec<String> = transcription
        .split_whitespace()
        .map(|w| w.to_lowercase())
        .collect();
    let n = words.len();
    if n < REPETITION_MIN_REPEATS * 2 {
        return false;
    }
    for window in 1..=4usize {
        if n < window * REPETITION_MIN_REPEATS {
            continue;
        }
        // A repeating run can start anywhere in the transcript, not just at
        // the beginning (real speech can precede or follow a degenerate loop).
        let mut start = 0;
        while start + window * REPETITION_MIN_REPEATS <= n {
            let mut repeats = 1usize;
            let mut i = start + window;
            while i + window <= n && words[i..i + window] == words[i - window..i] {
                repeats += 1;
                i += window;
            }
            let covered = (repeats * window) as f32 / n as f32;
            if repeats >= REPETITION_MIN_REPEATS && covered > REPETITION_MIN_COVERAGE {
                return true;
            }
            start += 1;
        }
    }
    false
}

/// Minimum run of consecutive words in a script other than the transcript's
/// own before it's treated as having drifted into Whisper's known
/// multi-script hallucination failure mode: on a low-confidence segment
/// (background noise, a pause) the decoder's temperature fallback can lose
/// the language constraint and emit fluent-looking garbage in unrelated
/// scripts, rather than admitting it heard nothing.
const SCRIPT_DRIFT_MIN_RUN: usize = 2;

/// Unicode script families distinguished for drift detection. Not
/// exhaustive — anything not covered here (symbols, most punctuation,
/// digits) has no script and doesn't participate in detection.
#[derive(PartialEq, Eq, Clone, Copy, Debug)]
enum Script {
    Latin,
    Greek,
    Cyrillic,
    Devanagari,
    Han,
    Hiragana,
    Katakana,
    Hangul,
    Arabic,
    Hebrew,
}

fn char_script(c: char) -> Option<Script> {
    match c {
        'a'..='z' | 'A'..='Z' | '\u{00C0}'..='\u{024F}' => Some(Script::Latin),
        '\u{0370}'..='\u{03FF}' => Some(Script::Greek),
        '\u{0400}'..='\u{04FF}' => Some(Script::Cyrillic),
        '\u{0900}'..='\u{097F}' => Some(Script::Devanagari),
        '\u{4E00}'..='\u{9FFF}' => Some(Script::Han),
        '\u{3040}'..='\u{309F}' => Some(Script::Hiragana),
        '\u{30A0}'..='\u{30FF}' => Some(Script::Katakana),
        '\u{AC00}'..='\u{D7A3}' => Some(Script::Hangul),
        '\u{0600}'..='\u{06FF}' => Some(Script::Arabic),
        '\u{0590}'..='\u{05FF}' => Some(Script::Hebrew),
        _ => None,
    }
}

/// A word's dominant script: the script of its first script-bearing
/// character. A word made only of digits/punctuation/symbols has none.
fn word_script(word: &str) -> Option<Script> {
    word.chars().find_map(char_script)
}

/// The transcript's own script, taken as the most common script among the
/// first few script-bearing words (a small sample, not just the first word,
/// so one misheard word at the very start can't misidentify it).
fn primary_script(scripts: &[Option<Script>]) -> Option<Script> {
    let mut counts: Vec<(Script, usize)> = Vec::new();
    for s in scripts.iter().flatten().take(5) {
        match counts.iter_mut().find(|(sc, _)| sc == s) {
            Some((_, n)) => *n += 1,
            None => counts.push((*s, 1)),
        }
    }
    counts.into_iter().max_by_key(|&(_, n)| n).map(|(s, _)| s)
}

/// Detects a transcript that starts in its own script and then drifts, for
/// `SCRIPT_DRIFT_MIN_RUN`-or-more consecutive script-bearing words, into a
/// different script — the shape of the hallucination described above.
/// Returns the clean prefix up to (not including) the drift when found, so
/// the caller can keep the good part instead of discarding everything.
/// Returns `None` when no drift is found (including transcripts with no
/// determinable script, or ones consistently in a single non-Latin script).
fn truncate_script_drift(transcription: &str) -> Option<String> {
    let words: Vec<&str> = transcription.split_whitespace().collect();
    let scripts: Vec<Option<Script>> = words.iter().map(|w| word_script(w)).collect();
    let primary = primary_script(&scripts)?;

    let mut run = 0usize;
    let mut drift_start = 0usize;
    for (i, script) in scripts.iter().enumerate() {
        match script {
            Some(s) if *s != primary => {
                if run == 0 {
                    drift_start = i;
                }
                run += 1;
                if run >= SCRIPT_DRIFT_MIN_RUN {
                    return Some(words[..drift_start].join(" "));
                }
            }
            Some(_) => run = 0,
            // Digit/punctuation-only words carry no script evidence either
            // way and don't interrupt or extend a drift run.
            None => {}
        }
    }
    None
}

async fn complete_unless_cancelled<F, C>(operation: F, is_cancelled: C) -> Option<F::Output>
where
    F: Future,
    C: Fn() -> bool,
{
    tokio::pin!(operation);

    loop {
        if is_cancelled() {
            return None;
        }

        if let Ok(result) =
            tokio::time::timeout(CANCELLATION_POLL_INTERVAL, operation.as_mut()).await
        {
            return Some(result);
        }
    }
}

fn should_use_streaming_overlay(style: OverlayStyle, is_streaming: bool) -> bool {
    style == OverlayStyle::Live && is_streaming
}

async fn post_process_transcription(settings: &AppSettings, transcription: &str) -> Option<String> {
    if is_blank_transcription(transcription) {
        debug!("Post-processing skipped because the transcription is empty");
        return None;
    }

    let provider = match settings.active_post_process_provider().cloned() {
        Some(provider) => provider,
        None => {
            debug!("Post-processing enabled but no provider is selected");
            return None;
        }
    };

    let model = settings
        .post_process_models
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    if model.trim().is_empty() {
        debug!(
            "Post-processing skipped because provider '{}' has no model configured",
            provider.id
        );
        return None;
    }

    let selected_prompt_id = match &settings.post_process_selected_prompt_id {
        Some(id) => id.clone(),
        None => {
            debug!("Post-processing skipped because no prompt is selected");
            return None;
        }
    };

    let prompt = match settings
        .post_process_prompts
        .iter()
        .find(|prompt| prompt.id == selected_prompt_id)
    {
        Some(prompt) => prompt.prompt.clone(),
        None => {
            debug!(
                "Post-processing skipped because prompt '{}' was not found",
                selected_prompt_id
            );
            return None;
        }
    };

    if prompt.trim().is_empty() {
        debug!("Post-processing skipped because the selected prompt is empty");
        return None;
    }

    let prompt = if settings.context_tone_enabled {
        match tauri::async_runtime::spawn_blocking(crate::active_app::foreground_app)
            .await
            .ok()
            .flatten()
        {
            Some(app) => match crate::active_app::match_tone(&settings.app_tone_rules, &app) {
                Some(rule) => {
                    debug!(
                        "Context tone '{}' applied for app '{}' (title: '{}')",
                        rule.id, app.name, app.title
                    );
                    format!("{prompt}{}", crate::active_app::tone_instruction(rule))
                }
                None => {
                    debug!("No tone rule matched app '{}'", app.name);
                    prompt
                }
            },
            None => {
                debug!("Foreground app not detected, skipping context tone");
                prompt
            }
        }
    } else {
        prompt
    };
    let prompt = format!(
        "{prompt}{}",
        crate::user_rules::instructions(&settings.user_rules, crate::user_rules::SCOPE_DICTATION)
    );

    debug!(
        "Starting LLM post-processing with provider '{}' (model: {})",
        provider.id, model
    );

    let api_key = settings
        .post_process_api_keys
        .get(&provider.id)
        .cloned()
        .unwrap_or_default();

    // Ask these providers to skip reasoning/thinking — post-processing rarely
    // benefits from it and it adds seconds of latency. llm_client picks the
    // field the endpoint understands and retries without it if rejected.
    let disable_reasoning = matches!(provider.id.as_str(), "custom" | "ollama" | "openrouter");

    if provider.supports_structured_output {
        debug!("Using structured outputs for provider '{}'", provider.id);

        let system_prompt = build_system_prompt(&prompt);
        let user_content = transcription.to_string();

        // Handle Apple Intelligence separately since it uses native Swift APIs
        if provider.id == APPLE_INTELLIGENCE_PROVIDER_ID {
            #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
            {
                if !apple_intelligence::check_apple_intelligence_availability() {
                    debug!(
                        "Apple Intelligence selected but not currently available on this device"
                    );
                    return None;
                }

                let token_limit = model.trim().parse::<i32>().unwrap_or(0);
                return match apple_intelligence::process_text_with_system_prompt(
                    &system_prompt,
                    &user_content,
                    token_limit,
                ) {
                    Ok(result) => {
                        if result.trim().is_empty() {
                            debug!("Apple Intelligence returned an empty response");
                            None
                        } else {
                            let result = strip_invisible_chars(&result);
                            debug!(
                                "Apple Intelligence post-processing succeeded. Output length: {} chars",
                                result.len()
                            );
                            Some(result)
                        }
                    }
                    Err(err) => {
                        error!("Apple Intelligence post-processing failed: {}", err);
                        None
                    }
                };
            }

            #[cfg(not(all(target_os = "macos", target_arch = "aarch64")))]
            {
                debug!("Apple Intelligence provider selected on unsupported platform");
                return None;
            }
        }

        // Define JSON schema for transcription output
        let json_schema = serde_json::json!({
            "type": "object",
            "properties": {
                (TRANSCRIPTION_FIELD): {
                    "type": "string",
                    "description": "The cleaned and processed transcription text"
                }
            },
            "required": [TRANSCRIPTION_FIELD],
            "additionalProperties": false
        });

        match crate::llm_client::send_chat_completion_with_schema(
            &provider,
            api_key.clone(),
            &model,
            user_content,
            Some(system_prompt),
            Some(json_schema),
            disable_reasoning,
        )
        .await
        {
            Ok(Some(content)) => {
                // Parse the JSON response to extract the transcription field
                let content = strip_think_block(&content);
                match serde_json::from_str::<serde_json::Value>(content) {
                    Ok(json) => {
                        if let Some(transcription_value) =
                            json.get(TRANSCRIPTION_FIELD).and_then(|t| t.as_str())
                        {
                            let result = strip_invisible_chars(transcription_value);
                            debug!(
                                "Structured output post-processing succeeded for provider '{}'. Output length: {} chars",
                                provider.id,
                                result.len()
                            );
                            return Some(result);
                        } else {
                            error!("Structured output response missing 'transcription' field");
                            return Some(strip_invisible_chars(content));
                        }
                    }
                    Err(e) => {
                        error!(
                            "Failed to parse structured output JSON: {}. Returning raw content.",
                            e
                        );
                        return Some(strip_invisible_chars(content));
                    }
                }
            }
            Ok(None) => {
                error!("LLM API response has no content");
                return None;
            }
            Err(e) => {
                warn!(
                    "Structured output failed for provider '{}': {}. Falling back to legacy mode.",
                    provider.id, e
                );
                // Fall through to legacy mode below
            }
        }
    }

    // Legacy mode: Replace ${output} variable in the prompt with the actual text
    let processed_prompt = prompt.replace("${output}", transcription);
    debug!("Processed prompt length: {} chars", processed_prompt.len());

    match crate::llm_client::send_chat_completion(
        &provider,
        api_key,
        &model,
        processed_prompt,
        disable_reasoning,
    )
    .await
    {
        Ok(Some(content)) => {
            let content = strip_invisible_chars(strip_think_block(&content));
            debug!(
                "LLM post-processing succeeded for provider '{}'. Output length: {} chars",
                provider.id,
                content.len()
            );
            Some(content)
        }
        Ok(None) => {
            error!("LLM API response has no content");
            None
        }
        Err(e) => {
            error!(
                "LLM post-processing failed for provider '{}': {}. Falling back to original transcription.",
                provider.id,
                e
            );
            None
        }
    }
}

pub(crate) struct ProcessedTranscription {
    pub final_text: String,
    pub post_processed_text: Option<String>,
    pub post_process_prompt: Option<String>,
}

#[derive(Clone, serde::Serialize)]
struct RuleRememberedEvent {
    text: String,
    /// `added`, `duplicate` or `full`.
    status: &'static str,
}

/// If the dictation is a spoken "remember ..." command, save it as a rule in
/// My Rules and tell the UI. Returns true when the text was such a command, so
/// the caller skips AI cleanup and pasting.
fn handle_remember_command(app: &AppHandle, transcription: &str) -> bool {
    let mut settings = get_settings(app);
    if !settings.voice_remember_enabled {
        return false;
    }
    let Some(text) = crate::user_rules::extract_remember(transcription) else {
        return false;
    };
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let outcome =
        crate::user_rules::add_rule(&mut settings.user_rules, &text, format!("urule_{millis:x}"));
    let status = match outcome {
        crate::user_rules::RememberOutcome::Added => {
            crate::settings::write_settings(app, settings);
            let _ = app.emit(
                "settings-changed",
                serde_json::json!({ "setting": "user_rules" }),
            );
            "added"
        }
        crate::user_rules::RememberOutcome::Duplicate => "duplicate",
        crate::user_rules::RememberOutcome::Full => "full",
    };
    debug!("Voice remember command handled: {status}");
    let _ = app.emit("rule-remembered", RuleRememberedEvent { text, status });
    true
}

pub(crate) async fn process_transcription_output(
    app: &AppHandle,
    transcription: &str,
    post_process: bool,
) -> ProcessedTranscription {
    let settings = get_settings(app);
    let mut final_text = transcription.to_string();
    let mut post_processed_text: Option<String> = None;
    let mut post_process_prompt: Option<String> = None;

    if post_process {
        let local_ready = crate::local_llm::prepare(app, &settings).await;
        if let Err(e) = &local_ready {
            warn!("Local model unavailable, keeping raw text: {}", e);
        }
        let processed = if local_ready.is_ok() {
            post_process_transcription(&settings, &final_text).await
        } else {
            None
        };
        if let Some(processed_text) = processed {
            post_processed_text = Some(processed_text.clone());
            final_text = processed_text;

            if let Some(prompt_id) = &settings.post_process_selected_prompt_id {
                if let Some(prompt) = settings
                    .post_process_prompts
                    .iter()
                    .find(|prompt| &prompt.id == prompt_id)
                {
                    post_process_prompt = Some(prompt.prompt.clone());
                }
            }
        }
    }

    ProcessedTranscription {
        final_text,
        post_processed_text,
        post_process_prompt,
    }
}

impl ShortcutAction for TranscribeAction {
    fn start(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        let start_time = Instant::now();
        debug!("TranscribeAction::start called for binding: {}", binding_id);

        // Load model in the background
        let tm = app.state::<Arc<TranscriptionManager>>();
        let rm = app.state::<Arc<AudioRecordingManager>>();

        // Load ASR model and VAD model in parallel
        let kickoff_started = Instant::now();
        tm.initiate_model_load();
        let rm_clone = Arc::clone(&rm);
        std::thread::spawn(move || {
            if let Err(e) = rm_clone.preload_vad() {
                debug!("VAD pre-load failed: {}", e);
            }
        });
        let kickoff_elapsed = kickoff_started.elapsed();

        // Don't open the mic if nothing can transcribe the recording; the load
        // kicked off above fails and reports why.
        if !tm.is_model_loaded() {
            let selected_model = get_settings(app).selected_model;
            if let Err(e) = app
                .state::<Arc<ModelManager>>()
                .get_model_path(&selected_model)
            {
                warn!("Not starting recording: no model can transcribe it ({})", e);
                return;
            }
        }

        let binding_id = binding_id.to_string();
        let tray_started = Instant::now();
        set_tray_state(app, TrayIconState::Recording);
        let tray_elapsed = tray_started.elapsed();

        // Get the microphone mode to determine audio feedback timing
        let plan_started = Instant::now();
        let settings = get_settings(app);
        let is_always_on = settings.always_on_microphone;

        let selected_model_info = app
            .state::<Arc<ModelManager>>()
            .get_model_info(&settings.selected_model);

        // Use the app-facing model capability as the single pre-recording source
        // for live streaming decisions. Unknown support is represented as false
        // until the model registry is updated by discovery or runtime load.
        let model_supports_streaming = selected_model_info
            .as_ref()
            .map(|m| m.supports_streaming)
            .unwrap_or(false);
        let vad_policy = if !settings.vad_enabled {
            VadPolicy::Disabled
        } else if model_supports_streaming {
            VadPolicy::Streaming
        } else {
            VadPolicy::Offline
        };
        if model_supports_streaming {
            tm.start_stream();
        }
        let plan_elapsed = plan_started.elapsed();

        // Sizing the overlay follows the same advertised capability. A model that
        // doesn't stream (or whose capability is not known yet) gets the compact
        // pill instead of an oversized transparent live window.
        let overlay_started = Instant::now();
        match settings.overlay_style {
            OverlayStyle::Live if model_supports_streaming => utils::show_streaming_overlay(app),
            OverlayStyle::Live | OverlayStyle::Minimal => show_recording_overlay(app),
            OverlayStyle::None => {} // show_overlay_state no-ops on None anyway
        }
        // Everything above runs before capture can begin, so each span here is
        // added keypress->capture latency.
        debug!(
            "start-path pre-recording steps: model_kickoff={:?} tray={:?} settings+stream_plan={:?} overlay={:?}",
            kickoff_elapsed,
            tray_elapsed,
            plan_elapsed,
            overlay_started.elapsed()
        );
        debug!("Microphone mode - always_on: {}", is_always_on);

        let mut recording_error: Option<anyhow::Error> = None;
        let recording_start_time = Instant::now();
        match rm.try_start_recording(&binding_id, vad_policy) {
            Ok(readiness) => {
                debug!(
                    "Recording request accepted in {:?}; waiting for first microphone samples",
                    recording_start_time.elapsed()
                );
                let generation = readiness.generation();
                let app_clone = app.clone();
                let rm_clone = Arc::clone(&rm);
                std::thread::spawn(move || {
                    if !readiness.wait() {
                        debug!("Microphone readiness wait ended without receiving samples");
                        return;
                    }

                    // Development-only preview hook for evaluating the brief
                    // arming animation on hardware that normally starts too fast
                    // to make it visible.
                    #[cfg(debug_assertions)]
                    if let Ok(delay_ms) = std::env::var("HANDY_DEBUG_MIC_READY_DELAY_MS")
                        .unwrap_or_default()
                        .parse::<u64>()
                    {
                        let delay_ms = delay_ms.min(10_000);
                        if delay_ms > 0 {
                            debug!("Delaying microphone-ready cue by {delay_ms}ms for UI preview");
                            std::thread::sleep(Duration::from_millis(delay_ms));
                        }
                    }

                    if !rm_clone.is_recording_readiness_current(generation) {
                        debug!("Microphone became ready for an inactive recording");
                        return;
                    }

                    debug!("Microphone is receiving samples; recording is ready");
                    utils::emit_recording_ready(&app_clone);

                    // The start chime is a readiness cue, so it must follow the
                    // first real input callback rather than Stream::play() or a
                    // fixed delay. The helper returns immediately when feedback
                    // is disabled; mute still follows the same readiness point.
                    if rm_clone.is_recording_readiness_current(generation) {
                        play_feedback_sound_blocking(&app_clone, SoundType::Start);
                    }
                    if rm_clone.is_recording_readiness_current(generation) {
                        rm_clone.apply_mute();
                    }
                });
            }
            Err(e) => {
                debug!("Failed to start recording: {}", e);
                recording_error = Some(e);
            }
        }

        if recording_error.is_none() {
            // Dynamically register the cancel shortcut in a separate task to avoid deadlock
            shortcut::register_cancel_shortcut(app);
        } else {
            // Starting failed (for example due to blocked microphone permissions).
            // Revert UI state so we don't stay stuck in the recording overlay.
            tm.cancel_stream();
            utils::hide_recording_overlay(app);
            set_tray_state(app, TrayIconState::Idle);
            if let Some(err) = recording_error {
                let _ = app.emit(
                    "recording-error",
                    RecordingErrorEvent {
                        error_type: recording_error_type(&err).to_string(),
                        detail: Some(format!("{err:#}")),
                    },
                );
            }
        }

        debug!(
            "TranscribeAction::start completed in {:?}",
            start_time.elapsed()
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, _shortcut_str: &str) {
        // Prevent a slow microphone from emitting a ready event or start chime
        // after the user has already requested stop.
        app.state::<Arc<AudioRecordingManager>>()
            .invalidate_recording_readiness();

        // Unregister the cancel shortcut when transcription stops
        shortcut::unregister_cancel_shortcut(app);

        let stop_time = Instant::now();
        debug!("TranscribeAction::stop called for binding: {}", binding_id);

        let ah = app.clone();
        let rm = Arc::clone(&app.state::<Arc<AudioRecordingManager>>());
        let tm = Arc::clone(&app.state::<Arc<TranscriptionManager>>());
        let hm = Arc::clone(&app.state::<Arc<HistoryManager>>());

        set_tray_state(app, TrayIconState::Transcribing);
        // Stop should give immediate visual feedback. Live streaming can keep
        // the larger panel, but it still switches from listening to a working
        // spinner while the stream finalizes. Non-streaming paths use the
        // compact transcribing pill (None no-ops in show_*).
        let style = get_settings(app).overlay_style;
        // Capture this before finalizing the stream so every later working state
        // targets the same overlay that was shown for this transcription.
        let use_streaming_overlay = should_use_streaming_overlay(style, tm.is_streaming());
        if use_streaming_overlay {
            tm.emit_stream_working(StreamWorkKind::Transcribing);
        } else {
            show_transcribing_overlay(app);
        }

        // Unmute before playing audio feedback so the stop sound is audible
        rm.remove_mute();

        // Play audio feedback for recording stop
        play_feedback_sound(app, SoundType::Stop);

        let binding_id = binding_id.to_string(); // Clone binding_id for the async task
        let post_process =
            self.post_process || crate::settings::get_settings(app).always_cleanup_enabled;
        let cancel_generation = rm.cancel_generation();

        tauri::async_runtime::spawn(async move {
            let _guard = FinishGuard(ah.clone(), Arc::clone(&tm));
            debug!(
                "Starting async transcription task for binding: {}",
                binding_id
            );

            let stop_recording_time = Instant::now();
            if let Some(samples) = rm.stop_recording(&binding_id, cancel_generation) {
                debug!(
                    "Recording stopped and samples retrieved in {:?}, sample count: {}",
                    stop_recording_time.elapsed(),
                    samples.len()
                );

                if rm.was_cancelled_since(cancel_generation) {
                    debug!("Transcription operation cancelled after recording stop");
                    tm.cancel_stream();
                    utils::hide_recording_overlay(&ah);
                    set_tray_state(&ah, TrayIconState::Idle);
                    return;
                }

                if samples.is_empty() {
                    debug!("Recording produced no audio samples; skipping persistence");
                    // Tear down any streaming worker so its channel doesn't leak
                    // and block the next start_stream.
                    tm.cancel_stream();
                    utils::hide_recording_overlay(&ah);
                    set_tray_state(&ah, TrayIconState::Idle);
                } else {
                    // Save WAV concurrently with transcription
                    let sample_count = samples.len();
                    let file_name = format!("handy-{}.wav", chrono::Utc::now().timestamp());
                    let wav_path = hm.recordings_dir().join(&file_name);
                    let wav_path_for_verify = wav_path.clone();
                    let samples_for_wav = samples.clone();
                    let wav_handle = tauri::async_runtime::spawn_blocking(move || {
                        crate::audio_toolkit::save_wav_file(&wav_path, &samples_for_wav)
                    });

                    // Transcribe concurrently with WAV save. If a live stream was
                    // running, finalize it and use its text (all audio was already
                    // fed to the stream); otherwise batch-transcribe the samples.
                    //
                    // The actual engine call is synchronous/CPU-bound (native
                    // Whisper/ONNX inference), so it runs on a blocking-pool
                    // thread rather than inline here: inline, it would occupy
                    // this task's async worker thread for the whole run,
                    // starving other work (cancellation checks, overlay
                    // updates) on a busy or emulated (Rosetta) CPU. The wait
                    // is bounded by TRANSCRIPTION_TIMEOUT and responsive to
                    // cancellation, so a wedged engine call surfaces an error
                    // and releases the overlay instead of leaving it stuck on
                    // "Processing" forever; the orphaned blocking thread is
                    // simply left to finish and its result discarded.
                    let transcription_time = Instant::now();
                    let transcription_result = match tm.finalize_stream() {
                        // A finalized stream with usable text wins. An empty result
                        // (no active stream, produced nothing, or the stream failed
                        // or its worker crashed) falls back to a full batch
                        // transcription of the same audio. A cancelled finalize is
                        // surfaced instead, so a cancel never starts a batch run.
                        Ok(Some(text)) if !text.trim().is_empty() => Ok(text),
                        Ok(_) => {
                            let tm_for_blocking = Arc::clone(&tm);
                            let handle = tauri::async_runtime::spawn_blocking(move || {
                                tm_for_blocking.transcribe(samples)
                            });
                            let rm_for_wait = Arc::clone(&rm);
                            match complete_unless_cancelled(
                                tokio::time::timeout(TRANSCRIPTION_TIMEOUT, handle),
                                || rm_for_wait.was_cancelled_since(cancel_generation),
                            )
                            .await
                            {
                                None => {
                                    debug!(
                                        "Transcription operation cancelled while awaiting the transcribe worker"
                                    );
                                    tm.cancel_stream();
                                    utils::hide_recording_overlay(&ah);
                                    set_tray_state(&ah, TrayIconState::Idle);
                                    return;
                                }
                                Some(Ok(join_result)) => join_result.unwrap_or_else(|join_err| {
                                    Err(anyhow::anyhow!(
                                        "Transcription worker panicked: {}",
                                        join_err
                                    ))
                                }),
                                Some(Err(_elapsed)) => {
                                    warn!(
                                        "Transcription timed out after {:?} without returning",
                                        TRANSCRIPTION_TIMEOUT
                                    );
                                    Err(anyhow::anyhow!(
                                        "Transcription timed out. Try a shorter recording or a faster model."
                                    ))
                                }
                            }
                        }
                        Err(err) => Err(err),
                    };

                    // Await WAV save and verify
                    let wav_saved = match wav_handle.await {
                        Ok(Ok(())) => {
                            match crate::audio_toolkit::verify_wav_file(
                                &wav_path_for_verify,
                                sample_count,
                            ) {
                                Ok(()) => true,
                                Err(e) => {
                                    error!("WAV verification failed: {}", e);
                                    false
                                }
                            }
                        }
                        Ok(Err(e)) => {
                            error!("Failed to save WAV file: {}", e);
                            false
                        }
                        Err(e) => {
                            error!("WAV save task panicked: {}", e);
                            false
                        }
                    };

                    if rm.was_cancelled_since(cancel_generation) {
                        debug!("Transcription operation cancelled before output handling");
                        utils::hide_recording_overlay(&ah);
                        set_tray_state(&ah, TrayIconState::Idle);
                        return;
                    }

                    match transcription_result {
                        Ok(transcription) => {
                            debug!(
                                "Transcription completed in {:?}: '{}'",
                                transcription_time.elapsed(),
                                utils::redact_text(&transcription)
                            );

                            let transcription = match truncate_script_drift(&transcription) {
                                Some(truncated) => {
                                    warn!(
                                            "Transcription drifted into an unexpected script partway through, truncating to the clean prefix: {}",
                                            utils::redact_text(&transcription)
                                        );
                                    truncated
                                }
                                None => transcription,
                            };

                            if is_degenerate_repetition(&transcription) {
                                warn!(
                                    "Transcription looked like a repeating loop, discarding: {}",
                                    utils::redact_text(&transcription)
                                );
                                let _ = ah.emit(
                                    "transcription-error",
                                    "The transcription repeated itself in a loop and was discarded. Try again.".to_string(),
                                );
                                if wav_saved {
                                    if let Err(save_err) = hm.save_entry(
                                        file_name,
                                        String::new(),
                                        post_process,
                                        None,
                                        None,
                                    ) {
                                        error!("Failed to save failed history entry: {}", save_err);
                                    }
                                }
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            if handle_remember_command(&ah, &transcription) {
                                // A voice command, not text to paste. The raw
                                // words are still kept in history.
                                if wav_saved {
                                    if let Err(err) =
                                        hm.save_entry(file_name, transcription, false, None, None)
                                    {
                                        error!("Failed to save history entry: {}", err);
                                    }
                                }
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            if post_process {
                                if use_streaming_overlay {
                                    tm.emit_stream_working(StreamWorkKind::Polishing);
                                } else {
                                    show_processing_overlay(&ah);
                                }
                            }
                            let Some(processed) = complete_unless_cancelled(
                                process_transcription_output(&ah, &transcription, post_process),
                                || rm.was_cancelled_since(cancel_generation),
                            )
                            .await
                            else {
                                debug!("Transcription operation cancelled during output handling");
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            };

                            if rm.was_cancelled_since(cancel_generation) {
                                debug!("Transcription operation cancelled before paste");
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            // Save to history if WAV was saved
                            if wav_saved {
                                if let Err(err) = hm.save_entry(
                                    file_name,
                                    transcription,
                                    post_process,
                                    processed.post_processed_text.clone(),
                                    processed.post_process_prompt.clone(),
                                ) {
                                    error!("Failed to save history entry: {}", err);
                                }
                            }

                            if processed.final_text.is_empty() {
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                            } else {
                                let ah_clone = ah.clone();
                                let paste_time = Instant::now();
                                let final_text = processed.final_text;
                                let rm_for_paste = Arc::clone(&rm);
                                ah.run_on_main_thread(move || {
                                    if rm_for_paste.was_cancelled_since(cancel_generation) {
                                        debug!("Transcription operation cancelled before paste");
                                        utils::hide_recording_overlay(&ah_clone);
                                        set_tray_state(&ah_clone, TrayIconState::Idle);
                                        return;
                                    }

                                    match utils::paste(final_text, ah_clone.clone()) {
                                        Ok(()) => debug!(
                                            "Text pasted successfully in {:?}",
                                            paste_time.elapsed()
                                        ),
                                        Err(e) => {
                                            error!("Failed to paste transcription: {}", e);
                                            let _ = ah_clone.emit("paste-error", ());
                                        }
                                    }
                                    utils::hide_recording_overlay(&ah_clone);
                                    set_tray_state(&ah_clone, TrayIconState::Idle);
                                })
                                .unwrap_or_else(|e| {
                                    error!("Failed to run paste on main thread: {:?}", e);
                                    utils::hide_recording_overlay(&ah);
                                    set_tray_state(&ah, TrayIconState::Idle);
                                });
                            }
                        }
                        Err(err) => {
                            if rm.was_cancelled_since(cancel_generation) {
                                debug!(
                                    "Transcription operation cancelled after transcription error"
                                );
                                utils::hide_recording_overlay(&ah);
                                set_tray_state(&ah, TrayIconState::Idle);
                                return;
                            }

                            error!("Transcription failed: {}", err);
                            // Surface the failure to the UI (toast). The full
                            // message is also in handy.log via the line above.
                            let _ = ah.emit("transcription-error", err.to_string());
                            // Save entry with empty text so user can retry
                            if wav_saved {
                                if let Err(save_err) = hm.save_entry(
                                    file_name,
                                    String::new(),
                                    post_process,
                                    None,
                                    None,
                                ) {
                                    error!("Failed to save failed history entry: {}", save_err);
                                }
                            }
                            utils::hide_recording_overlay(&ah);
                            set_tray_state(&ah, TrayIconState::Idle);
                        }
                    }
                }
            } else {
                debug!("No samples retrieved from recording stop");
                // Tear down any streaming worker so its channel doesn't leak.
                tm.cancel_stream();
                utils::hide_recording_overlay(&ah);
                set_tray_state(&ah, TrayIconState::Idle);
            }
        });

        debug!(
            "TranscribeAction::stop completed in {:?}",
            stop_time.elapsed()
        );
    }
}

// Cancel Action
struct CancelAction;

impl ShortcutAction for CancelAction {
    fn start(&self, app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        utils::cancel_current_operation(app);
    }

    fn stop(&self, _app: &AppHandle, _binding_id: &str, _shortcut_str: &str) {
        // Nothing to do on stop for cancel
    }
}

// Test Action
struct TestAction;

impl ShortcutAction for TestAction {
    fn start(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Started - {} (App: {})", // Changed "Pressed" to "Started" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }

    fn stop(&self, app: &AppHandle, binding_id: &str, shortcut_str: &str) {
        log::info!(
            "Shortcut ID '{}': Stopped - {} (App: {})", // Changed "Released" to "Stopped" for consistency
            binding_id,
            shortcut_str,
            app.package_info().name
        );
    }
}

// Static Action Map
pub static ACTION_MAP: Lazy<HashMap<String, Arc<dyn ShortcutAction>>> = Lazy::new(|| {
    let mut map = HashMap::new();
    map.insert(
        "transcribe".to_string(),
        Arc::new(TranscribeAction {
            post_process: false,
        }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "transcribe_with_post_process".to_string(),
        Arc::new(TranscribeAction { post_process: true }) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "cancel".to_string(),
        Arc::new(CancelAction) as Arc<dyn ShortcutAction>,
    );
    map.insert(
        "test".to_string(),
        Arc::new(TestAction) as Arc<dyn ShortcutAction>,
    );
    map
});

#[cfg(test)]
mod tests {
    use super::{
        complete_unless_cancelled, is_blank_transcription, is_degenerate_repetition,
        should_use_streaming_overlay, strip_think_block, truncate_script_drift,
    };
    use crate::settings::OverlayStyle;
    use std::future;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn blank_transcription_is_detected() {
        assert!(is_blank_transcription(""));
        assert!(is_blank_transcription("   "));
        assert!(is_blank_transcription("\t\n  \r\n"));
    }

    #[test]
    fn non_blank_transcription_is_kept() {
        assert!(!is_blank_transcription("hello"));
        assert!(!is_blank_transcription("  hello  "));
    }

    #[test]
    fn real_sentences_are_not_flagged_as_repetition() {
        assert!(!is_degenerate_repetition(
            "we should ship the update on friday morning"
        ));
        assert!(!is_degenerate_repetition("hello world"));
        assert!(!is_degenerate_repetition(""));
    }

    #[test]
    fn naturally_repeated_words_spread_through_a_sentence_are_not_flagged() {
        // "and" repeats, but not back-to-back, so this is real prose, not a loop.
        assert!(!is_degenerate_repetition(
            "the cat and the dog and the bird and the fish"
        ));
    }

    #[test]
    fn single_word_prompt_echo_loop_is_flagged() {
        assert!(is_degenerate_repetition("ravi ravi ravi ravi ravi ravi"));
    }

    #[test]
    fn multi_word_dictionary_entry_looping_is_flagged() {
        assert!(is_degenerate_repetition(
            "ravi sharma ravi sharma ravi sharma"
        ));
        assert!(is_degenerate_repetition(
            "acme corp acme corp acme corp acme corp acme corp"
        ));
    }

    #[test]
    fn a_dictionary_entry_pasted_exactly_twice_is_flagged() {
        // The reported real-world symptom: the whole output is just the
        // custom-word entry duplicated once, not a long loop.
        assert!(is_degenerate_repetition("ravi sharma ravi sharma"));
        assert!(is_degenerate_repetition("acme corp acme corp"));
    }

    #[test]
    fn a_short_partial_repeat_at_the_end_is_not_enough_to_flag() {
        // Only two repeats and doesn't cover most of the transcript.
        assert!(!is_degenerate_repetition(
            "let's meet tomorrow at noon ravi sharma ravi sharma to discuss the budget plan"
        ));
    }

    #[test]
    fn clean_transcription_is_unaffected_by_script_drift_check() {
        assert_eq!(
            truncate_script_drift("we should ship the update on friday morning"),
            None
        );
        assert_eq!(truncate_script_drift(""), None);
    }

    #[test]
    fn reported_hallucination_is_truncated_to_its_clean_prefix() {
        // The exact corrupted output from the bug report: clean English, then
        // an abrupt, sustained switch into Greek/Cyrillic/other scripts.
        let transcription = "Hi this is a test message Και ψ дав Ohhh jhaals kenj Western jhaals ka atenção aur shvaad ktk sveteek svediyug aur teonh gaup tek territory yau ite ho emp jahaan parne pa当ra ach condemn hain";
        assert_eq!(
            truncate_script_drift(transcription),
            Some("Hi this is a test message".to_string())
        );
    }

    #[test]
    fn a_single_foreign_loanword_does_not_trigger_truncation() {
        // One stray non-Latin word is not a sustained drift.
        assert_eq!(
            truncate_script_drift("let's grab a café Σ together tomorrow"),
            None
        );
    }

    #[test]
    fn a_transcription_entirely_in_one_non_latin_script_is_unaffected() {
        // Devanagari dictation: the primary script is Devanagari throughout,
        // so nothing "drifts" relative to it.
        assert_eq!(truncate_script_drift("नमस्ते आप कैसे हैं आज मौसम अच्छा है"), None);
    }

    #[test]
    fn digits_and_punctuation_do_not_reset_or_count_toward_drift() {
        assert_eq!(
            truncate_script_drift("meet at 5 pm, see you там тогда"),
            Some("meet at 5 pm, see you".to_string())
        );
    }

    #[test]
    fn completed_operation_returns_its_output() {
        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::ready("done"),
            || false,
        ));

        assert_eq!(result, Some("done"));
    }

    #[test]
    fn pending_operation_stops_after_cancellation() {
        let cancelled = Arc::new(AtomicBool::new(false));
        let cancelled_for_thread = Arc::clone(&cancelled);
        let cancel_thread = thread::spawn(move || {
            thread::sleep(Duration::from_millis(10));
            cancelled_for_thread.store(true, Ordering::Release);
        });

        let result = tauri::async_runtime::block_on(complete_unless_cancelled(
            future::pending::<()>(),
            || cancelled.load(Ordering::Acquire),
        ));

        cancel_thread.join().unwrap();
        assert_eq!(result, None);
    }

    #[test]
    fn leading_think_block_is_stripped() {
        assert_eq!(
            strip_think_block("<think>pondering...</think>Cleaned text."),
            "Cleaned text."
        );
        assert_eq!(
            strip_think_block("  \n<think>multi\nline</think>\n  Cleaned text."),
            "Cleaned text."
        );
    }

    #[test]
    fn content_without_think_block_is_unchanged() {
        assert_eq!(strip_think_block("Cleaned text."), "Cleaned text.");
        assert_eq!(
            strip_think_block("Mentions <think> mid-sentence."),
            "Mentions <think> mid-sentence."
        );
        // Unclosed block: leave untouched rather than guess
        assert_eq!(
            strip_think_block("<think>never closed"),
            "<think>never closed"
        );
    }

    #[test]
    fn live_overlay_uses_streaming_states_only_for_streaming_models() {
        assert!(should_use_streaming_overlay(OverlayStyle::Live, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::Live, false));
        assert!(!should_use_streaming_overlay(OverlayStyle::Minimal, true));
        assert!(!should_use_streaming_overlay(OverlayStyle::None, true));
    }
}
