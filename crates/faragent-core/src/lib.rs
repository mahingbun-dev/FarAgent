//! Vocabulary, local config and path plumbing shared by every FarAgent
//! crate. No processes, no network, no UI: this is the bottom of the
//! dependency graph, so every other crate may depend on it.

pub mod agents;
pub mod config;
pub mod paths;
pub mod shell;
pub mod text;
pub mod vocab;
