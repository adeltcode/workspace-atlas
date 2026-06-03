mod docker;
mod shell;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shell::ShellState(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .invoke_handler(tauri::generate_handler![
            docker::docker_check,
            docker::docker_system_df,
            docker::docker_images,
            docker::docker_prune_preview,
            docker::docker_prune_run,
            docker::docker_containers,
            docker::docker_volumes,
            docker::docker_container_action,
            docker::docker_volume_remove,
            docker::docker_volumes_prune,
            docker::docker_container_logs,
            docker::docker_networks,
            docker::docker_network_remove,
            docker::docker_compose_ls,
            docker::read_file_content,
            docker::get_default_backup_dir,
            docker::docker_list_backups,
            docker::docker_volume_backup,
            docker::docker_volume_restore,
            docker::docker_backup_compose,
            docker::docker_list_all_compose_backups,
            docker::docker_list_compose_backups,
            docker::docker_delete_compose_backup,
            docker::docker_delete_backup,
            docker::transfer_backups,
            docker::pick_backup_folder,
            shell::shell_run,
            shell::shell_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
