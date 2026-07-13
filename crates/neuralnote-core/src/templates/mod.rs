//! Obsidian-compatible note templates.
//!
//! Templates are untrusted vault content: they may come from a migrated or shared
//! vault. This module therefore implements a whitelist-only interpreter over a
//! fixed table of variables/functions. It never evaluates code, never shells out,
//! never dispatches to user functions, and leaves unknown syntax verbatim.

mod discovery;
mod render;
mod settings;

pub use discovery::{create_note_from_template, list_templates};
pub use render::{render_template, TemplateContext};
pub use settings::{
    load_template_settings, preview_template_format, reset_template_settings,
    save_template_settings, validate_template_format, TemplateSettings, TemplateSettingsSource,
    TemplateSettingsStatus,
};

#[cfg(test)]
pub(crate) use discovery::remove_created_note_after_template_write_failure;

const DEFAULT_DATE_FORMAT: &str = "YYYY-MM-DD";
const DEFAULT_TIME_FORMAT: &str = "HH:mm";
