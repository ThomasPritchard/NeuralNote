//! The tool-approval gate: who may run a gated tool, and on whose authority.
//!
//! Extracted as its own module rather than added to `orchestrator.rs` (4,600
//! lines) on purpose — a security control buried in the largest file in the
//! repo is a control nobody reads.
//!
//! ## The shape of it
//!
//! Three modes ([`ApprovalMode`]), a per-tool clamp that can only ever be *more*
//! restrictive, and one entry point ([`decide`]) that is the only way to obtain
//! the [`ApprovedCall`] `dispatch` requires.
//!
//! | Mode | Eligible calls | Ineligible / irreversible calls | Judge runs? |
//! |---|---|---|---|
//! | `AlwaysAsk` **(default)** | ask | ask | no |
//! | `ApproveForMe` | the judge decides | **ask** | yes |
//! | `Yolo` | run without asking | **run without asking** | no |
//!
//! ## Three things it is easy to get wrong later
//!
//! 1. **The unconditional-ask floor is a floor *inside* `ApproveForMe`, not a
//!    global invariant.** `Yolo` deliberately has none. A future reader who finds
//!    the YOLO path ungated should not "fix" it (§9.6.1).
//! 2. **`Yolo` removes the approval gate and nothing else.** Path confinement,
//!    input validation, the write budget, the `O_EXCL|O_NOFOLLOW` host primitive
//!    and the `UndoLedger` all still apply (§9.6.2). Routing confinement through
//!    the gate "to simplify the code" would silently make YOLO a vault escape.
//! 3. **Visibility is the compensating control.** When the gate is removed the
//!    *record* must not be: every call still renders a node, and Undo still
//!    applies (§9.6.3). A skipped prompt that leaves no trace is the failure that
//!    clause exists to prevent.
//!
//! ## The residual risk, stated honestly
//!
//! Direct injection into the judge is unreachable — [`ToolApprovalSubject`] has
//! no free-text field. **Shaping is not.** Whoever controls a transcript controls
//! what the model proposes, and therefore the size, the folder, and the note
//! kind. The attack degrades from "talk the judge into yes" to "shape a request
//! the honest rules approve", which defeats *any* auto-approval policy. The
//! safety of auto-approval here does not come from the judge's judgement; it
//! comes from [`eligible`] admitting only create-note calls, whose worst outcome
//! is an undoable junk note. Under `Yolo` the residual risk is total, and the
//! mode's name exists to say so.

mod classifier;
mod digest;
mod gate;
mod gated;
mod mode;
mod outcome;
mod subject;

pub use classifier::{
    classifier_prompt, classifier_system_prompt, parse_verdict, ApprovalClassifier, ApprovalRule,
    ClassifierVerdict, UnavailableApprovalClassifier, CLASSIFIER_BUDGET, CLASSIFIER_MAX_TOKENS,
    CLASSIFIER_TEMPERATURE,
};
pub use digest::{PathDigest, PathDigestSalt};
pub use gate::{
    decide, ApprovalContext, ApprovalGate, ApprovalPolicy, ApprovalPrompt, ApprovalPromptRequest,
    DenyingApprovalPrompt,
};
pub use gated::{
    irreversible_display_names, reversibility, yolo_irreversible_sentence, GatedTool,
    Reversibility, ALL_GATED_TOOLS,
};
pub use mode::{
    compiled_default_override, effective_mode, retain_known_tool_overrides, ApprovalMode,
};
pub use outcome::{
    ApprovalAnswer, ApprovalDecision, ApprovalDegradedReason, ApprovalReason, ApprovalResolution,
    ApprovedCall, APPROVAL_TIMEOUT_SECS,
};
pub use subject::{
    build_subject, eligible, operation_kind, BuiltSubject, HardDeny, OperationKind, TargetLocation,
    ToolApprovalSubject, MAX_AUTO_APPROVED_PAYLOAD_BYTES,
};
