//! The remote-side protocol: the POSIX (bash + tmux) and Windows (cmd +
//! PowerShell) dialects of FarAgent's scripts, and the parsers for their
//! output. Pure data — no processes, no connection; the transport crate
//! executes what this crate builds.

pub mod remote;
pub mod win;
