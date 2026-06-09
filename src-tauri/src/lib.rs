mod config;
mod docker;
mod shell;
mod system;
mod wsl;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shell::ShellState(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .manage(docker::ComposeLogState(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .manage(system::SysState(std::sync::Mutex::new(sysinfo::System::new())))
        .invoke_handler(tauri::generate_handler![
            docker::docker_check,
            docker::launch_docker_desktop,
            docker::get_disk_stats,
            docker::get_backup_size,
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
            docker::docker_compose_action,
            docker::docker_compose_service_action,
            docker::docker_compose_service_logs,
            docker::open_container_shell,
            docker::write_file_content,
            docker::docker_stats,
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
            docker::metadata_load,
            docker::metadata_save_project,
            docker::detect_compose_project_files,
            docker::detect_editors,
            docker::open_in_editor,
            docker::reveal_path,
            docker::docker_compose_config,
            docker::compose_logs_watch,
            docker::compose_logs_stop,
            shell::shell_run,
            shell::shell_kill,
            system::get_system_metrics,
            config::export_config,
            config::import_config,
            wsl::wsl_check,
            wsl::wsl_list_distros,
            wsl::read_wslconfig,
            wsl::write_wslconfig,
            wsl::wsl_shutdown,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
