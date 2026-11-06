use std::io::{BufRead, BufReader, Read};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use tauri::Emitter;
use crate::error::AtlasError;

/// A console program with no window. An installed copy has no console of its own,
/// so without CREATE_NO_WINDOW Windows opens a new window for every command.
pub(crate) fn hidden(program: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut command = Command::new(program);
    command.creation_flags(0x0800_0000);
    command
}

pub(crate) fn powershell(script: &str) -> Command {
    let mut command = hidden("powershell");
    command.args(["-NoProfile", "-NonInteractive", "-Command", script]);
    command
}

/// The lines of a child's output. `BufRead::lines` fails on a line that is not UTF-8, which is
/// normal on a Windows set to another language, and that line would be lost.
pub(crate) fn output_lines(pipe: impl Read) -> impl Iterator<Item = String> {
    BufReader::new(pipe)
        .split(b'\n')
        .map_while(Result::ok)
        .map(|line| String::from_utf8_lossy(&line).trim_end_matches('\r').to_string())
}

/// A line in the terminal panel.
pub(crate) fn emit_line(app: &tauri::AppHandle, text: impl Into<String>, stderr: bool) {
    app.emit("shell-out", ShellOut { text: text.into(), stderr }).ok();
}

/// Show a failure in the terminal panel and pass it on.
pub(crate) fn logged<T, E: std::fmt::Display + Into<AtlasError>>(app: &tauri::AppHandle, result: Result<T, E>) -> Result<T, AtlasError> {
    result.map_err(|e| {
        emit_line(app, format!("  ✗ {}", e), true);
        e.into()
    })
}

pub(crate) async fn in_background<T: Send + 'static>(work: impl FnOnce() -> Result<T, AtlasError> + Send + 'static) -> Result<T, AtlasError> {
    tauri::async_runtime::spawn_blocking(work).await.map_err(|e| e.to_string())?
}

pub(crate) fn now_seconds() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

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
    migration: tauri::State<'_, crate::wsl_migration::MigrationState>,
    app: tauri::AppHandle,
    state: tauri::State<'_, ShellState>,
    cmd: String,
) -> Result<i32, AtlasError> {
    let child_arc = state.0.clone();
    migration.inner().clone().run_operation(move || {
        let mut child = powershell(&cmd)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start shell: {}", e))?;

        // Take pipes before storing child - the stored handle is used only for
        // kill() / try_wait(); taking pipes doesn't affect those.
        let stdout = child.stdout.take();
        let stderr = child.stderr.take();

        // Store child for kill support. A poisoned lock still holds a usable handle,
        // and one panic must not break the terminal for good.
        *child_arc.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);

        // Spawn reader threads - each line is emitted as a shell-out event
        let stdout_app = app.clone();
        let stdout_handle = stdout.map(|out| {
            thread::spawn(move || {
                output_lines(out).for_each(|line| {
                    stdout_app
                        .emit("shell-out", ShellOut { text: line, stderr: false })
                        .ok();
                });
            })
        });

        let stderr_app = app.clone();
        let stderr_handle = stderr.map(|err| {
            thread::spawn(move || {
                output_lines(err).for_each(|line| {
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
                let mut guard = child_arc.lock().unwrap_or_else(|e| e.into_inner());
                guard
                    .as_mut()
                    .ok_or_else(|| "Workspace Atlas lost track of the running command.".to_string())?
                    .try_wait()
                    .map_err(|e| e.to_string())
            }; // lock released here
            match result {
                Ok(Some(status)) => break status.code().unwrap_or(-1),
                Ok(None)         => thread::sleep(Duration::from_millis(50)),
                Err(e)           => return Err(e.into()),
            }
        };

        // Join reader threads so every shell-out event is enqueued before
        // shell-done is enqueued. Tauri's event queue is FIFO per AppHandle,
        // so the frontend will always see all output lines first.
        if let Some(h) = stdout_handle { h.join().ok(); }
        if let Some(h) = stderr_handle { h.join().ok(); }

        // Clear stored child
        *child_arc.lock().unwrap_or_else(|e| e.into_inner()) = None;

        // shell-done is emitted AFTER all shell-out events are flushed
        app.emit("shell-done", ShellDone { exit_code }).ok();

        Ok(exit_code)
    }).await
}

/// Interrupt the currently running shell command.
#[tauri::command]
pub async fn shell_kill(state: tauri::State<'_, ShellState>) -> Result<(), AtlasError> {
    let mut guard = state.0.lock().map_err(|_| "Could not stop the command because of an internal error.".to_string())?;
    if let Some(ref mut child) = *guard {
        // Ignore errors - process may have already exited between the check and the kill
        child.kill().ok();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_line_that_is_not_utf8_is_kept() {
        let lines: Vec<String> = output_lines(&b"first\r\ncaf\xe9\r\n\nlast"[..]).collect();
        assert_eq!(lines, ["first", "caf\u{fffd}", "", "last"]);
    }
}
