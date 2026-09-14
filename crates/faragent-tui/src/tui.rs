use crate::chrome::Chrome;
use crate::pty;
use anyhow::Result;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use faragent_core::agents::AgentKind;
use faragent_core::config;
use faragent_core::paths::expand_home;
use faragent_core::text::Lang;
use faragent_core::vocab::HostOs;
use faragent_install::{self as install, Plan};
use faragent_remote::dirs::{join_dir, DirListing};
use faragent_service::diagnose::{self, Diagnosis};
use faragent_service::dirs as dirsvc;
use faragent_service::github;
use faragent_service::probe::{self, Probe};
use faragent_service::sessions::{self as runtime, SessionSummary};
use faragent_transport::{self as ssh, askpass, AuthMode, SshHost};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, List, ListItem, ListState, Paragraph, Wrap};
use ratatui::{DefaultTerminal, Frame};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

#[derive(Debug, Clone)]
enum Screen {
    Language,
    Hosts,
    Agents,
    Sessions,
    NewCwd,
    /// The typed working directory does not exist: ask before creating it.
    NewDirConfirm,
    /// Confirm writing local `gh` login onto the highlighted host.
    GithubConfirm,
    Confirm,
    /// A connection problem: raw ssh output + cause + fixes.
    Problem,
    /// Password for a host whose ssh cannot multiplex (Win32 OpenSSH). The
    /// value is held in process memory only and fed to ssh via askpass.
    Password,
    /// Windows-remote session that looks like it may still be running: warn
    /// before starting a second process on the same transcript.
    RunningConfirm,
}

/// What to re-run when the user retries from the problem screen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Retry {
    /// Re-probe the selected host (the usual entry point).
    Probe,
    /// Re-probe and, when we were on the session list, reload it too.
    Reload,
}

/// A session we could not start yet: its working directory is missing, so the
/// TUI asks before anything is written on the remote. `session_id` is `Some`
/// when the user was resuming an idle session rather than starting a new one.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PendingStart {
    dir: String,
    session_id: Option<String>,
}

struct App {
    screen: Screen,
    lang: Lang,
    lang_idx: usize,
    hosts: Vec<SshHost>,
    /// Sign-in mode per host row: `auto`, `key` or `password`.
    auth: Vec<AuthMode>,
    host_idx: usize,
    agent_idx: usize,
    session_idx: usize,
    probe: Option<Probe>,
    sessions: Vec<SessionSummary>,
    cwd_input: String,
    dir_listing: Option<DirListing>,
    dir_idx: usize,
    /// Session awaiting the "create the working directory?" confirmation.
    pending: Option<PendingStart>,
    plan: Option<Plan>,
    status: String,
    error: Option<String>,
    diag: Option<Diagnosis>,
    diag_scroll: u16,
    retry: Retry,
    problem_from: Screen,
    /// Masked input on `Screen::Password`; moved into `askpass` on Enter.
    password_input: String,
    quit: bool,
}

impl App {
    fn new(hosts: Vec<SshHost>, saved: Option<Lang>) -> Self {
        let (screen, lang, lang_idx, status) = match saved {
            Some(lang) => {
                let idx = Lang::ALL.iter().position(|l| *l == lang).unwrap_or(0);
                (Screen::Hosts, lang, idx, lang.status_ready().to_string())
            }
            None => (
                Screen::Language,
                Lang::Zh,
                0,
                Lang::Zh.language_keys_hint().to_string(),
            ),
        };
        let auth = auth_modes(&hosts);
        Self {
            screen,
            lang,
            lang_idx,
            hosts,
            auth,
            host_idx: 0,
            agent_idx: 0,
            session_idx: 0,
            probe: None,
            sessions: Vec::new(),
            cwd_input: String::new(),
            dir_listing: None,
            dir_idx: 0,
            pending: None,
            plan: None,
            status,
            error: None,
            diag: None,
            diag_scroll: 0,
            retry: Retry::Probe,
            problem_from: Screen::Hosts,
            password_input: String::new(),
            quit: false,
        }
    }

    fn auth_of(&self, idx: usize) -> AuthMode {
        self.auth.get(idx).copied().unwrap_or_default()
    }

    fn host(&self) -> Option<&SshHost> {
        self.hosts.get(self.host_idx)
    }

    fn agent(&self) -> AgentKind {
        AgentKind::ALL[self.agent_idx.min(3)]
    }

    fn clamp(&mut self) {
        if !self.hosts.is_empty() {
            self.host_idx = self.host_idx.min(self.hosts.len() - 1);
        }
        if self.auth.len() != self.hosts.len() {
            self.auth = auth_modes(&self.hosts);
        }
        self.agent_idx = self.agent_idx.min(3);
        self.lang_idx = self.lang_idx.min(Lang::ALL.len().saturating_sub(1));
        if !self.sessions.is_empty() {
            self.session_idx = self.session_idx.min(self.sessions.len() - 1);
        } else {
            self.session_idx = 0;
        }
        let n = picker_rows(&unique_recents(&self.sessions), self.dir_listing.as_ref()).len();
        if n == 0 {
            self.dir_idx = 0;
        } else {
            self.dir_idx = self.dir_idx.min(n - 1);
        }
    }

    fn move_sel(&mut self, delta: i32) {
        match self.screen {
            Screen::Language => {
                let n = Lang::ALL.len() as i32;
                self.lang_idx = (self.lang_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::Hosts => {
                if self.hosts.is_empty() {
                    return;
                }
                let n = self.hosts.len() as i32;
                self.host_idx = (self.host_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::Agents => {
                self.agent_idx = (self.agent_idx as i32 + delta).rem_euclid(4) as usize;
            }
            Screen::Sessions => {
                if self.sessions.is_empty() {
                    return;
                }
                let n = self.sessions.len() as i32;
                self.session_idx = (self.session_idx as i32 + delta).rem_euclid(n) as usize;
            }
            Screen::NewCwd
            | Screen::NewDirConfirm
            | Screen::GithubConfirm
            | Screen::Confirm
            | Screen::Problem
            | Screen::Password
            | Screen::RunningConfirm => {}
        }
    }
}

fn auth_modes(hosts: &[SshHost]) -> Vec<AuthMode> {
    hosts.iter().map(|h| config::auth_for(&h.alias)).collect()
}

pub fn run() -> Result<()> {
    let hosts = ssh::list_hosts()?;
    let mut app = App::new(hosts, config::language());
    if matches!(app.screen, Screen::Hosts) && app.hosts.is_empty() {
        app.status = app.lang.no_hosts().into();
    }
    let mut terminal = ratatui::init();
    let result = event_loop(&mut terminal, &mut app);
    ratatui::restore();
    result
}

fn event_loop(terminal: &mut DefaultTerminal, app: &mut App) -> Result<()> {
    while !app.quit {
        terminal.draw(|f| draw(f, app))?;
        if !event::poll(Duration::from_millis(200))? {
            continue;
        }
        let Event::Key(key) = event::read()? else {
            continue;
        };
        if key.kind != KeyEventKind::Press {
            continue;
        }
        handle_key(app, key, terminal)?;
    }
    Ok(())
}

fn handle_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    if matches!(app.screen, Screen::NewCwd) {
        return handle_cwd_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::NewDirConfirm) {
        return handle_new_dir_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::Confirm) {
        return handle_confirm_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::Problem) {
        return handle_problem_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::Password) {
        return handle_password_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::RunningConfirm) {
        return handle_running_confirm_key(app, key, terminal);
    }
    if matches!(app.screen, Screen::GithubConfirm) {
        return handle_github_key(app, key, terminal);
    }
    match key.code {
        KeyCode::Char('q') | KeyCode::Esc => match app.screen {
            Screen::Language | Screen::Hosts => app.quit = true,
            Screen::Agents => {
                app.screen = Screen::Hosts;
                app.probe = None;
                app.plan = None;
                app.status = app.lang.status_ready().into();
            }
            Screen::Sessions => {
                app.screen = Screen::Agents;
                app.status = app.lang.select_agent().into();
            }
            Screen::NewCwd
            | Screen::NewDirConfirm
            | Screen::GithubConfirm
            | Screen::Confirm
            | Screen::Problem
            | Screen::Password
            | Screen::RunningConfirm => {}
        },
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Down | KeyCode::Char('j') => app.move_sel(1),
        KeyCode::Up | KeyCode::Char('k') => app.move_sel(-1),
        KeyCode::Char('r') => refresh(app)?,
        KeyCode::Char('g') if matches!(app.screen, Screen::Hosts) => cycle_auth(app)?,
        KeyCode::Char('G') if matches!(app.screen, Screen::Hosts) => begin_github_sync(app),
        KeyCode::Char('p') | KeyCode::Char('P') if matches!(app.screen, Screen::Sessions) => {
            toggle_full_permissions(app)?;
        }
        KeyCode::Char('l') | KeyCode::Char('L')
            if matches!(app.screen, Screen::Hosts | Screen::Language) =>
        {
            begin_language(app);
        }
        KeyCode::Char('?') => {
            app.status = app.lang.status_help().into();
        }
        KeyCode::Char('n') if matches!(app.screen, Screen::Sessions) => begin_new(app),
        KeyCode::Char('u') | KeyCode::Char('U') if matches!(app.screen, Screen::Agents) => {
            begin_agent_action(app, terminal, install::Action::Upgrade)?;
        }
        KeyCode::Char('x') | KeyCode::Char('X') if matches!(app.screen, Screen::Agents) => {
            begin_agent_action(app, terminal, install::Action::Uninstall)?;
        }
        KeyCode::Enter => on_enter(app, terminal)?,
        _ => {}
    }
    Ok(())
}

fn handle_cwd_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc => {
            app.screen = Screen::Sessions;
            app.status = app.lang.cancelled().into();
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Backspace => {
            app.cwd_input.pop();
        }
        KeyCode::Down | KeyCode::Char('j') => move_dir_sel(app, 1),
        KeyCode::Up | KeyCode::Char('k') => move_dir_sel(app, -1),
        KeyCode::Tab => refresh_dir_listing(app),
        KeyCode::Char('p') | KeyCode::Char('P') => toggle_full_permissions(app)?,
        KeyCode::Char('s') | KeyCode::Char('S') => start_from_cwd_input(app, terminal)?,
        KeyCode::Enter => navigate_dir_sel(app),
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.cwd_input.push(c);
        }
        _ => {}
    }
    Ok(())
}

/// Keys on the "directory does not exist, create it?" screen.
fn handle_new_dir_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.pending = None;
            app.screen = Screen::NewCwd;
            app.status = app.lang.type_cwd().into();
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Enter => {
            let Some(pending) = app.pending.clone() else {
                app.screen = Screen::NewCwd;
                return Ok(());
            };
            let Some(host) = app.host().map(|h| h.alias.clone()) else {
                return Ok(());
            };
            let agent = app.agent();
            app.status = app.lang.dir_creating(&pending.dir);
            app.error = None;
            terminal.draw(|f| draw(f, app))?;
            start_session(
                app,
                terminal,
                &host,
                agent,
                &pending.dir,
                pending.session_id.as_deref(),
                true,
            )?;
        }
        _ => {}
    }
    Ok(())
}

/// Can sessions be started on this host? On POSIX that needs tmux (it carries
/// the session); Windows remotes run the agent in the foreground instead.
fn sessions_supported(os: HostOs, tmux: bool) -> bool {
    os == HostOs::Windows || tmux
}

/// The probed dialect, defaulting to POSIX before any probe has run.
fn probe_os(app: &App) -> HostOs {
    app.probe.as_ref().map(|p| p.os).unwrap_or_default()
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum PickerRow {
    Recent(String),
    Parent,
    Child(String),
}

fn unique_recents(sessions: &[SessionSummary]) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for s in sessions {
        let Some(cwd) = s.cwd.as_deref().map(str::trim).filter(|c| !c.is_empty()) else {
            continue;
        };
        if seen.insert(cwd.to_string()) {
            out.push(cwd.to_string());
        }
    }
    out
}

fn picker_rows(recents: &[String], listing: Option<&DirListing>) -> Vec<PickerRow> {
    let mut rows: Vec<PickerRow> = recents.iter().cloned().map(PickerRow::Recent).collect();
    rows.push(PickerRow::Parent);
    if let Some(listing) = listing {
        rows.extend(listing.dirs.iter().cloned().map(PickerRow::Child));
    }
    rows
}

fn picker_base(cwd_input: &str, listing: Option<&DirListing>) -> String {
    listing
        .map(|l| l.cwd.as_str())
        .filter(|s| !s.is_empty())
        .unwrap_or(cwd_input)
        .to_string()
}

fn navigate_picker(
    cwd_input: &str,
    row: &PickerRow,
    listing: Option<&DirListing>,
    os: HostOs,
) -> String {
    match row {
        PickerRow::Recent(path) => path.clone(),
        PickerRow::Parent => listing
            .map(|l| l.parent.clone())
            .filter(|p| !p.is_empty())
            .unwrap_or_else(|| join_dir(&picker_base(cwd_input, listing), "..", os)),
        PickerRow::Child(name) => join_dir(&picker_base(cwd_input, listing), name, os),
    }
}

fn move_dir_sel(app: &mut App, delta: i32) {
    let rows = picker_rows(&unique_recents(&app.sessions), app.dir_listing.as_ref());
    if rows.is_empty() {
        return;
    }
    let n = rows.len() as i32;
    app.dir_idx = (app.dir_idx as i32 + delta).rem_euclid(n) as usize;
}

fn navigate_dir_sel(app: &mut App) {
    let recents = unique_recents(&app.sessions);
    let rows = picker_rows(&recents, app.dir_listing.as_ref());
    let Some(row) = rows.get(app.dir_idx).cloned() else {
        return;
    };
    let os = probe_os(app);
    app.cwd_input = navigate_picker(&app.cwd_input, &row, app.dir_listing.as_ref(), os);
    app.dir_idx = 0;
    refresh_dir_listing(app);
}

fn start_from_cwd_input(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let typed = app.cwd_input.trim().to_string();
    if typed.is_empty() {
        app.error = Some(app.lang.cwd_required().into());
        return Ok(());
    }
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let agent = app.agent();
    let (home, os) = match &app.probe {
        Some(p) => (p.home.clone(), p.os),
        None => ("/".into(), Default::default()),
    };
    let cwd = expand_home(&typed, &home, os);
    start_session(app, terminal, &host, agent, &cwd, None, false)
}

fn refresh_dir_listing(app: &mut App) {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return;
    };
    let (home, os) = match &app.probe {
        Some(p) => (p.home.clone(), p.os),
        None => ("/".into(), Default::default()),
    };
    let typed = app.cwd_input.trim();
    if typed.is_empty() {
        app.dir_listing = None;
        app.error = Some(app.lang.cwd_required().into());
        return;
    }
    let path = expand_home(typed, &home, os);
    match dirsvc::list_dirs(&host, os, &path) {
        Ok(listing) => {
            app.cwd_input = listing.cwd.clone();
            app.dir_listing = Some(listing);
            app.error = None;
            app.status = app.lang.type_cwd().into();
        }
        Err(e) => {
            app.dir_listing = None;
            app.error = Some(e.to_string());
        }
    }
    app.clamp();
}

fn toggle_full_permissions(app: &mut App) -> Result<()> {
    let on = !config::full_permissions();
    match config::set_full_permissions(on) {
        Ok(()) => {
            app.status = app.lang.full_permissions_status(on).into();
            app.error = None;
        }
        Err(e) => {
            app.error = Some(e.to_string());
        }
    }
    Ok(())
}

fn begin_github_sync(app: &mut App) {
    if app.host().is_none() {
        return;
    }
    app.error = None;
    app.screen = Screen::GithubConfirm;
    app.status = github::CONFIRM_KEYS.pick(app.lang).into();
}

fn handle_github_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.screen = Screen::Hosts;
            app.status = app.lang.status_ready().into();
            app.error = None;
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Enter => run_github_sync(app, terminal)?,
        _ => {}
    }
    Ok(())
}

fn run_github_sync(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    app.status = github::SYNCING.pick(app.lang).into();
    app.error = None;
    terminal.draw(|f| draw(f, app))?;
    match github::sync_to_host(&host) {
        Ok(report) => {
            app.screen = Screen::Hosts;
            app.status = report.plain(&host, app.lang);
            app.error = None;
        }
        Err(e) => {
            app.screen = Screen::Hosts;
            report_error(app, Retry::Probe, Screen::Hosts, &e);
        }
    }
    Ok(())
}

/// One `*` per character (not per byte) — the password itself never reaches
/// the screen buffer.
fn mask(input: &str) -> String {
    "*".repeat(input.chars().count())
}

fn begin_language(app: &mut App) {
    app.lang_idx = Lang::ALL.iter().position(|l| *l == app.lang).unwrap_or(0);
    app.screen = Screen::Language;
    app.error = None;
    app.status = app.lang.language_keys_hint().into();
}

fn commit_language(app: &mut App) -> Result<()> {
    let lang = Lang::ALL[app.lang_idx.min(Lang::ALL.len() - 1)];
    match config::set_language(lang) {
        Ok(()) => {
            app.lang = lang;
            app.screen = Screen::Hosts;
            app.error = None;
            app.status = if app.hosts.is_empty() {
                lang.no_hosts().into()
            } else {
                lang.language_saved()
            };
        }
        Err(e) => {
            app.error = Some(lang.language_save_failed(&e.to_string()));
        }
    }
    Ok(())
}

fn begin_new(app: &mut App) {
    let Some(probe) = &app.probe else {
        app.error = Some(app.lang.probe_host_first().into());
        return;
    };
    if !sessions_supported(probe.os, probe.tmux.found) {
        app.error = Some(runtime::TMUX_MISSING_SHORT.pick(app.lang).into());
        return;
    }
    if probe.agent(app.agent()).map(|a| a.found) != Some(true) {
        app.error = Some(runtime::agent_missing(&app.agent().to_string()).pick(app.lang));
        return;
    }
    app.cwd_input = app
        .sessions
        .iter()
        .find_map(|s| s.cwd.clone())
        .unwrap_or_else(|| probe.home.clone());
    app.pending = None;
    app.error = None;
    app.dir_idx = 0;
    app.screen = Screen::NewCwd;
    app.status = app.lang.type_cwd().into();
    refresh_dir_listing(app);
}

fn refresh(app: &mut App) -> Result<()> {
    match app.screen {
        Screen::Language => {}
        Screen::Hosts => {
            app.hosts = ssh::list_hosts()?;
            app.auth = auth_modes(&app.hosts);
            app.status = app.lang.host_count(app.hosts.len());
        }
        Screen::Agents | Screen::Sessions | Screen::NewCwd => reload_probe_and_sessions(app)?,
        Screen::Confirm
        | Screen::Problem
        | Screen::NewDirConfirm
        | Screen::GithubConfirm
        | Screen::Password
        | Screen::RunningConfirm => {}
    }
    app.clamp();
    Ok(())
}

/// `auto` -> `key` -> `password` -> `auto` for the highlighted host.
fn cycle_auth(app: &mut App) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let next = next_auth(app.auth_of(app.host_idx));
    config::set_auth(&host, next)?;
    app.auth = auth_modes(&app.hosts);
    app.status = ssh::auth_saved(&host, next).pick(app.lang);
    Ok(())
}

/// `auto` -> `key` -> `password` -> `auto`.
fn next_auth(mode: AuthMode) -> AuthMode {
    let i = AuthMode::ALL.iter().position(|m| *m == mode).unwrap_or(0);
    AuthMode::ALL[(i + 1) % AuthMode::ALL.len()]
}

fn on_enter(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    match app.screen {
        Screen::Language => commit_language(app)?,
        Screen::Hosts => probe_selected_host(app, terminal)?,
        Screen::Agents => {
            let found = app
                .probe
                .as_ref()
                .and_then(|p| p.agent(app.agent()))
                .map(|a| a.found)
                == Some(true);
            let supported = app
                .probe
                .as_ref()
                .map(|p| sessions_supported(p.os, p.tmux.found))
                == Some(true);
            if !found || !supported {
                open_confirm(app, terminal, install::Action::Install)?;
                return Ok(());
            }
            reload_sessions(app)?;
            app.screen = Screen::Sessions;
            app.session_idx = 0;
            app.status = app.lang.sessions_status_os(probe_os(app)).into();
        }
        Screen::Confirm
        | Screen::Problem
        | Screen::NewDirConfirm
        | Screen::GithubConfirm
        | Screen::Password
        | Screen::RunningConfirm => {}
        Screen::Sessions => {
            if app.sessions.is_empty() {
                begin_new(app);
                return Ok(());
            }
            attach_existing(app, terminal)?;
        }
        Screen::NewCwd => {}
    }
    Ok(())
}

/// Probe the highlighted host and move on to its agent list.
fn probe_selected_host(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    // Password host on a machine without multiplexing (Win32 OpenSSH): ask
    // for the password up front instead of running a probe that cannot
    // authenticate. Auto hosts reach the same prompt via the problem screen.
    if app.auth_of(app.host_idx) == AuthMode::Password
        && !ssh::mux_capable()
        && !askpass::active_for(&host)
    {
        app.retry = Retry::Probe;
        app.problem_from = Screen::Hosts;
        begin_password(app, &host);
        return Ok(());
    }
    app.status = app.lang.probing(&host);
    app.error = None;
    app.diag = None;
    terminal.draw(|f| draw(f, app))?;
    match probe::probe_host(&host) {
        Ok(p) => {
            app.probe = Some(p);
            app.screen = Screen::Agents;
            app.agent_idx = 0;
            app.error = None;
            app.status = app.lang.select_agent().into();
        }
        Err(e) => {
            app.status = app.lang.probe_failed(&host);
            report_error(app, Retry::Probe, Screen::Hosts, &e);
        }
    }
    Ok(())
}

/// Connection failures get the full report; anything else stays a one-line
/// red footer message.
fn report_error(app: &mut App, retry: Retry, from: Screen, e: &anyhow::Error) {
    let host = app.host().map(|h| h.alias.clone()).unwrap_or_default();
    match diagnose::diagnosis_of(e, &host) {
        Some(diag) => {
            app.status = if diag.timed_out {
                app.lang.problem_status_timeout().to_string()
            } else {
                app.lang.problem_status(diag.needs_auth).to_string()
            };
            app.diag = Some(diag);
            app.diag_scroll = 0;
            app.retry = retry;
            app.problem_from = from;
            app.error = None;
            app.screen = Screen::Problem;
        }
        None => {
            if app.error.is_none() {
                app.error = Some(e.to_string());
            }
        }
    }
}

fn handle_confirm_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.screen = Screen::Agents;
            app.plan = None;
            app.error = None;
            app.status = app.lang.select_agent().into();
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Char('r') => {
            if let Some(action) = app.plan.as_ref().map(|p| p.action) {
                open_confirm(app, terminal, action)?;
            }
        }
        KeyCode::Enter => execute_plan(app, terminal)?,
        _ => {}
    }
    Ok(())
}

/// Keys on the connection-problem screen. `a` is the escape hatch for password
/// hosts and for first-connect host key confirmation.
fn handle_problem_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.diag = None;
            app.diag_scroll = 0;
            app.error = None;
            app.screen = app.problem_from.clone();
            app.status = match app.screen {
                Screen::Sessions => app.lang.sessions_status_os(probe_os(app)).into(),
                Screen::Agents => app.lang.select_agent().into(),
                _ => app.lang.status_ready().into(),
            };
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Down | KeyCode::Char('j') => {
            app.diag_scroll = app.diag_scroll.saturating_add(1);
        }
        KeyCode::Up | KeyCode::Char('k') => {
            app.diag_scroll = app.diag_scroll.saturating_sub(1);
        }
        KeyCode::PageDown | KeyCode::Char(' ') => {
            app.diag_scroll = app.diag_scroll.saturating_add(8);
        }
        KeyCode::PageUp => {
            app.diag_scroll = app.diag_scroll.saturating_sub(8);
        }
        KeyCode::Char('r') => retry(app, terminal)?,
        KeyCode::Char('a') => authenticate(app, terminal)?,
        KeyCode::Char('y') => {
            let ok = match &app.diag {
                Some(d) => copy_to_clipboard(&d.plain(app.lang)),
                None => false,
            };
            app.status = if ok {
                app.lang.clipboard_ok().into()
            } else {
                app.lang.clipboard_failed().into()
            };
        }
        _ => {}
    }
    Ok(())
}

/// Re-run whatever failed, now that the user fixed something on the host.
fn retry(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    app.diag = None;
    app.diag_scroll = 0;
    app.error = None;
    match app.retry {
        Retry::Probe => {
            app.screen = Screen::Hosts;
            probe_selected_host(app, terminal)
        }
        Retry::Reload => {
            app.screen = app.problem_from.clone();
            reload_probe_and_sessions(app)
        }
    }
}

/// `a` on the problem screen. On machines whose ssh cannot multiplex
/// (Win32 OpenSSH), a credential problem opens the in-memory password
/// prompt — ssh then reads the secret via askpass instead of prompting per
/// command. Host-key and passphrase problems keep the interactive path
/// (`faragent login`), which is also how first-connect fingerprints get
/// confirmed.
fn authenticate(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let problem = app.diag.as_ref().map(|d| d.problem);
    if should_prompt_password(ssh::mux_capable(), problem) {
        begin_password(app, &host);
        return Ok(());
    }
    let mode = app.auth_of(app.host_idx);
    ratatui::restore();
    let code = pty::interactive_connect(&host, mode, app.lang);
    *terminal = ratatui::init();
    app.auth = auth_modes(&app.hosts);
    match code {
        Ok(0) => retry(app, terminal)?,
        Ok(c) => app.status = ssh::auth_failed(c).pick(app.lang),
        Err(e) => app.error = Some(e.to_string()),
    }
    Ok(())
}

/// Only credential problems on a machine without connection multiplexing
/// warrant the in-memory prompt; everything else stays with OpenSSH's own
/// interactive handling.
fn should_prompt_password(mux: bool, problem: Option<diagnose::Problem>) -> bool {
    !mux && matches!(
        problem,
        Some(diagnose::Problem::NeedsPassword | diagnose::Problem::PasswordDenied)
    )
}

fn begin_password(app: &mut App, host: &str) {
    app.password_input.clear();
    app.error = None;
    app.screen = Screen::Password;
    app.status = app.lang.password_prompt(host);
}

/// Keys on the in-memory password screen. The input is rendered as `*` only;
/// on Enter it moves into `askpass` (zeroized when faragent exits).
fn handle_password_key(app: &mut App, key: KeyEvent, terminal: &mut DefaultTerminal) -> Result<()> {
    match key.code {
        KeyCode::Esc => {
            app.password_input.clear();
            app.error = None;
            app.screen = app.problem_from.clone();
            app.status = match app.screen {
                Screen::Sessions => app.lang.sessions_status_os(probe_os(app)).into(),
                Screen::Agents => app.lang.select_agent().into(),
                _ => app.lang.status_ready().into(),
            };
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Char('u') if key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.password_input.clear();
        }
        KeyCode::Backspace => {
            app.password_input.pop();
        }
        KeyCode::Enter => {
            let Some(host) = app.host().map(|h| h.alias.clone()) else {
                return Ok(());
            };
            if app.password_input.is_empty() {
                app.error = Some(app.lang.password_required().into());
                return Ok(());
            }
            let password = std::mem::take(&mut app.password_input);
            askpass::install_session(&host, password);
            app.error = None;
            app.status = app.lang.password_stored(&host);
            retry(app, terminal)?;
        }
        KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
            app.password_input.push(c);
        }
        _ => {}
    }
    Ok(())
}

/// Copy-paste the whole report. Uses whichever clipboard tool exists.
fn copy_to_clipboard(text: &str) -> bool {
    #[allow(unused_mut)]
    let mut tools: Vec<(&str, &[&str])> = vec![
        ("pbcopy", &[]),
        ("wl-copy", &[]),
        ("xclip", &["-selection", "clipboard"]),
    ];
    #[cfg(windows)]
    tools.push(("clip", &[]));
    for (bin, args) in tools {
        let Ok(mut child) = Command::new(bin)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
        else {
            continue;
        };
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        if matches!(child.wait(), Ok(status) if status.success()) {
            return true;
        }
    }
    false
}

fn begin_agent_action(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    action: install::Action,
) -> Result<()> {
    let found = app
        .probe
        .as_ref()
        .and_then(|p| p.agent(app.agent()))
        .map(|a| a.found)
        == Some(true);
    match action {
        install::Action::Uninstall if !found => {
            app.error = Some(install::no_need_uninstall(&app.agent().to_string()).pick(app.lang));
            Ok(())
        }
        install::Action::Upgrade if !found => open_confirm(app, terminal, install::Action::Install),
        other => open_confirm(app, terminal, other),
    }
}

fn open_confirm(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    action: install::Action,
) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let agent = app.agent();
    app.status = install::planning().pick(app.lang).into();
    app.error = None;
    terminal.draw(|f| draw(f, app))?;
    match install::preflight_host(&host, agent) {
        Ok(pf) => {
            let plan = install::plan_for(action, agent, &pf);
            let can = plan.can_run();
            app.plan = Some(plan);
            app.screen = Screen::Confirm;
            app.status = app.lang.confirm_keys_hint(can).into();
        }
        Err(e) => {
            app.error = Some(install::plan_failed(&e.to_string()).pick(app.lang));
            report_error(app, Retry::Reload, Screen::Agents, &e);
        }
    }
    Ok(())
}

fn execute_plan(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(plan) = app.plan.clone() else {
        return Ok(());
    };
    if !plan.can_run() {
        app.error = Some(install::plan_blocked_enter().pick(app.lang).into());
        return Ok(());
    }
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    app.status = install::running_remote().pick(app.lang).into();
    ratatui::restore();
    let code = match probe_os(app) {
        HostOs::Posix => pty::run_remote_script(&host, &plan.script),
        HostOs::Windows => pty::run_remote_ps(&host, &plan.script),
    };
    *terminal = ratatui::init();
    app.screen = Screen::Agents;
    app.plan = None;
    match code {
        Ok(0) => {
            app.status = install::remote_ok().pick(app.lang).into();
            app.error = None;
        }
        Ok(c) => {
            let msg = install::remote_failed(c).pick(app.lang);
            app.status = msg.clone();
            app.error = Some(msg);
        }
        Err(e) => app.error = Some(e.to_string()),
    }
    let _ = reload_probe_and_sessions(app);
    Ok(())
}

fn reload_probe_and_sessions(app: &mut App) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    match probe::probe_host(&host) {
        Ok(p) => {
            app.probe = Some(p);
            app.error = None;
        }
        Err(e) => {
            app.status = app.lang.probe_failed(&host);
            let from = app.screen.clone();
            report_error(app, Retry::Reload, from, &e);
            return Ok(());
        }
    }
    if matches!(app.screen, Screen::Sessions | Screen::NewCwd) {
        reload_sessions(app)?;
    }
    Ok(())
}

fn reload_sessions(app: &mut App) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    match runtime::list_sessions(&host, app.agent(), probe_os(app)) {
        Ok(rows) => {
            app.sessions = rows;
            app.error = None;
            app.status = app.lang.session_count(app.sessions.len());
        }
        Err(e) => report_error(app, Retry::Reload, Screen::Sessions, &e),
    }
    Ok(())
}

fn attach_existing(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(sess) = app.sessions.get(app.session_idx).cloned() else {
        return Ok(());
    };
    // Live tmux: attach only. Never resume a running session (Codex #30424).
    if sess.live {
        let Some(host) = app.host().map(|h| h.alias.clone()) else {
            return Ok(());
        };
        let agent = app.agent();
        let tmux = sess
            .tmux
            .clone()
            .unwrap_or_else(|| faragent_core::agents::tmux_name(agent, &sess.id));
        return drop_into_tmux(app, terminal, &host, &tmux);
    }
    // A Windows remote cannot prove liveness, only suggest it: ask first.
    if sess.running {
        app.screen = Screen::RunningConfirm;
        return Ok(());
    }
    open_session(app, terminal)
}

/// Start or resume the highlighted session in its working directory.
fn open_session(app: &mut App, terminal: &mut DefaultTerminal) -> Result<()> {
    let Some(host) = app.host().map(|h| h.alias.clone()) else {
        return Ok(());
    };
    let Some(sess) = app.sessions.get(app.session_idx).cloned() else {
        return Ok(());
    };
    let agent = app.agent();
    let cwd = sess
        .cwd
        .as_deref()
        .map(PathBuf::from)
        .or_else(|| app.probe.as_ref().map(|p| PathBuf::from(&p.home)))
        .unwrap_or_else(|| PathBuf::from("."));
    let cwd_s = cwd.to_string_lossy().into_owned();
    start_session(app, terminal, &host, agent, &cwd_s, Some(&sess.id), false)
}

/// Keys on the "that session may still be running" confirmation.
fn handle_running_confirm_key(
    app: &mut App,
    key: KeyEvent,
    terminal: &mut DefaultTerminal,
) -> Result<()> {
    match key.code {
        KeyCode::Esc | KeyCode::Char('q') => {
            app.screen = Screen::Sessions;
            app.status = app.lang.sessions_status_os(probe_os(app)).into();
        }
        KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => app.quit = true,
        KeyCode::Enter => open_session(app, terminal)?,
        _ => {}
    }
    Ok(())
}

/// Start (or resume) a session in `cwd`. With `create_cwd = false` nothing is
/// written on the remote: a missing directory comes back as a confirmation
/// screen instead of an error.
fn start_session(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    host: &str,
    agent: AgentKind,
    cwd: &str,
    session_id: Option<&str>,
    create_cwd: bool,
) -> Result<()> {
    let os = probe_os(app);
    let result = match os {
        HostOs::Posix => runtime::ensure_tmux_session(
            host,
            agent,
            std::path::Path::new(cwd),
            session_id,
            create_cwd,
        ),
        HostOs::Windows => runtime::ensure_win_session(
            host,
            agent,
            std::path::Path::new(cwd),
            session_id,
            create_cwd,
        ),
    };
    match result {
        Ok(name) => {
            app.pending = None;
            app.screen = Screen::Sessions;
            match os {
                HostOs::Posix => drop_into_tmux(app, terminal, host, &name)?,
                HostOs::Windows => {
                    drop_into_win_session(app, terminal, host, agent, cwd, session_id)?
                }
            }
        }
        Err(e) => {
            match e.downcast_ref::<runtime::SessionError>() {
                // Not an error: we simply need the user's go-ahead to write.
                Some(runtime::SessionError::CwdMissing { dir }) => {
                    app.pending = Some(PendingStart {
                        dir: dir.clone(),
                        session_id: session_id.map(|s| s.to_string()),
                    });
                    app.screen = Screen::NewDirConfirm;
                    app.status = app.lang.dir_missing_status().into();
                }
                _ => {
                    app.screen = Screen::Sessions;
                    report_error(app, Retry::Reload, Screen::Sessions, &e);
                }
            }
        }
    }
    Ok(())
}

/// Launch an agent in the foreground on a Windows remote. When it exits (or
/// ssh drops), the session ends; resume restores the conversation later.
fn drop_into_win_session(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    host: &str,
    agent: AgentKind,
    cwd: &str,
    session_id: Option<&str>,
) -> Result<()> {
    let argv = agent.launch_argv(session_id, config::full_permissions());
    app.status = app.lang.attaching_resume(agent.title());
    ratatui::restore();
    let code = pty::attach_win(host, cwd, &argv);
    *terminal = ratatui::init();
    match code {
        Ok(0) | Ok(1) => {
            app.status = app.lang.session_ended().into();
            app.error = None;
        }
        Ok(c) => app.status = app.lang.ssh_exited(c),
        Err(e) => app.error = Some(e.to_string()),
    }
    let _ = reload_sessions(app);
    Ok(())
}

fn drop_into_tmux(
    app: &mut App,
    terminal: &mut DefaultTerminal,
    host: &str,
    tmux_name: &str,
) -> Result<()> {
    app.status = app.lang.attaching(tmux_name);
    ratatui::restore();
    let code = pty::attach_tmux(host, tmux_name);
    *terminal = ratatui::init();
    match code {
        Ok(0) | Ok(1) => {
            // ssh/tmux often exit 1 on detach; still refresh.
            app.status = app.lang.detached().into();
            app.error = None;
        }
        Ok(c) => app.status = app.lang.ssh_exited(c),
        Err(e) => app.error = Some(e.to_string()),
    }
    let _ = reload_sessions(app);
    Ok(())
}

fn session_line(s: &SessionSummary) -> String {
    let mark = if s.live {
        runtime::MARK_LIVE
    } else if s.running {
        runtime::MARK_RUNNING
    } else {
        runtime::MARK_IDLE
    };
    let title = s
        .title
        .as_deref()
        .filter(|t| !t.is_empty())
        .unwrap_or(&s.id);
    let cwd = s.cwd.as_deref().unwrap_or("?");
    format!("[{mark}]  {title}  ({cwd})")
}

fn draw(frame: &mut Frame, app: &App) {
    let footer_h = if app.error.is_some() { 8 } else { 5 };
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3),
            Constraint::Min(5),
            Constraint::Length(footer_h),
        ])
        .split(frame.area());

    let title = match app.screen {
        Screen::Language => app.lang.language_title().to_string(),
        Screen::Hosts => app.lang.hosts_title().to_string(),
        Screen::Agents => app
            .lang
            .agents_title(app.host().map(|h| h.alias.as_str()).unwrap_or("?")),
        Screen::Sessions => format!(
            "{} · {}",
            app.lang.sessions_title(
                app.host().map(|h| h.alias.as_str()).unwrap_or("?"),
                app.agent().title(),
            ),
            app.lang.full_permissions_tag(config::full_permissions())
        ),
        Screen::NewCwd => format!(
            "{} · {}",
            app.lang.new_cwd_title(),
            app.lang.full_permissions_tag(config::full_permissions())
        ),
        Screen::GithubConfirm => github::CONFIRM_TITLE.pick(app.lang).into(),
        Screen::NewDirConfirm => app
            .lang
            .new_dir_title(app.pending.as_ref().map(|p| p.dir.as_str()).unwrap_or("?")),
        Screen::Confirm => {
            let action = app
                .plan
                .as_ref()
                .map(|p| p.action)
                .unwrap_or(install::Action::Install);
            let agent = app
                .plan
                .as_ref()
                .map(|p| p.agent.title())
                .unwrap_or_else(|| app.agent().title());
            install::confirm_title(
                action,
                app.host().map(|h| h.alias.as_str()).unwrap_or("?"),
                agent,
            )
            .pick(app.lang)
        }
        Screen::Problem => {
            diagnose::title(app.host().map(|h| h.alias.as_str()).unwrap_or("?")).pick(app.lang)
        }
        Screen::Password => app.lang.password_title().into(),
        Screen::RunningConfirm => app
            .lang
            .running_confirm_title(app.host().map(|h| h.alias.as_str()).unwrap_or("?")),
    };
    let header = Paragraph::new(title).block(
        Block::default()
            .borders(Borders::ALL)
            .style(Style::default().fg(Color::Cyan)),
    );
    frame.render_widget(header, chunks[0]);

    match app.screen {
        Screen::Language => {
            let lines: Vec<String> = Lang::ALL
                .iter()
                .map(|l| format!("{}  ({})", l.native_name(), l.code()))
                .collect();
            draw_list(
                frame,
                chunks[1],
                app.lang.language_list_title(),
                &lines,
                app.lang_idx,
            );
        }
        Screen::Hosts => draw_list(
            frame,
            chunks[1],
            app.lang.hosts_list_title(),
            &app.hosts
                .iter()
                .enumerate()
                .map(|(i, h)| {
                    format!(
                        "{}{}",
                        h.label(),
                        ssh::auth_tag(app.auth_of(i)).pick(app.lang)
                    )
                })
                .collect::<Vec<_>>(),
            app.host_idx,
        ),
        Screen::Agents => {
            let probe = app.probe.as_ref();
            let lines: Vec<String> = AgentKind::ALL
                .iter()
                .map(|k| match probe {
                    Some(p) => probe::format_agent_line(*k, p).pick(app.lang),
                    None => k.title().to_string(),
                })
                .collect();
            draw_list(
                frame,
                chunks[1],
                app.lang.agents_list_title(),
                &lines,
                app.agent_idx,
            );
        }
        Screen::Sessions => {
            let lines: Vec<String> = if app.sessions.is_empty() {
                vec![app.lang.no_sessions().into()]
            } else {
                app.sessions.iter().map(session_line).collect()
            };
            let idx = if app.sessions.is_empty() {
                0
            } else {
                app.session_idx
            };
            draw_list(
                frame,
                chunks[1],
                app.lang.sessions_list_title(probe_os(app)),
                &lines,
                idx,
            );
        }
        Screen::NewCwd => draw_new_cwd(frame, chunks[1], app),
        Screen::GithubConfirm => draw_github_confirm(frame, chunks[1], app),
        Screen::NewDirConfirm => draw_new_dir(frame, chunks[1], app),
        Screen::Confirm => draw_confirm(frame, chunks[1], app),
        Screen::Problem => draw_problem(frame, chunks[1], app),
        Screen::Password => {
            let p = Paragraph::new(format!("> {}_", mask(&app.password_input))).block(
                Block::default()
                    .title(app.host().map(|h| h.alias.as_str()).unwrap_or("?"))
                    .borders(Borders::ALL),
            );
            frame.render_widget(p, chunks[1]);
        }
        Screen::RunningConfirm => {
            let title = app
                .sessions
                .get(app.session_idx)
                .and_then(|s| s.title.clone())
                .unwrap_or_default();
            let lines: Vec<Line> = app
                .lang
                .running_confirm_lines(&title)
                .into_iter()
                .map(Line::from)
                .collect();
            let p = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
                Block::default()
                    .title(app.lang.session_warning_block_title())
                    .borders(Borders::ALL),
            );
            frame.render_widget(p, chunks[1]);
        }
    }

    let mut footer_lines = vec![Line::from(app.status.clone())];
    let hint = match app.screen {
        Screen::Language => app.lang.language_keys_hint(),
        Screen::Hosts => app.lang.hosts_keys_hint(),
        Screen::Agents => app.lang.agents_keys_hint(),
        Screen::NewCwd => app.lang.new_cwd_keys_hint(),
        Screen::GithubConfirm => github::CONFIRM_KEYS.pick(app.lang),
        Screen::NewDirConfirm => app.lang.new_dir_keys_hint(),
        Screen::Confirm => app
            .lang
            .confirm_keys_hint(app.plan.as_ref().map(|p| p.can_run()).unwrap_or(false)),
        Screen::Problem => app.lang.problem_keys_hint(),
        Screen::Password => app.lang.password_keys_hint(),
        Screen::RunningConfirm => app.lang.running_confirm_keys_hint(),
        _ => app.lang.keys_hint_os(probe_os(app)),
    };
    footer_lines.push(Line::from(Span::styled(
        hint,
        Style::default().fg(Color::DarkGray),
    )));
    if let Some(err) = &app.error {
        footer_lines.push(Line::from(Span::styled(
            err.clone(),
            Style::default().fg(Color::Red),
        )));
    }
    let footer = Paragraph::new(footer_lines)
        .wrap(Wrap { trim: true })
        .block(Block::default().borders(Borders::ALL));
    frame.render_widget(footer, chunks[2]);
}

fn draw_new_cwd(frame: &mut Frame, area: ratatui::layout::Rect, app: &App) {
    let parts = Layout::default()
        .direction(Direction::Vertical)
        .constraints([Constraint::Length(3), Constraint::Min(3)])
        .split(area);
    let input = Paragraph::new(format!("cwd> {}_", app.cwd_input)).block(
        Block::default()
            .title(app.lang.cwd_block_title())
            .borders(Borders::ALL),
    );
    frame.render_widget(input, parts[0]);
    let recents = unique_recents(&app.sessions);
    let rows = picker_rows(&recents, app.dir_listing.as_ref());
    let labels: Vec<String> = rows
        .iter()
        .map(|row| match row {
            PickerRow::Recent(path) => app.lang.dir_recent_label(path),
            PickerRow::Parent => "..".into(),
            PickerRow::Child(name) => name.clone(),
        })
        .collect();
    draw_list(
        frame,
        parts[1],
        app.lang.dir_picker_title(),
        &labels,
        app.dir_idx,
    );
}

fn draw_github_confirm(frame: &mut Frame, area: ratatui::layout::Rect, app: &App) {
    let host = app.host().map(|h| h.alias.as_str()).unwrap_or("?");
    let lines: Vec<Line> = github::confirm_lines(host)
        .pick(app.lang)
        .into_iter()
        .map(Line::from)
        .collect();
    let p = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .title(github::CONFIRM_LIST_TITLE.pick(app.lang))
            .borders(Borders::ALL),
    );
    frame.render_widget(p, area);
}

/// "That directory is not on the remote yet" — show exactly what Enter will
/// do before anything is written there.
fn draw_new_dir(frame: &mut Frame, area: ratatui::layout::Rect, app: &App) {
    let dir = app.pending.as_ref().map(|p| p.dir.as_str()).unwrap_or("?");
    let cmd_index = app.lang.new_dir_cmd_index();
    let mut lines: Vec<Line> = Vec::new();
    for (i, line) in app
        .lang
        .new_dir_lines(dir, probe_os(app))
        .iter()
        .enumerate()
    {
        if i == cmd_index {
            lines.push(Line::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(Color::Cyan),
            )));
        } else {
            lines.push(Line::from(line.clone()));
        }
    }
    let p = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .title(app.lang.new_dir_list_title())
            .borders(Borders::ALL),
    );
    frame.render_widget(p, area);
}

fn draw_confirm(frame: &mut Frame, area: ratatui::layout::Rect, app: &App) {
    let mut lines: Vec<Line> = Vec::new();
    match &app.plan {
        None => lines.push(Line::from(install::planning().pick(app.lang))),
        Some(plan) => {
            if let Some(b) = plan.blocked {
                lines.push(Line::from(Span::styled(
                    install::blocked(b).pick(app.lang),
                    Style::default().fg(Color::Red),
                )));
                lines.push(Line::from(""));
            }
            for w in &plan.warnings {
                lines.push(Line::from(Span::styled(
                    install::warning(*w).pick(app.lang),
                    Style::default().fg(Color::Yellow),
                )));
            }
            if !plan.warnings.is_empty() {
                lines.push(Line::from(""));
            }
            for (i, step) in plan.steps.iter().enumerate() {
                let sudo = if step.sudo {
                    format!("  ({})", install::step_sudo().pick(app.lang))
                } else {
                    String::new()
                };
                lines.push(Line::from(Span::styled(
                    format!("{}. {}{sudo}", i + 1, step.title),
                    Style::default().add_modifier(Modifier::BOLD),
                )));
                lines.push(Line::from(Span::styled(
                    format!("   {}", step.command),
                    Style::default().fg(Color::Cyan),
                )));
            }
            if !plan.suggested.is_empty() {
                lines.push(Line::from(""));
                lines.push(Line::from(Span::styled(
                    install::suggested_title().pick(app.lang),
                    Style::default().fg(Color::Yellow),
                )));
                for cmd in &plan.suggested {
                    lines.push(Line::from(format!("  {cmd}")));
                }
            }
        }
    }
    let p = Paragraph::new(lines).wrap(Wrap { trim: false }).block(
        Block::default()
            .title(install::confirm_list_title().pick(app.lang))
            .borders(Borders::ALL),
    );
    frame.render_widget(p, area);
}

/// The whole point of this screen: verbatim ssh output, then the fix.
fn draw_problem(frame: &mut Frame, area: ratatui::layout::Rect, app: &App) {
    let Some(diag) = &app.diag else {
        return;
    };
    let lang = app.lang;
    let bold = Style::default().add_modifier(Modifier::BOLD);
    let mut lines: Vec<Line> = vec![
        Line::from(Span::styled(
            diag.summary.pick(lang),
            Style::default()
                .fg(Color::Yellow)
                .add_modifier(Modifier::BOLD),
        )),
        Line::from(""),
    ];

    let raw = diag.raw.trim();
    if !raw.is_empty() {
        lines.push(Line::from(Span::styled(
            diagnose::raw_label().pick(lang),
            bold,
        )));
        for line in raw.lines() {
            lines.push(Line::from(Span::styled(
                format!("  {line}"),
                Style::default().fg(Color::Red),
            )));
        }
        lines.push(Line::from(""));
    }

    if !diag.command.is_empty() {
        lines.push(Line::from(Span::styled(
            format!("{}: {}", diagnose::command_label().pick(lang), diag.command),
            Style::default().fg(Color::DarkGray),
        )));
        lines.push(Line::from(""));
    }

    lines.push(Line::from(Span::styled(
        diagnose::fixes_label().pick(lang),
        bold,
    )));
    for (i, step) in diag.steps.pick(lang).iter().enumerate() {
        lines.push(Line::from(format!("  {}. {step}", i + 1)));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        format!(
            "{}: {}",
            diagnose::docs_label().pick(lang),
            diagnose::ssh_doc().pick(lang)
        ),
        Style::default().fg(Color::DarkGray),
    )));

    let max_scroll = lines.len().saturating_sub(1) as u16;
    let scroll = app.diag_scroll.min(max_scroll);
    let p = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .block(
            Block::default()
                .title(diagnose::list_title(diag.problem.slug()).pick(lang))
                .borders(Borders::ALL),
        );
    frame.render_widget(p, area);
}

fn draw_list(
    frame: &mut Frame,
    area: ratatui::layout::Rect,
    title: &str,
    items: &[String],
    idx: usize,
) {
    let list_items: Vec<ListItem> = items.iter().map(|s| ListItem::new(s.as_str())).collect();
    let list = List::new(list_items)
        .block(Block::default().title(title).borders(Borders::ALL))
        .highlight_style(
            Style::default()
                .fg(Color::Black)
                .bg(Color::Cyan)
                .add_modifier(Modifier::BOLD),
        )
        .highlight_symbol("▸ ");
    let mut state = ListState::default();
    if !items.is_empty() {
        state.select(Some(idx.min(items.len() - 1)));
    }
    frame.render_stateful_widget(list, area, &mut state);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn g_cycles_through_every_auth_mode() {
        assert_eq!(next_auth(AuthMode::Auto), AuthMode::Key);
        assert_eq!(next_auth(AuthMode::Key), AuthMode::Password);
        assert_eq!(next_auth(AuthMode::Password), AuthMode::Auto);
        // Three presses come back to where we started.
        let mut mode = AuthMode::Auto;
        for _ in 0..AuthMode::ALL.len() {
            mode = next_auth(mode);
        }
        assert_eq!(mode, AuthMode::Auto);
    }

    #[test]
    fn tilde_expands_against_the_remote_home_only_as_a_prefix() {
        let os = HostOs::Posix;
        assert_eq!(expand_home("~", "/home/me", os), "/home/me");
        assert_eq!(
            expand_home("~/code/app", "/home/me", os),
            "/home/me/code/app"
        );
        assert_eq!(
            expand_home("~/code/app", "/home/me/", os),
            "/home/me/code/app"
        );
        assert_eq!(expand_home("/srv/app", "/home/me", os), "/srv/app");
        // Mid-path tildes are literal, and a user named `~bob` is not a home ref.
        assert_eq!(expand_home("/srv/~weird", "/home/me", os), "/srv/~weird");
        assert_eq!(expand_home("~bob/app", "/home/me", os), "~bob/app");
    }

    #[test]
    fn tilde_expands_windows_style_home() {
        let os = HostOs::Windows;
        let home = "C:\\Users\\me";
        assert_eq!(expand_home("~", home, os), home);
        assert_eq!(
            expand_home("~\\code\\app", home, os),
            "C:\\Users\\me\\code\\app"
        );
        assert_eq!(
            expand_home("~/code/app", home, os),
            "C:\\Users\\me\\code\\app"
        );
        assert_eq!(expand_home("C:\\srv\\app", home, os), "C:\\srv\\app");
        assert_eq!(expand_home("~bob", home, os), "~bob");
        // Trailing separators on the home do not double up.
        assert_eq!(
            expand_home("~\\x", "C:\\Users\\me\\", os),
            "C:\\Users\\me\\x"
        );
    }

    #[test]
    fn windows_remotes_do_not_need_tmux_for_sessions() {
        assert!(sessions_supported(HostOs::Windows, false));
        assert!(sessions_supported(HostOs::Posix, true));
        assert!(!sessions_supported(HostOs::Posix, false));
    }

    #[test]
    fn new_dir_command_index_matches_the_command_line() {
        for lang in Lang::ALL {
            for os in [HostOs::Posix, HostOs::Windows] {
                let dir = "C:\\tmp\\x";
                let lines = lang.new_dir_lines(dir, os);
                let idx = lang.new_dir_cmd_index();
                assert_eq!(
                    lines[idx],
                    faragent_remote::remote::new_dir_command(dir, os),
                    "{lang:?} {os:?}"
                );
            }
        }
    }

    #[test]
    fn session_line_prefers_live_then_running() {
        let mk = |live: bool, running: bool| SessionSummary {
            id: "x".into(),
            agent: "claude".into(),
            title: Some("t".into()),
            cwd: Some("c".into()),
            mtime: 0.0,
            live,
            running,
            tmux: None,
        };
        assert!(session_line(&mk(true, false)).starts_with("[live]"));
        assert!(session_line(&mk(false, true)).starts_with("[running]"));
        assert!(session_line(&mk(false, false)).starts_with("[idle]"));
        assert!(session_line(&mk(true, false)).contains("(c)"));
    }

    #[test]
    fn mask_counts_characters_not_bytes() {
        assert_eq!(mask(""), "");
        assert_eq!(mask("abc"), "***");
        assert_eq!(mask("密码"), "**");
    }

    #[test]
    fn password_prompt_only_without_mux_on_credential_problems() {
        use faragent_service::diagnose::Problem;
        assert!(should_prompt_password(false, Some(Problem::NeedsPassword)));
        assert!(should_prompt_password(false, Some(Problem::PasswordDenied)));
        // Host keys and passphrases keep the interactive OpenSSH path.
        assert!(!should_prompt_password(
            false,
            Some(Problem::HostKeyUnknown)
        ));
        assert!(!should_prompt_password(false, Some(Problem::KeyPassphrase)));
        // With multiplexing, `faragent login` covers password hosts.
        assert!(!should_prompt_password(true, Some(Problem::NeedsPassword)));
        assert!(!should_prompt_password(false, None));
    }

    fn summary(cwd: Option<&str>) -> SessionSummary {
        SessionSummary {
            id: "x".into(),
            agent: "claude".into(),
            title: None,
            cwd: cwd.map(|s| s.to_string()),
            mtime: 0.0,
            live: false,
            running: false,
            tmux: None,
        }
    }

    #[test]
    fn unique_recents_skips_empty_and_dedupes() {
        let rows = unique_recents(&[
            summary(Some("/a")),
            summary(Some("")),
            summary(None),
            summary(Some(" /a ")),
            summary(Some("/b")),
        ]);
        assert_eq!(rows, vec!["/a", "/b"]);
    }

    #[test]
    fn picker_rows_are_recents_then_parent_then_children() {
        let listing = DirListing {
            cwd: "/home/me".into(),
            parent: "/home".into(),
            dirs: vec!["code".into(), "docs".into()],
        };
        let rows = picker_rows(&["/home/me/old".into()], Some(&listing));
        assert_eq!(
            rows,
            vec![
                PickerRow::Recent("/home/me/old".into()),
                PickerRow::Parent,
                PickerRow::Child("code".into()),
                PickerRow::Child("docs".into()),
            ]
        );
    }

    #[test]
    fn picker_navigation_joins_and_uses_listing_parent() {
        let listing = DirListing {
            cwd: "/home/me".into(),
            parent: "/home".into(),
            dirs: vec!["code".into()],
        };
        assert_eq!(
            navigate_picker(
                "/home/me",
                &PickerRow::Parent,
                Some(&listing),
                HostOs::Posix
            ),
            "/home"
        );
        assert_eq!(
            navigate_picker(
                "/home/me",
                &PickerRow::Child("code".into()),
                Some(&listing),
                HostOs::Posix
            ),
            "/home/me/code"
        );
        assert_eq!(
            navigate_picker(
                "/x",
                &PickerRow::Recent("/srv".into()),
                Some(&listing),
                HostOs::Posix
            ),
            "/srv"
        );
        assert_eq!(
            navigate_picker("C:\\Users\\me", &PickerRow::Parent, None, HostOs::Windows),
            "C:\\Users"
        );
    }
}
