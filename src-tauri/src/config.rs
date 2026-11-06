use std::fs;
use crate::error::AtlasError;
use crate::shell::in_background;

/// Open a save dialog and write `contents` to the chosen file.
/// Returns the saved path, or `None` if the user cancelled.
#[tauri::command]
pub async fn export_config(contents: String) -> Result<Option<String>, AtlasError> {
    in_background(move || {
        let Some(path) = rfd::FileDialog::new()
            .set_file_name("workspace-atlas-config.json")
            .add_filter("JSON", &["json"])
            .save_file()
        else {
            return Ok(None);
        };
        fs::write(&path, contents).map_err(|e| format!("Failed to write config: {}", e))?;
        Ok(Some(path.to_string_lossy().to_string()))
    }).await
}

/// Open a file dialog and return the chosen file's contents.
/// Returns `None` if the user cancelled.
#[tauri::command]
pub async fn import_config() -> Result<Option<String>, AtlasError> {
    in_background(|| {
        let Some(path) = rfd::FileDialog::new()
            .add_filter("JSON", &["json"])
            .pick_file()
        else {
            return Ok(None);
        };
        let contents = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read config: {}", e))?;
        Ok(Some(contents))
    }).await
}
