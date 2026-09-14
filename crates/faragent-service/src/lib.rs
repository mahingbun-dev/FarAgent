//! The service layer: everything FarAgent does *against* a host, above the
//! raw transport — probing, session listing/creation, the doctor report and
//! the error diagnosis (with its wording). UIs (TUI, CLI, app) consume this;
//! none of it is terminal- or window-specific.

pub mod diagnose;
pub mod doctor;
pub mod github;
pub mod probe;
pub mod sessions;
