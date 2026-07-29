use std::sync::Mutex;

use sysinfo::{Disks, System};
use crate::error::AtlasError;

/// Long-lived `System` so CPU usage is measured as a delta between polls.
/// The first reading after startup reports 0% until a second poll provides a delta.
pub struct SysState(pub Mutex<System>);

#[derive(serde::Serialize, Clone)]
pub struct DiskInfo {
    /// Mount point shown to the user, e.g. "C:\".
    pub mount: String,
    pub total_bytes: u64,
    pub free_bytes: u64,
}

#[derive(serde::Serialize, Clone)]
pub struct SystemMetrics {
    /// Global CPU usage since the previous poll (0–100).
    pub cpu_pct: f32,
    /// Number of logical CPUs.
    pub cpu_count: usize,
    pub mem_used_bytes: u64,
    pub mem_total_bytes: u64,
    pub disks: Vec<DiskInfo>,
}

/// Snapshot live CPU, memory, and per-disk usage for the home dashboard.
/// Polled by the frontend; cheap enough to run on the async runtime directly.
#[tauri::command]
pub async fn get_system_metrics(
    state: tauri::State<'_, SysState>,
) -> Result<SystemMetrics, AtlasError> {
    let (cpu_pct, cpu_count, mem_used_bytes, mem_total_bytes) = {
        let mut sys = state.0.lock().map_err(|_| "system state poisoned".to_string())?;
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        (sys.global_cpu_usage(), sys.cpus().len(), sys.used_memory(), sys.total_memory())
    }; // guard dropped before the disk scan below

    let disks = Disks::new_with_refreshed_list()
        .iter()
        .map(|d| DiskInfo {
            mount: d.mount_point().to_string_lossy().to_string(),
            total_bytes: d.total_space(),
            free_bytes: d.available_space(),
        })
        .collect();

    Ok(SystemMetrics { cpu_pct, cpu_count, mem_used_bytes, mem_total_bytes, disks })
}
