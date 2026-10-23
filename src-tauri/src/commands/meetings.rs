//! Tauri commands for meeting notes.

use crate::meetings::store::{MeetingDetail, MeetingRow, MeetingSearchHit};
use crate::meetings::{ActiveMeeting, MeetingManager};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Manager};

fn manager(app: &AppHandle) -> Result<Arc<MeetingManager>, String> {
    app.try_state::<Arc<MeetingManager>>()
        .map(|s| Arc::clone(&s))
        .ok_or_else(|| "Meeting notes are not available".to_string())
}

// Opening audio devices (`MeetingManager::start`) is internally bounded to
// about 10s per track, so 30s leaves margin without masking a real hang.
const MEETING_START_TIMEOUT: Duration = Duration::from_secs(30);
// `MeetingManager::stop` joins the recording worker, which may still be
// transcribing the last segment on a slow/CPU-only path. Generous enough
// that a normal stop never trips it.
const MEETING_STOP_TIMEOUT: Duration = Duration::from_secs(240);

#[tauri::command]
#[specta::specta]
pub async fn meeting_start(app: AppHandle, title: Option<String>) -> Result<ActiveMeeting, String> {
    // Opening audio devices can block for seconds. Never do that on the UI thread.
    let mgr = manager(&app)?;
    let mgr_for_check = Arc::clone(&mgr);
    let handle = tauri::async_runtime::spawn_blocking(move || mgr.start(title));
    match tokio::time::timeout(MEETING_START_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())?,
        Err(_elapsed) => {
            // `mgr.start()` sets the active-meeting state and returns before
            // this await resolves: on a machine where the meeting's own
            // transcription saturates every CPU core, the async runtime can
            // be starved long enough that this future isn't woken for tens
            // of seconds after the blocking call already finished and
            // succeeded. Treat that as success instead of a false failure.
            if let Some(active) = mgr_for_check.active() {
                log::warn!(
                    "meeting_start await exceeded {:?}, but a meeting is active; reporting success",
                    MEETING_START_TIMEOUT
                );
                return Ok(active);
            }
            log::warn!(
                "meeting_start timed out after {:?} without returning",
                MEETING_START_TIMEOUT
            );
            Err("Starting the meeting recording timed out. Try again.".to_string())
        }
    }
}

#[tauri::command]
#[specta::specta]
pub async fn meeting_stop(app: AppHandle) -> Result<i64, String> {
    let mgr = manager(&app)?;
    let mgr_for_stop = Arc::clone(&mgr);
    let handle = tauri::async_runtime::spawn_blocking(move || mgr_for_stop.stop());
    let id = match tokio::time::timeout(MEETING_STOP_TIMEOUT, handle).await {
        Ok(join_result) => join_result.map_err(|e| e.to_string())??,
        Err(_elapsed) => {
            log::warn!(
                "meeting_stop timed out after {:?} without returning",
                MEETING_STOP_TIMEOUT
            );
            return Err("Stopping the meeting recording timed out.".to_string());
        }
    };
    mgr.purge_expired();
    mgr.summarize_in_background(id);
    Ok(id)
}

#[tauri::command]
#[specta::specta]
pub fn meeting_pause(app: AppHandle) -> Result<(), String> {
    manager(&app)?.pause()
}

#[tauri::command]
#[specta::specta]
pub fn meeting_resume(app: AppHandle) -> Result<(), String> {
    manager(&app)?.resume()
}

#[tauri::command]
#[specta::specta]
pub fn meeting_active(app: AppHandle) -> Result<Option<ActiveMeeting>, String> {
    Ok(manager(&app)?.active())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_list(app: AppHandle) -> Result<Vec<MeetingRow>, String> {
    manager(&app)?.store().list().map_err(|e| e.to_string())
}

/// Search titles, summaries and transcripts of all saved meetings.
#[tauri::command]
#[specta::specta]
pub fn meeting_search(app: AppHandle, query: String) -> Result<Vec<MeetingSearchHit>, String> {
    manager(&app)?
        .store()
        .search(&query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_get(app: AppHandle, id: i64) -> Result<Option<MeetingDetail>, String> {
    manager(&app)?.store().get(id).map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_rename(app: AppHandle, id: i64, title: String) -> Result<(), String> {
    let title = title.trim();
    if title.is_empty() {
        return Err("Title cannot be empty".to_string());
    }
    manager(&app)?
        .store()
        .rename(id, title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
#[specta::specta]
pub fn meeting_delete(app: AppHandle, id: i64) -> Result<(), String> {
    let mgr = manager(&app)?;
    if mgr.active().map(|a| a.id) == Some(id) {
        return Err("Stop the meeting before deleting it".to_string());
    }
    mgr.store().delete(id).map_err(|e| e.to_string())
}

/// Make (or remake) the summary for a finished meeting.
#[tauri::command]
#[specta::specta]
pub fn meeting_summarize(app: AppHandle, id: i64) -> Result<(), String> {
    manager(&app)?.summarize_in_background(id);
    Ok(())
}

/// Make a string safe to use as a file name on every platform.
fn safe_file_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') {
                '-'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    let short: String = trimmed.chars().take(80).collect();
    if short.is_empty() {
        "Meeting".to_string()
    } else {
        short
    }
}

/// Save an exported meeting document (Word or PDF) in
/// `Documents/Oshabe Meetings` and return the file path. Existing files are
/// never overwritten.
#[tauri::command]
#[specta::specta]
pub fn meeting_save_document(
    app: AppHandle,
    title: String,
    date: String,
    extension: String,
    content: Vec<u8>,
) -> Result<String, String> {
    if !matches!(extension.as_str(), "docx" | "pdf") {
        return Err("Unsupported file type".to_string());
    }
    let base = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| e.to_string())?;
    let dir = base.join("Oshabe Meetings");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let stem = format!("{} {}", safe_file_stem(&title), safe_file_stem(&date));
    let mut path = dir.join(format!("{stem}.{extension}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}).{extension}"));
        n += 1;
    }
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[cfg(test)]
mod tests {
    use super::safe_file_stem;

    #[test]
    fn file_names_are_sanitised() {
        assert_eq!(safe_file_stem("Q3 / plan: v2?"), "Q3 - plan- v2-");
        assert_eq!(safe_file_stem("  ..  "), "Meeting");
        assert_eq!(safe_file_stem(&"a".repeat(200)).len(), 80);
    }
}
