use std::fs;
use crate::error::AtlasError;

/// Open a save dialog and write `contents` to the chosen file.
/// Returns the saved path, or `None` if the user cancelled.
#[tauri::command]
pub async fn export_config(contents: String) -> Result<Option<String>, AtlasError> {
    tauri::async_runtime::spawn_blocking(move || -> Result<Option<String>, AtlasError> {
        let Some(path) = rfd::FileDialog::new()
            .set_file_name("workspace-atlas-config.json")
            .add_filter("JSON", &["json"])
            .save_file()
        else {
            return Ok(None);
        };
        fs::write(&path, contents).map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(Some(path.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Open a file dialog and return the chosen file's contents.
/// Returns `None` if the user cancelled.
#[tauri::command]
pub async fn import_config() -> Result<Option<String>, AtlasError> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Option<String>, AtlasError> {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        Ok(Some(contents))
    })
    .await
    .map_err(|e| e.to_string())?
}
