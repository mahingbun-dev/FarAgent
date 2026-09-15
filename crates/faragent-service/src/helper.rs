//! Getting the `faragent-helper` binary onto a remote host — or deciding,
//! loudly, that it cannot be used.
//!
//! The native helper is an optional accelerator. Everything FarAgent does
//! today (probe, session list, install) works without it, so **no failure in
//! this module is an error**: every dead end resolves to a
//! [`HelperMode::ScriptFallback`] carrying the reason, and the caller renders
//! that to the user. Silence is the one forbidden outcome.
//!
//! # Shape of the flow
//!
//! ```text
//!   probe remote  ──►  plan  ──►  reuse   ─┐
//!        │              │                ├──► HelperMode
//!        │              └──►  upload ──► verify ─┘
//!        └──► fallback (unsupported platform, no artifact, no checksum tool)
//! ```
//!
//! The remote half is behind [`HelperHost`] so the decision logic runs against
//! a scripted fake in tests: every branch below is exercised without a host.
//!
//! # Boundaries
//!
//! * The POSIX channel only. A Windows remote takes the script fallback; the
//!   artifact table still names `windows-x86_64` because CI produces it, but
//!   delivery there is not this module's job.
//! * The helper binary travels over **stdin** ([`exec_login_stdin_timeout`]),
//!   never interpolated into a shell command string.
//! * Nothing here speaks the helper's NDJSON protocol — that is the caller's.
//! * No writes outside `$HOME/.faragent/bin`.
//!
//! [`exec_login_stdin_timeout`]: faragent_transport::OpenSshTransport::exec_login_stdin_timeout

use anyhow::Result;
use faragent_core::text::LocalizedText;
use faragent_core::vocab::HostOs;
use faragent_transport::OpenSshTransport;
use sha2::{Digest, Sha256};
use std::path::Path;
use std::time::Duration;

// ---------------------------------------------------------------------------
// Fixed remote locations
// ---------------------------------------------------------------------------

/// Directory the helper is installed into, written the way a remote shell
/// expands it. `$HOME`, not `~`, because the string goes into `bash -lc`.
pub const REMOTE_HELPER_DIR: &str = "$HOME/.faragent/bin";

/// File name of the helper on a POSIX remote.
pub const REMOTE_HELPER_BIN: &str = "faragent-helper";

/// Full remote path of the helper. Never written to `PATH`, never a service,
/// never a registry key.
pub const REMOTE_HELPER_PATH: &str = "$HOME/.faragent/bin/faragent-helper";

// ---------------------------------------------------------------------------
// Artifact table (pinned — mirrors scripts/build-helper.sh exactly)
// ---------------------------------------------------------------------------

pub const PLATFORM_LINUX_X86_64: &str = "linux-x86_64";
pub const PLATFORM_LINUX_AARCH64: &str = "linux-aarch64";
pub const PLATFORM_DARWIN_ARM64: &str = "darwin-arm64";
pub const PLATFORM_DARWIN_X86_64: &str = "darwin-x86_64";
pub const PLATFORM_WINDOWS_X86_64: &str = "windows-x86_64";

/// The artifact table from the task brief: a remote's `uname -s -m` to the
/// directory name holding its binary. `None` means *no build exists for this
/// remote*, which is a fallback, not a bug.
///
/// Acceptance is deliberately generous about the spellings a remote reports
/// (`amd64`/`x86_64`/`x64`, `arm64`/`aarch64`) but strict about the platform:
/// an unknown OS or an architecture we never build for maps to `None`.
pub fn platform_dir(os: &str, arch: &str) -> Option<&'static str> {
    let os = os.trim().to_ascii_lowercase();
    let arch = arch.trim().to_ascii_lowercase();

    let os = if os == "linux" {
        "linux"
    } else if os == "darwin" || os == "macos" || os == "mac os x" {
        "darwin"
    } else if os == "windows"
        || os.starts_with("mingw")
        || os.starts_with("msys")
        || os.starts_with("cygwin")
    {
        "windows"
    } else {
        return None;
    };

    let arch = if arch == "x86_64" || arch == "amd64" || arch == "x64" {
        "x86_64"
    } else if arch == "aarch64" || arch == "arm64" {
        "aarch64"
    } else {
        return None;
    };

    match (os, arch) {
        ("linux", "x86_64") => Some(PLATFORM_LINUX_X86_64),
        ("linux", "aarch64") => Some(PLATFORM_LINUX_AARCH64),
        ("darwin", "aarch64") => Some(PLATFORM_DARWIN_ARM64),
        ("darwin", "x86_64") => Some(PLATFORM_DARWIN_X86_64),
        ("windows", "x86_64") => Some(PLATFORM_WINDOWS_X86_64),
        _ => None,
    }
}

/// The file name a platform's binary is built as.
pub fn bin_name_for(platform: &str) -> Option<&'static str> {
    match platform {
        PLATFORM_LINUX_X86_64
        | PLATFORM_LINUX_AARCH64
        | PLATFORM_DARWIN_ARM64
        | PLATFORM_DARWIN_X86_64 => Some("faragent-helper"),
        PLATFORM_WINDOWS_X86_64 => Some("faragent-helper.exe"),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Local artifacts
// ---------------------------------------------------------------------------

/// SHA-256 of `bytes`, lowercase hex. This is the identity of the artifact:
/// the helper's own `ping` reports a version string, which is not proof of
/// content and must never stand in for this.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for byte in digest {
        use std::fmt::Write;
        let _ = write!(out, "{byte:02x}");
    }
    out
}

/// A built helper binary, read from the bundled resources.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalArtifact {
    /// Directory name from the pinned table, e.g. `linux-x86_64`.
    pub platform: String,
    pub file_name: String,
    pub bytes: Vec<u8>,
    /// Lowercase hex SHA-256 of `bytes`.
    pub sha256: String,
}

impl LocalArtifact {
    pub fn new(platform: &str, bytes: Vec<u8>) -> Self {
        let sha256 = sha256_hex(&bytes);
        Self {
            file_name: bin_name_for(platform)
                .unwrap_or("faragent-helper")
                .to_string(),
            platform: platform.to_string(),
            bytes,
            sha256,
        }
    }
}

/// Read the binary for `platform` out of a Tauri resource root
/// (`.../resources/helper/<platform>/faragent-helper`).
///
/// `None` covers both "this build produced no such artifact" and "the file is
/// unreadable" — in both cases there is nothing to upload.
pub fn load_local_artifact(resource_root: &Path, platform: &str) -> Option<LocalArtifact> {
    let name = bin_name_for(platform)?;
    let path = resource_root.join("helper").join(platform).join(name);
    let bytes = std::fs::read(&path).ok()?;
    Some(LocalArtifact::new(platform, bytes))
}

/// The artifact for a probed remote, if this build ships one.
pub fn artifact_for(probe: &RemoteProbe, resource_root: &Path) -> Option<LocalArtifact> {
    let platform = platform_dir(&probe.os, &probe.arch)?;
    load_local_artifact(resource_root, platform)
}

// ---------------------------------------------------------------------------
// What the remote told us
// ---------------------------------------------------------------------------

/// Which checksum program the remote has. `sha256sum` (coreutils) is preferred,
/// `shasum -a 256` (Perl) is the macOS/BSD fallback.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HashTool {
    Sha256Sum,
    Shasum,
}

impl HashTool {
    /// The name as it appears in the probe's `tool=` field.
    pub fn wire_name(self) -> &'static str {
        match self {
            HashTool::Sha256Sum => "sha256sum",
            HashTool::Shasum => "shasum",
        }
    }
}

/// One probe of the remote: platform, whether the helper is already there, and
/// which checksum tool could read it.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RemoteProbe {
    /// Raw `uname -s` (e.g. `Linux`). Empty when the probe produced nothing.
    pub os: String,
    /// Raw `uname -m` (e.g. `x86_64`). Empty when the probe produced nothing.
    pub arch: String,
    /// `None` when the remote has neither `sha256sum` nor `shasum`.
    pub tool: Option<HashTool>,
    /// Is there a file at [`REMOTE_HELPER_PATH`]?
    pub present: bool,
    /// Lowercase hex digest read off the remote; empty when the file is absent
    /// or no tool was available.
    pub digest: String,
}

impl RemoteProbe {
    /// Did the probe actually reach a POSIX shell and report anything?
    pub fn usable(&self) -> bool {
        !self.os.is_empty() && !self.arch.is_empty()
    }

    /// The artifact directory this remote needs, if we have one.
    pub fn platform(&self) -> Option<&'static str> {
        platform_dir(&self.os, &self.arch)
    }
}

/// Marker prefix every probe line carries.
const PROBE_MARKER: &str = "FARAGENT_HELPER_PROBE";
/// Marker the post-upload execution check prints.
const EXEC_MARKER: &str = "FARAGENT_HELPER_EXEC";

/// Parse [`probe_script`]'s output. Unknown lines (a login banner, a shell
/// greeting) are ignored, exactly like the framed protocol does.
pub fn parse_probe(text: &str) -> RemoteProbe {
    let mut probe = RemoteProbe::default();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix(PROBE_MARKER) else {
            continue;
        };
        let rest = rest.trim();
        let Some((key, value)) = rest.split_once('=') else {
            continue;
        };
        let value = value.trim();
        match key.trim() {
            "os" => probe.os = value.to_string(),
            "arch" => probe.arch = value.to_string(),
            "present" => probe.present = value == "1",
            "tool" => {
                probe.tool = match value {
                    "sha256sum" => Some(HashTool::Sha256Sum),
                    "shasum" => Some(HashTool::Shasum),
                    _ => None,
                }
            }
            "digest" => probe.digest = value.to_ascii_lowercase(),
            _ => {}
        }
    }
    probe
}

/// Parse the exit code [`verify_script`] reports for running the helper.
/// `None` when the marker never appeared (the run died before it got there).
pub fn parse_exec_code(text: &str) -> Option<i32> {
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix(EXEC_MARKER) else {
            continue;
        };
        let value = rest.trim().strip_prefix("code=")?;
        return value.trim().parse().ok();
    }
    None
}

/// Does the remote digest equal the local one?
///
/// Case-insensitive and whitespace-tolerant: `sha256sum` and `shasum` both
/// print lowercase, but a hex digest is a hex digest and folding the case
/// costs nothing.
pub fn hashes_match(local_hex: &str, remote_hex: &str) -> bool {
    let local = local_hex.trim();
    let remote = remote_hex.trim();
    !local.is_empty() && local.eq_ignore_ascii_case(remote)
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/// Why the native helper is not in use. Carried by [`HelperMode`] so a UI can
/// say *which* dead end was hit instead of a bare "fallback".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FallbackReason {
    /// The remote's `uname -s -m` has no build in the artifact table.
    UnsupportedPlatform { os: String, arch: String },
    /// The remote's platform is known but this build ships no binary for it.
    NoLocalArtifact { platform: String },
    /// No `sha256sum` and no `shasum`: the transfer cannot be verified, so it
    /// is not attempted.
    NoChecksumTool { os: String },
    /// The probe itself failed — no POSIX login shell, host down, timeout.
    ProbeFailed { detail: String },
    /// A Windows remote: the helper channel here is POSIX-only.
    WindowsRemote,
    /// Writing to `~/.faragent/bin` failed (unwritable home, noexec, ...).
    UploadFailed { detail: String },
    /// The bytes arrived but do not hash to the local digest.
    VerifyFailed { detail: String },
    /// The file is present but cannot be executed (`noexec` mount, wrong
    /// architecture, corrupt).
    NotExecutable { code: Option<i32> },
}

impl FallbackReason {
    /// User-facing wording for the downgrade. Chinese and English both, so the
    /// TUI and the app render the same sentence.
    pub fn message(&self) -> LocalizedText<String> {
        match self {
            FallbackReason::UnsupportedPlatform { os, arch } => LocalizedText::new(
                format!("远端平台 {os}/{arch} 没有对应的 helper 构建，改用脚本模式。"),
                format!("no helper build for remote platform {os}/{arch}; using the script mode."),
            ),
            FallbackReason::NoLocalArtifact { platform } => LocalizedText::new(
                format!("本次构建未包含 {platform} 的 helper 产物，改用脚本模式。"),
                format!("this build ships no helper artifact for {platform}; using the script mode."),
            ),
            FallbackReason::NoChecksumTool { os } => LocalizedText::new(
                format!("远端（{os}）缺少 sha256sum / shasum，无法校验上传，改用脚本模式。"),
                format!("the remote ({os}) has neither sha256sum nor shasum, so the upload cannot be verified; using the script mode."),
            ),
            FallbackReason::ProbeFailed { detail } => LocalizedText::new(
                format!("探测远端失败（{detail}），改用脚本模式。"),
                format!("could not probe the remote ({detail}); using the script mode."),
            ),
            // Not a downgrade: `helper_open` refuses a Windows remote outright
            // (see `posix_only`), so a sentence promising the script fallback
            // would describe a mode the caller never gets. The wording says
            // what actually happens instead.
            FallbackReason::WindowsRemote => LocalizedText::new(
                "远程是 Windows：helper 通道仅支持 POSIX，无法在这些远端打开 helper 会话。".to_string(),
                "the remote is Windows: the helper channel is POSIX-only, so no helper session can be opened on it."
                    .to_string(),
            ),
            FallbackReason::UploadFailed { detail } => LocalizedText::new(
                format!("上传 helper 失败（{detail}），改用脚本模式。"),
                format!("the helper upload failed ({detail}); using the script mode."),
            ),
            FallbackReason::VerifyFailed { detail } => LocalizedText::new(
                format!("远端 helper 校验不一致（{detail}），改用脚本模式。"),
                format!("the remote helper failed verification ({detail}); using the script mode."),
            ),
            FallbackReason::NotExecutable { code } => LocalizedText::new(
                format!(
                    "远端 helper 无法执行（退出码 {}）：可能是 noexec 挂载点或架构不符，改用脚本模式。",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "无".into())
                ),
                format!(
                    "the remote helper cannot be executed (exit {}): likely a noexec mount or a wrong architecture; using the script mode.",
                    code.map(|c| c.to_string()).unwrap_or_else(|| "none".into())
                ),
            ),
        }
    }

    /// Short machine-ish tag, for logs and tests.
    pub fn code(&self) -> &'static str {
        match self {
            FallbackReason::UnsupportedPlatform { .. } => "unsupported_platform",
            FallbackReason::NoLocalArtifact { .. } => "no_local_artifact",
            FallbackReason::NoChecksumTool { .. } => "no_checksum_tool",
            FallbackReason::ProbeFailed { .. } => "probe_failed",
            FallbackReason::WindowsRemote => "windows_remote",
            FallbackReason::UploadFailed { .. } => "upload_failed",
            FallbackReason::VerifyFailed { .. } => "verify_failed",
            FallbackReason::NotExecutable { .. } => "not_executable",
        }
    }
}

/// How the caller should talk to this remote.
///
/// The distinction is the whole point of this module: a UI that cannot tell
/// these apart would be degrading silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HelperMode {
    /// Verified native helper in place at [`REMOTE_HELPER_PATH`].
    Native,
    /// No usable native helper — the caller must use the bash fallback channel,
    /// and should tell the user why.
    ScriptFallback(FallbackReason),
}

impl HelperMode {
    pub fn is_native(&self) -> bool {
        matches!(self, HelperMode::Native)
    }

    /// Why we fell back, if we did.
    pub fn fallback_reason(&self) -> Option<&FallbackReason> {
        match self {
            HelperMode::Native => None,
            HelperMode::ScriptFallback(reason) => Some(reason),
        }
    }

    /// One-line status for the UI.
    pub fn message(&self) -> LocalizedText<String> {
        match self {
            HelperMode::Native => LocalizedText::new(
                "原生 helper 已就绪。".to_string(),
                "the native helper is ready.".to_string(),
            ),
            HelperMode::ScriptFallback(reason) => reason.message(),
        }
    }
}

/// What to do about a probed remote, given (maybe) a local artifact.
///
/// Pure: no I/O, no ssh. This is the decision table the whole module exists to
/// make legible.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Plan {
    /// The remote already holds exactly these bytes.
    Reuse,
    /// Send the bytes.
    Upload,
    /// Give up on the native helper.
    Fallback(FallbackReason),
}

/// Decide, in order:
///
/// | condition                                   | plan     |
/// |---------------------------------------------|----------|
/// | `uname -s -m` maps to no artifact directory | fallback |
/// | no local artifact for the mapped platform   | fallback |
/// | remote has no checksum tool                 | fallback |
/// | file present and digest matches             | reuse    |
/// | otherwise                                   | upload   |
pub fn plan(probe: &RemoteProbe, local: Option<&LocalArtifact>) -> Plan {
    let Some(platform) = probe.platform() else {
        return Plan::Fallback(FallbackReason::UnsupportedPlatform {
            os: probe.os.clone(),
            arch: probe.arch.clone(),
        });
    };
    let Some(local) = local.filter(|a| a.platform == platform) else {
        return Plan::Fallback(FallbackReason::NoLocalArtifact {
            platform: platform.to_string(),
        });
    };
    if probe.tool.is_none() {
        return Plan::Fallback(FallbackReason::NoChecksumTool {
            os: probe.os.clone(),
        });
    }
    if probe.present && hashes_match(&local.sha256, &probe.digest) {
        return Plan::Reuse;
    }
    Plan::Upload
}

// ---------------------------------------------------------------------------
// The remote half (seam for tests)
// ---------------------------------------------------------------------------

/// What a post-upload verification found.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifyReport {
    /// A fresh probe: the digest now on the remote.
    pub probe: RemoteProbe,
    /// Exit code of running the installed binary with stdin at EOF.
    /// `None` when the marker never appeared.
    pub exec_code: Option<i32>,
}

impl VerifyReport {
    /// The binary runs: the exit code is a clean 0, not `126` (not executable,
    /// i.e. `noexec`) and not a signal.
    pub fn executable(&self) -> bool {
        self.exec_code == Some(0)
    }
}

/// The three remote operations the install flow needs, so the flow itself can
/// be driven by a scripted fake with no host in sight.
pub trait HelperHost {
    /// One round trip: platform, presence, and digest of the installed helper.
    fn probe(&self) -> Result<RemoteProbe>;
    /// Write `bytes` to [`REMOTE_HELPER_PATH`], atomically.
    fn upload(&self, bytes: &[u8]) -> Result<()>;
    /// After an upload: re-read the digest and confirm the binary executes.
    fn verify(&self) -> Result<VerifyReport>;
}

/// The real [`HelperHost`]: system OpenSSH, login shell, stdin payload.
pub struct SshHelperHost<'a> {
    client: &'a OpenSshTransport,
    upload_timeout: Duration,
}

impl<'a> SshHelperHost<'a> {
    pub fn new(client: &'a OpenSshTransport) -> Self {
        Self {
            client,
            upload_timeout: UPLOAD_TIMEOUT,
        }
    }

    /// Override the upload deadline (tests, or a user on a very slow link).
    pub fn with_upload_timeout(mut self, timeout: Duration) -> Self {
        self.upload_timeout = timeout;
        self
    }
}

impl HelperHost for SshHelperHost<'_> {
    fn probe(&self) -> Result<RemoteProbe> {
        let out = self.client.exec_login(&probe_script())?;
        Ok(parse_probe(&out.text()))
    }

    fn upload(&self, bytes: &[u8]) -> Result<()> {
        // The bytes ride stdin; the script carries only the expected digest.
        let script = upload_script(&sha256_hex(bytes));
        let out = self
            .client
            .exec_login_stdin_timeout(&script, bytes, self.upload_timeout)?;
        if !out.success() {
            return Err(anyhow::anyhow!(
                "{}",
                upload_failure_detail(out.code, &out.text())
            ));
        }
        Ok(())
    }

    fn verify(&self) -> Result<VerifyReport> {
        let out = self.client.exec_login(&verify_script())?;
        let text = out.text();
        Ok(VerifyReport {
            probe: parse_probe(&text),
            exec_code: parse_exec_code(&text),
        })
    }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/// Run the whole flow: probe, plan, upload, verify — and never return an
/// error, because every dead end is a legitimate fallback.
///
/// `local_for` resolves the artifact for the probed remote; in production it
/// wraps [`artifact_for`] over the Tauri resource root, in tests it returns a
/// canned artifact (or nothing).
pub fn install_helper(
    host: &dyn HelperHost,
    local_for: &dyn Fn(&RemoteProbe) -> Option<LocalArtifact>,
) -> HelperMode {
    let probe = match host.probe() {
        Ok(probe) => probe,
        Err(error) => {
            return HelperMode::ScriptFallback(FallbackReason::ProbeFailed {
                detail: error.to_string(),
            })
        }
    };

    let local = local_for(&probe);

    let artifact = match plan(&probe, local.as_ref()) {
        Plan::Reuse => return HelperMode::Native,
        Plan::Fallback(reason) => return HelperMode::ScriptFallback(reason),
        Plan::Upload => match local {
            Some(artifact) => artifact,
            // `plan` only returns `Upload` with an artifact in hand.
            None => {
                return HelperMode::ScriptFallback(FallbackReason::NoLocalArtifact {
                    platform: probe.platform().unwrap_or("unknown").to_string(),
                })
            }
        },
    };

    if let Err(error) = host.upload(&artifact.bytes) {
        return HelperMode::ScriptFallback(FallbackReason::UploadFailed {
            detail: error.to_string(),
        });
    }

    match host.verify() {
        Err(error) => HelperMode::ScriptFallback(FallbackReason::UploadFailed {
            detail: format!("post-upload verification could not run: {error}"),
        }),
        Ok(report) => {
            if !hashes_match(&artifact.sha256, &report.probe.digest) {
                return HelperMode::ScriptFallback(FallbackReason::VerifyFailed {
                    detail: format!(
                        "expected {}, remote reports {}",
                        artifact.sha256,
                        if report.probe.digest.is_empty() {
                            "(nothing)".to_string()
                        } else {
                            report.probe.digest.clone()
                        }
                    ),
                });
            }
            if !report.executable() {
                return HelperMode::ScriptFallback(FallbackReason::NotExecutable {
                    code: report.exec_code,
                });
            }
            HelperMode::Native
        }
    }
}

/// Production entry point: connect is the caller's job, `os` comes from the
/// probe result the caller already has.
///
/// A Windows remote is refused before any ssh round trip: the upload channel
/// is `bash -lc`, which a Windows remote does not have.
pub fn ensure_helper(
    client: &OpenSshTransport,
    os: HostOs,
    resource_root: Option<&Path>,
) -> HelperMode {
    if let Some(unsupported) = posix_only(os) {
        return unsupported;
    }
    let host = SshHelperHost::new(client);
    let resolve = |probe: &RemoteProbe| resource_root.and_then(|root| artifact_for(probe, root));
    install_helper(&host, &resolve)
}

/// The part of [`ensure_helper`] that needs no connection at all: which hosts
/// this module refuses outright. Split out so it is testable without a
/// transport (the app crate's transports are not constructible from here).
fn posix_only(os: HostOs) -> Option<HelperMode> {
    match os {
        HostOs::Windows => Some(HelperMode::ScriptFallback(FallbackReason::WindowsRemote)),
        HostOs::Posix => None,
    }
}

// ---------------------------------------------------------------------------
// Remote scripts
// ---------------------------------------------------------------------------

/// Uploading a few megabytes over a slow link can blow far past the
/// transport's 25-second default, so the upload path gets its own deadline.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// The shared "which tool, and what digest" block, used by both the probe and
/// the post-upload check so the two can never disagree about the tool.
const HASH_BLOCK: &str = r#"if command -v sha256sum >/dev/null 2>&1; then
  printf 'FARAGENT_HELPER_PROBE tool=sha256sum\n'
  printf 'FARAGENT_HELPER_PROBE digest=%s\n' "$(sha256sum "$p" 2>/dev/null | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  printf 'FARAGENT_HELPER_PROBE tool=shasum\n'
  printf 'FARAGENT_HELPER_PROBE digest=%s\n' "$(shasum -a 256 "$p" 2>/dev/null | cut -d' ' -f1)"
else
  printf 'FARAGENT_HELPER_PROBE tool=none\n'
  printf 'FARAGENT_HELPER_PROBE digest=\n'
fi"#;

/// Read-only: platform, presence, digest. Writes nothing, anywhere.
///
/// One `key=value` per line: the parser splits on the first `=` and takes the
/// rest as the value, so two fields on one line would be read as one.
pub fn probe_script() -> String {
    format!(
        r#"p="{path}"
printf 'FARAGENT_HELPER_PROBE os=%s\n' "$(uname -s)"
printf 'FARAGENT_HELPER_PROBE arch=%s\n' "$(uname -m)"
if [ -f "$p" ]; then
  printf 'FARAGENT_HELPER_PROBE present=1\n'
else
  printf 'FARAGENT_HELPER_PROBE present=0\n'
fi
{hash}
exit 0"#,
        path = REMOTE_HELPER_PATH,
        hash = HASH_BLOCK,
    )
}

/// Post-upload: re-read the digest and prove the binary actually runs.
///
/// The execution check is how a `noexec` mount is caught: the file is there and
/// hashes right, but running it exits `126`. The helper treats stdin-at-EOF as
/// an orderly shutdown, so feeding it `/dev/null` is a side-effect-free probe
/// that says nothing on the NDJSON channel — no protocol client needed.
pub fn verify_script() -> String {
    format!(
        r#"p="{path}"
printf 'FARAGENT_HELPER_PROBE os=%s\n' "$(uname -s)"
printf 'FARAGENT_HELPER_PROBE arch=%s\n' "$(uname -m)"
if [ -f "$p" ]; then
  printf 'FARAGENT_HELPER_PROBE present=1\n'
else
  printf 'FARAGENT_HELPER_PROBE present=0\n'
fi
{hash}
if [ -x "$p" ]; then
  "$p" </dev/null >/dev/null 2>&1
  printf 'FARAGENT_HELPER_EXEC code=%s\n' "$?"
else
  printf 'FARAGENT_HELPER_EXEC code=126\n'
fi
exit 0"#,
        path = REMOTE_HELPER_PATH,
        hash = HASH_BLOCK,
    )
}

/// Upload script. `expected` is the local digest of exactly the bytes being
/// piped in.
///
/// The write is **temp file, verify, then rename**: a truncated or corrupted
/// transfer never reaches the deterministic path, so a half-written binary
/// cannot be mistaken for a working one. The exit codes are distinct so the
/// caller's fallback reason can name the real failure.
pub fn upload_script(expected_sha256: &str) -> String {
    format!(
        r#"expected={expected}
dir="{dir}"
p="$dir/{bin}"
mkdir -p "$dir" || exit 3
tmp="$dir/.faragent-helper.incoming.$$"
cat > "$tmp" || {{ rm -f "$tmp"; exit 4; }}
got=""
if command -v sha256sum >/dev/null 2>&1; then
  got="$(sha256sum "$tmp" | cut -d' ' -f1)"
elif command -v shasum >/dev/null 2>&1; then
  got="$(shasum -a 256 "$tmp" | cut -d' ' -f1)"
else
  rm -f "$tmp"
  exit 7
fi
if [ "$got" != "$expected" ]; then
  rm -f "$tmp"
  exit 8
fi
chmod +x "$tmp" || {{ rm -f "$tmp"; exit 5; }}
mv -f "$tmp" "$p" || {{ rm -f "$tmp"; exit 6; }}
printf 'FARAGENT_HELPER_UPLOAD ok\n'
exit 0"#,
        expected = expected_sha256,
        dir = REMOTE_HELPER_DIR,
        bin = REMOTE_HELPER_BIN,
    )
}

/// Turn the upload script's exit code into something a human can act on.
fn upload_failure_detail(code: Option<i32>, output: &str) -> String {
    let what = match code {
        Some(3) => "could not create ~/.faragent/bin (home not writable)".to_string(),
        Some(4) => "the remote could not read the upload stream".to_string(),
        Some(5) => "chmod +x failed on the temporary file".to_string(),
        Some(6) => "could not rename the temporary file into place".to_string(),
        Some(7) => "the remote has no checksum tool after all".to_string(),
        Some(8) => "checksum mismatch: the transfer was truncated or corrupted".to_string(),
        Some(other) => format!("upload script exited {other}"),
        None => "the upload script was killed before it finished".to_string(),
    };
    let tail = output.trim();
    if tail.is_empty() {
        what
    } else {
        format!("{what}: {tail}")
    }
}

// ---------------------------------------------------------------------------
// Tests
//
// Everything below runs with **no host and no ssh**: the pure logic is tested
// directly, the orchestration is driven through a scripted `HelperHost`, and
// the remote scripts are executed against a scratch `$HOME` with the real
// `bash` on this machine.
//
// What is *not* covered here, and needs a real POSIX remote:
//   * `ssh` actually delivering the payload — only the transport's own test
//     fakes `ssh`; the real multiplexed connection is never opened.
//   * a genuine `noexec` mount, a genuinely unwritable `$HOME`, and a remote
//     whose `sha256sum`/`shasum` is missing.
//   * a login shell that emits a banner (the parser ignores unknown lines, but
//     only a real `bash -lc` proves it).
//   * `$HOME` expansion on the remote: the scripts are POSIX, but the actual
//     expansion is the remote shell's business.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use pretty_assertions::assert_eq;
    use std::cell::RefCell;

    // -- a scripted remote -------------------------------------------------

    #[derive(Default)]
    struct FakeHost {
        probe_result: Option<RemoteProbe>,
        probe_error: Option<String>,
        verify_result: Option<VerifyReport>,
        verify_error: Option<String>,
        upload_error: Option<String>,
        uploads: RefCell<Vec<Vec<u8>>>,
        calls: RefCell<Vec<&'static str>>,
    }

    impl HelperHost for FakeHost {
        fn probe(&self) -> Result<RemoteProbe> {
            self.calls.borrow_mut().push("probe");
            match (&self.probe_result, &self.probe_error) {
                (_, Some(e)) => Err(anyhow::anyhow!("{e}")),
                (Some(p), None) => Ok(p.clone()),
                (None, None) => Ok(RemoteProbe::default()),
            }
        }

        fn upload(&self, bytes: &[u8]) -> Result<()> {
            self.calls.borrow_mut().push("upload");
            self.uploads.borrow_mut().push(bytes.to_vec());
            match &self.upload_error {
                Some(e) => Err(anyhow::anyhow!("{e}")),
                None => Ok(()),
            }
        }

        fn verify(&self) -> Result<VerifyReport> {
            self.calls.borrow_mut().push("verify");
            match (&self.verify_result, &self.verify_error) {
                (_, Some(e)) => Err(anyhow::anyhow!("{e}")),
                (Some(r), None) => Ok(r.clone()),
                (None, None) => Ok(VerifyReport {
                    probe: RemoteProbe::default(),
                    exec_code: Some(0),
                }),
            }
        }
    }

    fn linux_probe(digest: &str, present: bool, tool: Option<HashTool>) -> RemoteProbe {
        RemoteProbe {
            os: "Linux".into(),
            arch: "x86_64".into(),
            tool,
            present,
            digest: digest.into(),
        }
    }

    fn linux_artifact(bytes: &[u8]) -> LocalArtifact {
        LocalArtifact::new(PLATFORM_LINUX_X86_64, bytes.to_vec())
    }

    /// A local artifact always, resolved from whatever platform was probed.
    fn any_local(bytes: Vec<u8>) -> impl Fn(&RemoteProbe) -> Option<LocalArtifact> {
        let sha = sha256_hex(&bytes);
        move |probe: &RemoteProbe| {
            probe.platform().map(|platform| LocalArtifact {
                platform: platform.to_string(),
                file_name: bin_name_for(platform)
                    .unwrap_or("faragent-helper")
                    .to_string(),
                bytes: bytes.clone(),
                sha256: sha.clone(),
            })
        }
    }

    // -- artifact table ----------------------------------------------------

    #[test]
    fn artifact_table_is_the_pinned_one() {
        // The brief pins these names; a rename silently breaks the build
        // script, the Tauri resource tree and this module at once.
        assert_eq!(platform_dir("Linux", "x86_64"), Some(PLATFORM_LINUX_X86_64));
        assert_eq!(
            platform_dir("Linux", "aarch64"),
            Some(PLATFORM_LINUX_AARCH64)
        );
        assert_eq!(platform_dir("Linux", "arm64"), Some(PLATFORM_LINUX_AARCH64));
        assert_eq!(platform_dir("Darwin", "arm64"), Some(PLATFORM_DARWIN_ARM64));
        assert_eq!(
            platform_dir("Darwin", "x86_64"),
            Some(PLATFORM_DARWIN_X86_64)
        );
        assert_eq!(
            platform_dir("Windows", "x86_64"),
            Some(PLATFORM_WINDOWS_X86_64)
        );
        assert_eq!(PLATFORM_LINUX_X86_64, "linux-x86_64");
        assert_eq!(PLATFORM_LINUX_AARCH64, "linux-aarch64");
        assert_eq!(PLATFORM_DARWIN_ARM64, "darwin-arm64");
        assert_eq!(PLATFORM_DARWIN_X86_64, "darwin-x86_64");
        assert_eq!(PLATFORM_WINDOWS_X86_64, "windows-x86_64");
    }

    #[test]
    fn platform_dir_accepts_every_spelling_a_remote_reports() {
        for arch in ["x86_64", "amd64", "AMD64", "x64", " X86_64 "] {
            assert_eq!(
                platform_dir("linux", arch),
                Some(PLATFORM_LINUX_X86_64),
                "{arch}"
            );
        }
        for os in ["Darwin", "darwin", "macOS", " Mac OS X ", "MACOS"] {
            assert_eq!(
                platform_dir(os, "arm64"),
                Some(PLATFORM_DARWIN_ARM64),
                "{os}"
            );
        }
        for os in [
            "MINGW64_NT-10.0",
            "MSYS_NT-10.0",
            "CYGWIN_NT-10.0",
            "Windows",
        ] {
            assert_eq!(
                platform_dir(os, "x86_64"),
                Some(PLATFORM_WINDOWS_X86_64),
                "{os}"
            );
        }
    }

    #[test]
    fn platform_dir_has_no_answer_for_the_unmappable() {
        // The whole point of `Option`: these must fall back, not guess.
        assert_eq!(platform_dir("FreeBSD", "x86_64"), None);
        assert_eq!(platform_dir("SunOS", "sparc"), None);
        assert_eq!(platform_dir("Linux", "riscv64"), None);
        assert_eq!(platform_dir("Linux", "i686"), None);
        assert_eq!(platform_dir("Darwin", "powerpc"), None);
        assert_eq!(platform_dir("", ""), None);
        // A 32-bit Windows arch is not a 32-bit build we ship.
        assert_eq!(platform_dir("Windows", "aarch64"), None);
    }

    #[test]
    fn bin_name_is_exe_only_on_windows() {
        assert_eq!(bin_name_for(PLATFORM_LINUX_X86_64), Some("faragent-helper"));
        assert_eq!(
            bin_name_for(PLATFORM_LINUX_AARCH64),
            Some("faragent-helper")
        );
        assert_eq!(bin_name_for(PLATFORM_DARWIN_ARM64), Some("faragent-helper"));
        assert_eq!(
            bin_name_for(PLATFORM_DARWIN_X86_64),
            Some("faragent-helper")
        );
        assert_eq!(
            bin_name_for(PLATFORM_WINDOWS_X86_64),
            Some("faragent-helper.exe")
        );
        assert_eq!(bin_name_for("plan9-386"), None);
    }

    // -- hashing -----------------------------------------------------------

    #[test]
    fn sha256_matches_known_vectors() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(sha256_hex(b"abc").len(), 64);
        assert!(sha256_hex(b"abc").chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn hashes_match_is_case_and_space_tolerant_but_never_for_empty() {
        let a = sha256_hex(b"payload");
        assert!(hashes_match(&a, &a));
        assert!(hashes_match(&a.to_uppercase(), &a));
        assert!(hashes_match(&format!("  {a}\n"), &a));
        assert!(!hashes_match(&a, &sha256_hex(b"other")));
        // An absent remote digest is never a match, however the local one looks.
        assert!(!hashes_match(&a, ""));
        assert!(!hashes_match("", ""));
    }

    // -- probe parsing -----------------------------------------------------

    #[test]
    fn parse_probe_reads_every_field() {
        let text = "\
Welcome to the box
FARAGENT_HELPER_PROBE os=Linux
FARAGENT_HELPER_PROBE arch=x86_64
FARAGENT_HELPER_PROBE present=1
FARAGENT_HELPER_PROBE tool=sha256sum
FARAGENT_HELPER_PROBE digest=BA7816BF8F01CFEA414140DE5DAE2223B00361A396177A9CB410FF61F20015AD
";
        let probe = parse_probe(text);
        assert_eq!(probe.os, "Linux");
        assert_eq!(probe.arch, "x86_64");
        assert!(probe.present);
        assert_eq!(probe.tool, Some(HashTool::Sha256Sum));
        // Digests are folded to lowercase so comparison never depends on the
        // tool's habits.
        assert_eq!(
            probe.digest,
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert!(probe.usable());
        assert_eq!(probe.platform(), Some(PLATFORM_LINUX_X86_64));
    }

    #[test]
    fn parse_probe_recognises_both_tools_and_notool() {
        let shasum = parse_probe("FARAGENT_HELPER_PROBE tool=shasum\n");
        assert_eq!(shasum.tool, Some(HashTool::Shasum));
        let none = parse_probe("FARAGENT_HELPER_PROBE tool=none\n");
        assert_eq!(none.tool, None);
        assert_eq!(none.digest, "");
        // An unknown token is "no tool", never a guess at a tool.
        let junk = parse_probe("FARAGENT_HELPER_PROBE tool=certutil\n");
        assert_eq!(junk.tool, None);
        assert_eq!(HashTool::Sha256Sum.wire_name(), "sha256sum");
        assert_eq!(HashTool::Shasum.wire_name(), "shasum");
    }

    #[test]
    fn parse_probe_on_empty_or_foreign_output_is_unusable_not_wrong() {
        // A login banner, a Windows remote, an unrelated script: no marker
        // means "we learned nothing", and nothing maps to no platform.
        for text in [
            "",
            "bash: line 1: uname: command not found\n",
            "FARAGENT_PROBE_V1\n",
        ] {
            let probe = parse_probe(text);
            assert!(!probe.usable(), "{text:?}");
            assert_eq!(probe.platform(), None);
            assert!(!probe.present);
            assert_eq!(probe.digest, "");
        }
        // A digest with no `=` is ignored rather than half-parsed.
        let probe = parse_probe("FARAGENT_HELPER_PROBE digest\n");
        assert_eq!(probe.digest, "");
    }

    #[test]
    fn parse_exec_code_reads_the_marker() {
        assert_eq!(parse_exec_code("FARAGENT_HELPER_EXEC code=0\n"), Some(0));
        assert_eq!(
            parse_exec_code("noise\nFARAGENT_HELPER_EXEC code=126\nmore\n"),
            Some(126)
        );
        assert_eq!(
            parse_exec_code("FARAGENT_HELPER_EXEC code=139\n"),
            Some(139)
        );
        assert_eq!(parse_exec_code(""), None);
        assert_eq!(parse_exec_code("FARAGENT_HELPER_EXEC\n"), None);
        assert_eq!(parse_exec_code("FARAGENT_HELPER_EXEC code=abc\n"), None);
    }

    #[test]
    fn verify_report_only_calls_a_clean_zero_executable() {
        let with = |code: Option<i32>| VerifyReport {
            probe: RemoteProbe::default(),
            exec_code: code,
        };
        assert!(with(Some(0)).executable());
        assert!(!with(Some(126)).executable()); // noexec / not +x
        assert!(!with(Some(1)).executable());
        assert!(!with(Some(139)).executable()); // crashed
        assert!(!with(None).executable()); // marker never appeared
    }

    // -- scripts -----------------------------------------------------------

    #[test]
    fn probe_script_is_read_only_and_points_at_the_fixed_path() {
        let script = probe_script();
        assert!(script.contains(REMOTE_HELPER_PATH));
        assert!(script.contains(REMOTE_HELPER_DIR));
        for forbidden in ["rm ", "mkdir", "mv ", "chmod", " > ", ">>"] {
            assert!(
                !script.contains(forbidden),
                "the probe must not write anything: found {forbidden:?} in {script}"
            );
        }
        assert!(script.contains("sha256sum"));
        assert!(script.contains("shasum -a 256"));
        assert!(script.contains("uname -s"));
        assert!(script.contains("uname -m"));
    }

    #[test]
    fn probe_script_puts_one_field_per_line() {
        // The parser splits on the first `=` and takes the rest as the value,
        // so `os=Linux arch=x86_64` would be read as os="Linux arch=x86_64".
        // Every emitting line must therefore carry exactly one field.
        for script in [probe_script(), verify_script()] {
            for line in script.lines().filter(|l| l.contains(PROBE_MARKER)) {
                assert_eq!(
                    line.matches('=').count(),
                    1,
                    "one field per line, got: {line}"
                );
            }
        }
    }

    #[test]
    fn verify_script_runs_the_binary_with_stdin_at_eof() {
        let script = verify_script();
        // `</dev/null` is what makes this side-effect free: the helper treats
        // EOF as an orderly shutdown, so no NDJSON client is needed here.
        assert!(script.contains(r#""$p" </dev/null"#));
        assert!(script.contains("EXEC"));
        assert!(script.contains("code=126"));
        assert!(script.contains("sha256sum"));
        assert!(!script.contains("rm "));
    }

    #[test]
    fn upload_script_verifies_before_renaming_and_carries_no_payload() {
        let digest = sha256_hex(b"the binary");
        let script = upload_script(&digest);
        assert!(script.contains(&format!("expected={digest}")));
        assert!(script.contains(r#"cat > "$tmp""#));
        // The rename must come *after* the checksum gate: that ordering is the
        // whole reason a truncated transfer cannot land.
        let gate = script.find("exit 8").expect("checksum-mismatch exit");
        let rename = script.find("mv -f").expect("rename");
        assert!(gate < rename, "checksum gate must precede the rename");
        let tmp_write = script.find("cat >").unwrap();
        assert!(script.find("chmod +x").unwrap() < rename);
        assert!(tmp_write < gate && gate < rename);
        // The payload is piped in, never inlined into the command string.
        for forbidden in ["base64", "printf %s", "echo \""] {
            assert!(!script.contains(forbidden), "found {forbidden:?}");
        }
        // A script that is a few hundred bytes cannot be carrying a binary.
        assert!(script.len() < 1200, "script is {} bytes", script.len());
    }

    #[test]
    fn upload_script_touches_no_path_outside_the_faragent_bin_dir() {
        let script = upload_script(&sha256_hex(b"x"));
        // The destination is the one fixed path, spelled out in full.
        assert!(
            script.contains(r#"dir="$HOME/.faragent/bin""#),
            "the install directory must be the fixed one: {script}"
        );
        // Every write is rooted at that directory or the temp name derived
        // from it — nothing reaches for `/etc`, a registry, or a service.
        let writes: Vec<&str> = script
            .lines()
            .filter(|l| l.contains("mkdir") || l.contains("mv ") || l.contains("chmod"))
            .collect();
        assert!(!writes.is_empty(), "expected the write lines to exist");
        for line in writes {
            assert!(
                line.contains("$dir") || line.contains("$tmp"),
                "every write must be rooted at $dir/$tmp: {line}"
            );
        }
        // No PATH edits, no shell rc edits, no service installs.
        assert!(!script.contains("PATH"));
        assert!(!script.contains(".bashrc"));
        assert!(!script.contains(".profile"));
        assert!(!script.contains("/etc/"));
        assert!(!script.contains("~/.faragent/bin/faragent-helper"));
    }

    #[test]
    fn upload_failure_detail_names_each_exit_code() {
        for (code, needle) in [
            (3, "create"),
            (4, "upload stream"),
            (5, "chmod"),
            (6, "rename"),
            (7, "checksum tool"),
            (8, "mismatch"),
        ] {
            let detail = upload_failure_detail(Some(code), "");
            assert!(
                detail.contains(needle),
                "exit {code} should mention {needle:?}, got {detail:?}"
            );
        }
        assert!(upload_failure_detail(None, "").contains("killed"));
        assert!(upload_failure_detail(Some(42), "boom").contains("42"));
        assert!(upload_failure_detail(Some(42), "boom").contains("boom"));
    }

    // -- plan --------------------------------------------------------------

    #[test]
    fn plan_falls_back_when_the_platform_is_unmappable() {
        let probe = RemoteProbe {
            os: "FreeBSD".into(),
            arch: "x86_64".into(),
            tool: Some(HashTool::Shasum),
            present: false,
            digest: String::new(),
        };
        let local = linux_artifact(b"x");
        assert_eq!(
            plan(&probe, Some(&local)),
            Plan::Fallback(FallbackReason::UnsupportedPlatform {
                os: "FreeBSD".into(),
                arch: "x86_64".into()
            })
        );
    }

    #[test]
    fn plan_falls_back_without_a_local_artifact_for_the_mapped_platform() {
        // Platform maps fine, but this build produced nothing for it.
        let probe = RemoteProbe {
            os: "Linux".into(),
            arch: "aarch64".into(),
            tool: Some(HashTool::Sha256Sum),
            present: false,
            digest: String::new(),
        };
        assert_eq!(
            plan(&probe, None),
            Plan::Fallback(FallbackReason::NoLocalArtifact {
                platform: PLATFORM_LINUX_AARCH64.into()
            })
        );
        // An artifact for a *different* platform is not a substitute.
        let wrong = linux_artifact(b"x");
        assert_eq!(
            plan(&probe, Some(&wrong)),
            Plan::Fallback(FallbackReason::NoLocalArtifact {
                platform: PLATFORM_LINUX_AARCH64.into()
            })
        );
    }

    #[test]
    fn plan_refuses_to_upload_when_the_transfer_could_not_be_verified() {
        let probe = linux_probe("", false, None);
        let local = linux_artifact(b"x");
        assert_eq!(
            plan(&probe, Some(&local)),
            Plan::Fallback(FallbackReason::NoChecksumTool { os: "Linux".into() })
        );
        // Even a perfect-looking existing install falls back: without a tool
        // we cannot prove what is there, and guessing is the failure mode this
        // module exists to prevent.
        let matching = linux_probe(&local.sha256, true, None);
        assert_eq!(
            plan(&matching, Some(&local)),
            Plan::Fallback(FallbackReason::NoChecksumTool { os: "Linux".into() })
        );
    }

    #[test]
    fn plan_reuses_only_on_a_matching_digest_and_uploads_otherwise() {
        let local = linux_artifact(b"payload");
        // Present + matching -> reuse (no transfer at all).
        assert_eq!(
            plan(
                &linux_probe(&local.sha256, true, Some(HashTool::Sha256Sum)),
                Some(&local)
            ),
            Plan::Reuse
        );
        // Present + different -> upload (stale or foreign binary).
        assert_eq!(
            plan(
                &linux_probe(&sha256_hex(b"older"), true, Some(HashTool::Shasum)),
                Some(&local)
            ),
            Plan::Upload
        );
        // Absent -> upload, with an empty remote digest.
        assert_eq!(
            plan(
                &linux_probe("", false, Some(HashTool::Sha256Sum)),
                Some(&local)
            ),
            Plan::Upload
        );
        // Present but the digest could not be read -> upload, never "probably fine".
        assert_eq!(
            plan(
                &linux_probe("", true, Some(HashTool::Sha256Sum)),
                Some(&local)
            ),
            Plan::Upload
        );
    }

    // -- install flow (scripted host) --------------------------------------

    #[test]
    fn install_reuses_a_verified_helper_without_transferring_anything() {
        let local = linux_artifact(b"payload");
        let host = FakeHost {
            probe_result: Some(linux_probe(&local.sha256, true, Some(HashTool::Sha256Sum))),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(local.clone()));
        assert_eq!(mode, HelperMode::Native);
        assert!(mode.is_native());
        assert_eq!(mode.fallback_reason(), None);
        assert!(
            host.uploads.borrow().is_empty(),
            "nothing should be uploaded"
        );
        assert_eq!(*host.calls.borrow(), vec!["probe"]);
    }

    #[test]
    fn install_uploads_then_verifies_and_only_then_reports_native() {
        let bytes = b"payload-to-send".to_vec();
        let local = linux_artifact(&bytes);
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            verify_result: Some(VerifyReport {
                probe: linux_probe(&local.sha256, true, Some(HashTool::Sha256Sum)),
                exec_code: Some(0),
            }),
            ..Default::default()
        };
        let mode = install_helper(&host, &any_local(bytes.clone()));
        assert_eq!(mode, HelperMode::Native);
        // Order matters: must not report success without a verification.
        assert_eq!(*host.calls.borrow(), vec!["probe", "upload", "verify"]);
        // The exact bytes went over stdin — not a re-encoded copy.
        assert_eq!(*host.uploads.borrow(), vec![bytes]);
    }

    #[test]
    fn install_falls_back_when_the_probe_itself_fails() {
        let host = FakeHost {
            probe_error: Some("ssh exited 255".into()),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(linux_artifact(b"x")));
        match mode {
            HelperMode::ScriptFallback(FallbackReason::ProbeFailed { detail }) => {
                assert!(detail.contains("255"), "{detail}")
            }
            other => panic!("expected ProbeFailed, got {other:?}"),
        }
        assert!(host.uploads.borrow().is_empty());
    }

    #[test]
    fn install_falls_back_when_the_upload_fails() {
        let local = linux_artifact(b"x");
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            upload_error: Some("upload script exited 3".into()),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(local.clone()));
        match mode {
            HelperMode::ScriptFallback(FallbackReason::UploadFailed { detail }) => {
                assert!(detail.contains("exited 3"), "{detail}")
            }
            other => panic!("expected UploadFailed, got {other:?}"),
        }
        // A failed upload must not even try to verify.
        assert_eq!(*host.calls.borrow(), vec!["probe", "upload"]);
    }

    #[test]
    fn install_falls_back_when_the_remote_still_has_the_wrong_bytes() {
        let local = linux_artifact(b"x");
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            verify_result: Some(VerifyReport {
                probe: linux_probe(&sha256_hex(b"truncated"), true, Some(HashTool::Sha256Sum)),
                exec_code: Some(0),
            }),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(local.clone()));
        match mode {
            HelperMode::ScriptFallback(FallbackReason::VerifyFailed { detail }) => {
                assert!(detail.contains(&local.sha256), "{detail}");
                assert!(
                    detail.contains(&sha256_hex(b"truncated")),
                    "the detail must name what the remote actually has: {detail}"
                );
            }
            other => panic!("expected VerifyFailed, got {other:?}"),
        }
    }

    #[test]
    fn install_falls_back_when_the_bytes_arrived_but_cannot_run() {
        // The digest is right and the file is on disk, but running it exits
        // 126: a noexec mount, or a binary for the wrong architecture. This is
        // exactly the case a byte-only check would wave through.
        let local = linux_artifact(b"x");
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            verify_result: Some(VerifyReport {
                probe: linux_probe(&local.sha256, true, Some(HashTool::Sha256Sum)),
                exec_code: Some(126),
            }),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(local.clone()));
        assert_eq!(
            mode,
            HelperMode::ScriptFallback(FallbackReason::NotExecutable { code: Some(126) })
        );
        assert_eq!(mode.fallback_reason().unwrap().code(), "not_executable");
    }

    #[test]
    fn install_falls_back_when_the_verification_never_ran() {
        let local = linux_artifact(b"x");
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            verify_error: Some("ssh timed out".into()),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(local.clone()));
        // Silence is never an acceptable answer to "did it land?".
        assert!(!mode.is_native());
        match mode {
            HelperMode::ScriptFallback(FallbackReason::UploadFailed { detail }) => {
                assert!(detail.contains("timed out"), "{detail}")
            }
            other => panic!("expected UploadFailed, got {other:?}"),
        }
    }

    #[test]
    fn install_reports_the_unmappable_platform_without_uploading() {
        let host = FakeHost {
            probe_result: Some(RemoteProbe {
                os: "SunOS".into(),
                arch: "sparc".into(),
                tool: Some(HashTool::Shasum),
                present: false,
                digest: String::new(),
            }),
            ..Default::default()
        };
        let mode = install_helper(&host, &|_| Some(linux_artifact(b"x")));
        assert_eq!(
            mode,
            HelperMode::ScriptFallback(FallbackReason::UnsupportedPlatform {
                os: "SunOS".into(),
                arch: "sparc".into()
            })
        );
        assert_eq!(*host.calls.borrow(), vec!["probe"]);
    }

    #[test]
    fn install_reports_a_missing_artifact_for_a_known_platform() {
        let host = FakeHost {
            probe_result: Some(linux_probe("", false, Some(HashTool::Sha256Sum))),
            ..Default::default()
        };
        // The resource root produced nothing (build script never ran).
        let mode = install_helper(&host, &|_| None);
        assert_eq!(
            mode,
            HelperMode::ScriptFallback(FallbackReason::NoLocalArtifact {
                platform: PLATFORM_LINUX_X86_64.into()
            })
        );
        assert_eq!(*host.calls.borrow(), vec!["probe"]);
    }

    #[test]
    fn windows_remotes_are_refused_without_a_round_trip() {
        assert_eq!(
            posix_only(HostOs::Windows),
            Some(HelperMode::ScriptFallback(FallbackReason::WindowsRemote))
        );
        assert_eq!(posix_only(HostOs::Posix), None);
    }

    // -- messaging ---------------------------------------------------------

    #[test]
    fn every_fallback_reason_has_distinct_wording_in_both_languages() {
        let reasons = [
            FallbackReason::UnsupportedPlatform {
                os: "FreeBSD".into(),
                arch: "x86_64".into(),
            },
            FallbackReason::NoLocalArtifact {
                platform: PLATFORM_DARWIN_ARM64.into(),
            },
            FallbackReason::NoChecksumTool { os: "Linux".into() },
            FallbackReason::ProbeFailed {
                detail: "ssh exited 255".into(),
            },
            FallbackReason::WindowsRemote,
            FallbackReason::UploadFailed {
                detail: "exit 3".into(),
            },
            FallbackReason::VerifyFailed {
                detail: "expected a, saw b".into(),
            },
            FallbackReason::NotExecutable { code: Some(126) },
        ];
        let mut codes = std::collections::HashSet::new();
        for reason in &reasons {
            let message = reason.message();
            assert!(!message.zh.trim().is_empty(), "{reason:?}");
            assert!(!message.en.trim().is_empty(), "{reason:?}");
            assert!(codes.insert(reason.code()), "duplicate code for {reason:?}");
        }
        assert_eq!(codes.len(), reasons.len());
        // The native message is its own thing and carries no downgrade wording.
        assert!(HelperMode::Native.message().en.contains("ready"));
        assert!(HelperMode::Native.fallback_reason().is_none());
    }

    // -- local artifact loading --------------------------------------------

    #[test]
    fn load_local_artifact_reads_the_bundled_resource_layout() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("helper").join(PLATFORM_LINUX_X86_64);
        std::fs::create_dir_all(&dir).unwrap();
        let bytes = b"\x7fELF not really".to_vec();
        std::fs::write(dir.join("faragent-helper"), &bytes).unwrap();

        let artifact = load_local_artifact(root.path(), PLATFORM_LINUX_X86_64).unwrap();
        assert_eq!(artifact.bytes, bytes);
        assert_eq!(artifact.sha256, sha256_hex(&bytes));
        assert_eq!(artifact.file_name, "faragent-helper");
        assert_eq!(artifact.platform, PLATFORM_LINUX_X86_64);

        // A platform whose directory was never built yields nothing...
        assert!(load_local_artifact(root.path(), PLATFORM_DARWIN_ARM64).is_none());
        // ...as does a platform with no entry in the table at all.
        assert!(load_local_artifact(root.path(), "plan9-386").is_none());

        // Windows looks for the `.exe` name specifically.
        let win = root.path().join("helper").join(PLATFORM_WINDOWS_X86_64);
        std::fs::create_dir_all(&win).unwrap();
        std::fs::write(win.join("faragent-helper"), b"wrong name").unwrap();
        assert!(load_local_artifact(root.path(), PLATFORM_WINDOWS_X86_64).is_none());
        std::fs::write(win.join("faragent-helper.exe"), b"MZ").unwrap();
        assert_eq!(
            load_local_artifact(root.path(), PLATFORM_WINDOWS_X86_64)
                .unwrap()
                .file_name,
            "faragent-helper.exe"
        );
    }

    #[test]
    fn artifact_for_picks_the_probes_platform_and_nothing_else() {
        let root = tempfile::tempdir().unwrap();
        let bytes = b"linux binary".to_vec();
        let dir = root.path().join("helper").join(PLATFORM_LINUX_X86_64);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("faragent-helper"), &bytes).unwrap();

        let linux = RemoteProbe {
            os: "Linux".into(),
            arch: "x86_64".into(),
            ..Default::default()
        };
        assert_eq!(
            artifact_for(&linux, root.path()).unwrap().sha256,
            sha256_hex(&bytes)
        );

        // A remote we have no build for gets nothing, so the flow falls back
        // rather than sending a binary for the wrong machine.
        let freebsd = RemoteProbe {
            os: "FreeBSD".into(),
            arch: "x86_64".into(),
            ..Default::default()
        };
        assert!(artifact_for(&freebsd, root.path()).is_none());
    }

    // -- the remote scripts, actually executed -------------------------------
    //
    // These run the exact script text that travels over ssh, through a real
    // `bash`, against a throwaway `$HOME`. That covers everything except the
    // ssh hop itself: the shell quoting, the tool detection, the temp-file
    // dance, and the agreement between our Rust sha256 and the remote tool's.

    /// Run a generated script the way the transport does, minus ssh: a real
    /// `bash` with `$HOME` pointed at a scratch directory and `stdin` piped.
    #[cfg(unix)]
    fn run_script(script: &str, home: &Path, stdin: &[u8]) -> std::process::Output {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let mut child = Command::new("bash")
            .arg("-c")
            .arg(script)
            .env("HOME", home)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("bash must be available to test the remote scripts");
        // Dropping the handle closes the pipe, which is the remote's EOF.
        child
            .stdin
            .take()
            .expect("piped stdin")
            .write_all(stdin)
            .expect("write the payload");
        child.wait_with_output().expect("bash should exit")
    }

    #[cfg(unix)]
    fn installed_path(home: &Path) -> std::path::PathBuf {
        home.join(".faragent/bin/faragent-helper")
    }

    #[cfg(unix)]
    #[test]
    fn probe_script_runs_in_a_real_shell_and_reports_an_absent_helper() {
        let home = tempfile::tempdir().unwrap();
        let out = run_script(&probe_script(), home.path(), b"");
        assert!(out.status.success(), "{out:?}");
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let probe = parse_probe(&text);
        assert!(probe.usable(), "probe produced nothing usable: {text:?}");
        assert!(!probe.present, "{text:?}");
        // Every supported host has one of the two tools; without one this
        // whole flow falls back by design, so the test would rather say so.
        assert!(
            probe.tool.is_some(),
            "this machine has neither sha256sum nor shasum: {text:?}"
        );
        assert_eq!(probe.digest, "", "no file means no digest: {text:?}");
        // And `uname` on the real host maps to a real artifact directory.
        assert!(
            probe.platform().is_some(),
            "uname reported {}/{}: {text:?}",
            probe.os,
            probe.arch
        );
    }

    #[cfg(unix)]
    #[test]
    fn probe_script_digest_agrees_with_our_own_sha256() {
        // The crux of the whole module: the remote computes the digest with a
        // shell tool, we compute it in Rust. If these two ever disagree, every
        // upload would look permanently mismatched.
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".faragent/bin");
        std::fs::create_dir_all(&dir).unwrap();
        let payload: Vec<u8> = b"\x7fELF\x02\x01\x01\x00 pretend helper \x00\xff\xfe".to_vec();
        std::fs::write(dir.join("faragent-helper"), &payload).unwrap();

        let out = run_script(&probe_script(), home.path(), b"");
        assert!(out.status.success(), "{out:?}");
        let probe = parse_probe(&String::from_utf8_lossy(&out.stdout));
        assert!(probe.present);
        assert!(probe.tool.is_some());
        assert_eq!(
            probe.digest,
            sha256_hex(&payload),
            "the remote tool and our sha2 must agree"
        );
    }

    #[cfg(unix)]
    #[test]
    fn upload_script_installs_the_payload_and_leaves_no_scratch_file() {
        let home = tempfile::tempdir().unwrap();
        // Enough bytes to cross a pipe buffer boundary or two.
        let payload: Vec<u8> = (0u8..=255).cycle().take(9000).collect();
        let out = run_script(&upload_script(&sha256_hex(&payload)), home.path(), &payload);
        assert!(
            out.status.success(),
            "stderr: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let installed = installed_path(home.path());
        assert_eq!(
            std::fs::read(&installed).unwrap(),
            payload,
            "the binary must arrive byte for byte"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&installed).unwrap().permissions().mode();
            assert!(mode & 0o111 != 0, "the helper must be executable: {mode:o}");
        }
        // The temp file is gone: a re-run starts from a clean directory.
        let scratch: Vec<String> = std::fs::read_dir(home.path().join(".faragent/bin"))
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|name| name.starts_with('.'))
            .collect();
        assert!(scratch.is_empty(), "scratch files left behind: {scratch:?}");
    }

    #[cfg(unix)]
    #[test]
    fn upload_script_refuses_a_truncated_transfer_and_writes_nothing() {
        // A cut-off transfer is the failure this guards against: the remote
        // must reject it *before* the rename, so the deterministic path never
        // holds a half-written binary.
        let home = tempfile::tempdir().unwrap();
        let full = vec![7u8; 5000];
        let out = run_script(
            &upload_script(&sha256_hex(&full)),
            home.path(),
            &full[..100],
        );
        assert!(!out.status.success(), "a truncated upload must fail");
        assert_eq!(
            out.status.code(),
            Some(8),
            "expected the checksum exit code"
        );
        assert!(
            !installed_path(home.path()).exists(),
            "no binary may land when the transfer was cut short"
        );
    }

    #[cfg(unix)]
    #[test]
    fn upload_script_is_idempotent_and_replaces_an_older_binary() {
        let home = tempfile::tempdir().unwrap();
        let first = b"version one".to_vec();
        let second = b"version two, longer".to_vec();
        for payload in [&first, &second] {
            let out = run_script(&upload_script(&sha256_hex(payload)), home.path(), payload);
            assert!(out.status.success(), "{out:?}");
            assert_eq!(
                std::fs::read(installed_path(home.path())).unwrap(),
                *payload
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn verify_script_separates_a_runnable_helper_from_a_dead_one() {
        let home = tempfile::tempdir().unwrap();
        let dir = home.path().join(".faragent/bin");
        std::fs::create_dir_all(&dir).unwrap();
        let installed = dir.join("faragent-helper");

        // A helper that exits cleanly on EOF: what the real one does.
        let ok_body = "#!/bin/sh\nexit 0\n";
        std::fs::write(&installed, ok_body).unwrap();
        let report = || {
            let out = run_script(&verify_script(), home.path(), b"");
            assert!(out.status.success(), "{out:?}");
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            (parse_probe(&text), parse_exec_code(&text), text)
        };

        // No +x yet: the shell cannot run it at all.
        let (probe, code, text) = report();
        assert!(probe.present, "{text}");
        assert!(!VerifyReport {
            probe,
            exec_code: code
        }
        .executable());

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&installed, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let (probe, code, text) = report();
        assert_eq!(
            code,
            Some(0),
            "an executable that exits 0 must pass: {text}"
        );
        assert_eq!(
            probe.digest,
            sha256_hex(ok_body.as_bytes()),
            "the verify probe reports the same digest the upload compares against"
        );
        assert!(VerifyReport {
            probe,
            exec_code: code
        }
        .executable());

        // A binary that dies (wrong architecture, corrupt, noexec): the digest
        // still matches, but the mode must not be `Native`.
        std::fs::write(&installed, "#!/bin/sh\nexit 3\n").unwrap();
        let (probe, code, text) = report();
        assert_eq!(code, Some(3), "{text}");
        assert!(
            !VerifyReport {
                probe,
                exec_code: code
            }
            .executable(),
            "a non-zero exit is not a usable helper"
        );
    }

    /// The closest thing to a real remote that runs without one: the **actual
    /// built binary** for this host, pushed through the **actual** upload and
    /// verify scripts, then executed. Everything but the ssh hop.
    ///
    /// Skips loudly when the resource tree has not been built (it is gitignored
    /// output of `scripts/build-helper.sh`), because there is then nothing real
    /// to send.
    #[cfg(unix)]
    #[test]
    fn the_real_built_helper_survives_the_local_round_trip() {
        let uname = |flag: &str| {
            let out = std::process::Command::new("uname")
                .arg(flag)
                .output()
                .expect("uname");
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        let (os, arch) = (uname("-s"), uname("-m"));
        let Some(platform) = platform_dir(&os, &arch) else {
            eprintln!("skipping: no artifact table entry for {os}/{arch}");
            return;
        };

        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../apps/faragent-app/src-tauri/resources");
        let Some(artifact) = load_local_artifact(&root, platform) else {
            eprintln!(
                "skipping: {platform} was not built at {} (run scripts/build-helper.sh)",
                root.display()
            );
            return;
        };
        assert!(!artifact.bytes.is_empty(), "the artifact is empty");

        let home = tempfile::tempdir().unwrap();
        let upload = run_script(
            &upload_script(&artifact.sha256),
            home.path(),
            &artifact.bytes,
        );
        assert!(
            upload.status.success(),
            "upload failed: {}",
            String::from_utf8_lossy(&upload.stderr)
        );

        let verify = run_script(&verify_script(), home.path(), b"");
        assert!(verify.status.success(), "{verify:?}");
        let text = String::from_utf8_lossy(&verify.stdout).into_owned();
        let report = VerifyReport {
            probe: parse_probe(&text),
            exec_code: parse_exec_code(&text),
        };
        // The real binary, on the real host: present, digest-matching, and it
        // runs to a clean 0 on stdin-at-EOF — which is what `plan` needs to
        // answer `Reuse` and what `install_helper` needs to answer `Native`.
        assert!(report.probe.present, "{text}");
        assert_eq!(
            report.probe.digest, artifact.sha256,
            "the installed digest must equal the artifact's: {text}"
        );
        assert_eq!(
            report.exec_code,
            Some(0),
            "the real helper must exit 0 on EOF: {text}"
        );
        assert!(report.executable(), "{text}");
        assert_eq!(
            plan(&report.probe, Some(&artifact),),
            Plan::Reuse,
            "a freshly uploaded helper must plan as Reuse, not another upload"
        );
    }
}
