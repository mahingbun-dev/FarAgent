mod attach;
mod commands;
mod dto;

/// The app entry point. The askpass short-circuit MUST stay the first thing
/// that happens: when ssh runs the GUI binary as its askpass helper
/// (`FARAGENT_INTERNAL=askpass`), we answer the prompt and exit — before any
/// Tauri/window initialization.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if faragent_transport::askpass::is_child() {
        let args: Vec<String> = std::env::args().skip(1).collect();
        std::process::exit(faragent_transport::askpass::run_child(&args));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(attach::SessionManager::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_hosts,
            commands::host_auth,
            commands::set_host_auth,
            commands::mux_capable,
            commands::host_os,
            commands::probe_host,
            commands::list_sessions,
            commands::ensure_session,
            commands::get_language,
            commands::set_language,
            commands::askpass_active,
            commands::askpass_install,
            commands::install_preflight,
            commands::install_plan,
            commands::list_dirs,
            commands::github_sync,
            commands::get_full_permissions,
            commands::set_full_permissions,
            attach::attach_open,
            attach::attach_write,
            attach::attach_resize,
            attach::attach_close,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
