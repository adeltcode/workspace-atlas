mod docker;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            docker::docker_check,
            docker::docker_system_df,
            docker::docker_images,
            docker::docker_prune_preview,
            docker::docker_prune_run,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
