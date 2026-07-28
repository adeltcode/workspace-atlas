use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Emitter;

// ── Managed state ─────────────────────────────────────────────────────────────

/// Holds the currently running child process so it can be killed from the
/// `shell_kill` command. `None` when no command is running.
pub struct ShellState(pub Arc<Mutex<Option<Child>>>);

// ── Event payloads ────────────────────────────────────────────────────────────

/// One line of a `shell-out` event. Shared by docker.rs / wsl.rs, which emit
/// the real commands they run so the bottom terminal shows them.
#[derive(serde::Serialize, Clone)]
pub(crate) struct ShellOut {
    pub(crate) text:   String,
    pub(crate) stderr: bool,
}

/// Emitted once after all stdout/stderr lines have been flushed, so the
/// frontend can safely append the "exited N" line without ordering races.
#[derive(serde::Serialize, Clone)]
struct ShellDone {
    exit_code: i32,
}

// ── Commands ──────────────────────────────────────────────────────────────────

/// Run an arbitrary shell command via PowerShell, streaming each stdout/stderr
/// line as a `shell-out` event. Emits `shell-done` once all output is flushed
/// and the process has exited. Returns the exit code.
#[tauri::command]
pub async fn shell_run(
    app: tauri::AppHandle,
    state: tauri::State<'_, ShellState>,
    cmd: String,
) -> Result<i32, String> {
    let child_arc = state.0.clone();

    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start shell: {}", e))?;

        // Take pipes before storing child - the stored handle is used only for
        // kill() / try_wait(); taking pipes doesn't affect those.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Store child for kill support
        *child_arc.lock().unwrap() = Some(child);

        // Spawn reader threads - each line is emitted as a shell-out event
        let stdout_app = app.clone();
        let stdout_handle = stdout.map(|out| {
            thread::spawn(move || {
                BufReader::new(out).lines().flatten().for_each(|line| {
                    stdout_app
                        .emit("shell-out", ShellOut { text: line, stderr: false })
                        .ok();
                });
            })
        });

        let stderr_app = app.clone();
        let stderr_handle = stderr.map(|err| {
            thread::spawn(move || {
                BufReader::new(err).lines().flatten().for_each(|line| {
                    if !line.trim().is_empty() {
                        stderr_app
                            .emit("shell-out", ShellOut { text: line, stderr: true })
                            .ok();
                    }
                });
            })
        });

        // Poll with try_wait so shell_kill can acquire the lock between polls
        // without deadlocking on a blocking wait() call.
        let exit_code = loop {
            let result = {
                let mut guard = child_arc.lock().unwrap();
                guard
                    .as_mut()
                    .ok_or_else(|| "process handle lost".to_string())?
                    .try_wait()
                    .map_err(|e| e.to_string())
            }; // lock released here
            match result {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None)         => thread::sleep(Duration::from_millis(50)),
                Err(e)           => return Err(e),
            }
        };

        // Join reader threads so every shell-out event is enqueued before
        // shell-done is enqueued. Tauri's event queue is FIFO per AppHandle,
        // so the frontend will always see all output lines first.
        if let Some(h) = stdout_handle { h.join().ok(); }
        if let Some(h) = stderr_handle { h.join().ok(); }

        // Clear stored child
        *child_arc.lock().unwrap() = None;

        // shell-done is emitted AFTER all shell-out events are flushed
        app.emit("shell-done", ShellDone { exit_code }).ok();

        Ok(exit_code)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Interrupt the currently running shell command.
#[tauri::command]
pub async fn shell_kill(state: tauri::State<'_, ShellState>) -> Result<(), String> {
    let mut guard = state.0.lock().map_err(|_| "state lock poisoned".to_string())?;
    if let Some(ref mut child) = *guard {
        // Ignore errors - process may have already exited between the check and the kill
        child.kill().ok();
    }
    Ok(())
}
