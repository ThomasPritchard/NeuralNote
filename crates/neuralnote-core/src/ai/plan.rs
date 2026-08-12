//! The declared plan: the steps the model says it intends to take, and where it
//! has got to.
//!
//! This is the only part of the agentic pane that **degrades gracefully to
//! nothing**. A model that never calls `update_plan` produces no [`RunPlan`]
//! state, no events, and a timeline with no step grouping — which is exactly
//! what the pane rendered before this existed. Nothing downstream may require a
//! plan to be present.
//!
//! Two rules keep the declaration honest, and both are enforced here rather than
//! trusted to the model:
//!
//! 1. **The step set is declared once.** Later calls may only move statuses. A
//!    call that adds, drops, or renames a step is rejected with a message the
//!    model can act on, because re-declaring mid-run would silently re-parent
//!    every timeline node already affiliated with a step id.
//! 2. **Only real transitions are emitted.** A repeated call carrying unchanged
//!    statuses emits nothing, so a model that re-sends its plan every turn does
//!    not fill the rail with duplicates.

use crate::ai::events::ChatEvent;
use crate::ai::tool_registry::TOOL_UPDATE_PLAN;
use crate::ai::tools::{action, function_tool, reject, ToolContext, ToolResult};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use ts_rs::TS;

/// One step the model declared it intends to take. `id` is the model's own
/// handle for the step — it is the correlation key that later status updates and
/// timeline affiliations use, so it is never re-derived from `label`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct PlanStep {
    pub id: String,
    /// A short human label. This one IS model prose, unavoidably: only the model
    /// knows what it plans to do. It is rendered as a label and never matched on.
    pub label: String,
}

/// Where a declared step has got to.
///
/// `Skipped` and `Failed` are separate on purpose, for the same reason
/// [`ToolStatus`](crate::ai::events::ToolStatus) splits its refusals: "I decided
/// this was unnecessary" and "I tried this and it did not work" are two different
/// accounts of the same missing work, and only one of them is a problem.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum StepStatus {
    Pending,
    Running,
    Done,
    Skipped,
    Failed,
}

/// The maximum number of steps a plan may declare. A plan is a handful of steps
/// a person can read at a glance; a model that emits fifty has misunderstood the
/// tool, and rendering them would bury the answer rather than explain it.
pub const MAX_PLAN_STEPS: usize = 12;

/// Rejection text for a second declaration whose step set differs from the first.
pub const PLAN_STEPS_ARE_FIXED: &str =
    "the plan's steps are declared once and cannot be changed; later calls may only update the status of the steps already declared";

/// One step as the model sends it: the declaration and the status in one shape,
/// so the tool takes the whole plan every time rather than needing two tools.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct PlanStepInput {
    pub id: String,
    pub label: String,
    #[serde(default = "pending")]
    pub status: StepStatus,
}

fn pending() -> StepStatus {
    StepStatus::Pending
}

/// What one `update_plan` call changed, for the caller to turn into events.
///
/// `declared` is `Some` only on the first accepted call: the step set is fixed
/// after that, so a UI can treat a second `Plan` event as impossible rather than
/// as a re-parenting it has to handle.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct PlanUpdate {
    pub declared: Option<Vec<PlanStep>>,
    pub transitions: Vec<(String, StepStatus)>,
}

/// Why an `update_plan` call was refused.
#[derive(Debug, PartialEq, Eq)]
pub enum PlanError {
    Empty,
    TooMany,
    DuplicateId,
    BlankField,
    StepsChanged,
}

impl PlanError {
    /// The message the model reads and recovers from. Compiled-in, never
    /// composed from the model's own argument text.
    pub fn message(&self) -> String {
        match self {
            Self::Empty => "a plan must declare at least one step".into(),
            Self::TooMany => format!("a plan may declare at most {MAX_PLAN_STEPS} steps"),
            Self::DuplicateId => "every plan step needs its own unique id".into(),
            Self::BlankField => "every plan step needs a non-empty id and label".into(),
            Self::StepsChanged => PLAN_STEPS_ARE_FIXED.into(),
        }
    }
}

/// The plan for one run. Absent until the model declares one, which is the
/// common case.
#[derive(Debug, Default)]
pub struct RunPlan {
    steps: Vec<PlanStep>,
    statuses: Vec<StepStatus>,
}

impl RunPlan {
    /// Fold one `update_plan` call in, returning what actually changed.
    pub fn update(&mut self, input: Vec<PlanStepInput>) -> Result<PlanUpdate, PlanError> {
        validate(&input)?;
        if self.steps.is_empty() {
            return Ok(self.declare(input));
        }
        if !self.same_steps(&input) {
            return Err(PlanError::StepsChanged);
        }
        Ok(PlanUpdate {
            declared: None,
            transitions: self.apply_statuses(&input),
        })
    }

    /// The id of the step currently [`StepStatus::Running`], for stamping onto a
    /// tool call as it is dispatched.
    ///
    /// `None` is the ordinary answer, not a failure: no plan was declared, or
    /// none of the declared steps is in flight right now. Callers affiliate the
    /// node with nothing rather than inventing a step to hang it under.
    ///
    /// Nothing stops the model marking two steps running at once — the plan is
    /// its own account of its work, and rejecting that would refuse a plausible
    /// claim (it may genuinely interleave). So this takes the **first in
    /// declared order**: declaration order is the only ordering the user can see
    /// on the rail, so the earliest running step is the one they will read as
    /// "where we are", and it is stable across calls in a way that "whichever
    /// transitioned most recently" would not be.
    pub fn running_step_id(&self) -> Option<&str> {
        self.statuses
            .iter()
            .position(|status| *status == StepStatus::Running)
            .map(|index| self.steps[index].id.as_str())
    }

    fn declare(&mut self, input: Vec<PlanStepInput>) -> PlanUpdate {
        self.steps = input
            .iter()
            .map(|step| PlanStep {
                id: step.id.clone(),
                label: step.label.clone(),
            })
            .collect();
        // Declared steps start pending, so the `Plan` event alone describes the
        // whole opening state and only genuine departures from it are emitted.
        self.statuses = vec![StepStatus::Pending; self.steps.len()];
        PlanUpdate {
            declared: Some(self.steps.clone()),
            transitions: self.apply_statuses(&input),
        }
    }

    /// The declared step set is identity: same ids, same labels, same order. A
    /// relabelled step is a different step — the label is what the user reads.
    fn same_steps(&self, input: &[PlanStepInput]) -> bool {
        self.steps.len() == input.len()
            && self
                .steps
                .iter()
                .zip(input)
                .all(|(step, sent)| step.id == sent.id && step.label == sent.label)
    }

    fn apply_statuses(&mut self, input: &[PlanStepInput]) -> Vec<(String, StepStatus)> {
        let mut transitions = Vec::new();
        for (index, sent) in input.iter().enumerate() {
            if self.statuses[index] == sent.status {
                continue;
            }
            self.statuses[index] = sent.status;
            transitions.push((sent.id.clone(), sent.status));
        }
        transitions
    }
}

fn validate(input: &[PlanStepInput]) -> Result<(), PlanError> {
    if input.is_empty() {
        return Err(PlanError::Empty);
    }
    if input.len() > MAX_PLAN_STEPS {
        return Err(PlanError::TooMany);
    }
    if input
        .iter()
        .any(|step| step.id.trim().is_empty() || step.label.trim().is_empty())
    {
        return Err(PlanError::BlankField);
    }
    let mut ids: Vec<&str> = input.iter().map(|step| step.id.as_str()).collect();
    ids.sort_unstable();
    let unique = ids.len();
    ids.dedup();
    if ids.len() != unique {
        return Err(PlanError::DuplicateId);
    }
    Ok(())
}

/// The one tool that declares and moves a plan.
///
/// One tool rather than a `declare` plus a `set_step_status` pair: the model
/// sends the whole plan every time and Rust works out what changed. That costs
/// the model nothing per transition (no extra round trip to mark a step done)
/// and it makes a repeated call idempotent instead of duplicative.
pub(super) fn update_plan_schema() -> Value {
    function_tool(
        TOOL_UPDATE_PLAN,
        "Declare the steps you intend to take, then keep their status current as you \
         go. Send the WHOLE plan every time — the same steps, in the same order, with \
         updated statuses. Use it only for multi-step work (three or more steps); skip \
         it entirely for a direct answer or a single search.",
        json!({
            "type": "object",
            "properties": {
                "steps": {
                    "type": "array",
                    "minItems": 1,
                    "maxItems": MAX_PLAN_STEPS,
                    "items": {
                        "type": "object",
                        "properties": {
                            "id": { "type": "string", "description": "Your own stable id for the step. It cannot change once declared." },
                            "label": { "type": "string", "description": "Short imperative label, e.g. \"Search for spaced repetition notes\"." },
                            "status": {
                                "type": "string",
                                "enum": ["pending", "running", "done", "skipped", "failed"],
                                "default": "pending"
                            }
                        },
                        "required": ["id", "label"],
                        "additionalProperties": false
                    }
                }
            },
            "required": ["steps"],
            "additionalProperties": false
        }),
    )
}

#[derive(Deserialize)]
struct UpdatePlanArgs {
    steps: Vec<PlanStepInput>,
}

/// Fold one `update_plan` call into the run's plan and emit what changed.
///
/// The rejections are the model's to recover from — they come back as ordinary
/// tool-result content, exactly like a malformed argument blob, so a model that
/// tries to re-plan is told why rather than being silently obeyed or silently
/// ignored.
pub(super) fn dispatch_update_plan(args_json: &str, context: &mut ToolContext<'_>) -> ToolResult {
    let args: UpdatePlanArgs = match serde_json::from_str(args_json) {
        Ok(args) => args,
        Err(error) => return reject(format!("invalid update_plan arguments: {error}")),
    };
    let Some(plan) = context.plan.as_deref_mut() else {
        // Reached only by a caller that built a `ToolContext` without wiring a
        // plan. Rejecting says so out loud; a silent success would tell the model
        // its plan was recorded when nothing recorded it.
        return reject("planning is not available in this run".into());
    };
    let update = match plan.update(args.steps) {
        Ok(update) => update,
        Err(error) => return reject(error.message()),
    };
    if let Some(steps) = update.declared {
        context.sink.send(ChatEvent::Plan { steps });
    }
    for (id, status) in update.transitions {
        context.sink.send(ChatEvent::PlanStepStatus { id, status });
    }
    action(json!({ "ok": true }).to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn step(id: &str, label: &str, status: StepStatus) -> PlanStepInput {
        PlanStepInput {
            id: id.into(),
            label: label.into(),
            status,
        }
    }

    #[test]
    fn the_first_call_declares_the_steps_and_reports_no_pending_transitions() {
        let mut plan = RunPlan::default();
        let update = plan
            .update(vec![
                step("s1", "Search the vault", StepStatus::Pending),
                step("s2", "Read the best matches", StepStatus::Pending),
            ])
            .unwrap();

        assert_eq!(
            update.declared,
            Some(vec![
                PlanStep {
                    id: "s1".into(),
                    label: "Search the vault".into()
                },
                PlanStep {
                    id: "s2".into(),
                    label: "Read the best matches".into()
                },
            ])
        );
        // Every declared step is pending by definition, so re-announcing that as
        // a transition would put two rows on the rail saying the same thing.
        assert!(update.transitions.is_empty());
    }

    #[test]
    fn a_first_call_that_already_marks_a_step_running_reports_that_transition() {
        let mut plan = RunPlan::default();
        let update = plan
            .update(vec![
                step("s1", "Search the vault", StepStatus::Running),
                step("s2", "Read the best matches", StepStatus::Pending),
            ])
            .unwrap();

        assert!(update.declared.is_some());
        assert_eq!(update.transitions, vec![("s1".into(), StepStatus::Running)]);
    }

    #[test]
    fn a_later_call_reports_only_the_steps_whose_status_moved() {
        let mut plan = RunPlan::default();
        plan.update(vec![
            step("s1", "Search", StepStatus::Running),
            step("s2", "Read", StepStatus::Pending),
        ])
        .unwrap();

        let update = plan
            .update(vec![
                step("s1", "Search", StepStatus::Done),
                step("s2", "Read", StepStatus::Pending),
            ])
            .unwrap();

        assert_eq!(update.declared, None);
        assert_eq!(update.transitions, vec![("s1".into(), StepStatus::Done)]);
    }

    #[test]
    fn an_unchanged_repeat_emits_nothing_at_all() {
        // A model that re-sends its whole plan on every turn is normal. Emitting
        // a transition per step per turn would bury the rail in duplicates.
        let mut plan = RunPlan::default();
        let steps = vec![
            step("s1", "Search", StepStatus::Done),
            step("s2", "Read", StepStatus::Running),
        ];
        plan.update(steps.clone()).unwrap();

        let update = plan.update(steps).unwrap();
        assert_eq!(update, PlanUpdate::default());
    }

    #[test]
    fn skipped_and_failed_are_reported_as_the_distinct_endings_they_are() {
        let mut plan = RunPlan::default();
        plan.update(vec![
            step("s1", "Search", StepStatus::Pending),
            step("s2", "Transcribe", StepStatus::Pending),
        ])
        .unwrap();

        let update = plan
            .update(vec![
                step("s1", "Search", StepStatus::Skipped),
                step("s2", "Transcribe", StepStatus::Failed),
            ])
            .unwrap();

        assert_eq!(
            update.transitions,
            vec![
                ("s1".into(), StepStatus::Skipped),
                ("s2".into(), StepStatus::Failed),
            ]
        );
    }

    #[test]
    fn a_second_declaration_with_a_different_step_set_is_refused() {
        // Re-declaring would silently re-parent every timeline node already
        // affiliated with a step id, so the model is told to stop instead.
        let mut plan = RunPlan::default();
        plan.update(vec![step("s1", "Search", StepStatus::Pending)])
            .unwrap();

        assert_eq!(
            plan.update(vec![
                step("s1", "Search", StepStatus::Done),
                step("s2", "Read", StepStatus::Pending),
            ]),
            Err(PlanError::StepsChanged)
        );
    }

    #[test]
    fn relabelling_a_step_is_refused_because_the_label_is_what_the_user_reads() {
        let mut plan = RunPlan::default();
        plan.update(vec![step("s1", "Search", StepStatus::Pending)])
            .unwrap();

        assert_eq!(
            plan.update(vec![step(
                "s1",
                "Something else entirely",
                StepStatus::Done
            )]),
            Err(PlanError::StepsChanged)
        );
    }

    #[test]
    fn a_refused_update_leaves_the_declared_plan_untouched() {
        let mut plan = RunPlan::default();
        plan.update(vec![step("s1", "Search", StepStatus::Running)])
            .unwrap();

        let _ = plan.update(vec![step("s9", "Different", StepStatus::Done)]);

        // The original step is still the plan, still running: a rejected call
        // must not half-apply.
        let update = plan
            .update(vec![step("s1", "Search", StepStatus::Done)])
            .unwrap();
        assert_eq!(update.transitions, vec![("s1".into(), StepStatus::Done)]);
    }

    #[test]
    fn an_empty_or_oversized_plan_is_refused() {
        let mut plan = RunPlan::default();
        assert_eq!(plan.update(Vec::new()), Err(PlanError::Empty));

        let too_many = (0..=MAX_PLAN_STEPS)
            .map(|i| step(&format!("s{i}"), "Step", StepStatus::Pending))
            .collect();
        assert_eq!(plan.update(too_many), Err(PlanError::TooMany));
    }

    #[test]
    fn duplicate_ids_are_refused_because_the_id_is_the_correlation_key() {
        let mut plan = RunPlan::default();
        assert_eq!(
            plan.update(vec![
                step("s1", "Search", StepStatus::Pending),
                step("s1", "Read", StepStatus::Pending),
            ]),
            Err(PlanError::DuplicateId)
        );
    }

    #[test]
    fn a_blank_id_or_label_is_refused() {
        let mut plan = RunPlan::default();
        assert_eq!(
            plan.update(vec![step("  ", "Search", StepStatus::Pending)]),
            Err(PlanError::BlankField)
        );
        assert_eq!(
            plan.update(vec![step("s1", " ", StepStatus::Pending)]),
            Err(PlanError::BlankField)
        );
    }

    #[test]
    fn an_undeclared_plan_has_no_running_step() {
        // The common case. `None` here is what makes an unaffiliated tool node
        // ordinary rather than an error to paper over.
        assert_eq!(RunPlan::default().running_step_id(), None);
    }

    #[test]
    fn the_running_step_is_the_one_the_model_marked_running() {
        let mut plan = RunPlan::default();
        plan.update(vec![
            step("s1", "Search", StepStatus::Done),
            step("s2", "Read", StepStatus::Running),
            step("s3", "Answer", StepStatus::Pending),
        ])
        .unwrap();

        assert_eq!(plan.running_step_id(), Some("s2"));
    }

    #[test]
    fn a_plan_with_nothing_running_has_no_running_step() {
        // Between steps — every one declared, none in flight — is a real state,
        // and it is `None`, not the last step that happened to finish.
        let mut plan = RunPlan::default();
        plan.update(vec![
            step("s1", "Search", StepStatus::Done),
            step("s2", "Read", StepStatus::Pending),
        ])
        .unwrap();

        assert_eq!(plan.running_step_id(), None);
    }

    #[test]
    fn two_running_steps_resolve_to_the_first_in_declared_order() {
        let mut plan = RunPlan::default();
        plan.update(vec![
            step("s1", "Search", StepStatus::Running),
            step("s2", "Read", StepStatus::Running),
        ])
        .unwrap();

        assert_eq!(plan.running_step_id(), Some("s1"));
    }

    #[test]
    fn a_step_without_a_status_arrives_pending_rather_than_failing_to_parse() {
        let parsed: Vec<PlanStepInput> =
            serde_json::from_str(r#"[{"id":"s1","label":"Search the vault"}]"#).unwrap();
        assert_eq!(parsed[0].status, StepStatus::Pending);
    }

    #[test]
    fn step_status_serialises_as_camel_case_over_every_state() {
        for (status, expected) in [
            (StepStatus::Pending, "pending"),
            (StepStatus::Running, "running"),
            (StepStatus::Done, "done"),
            (StepStatus::Skipped, "skipped"),
            (StepStatus::Failed, "failed"),
        ] {
            assert_eq!(serde_json::to_value(status).unwrap(), expected);
        }
    }

    #[test]
    fn every_rejection_has_a_message_and_none_of_them_is_blank() {
        for error in [
            PlanError::Empty,
            PlanError::TooMany,
            PlanError::DuplicateId,
            PlanError::BlankField,
            PlanError::StepsChanged,
        ] {
            assert!(
                !error.message().trim().is_empty(),
                "{error:?} had no message"
            );
        }
    }
}
