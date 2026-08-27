//! Ordered activity-journal envelopes for one agentic chat turn.
//!
//! Existing orchestration code still emits [`ChatEvent`]s. This module is the
//! final synchronous boundary that classifies those typed events, adds scoped
//! cycle/activity ownership, assigns a contiguous sequence, and forwards one
//! typed [`AgentActivityEnvelope`] at a time to the host.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::ai::approval::{
    ApprovalDegradedReason, ApprovalReason, ApprovalResolution, ApprovalRule, GatedTool,
};
use crate::ai::cycle_summary::CycleSummaryProtocolIssue;
use crate::ai::events::{
    ChatEvent, ElicitOption, EventSink, PlaylistPosition, TokenUsage, ToolStatus,
};
use crate::ai::plan::{PlanStep, StepStatus};
use crate::ai::write_policy::NoteKind;

/// The wire-schema version implemented by [`AgentActivityEnvelope`].
pub const ACTIVITY_JOURNAL_SCHEMA_VERSION: u16 = 1;

/// One causally ordered item in an agentic turn's activity journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AgentActivityEnvelope {
    pub schema_version: u16,
    pub turn_id: String,
    pub sequence: u64,
    pub cycle_id: Option<String>,
    pub activity_id: Option<String>,
    pub payload: AgentActivityPayload,
}

/// Which model phase produced a Thinking delta.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ThinkingSource {
    ToolTurn,
    FinalAnswer,
}

/// Whether the visible cycle summary came from the model or a bounded host
/// fallback. Legacy [`ChatEvent::SkillStep`] messages never become this type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CycleSummarySource {
    Model,
    Fallback,
}

/// Why a live activity had to be closed by terminal run bookkeeping.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ActivityAbandonReason {
    RunCompleted,
    RunFailed,
}

/// Typed activity-journal payloads. This is deliberately exhaustive over the
/// transitional [`ChatEvent`] protocol: no event is flattened into untyped JSON
/// or smuggled through a generic display string.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum AgentActivityPayload {
    RunStarted,
    CycleStarted {
        round: u32,
        max_rounds: u32,
        playlist: Option<PlaylistPosition>,
    },
    Keepalive,
    ActivityProgress {
        message: String,
    },
    VideoPreview {
        video_id: String,
        title: String,
        duration_secs: Option<u64>,
        channel: Option<String>,
        thumbnail_data_uri: Option<String>,
    },
    SkillActivated {
        id: String,
        name: String,
    },
    /// Host-authored legacy narration. It remains distinct from
    /// [`AgentActivityPayload::CycleSummary`] because text is not provenance.
    HostStatus {
        message: String,
    },
    CycleSummary {
        source: CycleSummarySource,
        message: String,
        protocol_issues: Vec<CycleSummaryProtocolIssue>,
    },
    Elicit {
        id: String,
        question: String,
        options: Vec<ElicitOption>,
        multi_select: bool,
    },
    SkillActivationFailed {
        id: String,
        name: String,
        message: String,
        missing_binary: Option<String>,
    },
    ActivityStarted {
        name: String,
        title: String,
        arguments: String,
        step_id: Option<String>,
    },
    ActivitySettled {
        status: ToolStatus,
        summary: Option<String>,
        detail: Option<String>,
        duration_ms: u64,
    },
    TranscriptSource {
        label: String,
        rel_path: Option<String>,
    },
    PartialRun {
        reason: String,
    },
    NoteWritten {
        rel_path: String,
        kind: NoteKind,
    },
    NoteExists {
        rel_path: String,
        kind: NoteKind,
    },
    NoteEditPreview {
        rel_path: Option<String>,
        kind: Option<NoteKind>,
        body: String,
        complete: bool,
    },
    NoteEditAbandoned {
        reason: String,
    },
    ApprovalChecking,
    ApprovalRequested {
        tool: GatedTool,
        rel_path: Option<String>,
        reason: ApprovalReason,
        expires_in_secs: u32,
    },
    AutoApproved {
        tool: GatedTool,
        rule: ApprovalRule,
    },
    ApprovalResolved {
        decision: ApprovalResolution,
    },
    ApprovalDegraded {
        reason: ApprovalDegradedReason,
    },
    Searching {
        query: String,
    },
    Retrieved {
        query: String,
        hit_count: u32,
    },
    Reading {
        rel_path: String,
        start_line: u32,
        end_line: u32,
    },
    Thinking {
        source: ThinkingSource,
        delta: String,
    },
    Verifying,
    CitationDropped {
        reason: String,
    },
    Answer {
        delta: String,
    },
    AnswerTruncated,
    Citation {
        id: String,
        rel_path: String,
        start_line: u32,
        end_line: u32,
        text: String,
    },
    Coverage {
        searched_terms: Vec<String>,
        notes_read: Vec<String>,
        truncated: bool,
        skipped_files: u32,
    },
    Plan {
        steps: Vec<PlanStep>,
    },
    PlanStepStatus {
        id: String,
        status: StepStatus,
    },
    Usage {
        elapsed_ms: u64,
        tokens_in: Option<u32>,
        tokens_out: Option<u32>,
        model: String,
    },
    ActivityAbandoned {
        reason: ActivityAbandonReason,
    },
    RunFailed {
        message: String,
    },
    RunCompleted,
}

/// Host transport boundary for already-sequenced activity envelopes.
///
/// Implementations must forward synchronously. The sequencer assigns a number
/// and invokes this method in one [`EventSink::send`] call, so there is no async
/// reservation window in which delivery can be reordered.
pub trait ActivityEnvelopeSink: Send {
    fn send(&mut self, envelope: AgentActivityEnvelope);

    /// Metering is not a UI journal event, but wrappers must preserve the
    /// existing [`EventSink`] accounting contract.
    fn record_usage(&mut self, _usage: Option<TokenUsage>) {}
}

/// The current owner for future Thinking deltas.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ThinkingPhase {
    ToolTurn,
    FinalAnswer,
}

/// A live activity and the cycle in which it was first announced.
#[derive(Debug, Clone, PartialEq, Eq)]
struct LiveActivity {
    id: String,
    cycle_id: Option<String>,
}

/// Converts the internal event stream into one ordered envelope stream.
pub struct SequencedActivitySink<S> {
    sink: S,
    turn_id: String,
    next_sequence: u64,
    cycle_counter: u64,
    current_cycle_id: Option<String>,
    thinking_phase: ThinkingPhase,
    live_activities: Vec<LiveActivity>,
}

impl<S: ActivityEnvelopeSink> SequencedActivitySink<S> {
    pub fn new(turn_id: impl Into<String>, sink: S) -> Self {
        Self {
            sink,
            turn_id: turn_id.into(),
            next_sequence: 1,
            cycle_counter: 0,
            current_cycle_id: None,
            thinking_phase: ThinkingPhase::ToolTurn,
            live_activities: Vec::new(),
        }
    }

    /// Mark subsequent Thinking as final-answer reasoning. The orchestrator can
    /// call this immediately before its existing final-answer stream without
    /// manufacturing a visible cycle.
    pub fn begin_final_answer(&mut self) {
        self.thinking_phase = ThinkingPhase::FinalAnswer;
        self.current_cycle_id = None;
    }

    pub fn into_inner(self) -> S {
        self.sink
    }

    fn allocate_cycle(&mut self) -> String {
        self.cycle_counter = self
            .cycle_counter
            .checked_add(1)
            .expect("activity journal cycle counter overflowed");
        self.thinking_phase = ThinkingPhase::ToolTurn;
        // The identity is intentionally opaque to the renderer. It is unique
        // only within this turn; the envelope's turn id supplies the outer scope.
        format!("cycle-{:016x}", self.cycle_counter)
    }

    fn emit(
        &mut self,
        cycle_id: Option<String>,
        activity_id: Option<String>,
        payload: AgentActivityPayload,
    ) {
        let sequence = self.next_sequence;
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .expect("activity journal sequence overflowed");
        self.sink.send(AgentActivityEnvelope {
            schema_version: ACTIVITY_JOURNAL_SCHEMA_VERSION,
            turn_id: self.turn_id.clone(),
            sequence,
            cycle_id,
            activity_id,
            payload,
        });
    }

    fn live_cycle(&self, activity_id: &str) -> Option<String> {
        self.live_activities
            .iter()
            .find(|activity| activity.id == activity_id)
            .and_then(|activity| activity.cycle_id.clone())
            .or_else(|| self.current_cycle_id.clone())
    }

    fn track_live(&mut self, activity_id: &str, cycle_id: Option<String>) {
        if self
            .live_activities
            .iter()
            .any(|activity| activity.id == activity_id)
        {
            return;
        }
        self.live_activities.push(LiveActivity {
            id: activity_id.to_owned(),
            cycle_id,
        });
    }

    fn settle_live(&mut self, activity_id: &str) {
        self.live_activities
            .retain(|activity| activity.id != activity_id);
    }

    fn abandon_live(&mut self, reason: ActivityAbandonReason) {
        let live = std::mem::take(&mut self.live_activities);
        for activity in live {
            self.emit(
                activity.cycle_id,
                Some(activity.id),
                AgentActivityPayload::ActivityAbandoned { reason },
            );
        }
    }

    fn keyed_scope(&self, activity_id: String) -> (Option<String>, Option<String>) {
        (self.live_cycle(&activity_id), Some(activity_id))
    }

    fn cycle_scope(&self) -> (Option<String>, Option<String>) {
        (self.current_cycle_id.clone(), None)
    }

    fn run_scope() -> (Option<String>, Option<String>) {
        (None, None)
    }

    fn classify(
        &mut self,
        event: ChatEvent,
    ) -> (Option<String>, Option<String>, AgentActivityPayload) {
        match event {
            ChatEvent::Processing => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::RunStarted)
            }
            ChatEvent::PlanningRound {
                round,
                max_rounds,
                playlist,
            } => {
                let cycle_id = self.allocate_cycle();
                self.current_cycle_id = Some(cycle_id.clone());
                (
                    Some(cycle_id),
                    None,
                    AgentActivityPayload::CycleStarted {
                        round,
                        max_rounds,
                        playlist,
                    },
                )
            }
            ChatEvent::Keepalive => {
                let (cycle, activity) = self.cycle_scope();
                (cycle, activity, AgentActivityPayload::Keepalive)
            }
            ChatEvent::ToolProgress { id, message } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::ActivityProgress { message },
                )
            }
            ChatEvent::VideoPreview {
                id,
                video_id,
                title,
                duration_secs,
                channel,
                thumbnail_data_uri,
            } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::VideoPreview {
                        video_id,
                        title,
                        duration_secs,
                        channel,
                        thumbnail_data_uri,
                    },
                )
            }
            ChatEvent::SkillActivated { id, name } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::SkillActivated { id, name },
                )
            }
            ChatEvent::SkillStep { message } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::HostStatus { message },
                )
            }
            ChatEvent::CycleSummary {
                source,
                message,
                protocol_issues,
            } => {
                let (cycle, activity) = self.cycle_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::CycleSummary {
                        source,
                        message,
                        protocol_issues,
                    },
                )
            }
            ChatEvent::Elicit {
                activity_id,
                id,
                question,
                options,
                multi_select,
            } => {
                let (cycle, activity) = self.keyed_scope(activity_id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Elicit {
                        id,
                        question,
                        options,
                        multi_select,
                    },
                )
            }
            ChatEvent::SkillActivationFailed {
                id,
                name,
                message,
                missing_binary,
            } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::SkillActivationFailed {
                        id,
                        name,
                        message,
                        missing_binary,
                    },
                )
            }
            ChatEvent::ToolCall {
                id,
                name,
                title,
                arguments,
                step_id,
            } => {
                let cycle = self.live_cycle(&id);
                self.track_live(&id, cycle.clone());
                (
                    cycle,
                    Some(id),
                    AgentActivityPayload::ActivityStarted {
                        name,
                        title,
                        arguments,
                        step_id,
                    },
                )
            }
            ChatEvent::ToolResult {
                id,
                status,
                summary,
                detail,
                duration_ms,
            } => {
                let cycle = self.live_cycle(&id);
                self.settle_live(&id);
                (
                    cycle,
                    Some(id),
                    AgentActivityPayload::ActivitySettled {
                        status,
                        summary,
                        detail,
                        duration_ms,
                    },
                )
            }
            ChatEvent::TranscriptSource {
                id,
                label,
                rel_path,
            } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::TranscriptSource { label, rel_path },
                )
            }
            ChatEvent::PartialRun { reason } => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::PartialRun { reason })
            }
            ChatEvent::NoteWritten { id, rel_path, kind } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::NoteWritten { rel_path, kind },
                )
            }
            ChatEvent::NoteExists { id, rel_path, kind } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::NoteExists { rel_path, kind },
                )
            }
            ChatEvent::NoteEditPreview {
                id,
                rel_path,
                kind,
                body,
                complete,
            } => {
                let cycle = self.live_cycle(&id);
                self.track_live(&id, cycle.clone());
                (
                    cycle,
                    Some(id),
                    AgentActivityPayload::NoteEditPreview {
                        rel_path,
                        kind,
                        body,
                        complete,
                    },
                )
            }
            ChatEvent::NoteEditAbandoned { id, reason } => {
                let cycle = self.live_cycle(&id);
                self.settle_live(&id);
                (
                    cycle,
                    Some(id),
                    AgentActivityPayload::NoteEditAbandoned { reason },
                )
            }
            ChatEvent::ToolApprovalChecking { id } => {
                let (cycle, activity) = self.keyed_scope(id);
                (cycle, activity, AgentActivityPayload::ApprovalChecking)
            }
            ChatEvent::ToolApprovalRequested {
                id,
                tool,
                rel_path,
                reason,
                expires_in_secs,
            } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::ApprovalRequested {
                        tool,
                        rel_path,
                        reason,
                        expires_in_secs,
                    },
                )
            }
            ChatEvent::ToolAutoApproved { id, tool, rule } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::AutoApproved { tool, rule },
                )
            }
            ChatEvent::ToolApprovalResolved { id, decision } => {
                let (cycle, activity) = self.keyed_scope(id);
                (
                    cycle,
                    activity,
                    AgentActivityPayload::ApprovalResolved { decision },
                )
            }
            ChatEvent::ToolApprovalDegraded { reason } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::ApprovalDegraded { reason },
                )
            }
            ChatEvent::Searching { query, call_id } => {
                let (cycle, activity) =
                    call_id.map_or_else(|| self.cycle_scope(), |id| self.keyed_scope(id));
                (cycle, activity, AgentActivityPayload::Searching { query })
            }
            ChatEvent::Retrieved {
                query,
                hit_count,
                call_id,
            } => {
                let (cycle, activity) =
                    call_id.map_or_else(|| self.cycle_scope(), |id| self.keyed_scope(id));
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Retrieved { query, hit_count },
                )
            }
            ChatEvent::Reading {
                rel_path,
                start_line,
                end_line,
                call_id,
            } => {
                let (cycle, activity) =
                    call_id.map_or_else(|| self.cycle_scope(), |id| self.keyed_scope(id));
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Reading {
                        rel_path,
                        start_line,
                        end_line,
                    },
                )
            }
            ChatEvent::Thinking { delta } => match self.thinking_phase {
                ThinkingPhase::ToolTurn => (
                    self.current_cycle_id.clone(),
                    None,
                    AgentActivityPayload::Thinking {
                        source: ThinkingSource::ToolTurn,
                        delta,
                    },
                ),
                ThinkingPhase::FinalAnswer => (
                    None,
                    None,
                    AgentActivityPayload::Thinking {
                        source: ThinkingSource::FinalAnswer,
                        delta,
                    },
                ),
            },
            ChatEvent::Verifying => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::Verifying)
            }
            ChatEvent::CitationDropped { reason } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::CitationDropped { reason },
                )
            }
            ChatEvent::Answer { delta } => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::Answer { delta })
            }
            ChatEvent::AnswerTruncated => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::AnswerTruncated)
            }
            ChatEvent::Citation {
                id,
                rel_path,
                start_line,
                end_line,
                text,
            } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Citation {
                        id,
                        rel_path,
                        start_line,
                        end_line,
                        text,
                    },
                )
            }
            ChatEvent::Coverage {
                searched_terms,
                notes_read,
                truncated,
                skipped_files,
            } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Coverage {
                        searched_terms,
                        notes_read,
                        truncated,
                        skipped_files,
                    },
                )
            }
            ChatEvent::Plan { steps } => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::Plan { steps })
            }
            ChatEvent::PlanStepStatus { id, status } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::PlanStepStatus { id, status },
                )
            }
            ChatEvent::Usage {
                elapsed_ms,
                tokens_in,
                tokens_out,
                model,
            } => {
                let (cycle, activity) = Self::run_scope();
                (
                    cycle,
                    activity,
                    AgentActivityPayload::Usage {
                        elapsed_ms,
                        tokens_in,
                        tokens_out,
                        model,
                    },
                )
            }
            ChatEvent::Error { message } => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::RunFailed { message })
            }
            ChatEvent::Done => {
                let (cycle, activity) = Self::run_scope();
                (cycle, activity, AgentActivityPayload::RunCompleted)
            }
        }
    }
}

impl<S: ActivityEnvelopeSink> EventSink for SequencedActivitySink<S> {
    fn send(&mut self, event: ChatEvent) {
        let terminal_reason = match &event {
            ChatEvent::Error { .. } => Some(ActivityAbandonReason::RunFailed),
            ChatEvent::Done => Some(ActivityAbandonReason::RunCompleted),
            _ => None,
        };
        if let Some(reason) = terminal_reason {
            self.abandon_live(reason);
        }
        let (cycle_id, activity_id, payload) = self.classify(event);
        self.emit(cycle_id, activity_id, payload);
    }

    fn begin_final_answer(&mut self) {
        SequencedActivitySink::begin_final_answer(self);
    }

    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        self.sink.record_usage(usage);
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;
    use crate::ai::events::{ChatEvent, EventSink, ToolStatus};
    use crate::ai::write_policy::NoteKind;

    #[derive(Debug, Default)]
    struct CollectingEnvelopeSink {
        envelopes: Vec<AgentActivityEnvelope>,
        usage: Vec<Option<TokenUsage>>,
    }

    impl ActivityEnvelopeSink for CollectingEnvelopeSink {
        fn send(&mut self, envelope: AgentActivityEnvelope) {
            self.envelopes.push(envelope);
        }

        fn record_usage(&mut self, usage: Option<TokenUsage>) {
            self.usage.push(usage);
        }
    }

    fn collected(sink: SequencedActivitySink<CollectingEnvelopeSink>) -> CollectingEnvelopeSink {
        sink.into_inner()
    }

    #[test]
    fn envelope_v1_serializes_as_a_typed_camel_case_contract() {
        let envelope = AgentActivityEnvelope {
            schema_version: ACTIVITY_JOURNAL_SCHEMA_VERSION,
            turn_id: "turn-7".into(),
            sequence: 4,
            cycle_id: Some("opaque-cycle".into()),
            activity_id: None,
            payload: AgentActivityPayload::HostStatus {
                message: "Preparing the workspace".into(),
            },
        };

        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({
                "schemaVersion": 1,
                "turnId": "turn-7",
                "sequence": 4,
                "cycleId": "opaque-cycle",
                "activityId": null,
                "payload": {
                    "type": "hostStatus",
                    "message": "Preparing the workspace",
                },
            })
        );
    }

    #[test]
    fn one_sink_assigns_contiguous_one_based_sequences_synchronously() {
        let mut sink = SequencedActivitySink::new("turn-a", CollectingEnvelopeSink::default());

        sink.send(ChatEvent::Processing);
        sink.send(ChatEvent::Keepalive);
        sink.send(ChatEvent::Done);

        let envelopes = collected(sink).envelopes;
        assert_eq!(
            envelopes
                .iter()
                .map(|envelope| envelope.sequence)
                .collect::<Vec<_>>(),
            vec![1, 2, 3]
        );
        assert!(envelopes
            .iter()
            .all(|envelope| envelope.turn_id == "turn-a"));
    }

    #[test]
    fn separate_turn_sinks_restart_their_sequences_at_one() {
        let mut first = SequencedActivitySink::new("turn-a", CollectingEnvelopeSink::default());
        let mut second = SequencedActivitySink::new("turn-b", CollectingEnvelopeSink::default());

        first.send(ChatEvent::Processing);
        first.send(ChatEvent::Keepalive);
        second.send(ChatEvent::Processing);

        assert_eq!(collected(first).envelopes[0].sequence, 1);
        assert_eq!(collected(second).envelopes[0].sequence, 1);
    }

    #[test]
    fn planning_round_allocates_an_opaque_cycle_owned_by_tool_thinking() {
        let mut sink = SequencedActivitySink::new("turn-cycle", CollectingEnvelopeSink::default());

        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::Thinking {
            delta: "inspect".into(),
        });
        sink.send(ChatEvent::PlanningRound {
            round: 2,
            max_rounds: 8,
            playlist: None,
        });

        let envelopes = collected(sink).envelopes;
        let first_cycle = envelopes[0].cycle_id.as_deref().unwrap();
        assert!(!first_cycle.is_empty());
        assert_eq!(envelopes[1].cycle_id.as_deref(), Some(first_cycle));
        assert!(matches!(
            envelopes[1].payload,
            AgentActivityPayload::Thinking {
                source: ThinkingSource::ToolTurn,
                ..
            }
        ));
        assert_ne!(envelopes[2].cycle_id, envelopes[0].cycle_id);
    }

    #[test]
    fn explicit_final_answer_lifecycle_removes_cycle_ownership_from_thinking() {
        let mut sink = SequencedActivitySink::new("turn-final", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });

        sink.begin_final_answer();
        sink.send(ChatEvent::Thinking {
            delta: "compose".into(),
        });

        let envelopes = collected(sink).envelopes;
        assert_eq!(envelopes[1].cycle_id, None);
        assert_eq!(envelopes[1].activity_id, None);
        assert!(matches!(
            envelopes[1].payload,
            AgentActivityPayload::Thinking {
                source: ThinkingSource::FinalAnswer,
                ..
            }
        ));
    }

    #[test]
    fn currently_keyed_activity_events_reuse_the_provider_call_id() {
        let mut sink =
            SequencedActivitySink::new("turn-activity", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::ToolProgress {
            id: "call-1".into(),
            message: "Fetching captions".into(),
        });
        sink.send(ChatEvent::VideoPreview {
            id: "call-1".into(),
            video_id: "abcdefghijk".into(),
            title: "Preview".into(),
            duration_secs: None,
            channel: None,
            thumbnail_data_uri: None,
        });
        sink.send(ChatEvent::NoteEditPreview {
            id: "call-1".into(),
            rel_path: Some("Notes/video.md".into()),
            kind: Some(NoteKind::Literature),
            body: "Draft".into(),
            complete: false,
        });
        sink.send(ChatEvent::ToolApprovalChecking {
            id: "call-1".into(),
        });
        sink.send(ChatEvent::TranscriptSource {
            id: "call-1".into(),
            label: "captions:en".into(),
            rel_path: None,
        });
        sink.send(ChatEvent::NoteWritten {
            id: "call-1".into(),
            rel_path: "Notes/video.md".into(),
            kind: NoteKind::Literature,
        });
        sink.send(ChatEvent::NoteExists {
            id: "call-1".into(),
            rel_path: "Notes/existing.md".into(),
            kind: NoteKind::Atomic,
        });
        sink.send(ChatEvent::ToolResult {
            id: "call-1".into(),
            status: ToolStatus::Ok,
            summary: Some("Written".into()),
            detail: None,
            duration_ms: 12,
        });

        let envelopes = collected(sink).envelopes;
        for envelope in &envelopes[1..] {
            assert_eq!(envelope.activity_id.as_deref(), Some("call-1"));
            assert_eq!(envelope.cycle_id, envelopes[0].cycle_id);
        }
    }

    #[test]
    fn implementation_authored_elicitation_keeps_prompt_id_but_owns_the_tool_activity() {
        let mut sink = SequencedActivitySink::new("turn-elicit", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::ToolCall {
            id: "call-youtube".into(),
            name: "distil_youtube".into(),
            title: "Distil YouTube".into(),
            arguments: "{}".into(),
            step_id: None,
        });
        sink.send(ChatEvent::Elicit {
            id: "call-youtube:install-whisper".into(),
            activity_id: "call-youtube".into(),
            question: "Install Whisper?".into(),
            options: vec![ElicitOption {
                id: "install".into(),
                label: "Install".into(),
                description: None,
                image_data_uri: None,
            }],
            multi_select: false,
        });

        let envelope = collected(sink).envelopes.pop().unwrap();
        assert_eq!(envelope.activity_id.as_deref(), Some("call-youtube"));
        assert!(matches!(
            envelope.payload,
            AgentActivityPayload::Elicit { id, .. }
                if id == "call-youtube:install-whisper"
        ));
    }

    #[test]
    fn run_level_usage_error_and_completion_never_inherit_activity_or_cycle_ids() {
        for terminal in [
            ChatEvent::Usage {
                elapsed_ms: 12,
                tokens_in: Some(3),
                tokens_out: Some(4),
                model: "local".into(),
            },
            ChatEvent::Error {
                message: "provider unavailable".into(),
            },
            ChatEvent::Done,
        ] {
            let mut sink =
                SequencedActivitySink::new("turn-run", CollectingEnvelopeSink::default());
            sink.send(ChatEvent::PlanningRound {
                round: 1,
                max_rounds: 8,
                playlist: None,
            });
            sink.send(terminal);

            let envelope = collected(sink).envelopes.pop().unwrap();
            assert_eq!(envelope.cycle_id, None);
            assert_eq!(envelope.activity_id, None);
        }
    }

    #[test]
    fn terminal_run_abandons_every_still_live_activity_before_settling() {
        let mut sink =
            SequencedActivitySink::new("turn-terminal", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::ToolCall {
            id: "call-live".into(),
            name: "search_notes".into(),
            title: "Search notes".into(),
            arguments: r#"{"query":"journal"}"#.into(),
            step_id: None,
        });
        sink.send(ChatEvent::Done);

        let envelopes = collected(sink).envelopes;
        assert_eq!(envelopes.len(), 4);
        assert_eq!(envelopes[2].sequence, 3);
        assert_eq!(envelopes[2].activity_id.as_deref(), Some("call-live"));
        assert!(matches!(
            envelopes[2].payload,
            AgentActivityPayload::ActivityAbandoned {
                reason: ActivityAbandonReason::RunCompleted,
            }
        ));
        assert!(matches!(
            envelopes[3].payload,
            AgentActivityPayload::RunCompleted
        ));
        assert_eq!(envelopes[3].activity_id, None);
    }

    #[test]
    fn legacy_skill_step_is_host_status_and_never_a_cycle_summary() {
        let mut sink = SequencedActivitySink::new("turn-status", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::SkillStep {
            message: "Downloading helper".into(),
        });

        let envelope = collected(sink).envelopes.pop().unwrap();
        assert_eq!(envelope.cycle_id, None);
        assert_eq!(envelope.activity_id, None);
        assert!(matches!(
            envelope.payload,
            AgentActivityPayload::HostStatus { .. }
        ));
        assert!(!matches!(
            envelope.payload,
            AgentActivityPayload::CycleSummary { .. }
        ));
    }

    #[test]
    fn typed_cycle_summary_keeps_cycle_scope_and_protocol_details() {
        let mut sink =
            SequencedActivitySink::new("turn-summary", CollectingEnvelopeSink::default());
        sink.send(ChatEvent::PlanningRound {
            round: 1,
            max_rounds: 8,
            playlist: None,
        });
        sink.send(ChatEvent::CycleSummary {
            source: CycleSummarySource::Fallback,
            message: "Continuing with the next step.".into(),
            protocol_issues: vec![crate::ai::CycleSummaryProtocolIssue::Missing],
        });

        let envelope = collected(sink).envelopes.pop().unwrap();
        assert!(envelope.cycle_id.is_some());
        assert_eq!(envelope.activity_id, None);
        assert!(matches!(
            envelope.payload,
            AgentActivityPayload::CycleSummary {
                source: CycleSummarySource::Fallback,
                protocol_issues,
                ..
            } if protocol_issues == [crate::ai::CycleSummaryProtocolIssue::Missing]
        ));
    }

    #[test]
    fn cycle_summary_protocol_issue_exports_as_a_tagged_typescript_union() {
        let declaration = crate::ai::CycleSummaryProtocolIssue::decl(&ts_rs::Config::default());
        assert!(
            declaration.contains("\"kind\": \"malformedArguments\""),
            "{declaration}"
        );
        assert!(
            declaration.contains("\"kind\": \"additional\""),
            "{declaration}"
        );
        assert!(declaration.contains("count: number"), "{declaration}");
    }

    #[test]
    fn usage_measurements_are_forwarded_without_becoming_journal_events() {
        let mut sink = SequencedActivitySink::new("turn-meter", CollectingEnvelopeSink::default());
        let usage = TokenUsage {
            tokens_in: 5,
            tokens_out: 8,
        };

        sink.record_usage(Some(usage));

        let inner = collected(sink);
        assert!(inner.envelopes.is_empty());
        assert_eq!(inner.usage, vec![Some(usage)]);
    }
}
