//! The terminal UI: the host → agent → session picker, its chrome wording
//! and the local-tty attach plumbing. Renders on the machine the user sits
//! at; the remote side is untouched.

pub mod chrome;
pub mod pty;
pub mod tui;
