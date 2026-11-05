mod config;
mod error;
mod docker;
mod holders;
mod packages;
mod sandbox;
mod shell;
mod system;
mod wsl;
mod wsl_migration;
#[cfg(windows)]
mod wsl_migration_acl;

/// Drop PowerShell 7's module folders from a PSModulePath. Started from
/// PowerShell 7, Atlas inherits them first, and every Windows PowerShell 5.1
/// child then fails to load 7's copy of PowerShellGet.
fn windows_powershell_module_path(path: &str) -> String {
    path.split(';')
        .filter(|dir| {
            let dir = dir.to_ascii_lowercase();
            !dir.contains("\\powershell\\") && !dir.contains("\\microsoft.powershell")
        })
        .collect::<Vec<_>>()
        .join(";")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Before any thread starts, so every child process inherits it.
    if let Ok(path) = std::env::var("PSModulePath") {
        std::env::set_var("PSModulePath", windows_powershell_module_path(&path));
    }
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(shell::ShellState(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .manage(docker::ComposeLogState(std::sync::Arc::new(std::sync::Mutex::new(None))))
        .manage(system::SysState(std::sync::Mutex::new(sysinfo::System::new())))
        .manage(wsl_migration::MigrationState::default())
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
            docker::open_container_shell,
            docker::write_file_content,
            docker::docker_stats,
            docker::read_file_content,
            docker::get_default_backup_dir,
            docker::docker_list_backups,
            docker::docker_volume_backup,
            docker::docker_volume_restore,
            docker::docker_backup_compose,
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
            holders::ports_list,
            holders::locks_find,
            holders::process_close,
            holders::pick_any_file,
            sandbox::sandbox_status,
            sandbox::sandbox_start,
            sandbox::sandbox_stop,
            sandbox::sandbox_open_window,
            sandbox::sandbox_open_file,
            sandbox::sandbox_details,
            sandbox::sandbox_path_kinds,
            shell::shell_run,
            shell::shell_kill,
            system::get_system_metrics,
            config::export_config,
            config::import_config,
            packages::pkg_scan,
            packages::pkg_export_csv,
            packages::pkg_check_updates,
            packages::pkg_upgrade,
            packages::pkg_uninstall_check,
            packages::pkg_uninstall,
            wsl::wsl_check,
            wsl::wsl_list_distros,
            wsl::wsl_running_names,
            wsl::wsl_distro_metrics,
            wsl::wsl_distro_stats,
            wsl::wsl_distro_extras,
            wsl::wsl_open_terminal,
            wsl::wsl_open_distro_folder,
            wsl::wsl_terminate_distro,
            wsl::wsl_restart_distro,
            wsl::wsl_start_distro,
            wsl::wsl_clone_distro,
            wsl::wsl_plan_migration,
            wsl::wsl_suggest_migration_dir,
            wsl::wsl_repair_migration,
            wsl::wsl_migrate_distro,
            wsl::wsl_unregister_distro,
            wsl::wsl_list_services,
            wsl::wsl_service_detail,
            wsl::wsl_service_set,
            wsl::wsl_benchmark_boot,
            wsl::wsl_profile_shell,
            wsl::read_wslconfig,
            wsl::write_wslconfig,
            wsl::wslconfig_backup,
            wsl::wslconfig_list_backups,
            wsl::wslconfig_restore,
            wsl::read_wsl_conf,
            wsl::write_wsl_conf,
            wsl::wsl_conf_backup,
            wsl::wsl_conf_list_backups,
            wsl::wsl_conf_restore,
            wsl::wsl_conf_delete_backup,
            wsl::wsl_shutdown,
            wsl::wsl_optimize_vhd,
            wsl::wsl_export_distro,
            wsl::wsl_import_distro,
            wsl::wsl_install_catalog,
            wsl::wsl_default_install_dir,
            wsl::wsl_install_download,
            wsl::pick_tar_file,
            wsl::pick_directory,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::windows_powershell_module_path;

    #[test]
    fn module_path_keeps_windows_powershell_and_drops_powershell_7() {
        let inherited = [
            r"C:\Users\me\Documents\PowerShell\Modules",
            r"C:\Program Files\PowerShell\Modules",
            r"c:\program files\windowsapps\microsoft.powershell_7.6.9.0_x64__8wekyb3d8bbwe\Modules",
            r"C:\Program Files\PowerShell\7\Modules",
            r"C:\Users\me\Documents\WindowsPowerShell\Modules",
            r"C:\Program Files\WindowsPowerShell\Modules",
            r"C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules",
            r"C:\Program Files\Intel\Wired Networking\",
        ]
        .join(";");
        assert_eq!(
            windows_powershell_module_path(&inherited),
            [
                r"C:\Users\me\Documents\WindowsPowerShell\Modules",
                r"C:\Program Files\WindowsPowerShell\Modules",
                r"C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules",
                r"C:\Program Files\Intel\Wired Networking\",
            ]
            .join(";")
        );
        let clean = r"C:\Program Files\WindowsPowerShell\Modules;C:\WINDOWS\system32\WindowsPowerShell\v1.0\Modules";
        assert_eq!(windows_powershell_module_path(clean), clean);
    }
}
