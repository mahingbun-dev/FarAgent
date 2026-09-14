//! Wire types for the frontend. The service crates stay UI-agnostic; this
//! module is the one place that shapes their data (and their `LocalizedText`
//! wording) into JSON the webview consumes.

use faragent_core::agents::AgentKind;
use faragent_core::text::LocalizedText;
use faragent_core::vocab::{AuthMode, HostOs};
use faragent_install::{Action, Blocked, Plan, Preflight, Warning};
use faragent_remote::remote::Probe;
use faragent_service::diagnose::{self, Diagnosis};
use faragent_service::sessions::SessionError;
use faragent_transport::SshHost;
use serde::Serialize;

/// A sentence in both languages; the frontend picks by the user's setting.
#[derive(Debug, Clone, Serialize)]
pub struct Text {
    pub zh: String,
    pub en: String,
}

impl From<LocalizedText<&'static str>> for Text {
    fn from(t: LocalizedText<&'static str>) -> Self {
        Self {
            zh: t.zh.to_string(),
            en: t.en.to_string(),
        }
    }
}

impl From<LocalizedText<String>> for Text {
    fn from(t: LocalizedText<String>) -> Self {
        Self { zh: t.zh, en: t.en }
    }
}

/// A multi-line body in both languages (fix steps, screen bodies).
#[derive(Debug, Clone, Serialize)]
pub struct Lines {
    pub zh: Vec<String>,
    pub en: Vec<String>,
}

impl From<LocalizedText<Vec<String>>> for Lines {
    fn from(t: LocalizedText<Vec<String>>) -> Self {
        Self { zh: t.zh, en: t.en }
    }
}

// ---------------------------------------------------------------- hosts

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HostDto {
    pub alias: String,
    pub hostname: Option<String>,
    pub user: Option<String>,
    pub port: u16,
    pub identity: Option<String>,
    /// What the picker shows: `alias (user hostname port)`.
    pub label: String,
    pub auth: AuthMode,
    /// `  [password]` / `  [key only]` / empty, both languages.
    pub auth_tag: Text,
}

pub fn host_dto(h: &SshHost, auth: AuthMode) -> HostDto {
    HostDto {
        alias: h.alias.clone(),
        hostname: h.hostname.clone(),
        user: h.user.clone(),
        port: h.port_or_22(),
        identity: h.identity.clone(),
        label: h.label(),
        auth,
        auth_tag: faragent_transport::ssh::auth_tag(auth).into(),
    }
}

// ---------------------------------------------------------------- probe

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TmuxDto {
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProbeDto {
    pub id: String,
    pub found: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    pub auth_hint: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeDto {
    pub home: String,
    pub os: HostOs,
    pub shell: String,
    pub path: String,
    pub tmux: TmuxDto,
    pub agents: Vec<AgentProbeDto>,
}

impl From<&Probe> for ProbeDto {
    fn from(p: &Probe) -> Self {
        Self {
            home: p.home.clone(),
            os: p.os,
            shell: p.shell.clone(),
            path: p.path.clone(),
            tmux: TmuxDto {
                found: p.tmux.found,
                path: p.tmux.path.clone(),
                version: p.tmux.version.clone(),
            },
            agents: p
                .agents
                .iter()
                .map(|a| AgentProbeDto {
                    id: a.id.clone(),
                    found: a.found,
                    path: a.path.clone(),
                    version: a.version.clone(),
                    auth_hint: a.auth_hint.clone(),
                })
                .collect(),
        }
    }
}

// -------------------------------------------------------------- install

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreflightDto {
    pub os: HostOs,
    pub home: String,
    pub curl: bool,
    pub node: bool,
    pub npm: bool,
    pub nvm: bool,
    pub tmux: bool,
    pub winget: bool,
    /// Package manager slug, e.g. `apt-get` (None when none was recognized).
    pub pkg: Option<String>,
    pub agent_found: bool,
    pub agent_path: Option<String>,
    pub live_tmux: bool,
}

impl From<Preflight> for PreflightDto {
    fn from(p: Preflight) -> Self {
        Self {
            os: p.os,
            home: p.home,
            curl: p.curl,
            node: p.node,
            npm: p.npm,
            nvm: p.nvm,
            tmux: p.tmux,
            winget: p.winget,
            pkg: p.pkg.map(|m| m.slug().to_string()),
            agent_found: p.agent_found,
            agent_path: p.agent_path,
            live_tmux: p.live_tmux,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StepDto {
    pub title: String,
    pub command: String,
    pub sudo: bool,
}

/// Everything the confirm screen renders. The wording fields are the same
/// `LocalizedText` the TUI shows — one source of truth for both UIs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanDto {
    pub action: Action,
    pub agent: AgentKind,
    /// The exact script Enter runs on the remote; handed back to
    /// `attach_open` when the user confirms. Empty for blocked plans.
    pub script: String,
    pub steps: Vec<StepDto>,
    pub blocked: Option<Blocked>,
    pub warnings: Vec<Warning>,
    pub suggested: Vec<String>,
    pub can_run: bool,
    pub title: Text,
    pub list_title: Text,
    pub blocked_text: Option<Text>,
    pub warning_texts: Vec<Text>,
    pub step_sudo: Text,
    pub suggested_title: Text,
}

impl PlanDto {
    pub fn new(plan: &Plan, host: &str) -> Self {
        Self {
            action: plan.action,
            agent: plan.agent,
            script: plan.script.clone(),
            steps: plan
                .steps
                .iter()
                .map(|s| StepDto {
                    title: s.title.clone(),
                    command: s.command.clone(),
                    sudo: s.sudo,
                })
                .collect(),
            blocked: plan.blocked,
            warnings: plan.warnings.clone(),
            suggested: plan.suggested.clone(),
            can_run: plan.can_run(),
            title: faragent_install::confirm_title(plan.action, host, plan.agent.title()).into(),
            list_title: faragent_install::confirm_list_title().into(),
            blocked_text: plan.blocked.map(|b| faragent_install::blocked(b).into()),
            warning_texts: plan
                .warnings
                .iter()
                .map(|w| faragent_install::warning(*w).into())
                .collect(),
            step_sudo: faragent_install::step_sudo().into(),
            suggested_title: faragent_install::suggested_title().into(),
        }
    }
}

// ------------------------------------------------------------- diagnosis

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisLabels {
    pub label: Text,
    pub raw: Text,
    pub command: Text,
    pub fixes: Text,
    pub docs: Text,
    pub ssh_doc: Text,
}

/// The error screen's full payload: structured fields for rendering plus the
/// ready-made plain report (both languages) for "copy report".
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosisDto {
    /// Machine-readable cause, e.g. `publickey_denied`.
    pub problem: String,
    pub summary: Text,
    pub steps: Lines,
    pub raw: String,
    pub command: String,
    pub needs_auth: bool,
    pub timed_out: bool,
    pub title: Text,
    pub list_title: Text,
    pub labels: DiagnosisLabels,
    pub plain_zh: String,
    pub plain_en: String,
}

impl DiagnosisDto {
    pub fn new(d: Diagnosis, host: &str) -> Self {
        Self {
            problem: d.problem.slug().to_string(),
            summary: d.summary.into(),
            steps: d.steps.clone().into(),
            raw: d.raw.clone(),
            command: d.command.clone(),
            needs_auth: d.needs_auth,
            timed_out: d.timed_out,
            title: diagnose::title(host).into(),
            list_title: diagnose::list_title(d.problem.slug()).into(),
            labels: DiagnosisLabels {
                label: diagnose::label().into(),
                raw: diagnose::raw_label().into(),
                command: diagnose::command_label().into(),
                fixes: diagnose::fixes_label().into(),
                docs: diagnose::docs_label().into(),
                ssh_doc: diagnose::ssh_doc().into(),
            },
            plain_zh: d.plain(faragent_core::text::Lang::Zh),
            plain_en: d.plain(faragent_core::text::Lang::En),
        }
    }
}

/// Every command's error shape. `diagnosis` opens the full report screen
/// (same gate as the TUI: only connection problems get one).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CommandError {
    Diagnosis { diagnosis: Box<DiagnosisDto> },
    Plain { message: String },
}

pub fn shape_error(err: &anyhow::Error, host: &str) -> CommandError {
    match diagnose::diagnosis_of(err, host) {
        Some(d) => CommandError::Diagnosis {
            diagnosis: Box::new(DiagnosisDto::new(d, host)),
        },
        None => CommandError::Plain {
            message: format!("{err:#}"),
        },
    }
}

/// Starting a session can also mean "the working directory is missing" — a
/// question, not an error (same as the TUI's create-directory screen).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum StartError {
    CwdMissing { dir: String },
    Diagnosis { diagnosis: Box<DiagnosisDto> },
    Plain { message: String },
}

pub fn shape_start_error(err: &anyhow::Error, host: &str) -> StartError {
    if let Some(SessionError::CwdMissing { dir }) = err.downcast_ref::<SessionError>() {
        return StartError::CwdMissing { dir: dir.clone() };
    }
    match shape_error(err, host) {
        CommandError::Diagnosis { diagnosis } => StartError::Diagnosis { diagnosis },
        CommandError::Plain { message } => StartError::Plain { message },
    }
}
