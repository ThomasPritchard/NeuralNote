//! Generates the default `ApprovalStatus` the frontend's test fixture is built
//! from, and reddens when the tracked copy disagrees with Rust (issue #120).
//!
//! `app/desktop/src/lib/approvalStatusFixture.ts` used to hand-write this value:
//! seven `snake_case` tool keys and three English phrases, as literals, with
//! nothing checking either against the tables Rust derives them from. Adding a
//! gated tool tomorrow reddens Rust correctly — and the frontend's coverage of
//! the settings surface would quietly narrow, because
//! `ApprovalSettings.test.tsx` builds its per-tool cases from the fixture's own
//! keys. Green suite, one ungoverned row.
//!
//! So the value is generated here instead, exactly as
//! `mock_ipc_contract_v1.rs` generates the mock IPC contract: serialise the
//! canonical Rust data to a tracked JSON file under the frontend tree, and
//! assert the tracked bytes still match. **What goes red:** add, remove or
//! rename a [`GatedTool`], change the default `ApprovalMode`, or reclassify a
//! tool's reversibility, and this test fails until the fixture is regenerated.
//!
//! That is only half the chain. A regenerated fixture still teaches the
//! frontend nothing on its own, so the TypeScript side pairs it with a
//! `Record<GatedTool, string>` wire-name registry that is exhaustive over the
//! generated `GatedTool` union — see `app/desktop/src/lib/gatedToolWireNames.ts`
//! and `approvalStatusFixture.test.ts`. New tool in Rust → new key here → the
//! frontend fails to compile until someone teaches it the tool.

use std::collections::BTreeMap;
use std::fs;

use neuralnote_core::ai::approval::{irreversible_display_names, ApprovalMode, ALL_GATED_TOOLS};
use neuralnote_core::ai::ProviderConfig;
use serde::Serialize;

const FIXTURE_PATH: &str = concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../app/desktop/src/lib/fixtures/approval-status-default.json"
);

/// The fixture describes a fresh install, which has no API key — so the judge
/// cannot run and `classifierAvailable` is `false`. Derived through
/// `approval_policy` rather than written down, so the day the local lane learns
/// to judge, this fixture says so instead of lying about it.
const KEY_PRESENT: bool = false;

/// Mirrors the shell's `ApprovalStatus` DTO (`commands/ai.rs`), field for field
/// and name for name, so the generated JSON is the shape the frontend actually
/// receives over IPC. It cannot be reused directly: that type is `pub(crate)` to
/// the desktop shell, and this test lives in the core crate.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DefaultApprovalStatus {
    mode: ApprovalMode,
    tool_overrides: BTreeMap<String, ApprovalMode>,
    effective_modes: BTreeMap<String, ApprovalMode>,
    classifier_available: bool,
    irreversible_actions: Vec<&'static str>,
}

/// What a fresh install — and any `ai-config.json` written before the approval
/// fields existed — resolves to.
///
/// Every value is computed from `ProviderConfig::default()` through the same
/// calls `build_ai_status` makes, rather than restated here. A test that
/// re-implements the clamp would pass while the shipped clamp was broken.
fn default_approval_status() -> DefaultApprovalStatus {
    let config = ProviderConfig::default();
    DefaultApprovalStatus {
        mode: config.approval_mode,
        tool_overrides: config.tool_approval_overrides.clone(),
        effective_modes: ALL_GATED_TOOLS
            .into_iter()
            .map(|tool| {
                (
                    tool.name().to_string(),
                    config.effective_approval_mode(tool),
                )
            })
            .collect(),
        classifier_available: config.approval_policy(KEY_PRESENT).classifier_available,
        irreversible_actions: irreversible_display_names(),
    }
}

#[test]
fn tracked_approval_status_fixture_matches_rust() {
    let rendered = format!(
        "{}\n",
        serde_json::to_string_pretty(&default_approval_status())
            .expect("render the default ApprovalStatus")
    );
    if std::env::var_os("UPDATE_APPROVAL_STATUS_FIXTURE").is_some() {
        fs::write(FIXTURE_PATH, rendered).expect("write the generated approval status fixture");
        return;
    }
    let tracked =
        fs::read_to_string(FIXTURE_PATH).expect("read the tracked approval status fixture");
    assert_eq!(
        tracked, rendered,
        "the tracked approval fixture no longer matches Rust — read the diff, and if the \
         change is intended run: UPDATE_APPROVAL_STATUS_FIXTURE=1 cargo test -p neuralnote-core \
         --test approval_status_fixture (a new gated tool ALSO needs a wire name in \
         app/desktop/src/lib/gatedToolWireNames.ts, which will not compile without it)"
    );
}
