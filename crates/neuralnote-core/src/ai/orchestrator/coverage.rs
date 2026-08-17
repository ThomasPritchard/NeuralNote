//! Coverage footer: searched terms, notes read, truncation, skipped files.

use crate::ai::events::{ChatEvent, EventSink};

#[derive(Default)]
pub(super) struct CoverageAcc {
    pub(super) searched_terms: Vec<String>,
    pub(super) notes_read: Vec<String>,
    pub(super) truncated: bool,
    pub(super) skipped_files: u32,
}

pub(super) fn emit_coverage(coverage: CoverageAcc, guard_tripped: bool, sink: &mut dyn EventSink) {
    let truncated = coverage.truncated || guard_tripped;

    // A conversational turn searched and read nothing, so an empty footer would be a
    // lie of precision — say nothing instead. But suppress only when the footer would
    // carry *no* information: a run can trip a guard (or skip files) having called
    // only `list_notes`/`list_folders`, which populate neither vector, and dropping
    // the footer there would hide the truncation. Partial coverage is visible, never
    // hidden (see `ChatEvent::Coverage`).
    if coverage.searched_terms.is_empty()
        && coverage.notes_read.is_empty()
        && !truncated
        && coverage.skipped_files == 0
    {
        return;
    }

    sink.send(ChatEvent::Coverage {
        searched_terms: coverage.searched_terms,
        notes_read: coverage.notes_read,
        // "Partial coverage" = the sweep was genuinely cut short: a loop guard
        // stopped it, OR the vault search hit its own global cap (`coverage.truncated`
        // now carries only that, not a routine per-search `max_results` clip).
        truncated,
        skipped_files: coverage.skipped_files,
    });
}

pub(super) fn push_unique(list: &mut Vec<String>, value: &str) {
    if !list.iter().any(|v| v == value) {
        list.push(value.to_string());
    }
}
