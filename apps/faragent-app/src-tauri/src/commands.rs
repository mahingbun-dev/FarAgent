//! The Tauri command surface: thin, blocking-safe wrappers over the same
//! service crates the TUI drives. Every remote-touching call runs on the
//! blocking pool; the UI thread never waits on ssh.

use crate::dto::{
    host_dto, shape_error, shape_start_error, CommandError, DirListingDto, GitHubSyncDto, HostDto,
    PlanDto, PreflightDto, ProbeDto, StartError,
};
use faragent_core::agents::AgentKind;
use faragent_core::vocab::{AuthMode, HostOs};
use faragent_install::{self as install, Action};
use faragent_service::{probe, sessions};
use faragent_transport::{self as transport};
use tauri::async_runtime::spawn_blocking;

/// Run a blocking closure off the UI thread. A panic in the closure becomes
/// a plain error instead of taking the app down.
async fn blocking<T, F>(f: F) -> Result<T, CommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, CommandError> + Send + 'static,
{
    match spawn_blocking(f).await {
        Ok(result) => result,
        Err(e) => Err(CommandError::Plain {
            message: format!("internal task failed: {e}"),
        }),
    }
}

// ---------------------------------------------------------------- hosts

#[tauri::command]
pub async fn list_hosts() -> Result<Vec<HostDto>, CommandError> {
    blocking(|| {
        let hosts = transport::ssh::list_hosts().map_err(|e| CommandError::Plain {
            message: format!("{e:#}"),
        })?;
        Ok(hosts
            .iter()
            .map(|h| host_dto(h, faragent_core::config::auth_for(&h.alias)))
            .collect())
    })
    .await
}

#[tauri::command]
pub async fn host_auth(host: String) -> AuthMode {
    faragent_core::config::auth_for(&host)
}

#[tauri::command]
pub async fn set_host_auth(host: String, mode: AuthMode) -> Result<(), CommandError> {
    faragent_core::config::set_auth(&host, mode).map_err(|e| CommandError::Plain {
        message: format!("{e:#}"),
    })
}

/// Does this machine's ssh multiplex (ControlMaster)? Gates the in-app
/// password prompt exactly like the TUI.
#[tauri::command]
pub async fn mux_capable() -> bool {
    blocking(|| Ok(transport::ssh::mux_capable()))
        .await
        .unwrap_or(true)
}

// ---------------------------------------------------------------- probe

#[tauri::command]
pub async fn host_os(host: String) -> Result<HostOs, CommandError> {
    blocking(move || transport::host_os(&host).map_err(|e| shape_error(&e, &host))).await
}

#[tauri::command]
pub async fn probe_host(host: String) -> Result<ProbeDto, CommandError> {
    blocking(move || {
        probe::probe_host(&host)
            .map(|p| ProbeDto::from(&p))
            .map_err(|e| shape_error(&e, &host))
    })
    .await
}

// -------------------------------------------------------------- sessions

#[tauri::command]
pub async fn list_sessions(
    host: String,
    agent: AgentKind,
    os: HostOs,
) -> Result<Vec<sessions::SessionSummary>, CommandError> {
    blocking(move || sessions::list_sessions(&host, agent, os).map_err(|e| shape_error(&e, &host)))
        .await
}

/// Start (or resume) a session. `createCwd = true` may create the working
/// directory on the remote; with `false` a missing directory comes back as
/// `cwd_missing` — a question for the user, not an error.
///
/// Returns the tmux/display name *and* the session id the remote CLI was
/// pinned to (`null` when it was not — a fresh Codex/Grok/Pi session, or any
/// fresh Windows one). The app needs the id to compute the transcript path.
#[tauri::command]
pub async fn ensure_session(
    host: String,
    agent: AgentKind,
    cwd: String,
    session_id: Option<String>,
    create_cwd: bool,
) -> Result<sessions::StartedSession, StartError> {
    let host_for_task = host.clone();
    match spawn_blocking(move || {
        let os = transport::host_os(&host_for_task).unwrap_or_default();
        let path = std::path::PathBuf::from(&cwd);
        let result = match os {
            HostOs::Posix => sessions::ensure_tmux_session(
                &host_for_task,
                agent,
                &path,
                session_id.as_deref(),
                create_cwd,
            ),
            HostOs::Windows => sessions::ensure_win_session(
                &host_for_task,
                agent,
                &path,
                session_id.as_deref(),
                create_cwd,
            ),
        };
        result.map_err(|e| shape_start_error(&e, &host_for_task))
    })
    .await
    {
        Ok(res) => res,
        Err(e) => Err(StartError::Plain {
            message: format!("internal task failed: {e}"),
        }),
    }
}

// ------------------------------------------------------- app-level state

/// The UI language lives in the same `~/.faragent/config.json` the TUI uses.
#[tauri::command]
pub async fn get_language() -> String {
    faragent_core::config::language_or_default()
        .code()
        .to_string()
}

#[tauri::command]
pub async fn set_language(lang: String) -> Result<(), CommandError> {
    let parsed = faragent_core::text::Lang::parse(&lang).ok_or_else(|| CommandError::Plain {
        message: format!("unknown language '{lang}': use zh | en"),
    })?;
    faragent_core::config::set_language(parsed).map_err(|e| CommandError::Plain {
        message: format!("{e:#}"),
    })
}

// -------------------------------------------------------------- askpass

/// Is a password held for this host (this run only)?
#[tauri::command]
pub async fn askpass_active(host: String) -> bool {
    faragent_transport::askpass::active_for(&host)
}

/// Hold the password in memory for later ssh commands (askpass). The value
/// never leaves the process except to OpenSSH itself.
#[tauri::command]
pub async fn askpass_install(host: String, password: String) -> bool {
    faragent_transport::askpass::install_session(&host, password).is_some()
}

// --------------------------------------------------------------- install

#[tauri::command]
pub async fn install_preflight(
    host: String,
    agent: AgentKind,
) -> Result<PreflightDto, CommandError> {
    blocking(move || {
        install::preflight_host(&host, agent)
            .map(PreflightDto::from)
            .map_err(|e| shape_error(&e, &host))
    })
    .await
}

/// Preflight + plan in one round trip, mirroring the TUI's confirm screen
/// (upgrade on a missing agent silently becomes an install — follow
/// `plan.action`, not the requested one).
#[tauri::command]
pub async fn install_plan(
    host: String,
    agent: AgentKind,
    action: Action,
) -> Result<PlanDto, CommandError> {
    blocking(move || {
        let pf = install::preflight_host(&host, agent).map_err(|e| shape_error(&e, &host))?;
        let plan = install::plan_for(action, agent, &pf);
        Ok(PlanDto::new(&plan, &host))
    })
    .await
}

// ---------------------------------------------------------------- dirs

/// Expand `~` / `~/x` / `~\x` against a remote home. Prefix only; same rules
/// as the TUI. Pure — no SSH.
#[tauri::command]
pub async fn expand_home(path: String, home: String, os: HostOs) -> String {
    faragent_core::paths::expand_home(&path, &home, os)
}

/// List child directories of `path` on the remote. Never creates directories.
/// The caller expands `~`.
#[tauri::command]
pub async fn list_dirs(host: String, path: String) -> Result<DirListingDto, CommandError> {
    blocking(move || {
        let os = transport::host_os(&host).map_err(|e| shape_error(&e, &host))?;
        faragent_service::dirs::list_dirs(&host, os, &path)
            .map(DirListingDto::from)
            .map_err(|e| shape_error(&e, &host))
    })
    .await
}

// ------------------------------------------------------------- github

/// Copy this machine's `gh` login onto the remote. The token is never returned.
#[tauri::command]
pub async fn github_sync(host: String) -> Result<GitHubSyncDto, CommandError> {
    blocking(move || {
        faragent_service::github::sync_to_host(&host)
            .map(|report| GitHubSyncDto::new(&host, report))
            .map_err(|e| shape_error(&e, &host))
    })
    .await
}

// ------------------------------------------------------- permissions

#[tauri::command]
pub async fn get_full_permissions() -> bool {
    faragent_core::config::full_permissions()
}

#[tauri::command]
pub async fn set_full_permissions(on: bool) -> Result<(), CommandError> {
    faragent_core::config::set_full_permissions(on).map_err(|e| CommandError::Plain {
        message: format!("{e:#}"),
    })
}
