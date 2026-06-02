use std::io::{BufRead, BufReader};
use std::process::{Command, Stdio};
use std::thread;

use tauri::Emitter;

#[derive(serde::Serialize, Clone)]
struct ShellLine {
    text: String,
    stderr: bool,
}

/// Run an arbitrary shell command via PowerShell, streaming each stdout/stderr
/// line as a `shell-out` event. Returns the process exit code.
#[tauri::command]
pub async fn shell_run(app: tauri::AppHandle, cmd: String) -> Result<i32, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut child = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &cmd])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to start shell: {}", e))?;

        let stdout_app = app.clone();
        let stdout_handle = child.stdout.take().map(|out| {
            thread::spawn(move || {
                BufReader::new(out).lines().flatten().for_each(|line| {
                    stdout_app
                        .emit("shell-out", ShellLine { text: line, stderr: false })
                        .ok();
                });
            })
        });

        let stderr_app = app.clone();
        let stderr_handle = child.stderr.take().map(|err| {
            thread::spawn(move || {
                BufReader::new(err).lines().flatten().for_each(|line| {
                    if !line.trim().is_empty() {
                        stderr_app
                            .emit("shell-out", ShellLine { text: line, stderr: true })
                            .ok();
                    }
                });
            })
        });

        let status = child.wait().map_err(|e| e.to_string())?;
        if let Some(h) = stdout_handle { h.join().ok(); }
        if let Some(h) = stderr_handle { h.join().ok(); }

        Ok(status.code().unwrap_or(-1))
    })
    .await
    .map_err(|e| e.to_string())?
}
