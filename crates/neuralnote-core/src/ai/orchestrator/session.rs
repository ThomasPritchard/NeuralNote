//! One chat run: skill preload, evidence collection, streamed answer, citations.

use super::citations::extract_cited_ids;
use super::collect::EvidenceCollection;
use super::coverage::{emit_coverage, CoverageAcc};
use super::history::{prepare_final_answer_messages, prepare_history};
use super::prompt::system_prompt;
use super::services::SkillServices;
use super::usage::ThinkingCounter;
use super::{context_budget::fit_prompt_to_window, Guards, PARTIAL_RUN_GUARD_TRIPPED};
use crate::ai::approval::ApprovalGate;
use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::evidence::EvidenceRegistry;
use crate::ai::llm::{LlmClient, LlmMessage, LlmRequest};
use crate::ai::plan::RunPlan;
use crate::ai::retrieval::RetrievalProvider;
use crate::ai::skill_activation::{activation_failure_message, skill_activation_failed};
use crate::ai::skills::ActiveSkills;
use crate::ai::verify::CitationVerifier;
use crate::ai::write_policy::WriteSession;
use crate::ai::youtube::YoutubeToolSession;
use crate::error::CoreResult;
use std::path::Path;

/// The collaborators for one run, bundled so the loop's helpers stay small.
pub(super) struct ChatSession<'a> {
    pub(super) root: &'a Path,
    pub(super) model: &'a str,
    pub(super) provider: &'a dyn RetrievalProvider,
    pub(super) llm: &'a dyn LlmClient,
    pub(super) skill_services: &'a SkillServices<'a>,
    pub(super) guards: &'a Guards,
}

impl ChatSession<'_> {
    pub(super) async fn drive(
        &self,
        user_input: &str,
        history: &[LlmMessage],
        preloaded_skills: &[String],
        writes: &mut WriteSession,
        gate: &mut ApprovalGate,
        sink: &mut dyn EventSink,
    ) -> CoreResult<()> {
        // Sanitise history in the core (strip stale `[eN]` markers, window to a char
        // budget) so the grounding rules + evidence can't be silently front-truncated
        // out of a local model's context window, and a stale marker can't mis-cite —
        // regardless of which client built the history. See `prepare_history`.
        let history = prepare_history(history);
        let mut messages = Vec::with_capacity(history.len() + preloaded_skills.len() + 2);
        messages.push(LlmMessage::system(system_prompt(
            self.skill_services.registry,
        )));
        let mut active_skills = ActiveSkills::new(self.guards.max_iterations);
        for id in preloaded_skills {
            let activation = match active_skills.activate(
                id,
                self.skill_services.registry,
                self.skill_services.environment,
            ) {
                Ok(activation) => activation,
                Err(error) => {
                    sink.send(ChatEvent::SkillStep {
                        message: activation_failure_message(id, &error),
                    });
                    sink.send(skill_activation_failed(
                        id,
                        &error,
                        self.skill_services.registry,
                        self.skill_services.environment,
                    ));
                    // A preload has no genuine tool-call id. Preserve protocol order
                    // with system context carrying the same recoverable JSON error a
                    // rejected `use_skill` call would return, then continue ungranted.
                    messages.push(LlmMessage::system(format!(
                        "A preloaded skill could not be activated; continue without it.\n{}",
                        serde_json::json!({ "error": error })
                    )));
                    continue;
                }
            };
            if activation.newly_activated {
                sink.send(ChatEvent::SkillActivated {
                    id: activation.manifest.id.clone(),
                    name: activation.manifest.name.clone(),
                });
                // Preloads have no genuine tool-call id, so instructions enter as a
                // system turn. Synthesising assistant/tool messages would violate
                // the chat protocol; activation policy and grants remain shared.
                messages.push(LlmMessage::system(format!(
                    "Activated skill `{}`:\n\n{}",
                    activation.manifest.id, activation.manifest.instructions
                )));
            }
        }
        messages.extend(history);
        messages.push(LlmMessage::user(user_input));

        let mut registry = EvidenceRegistry::new();
        let mut coverage = CoverageAcc::default();
        let mut youtube_session = YoutubeToolSession::new_with_update_session(
            self.skill_services.capture_cancellation.clone(),
            self.skill_services.extractor_updates.clone(),
        );
        // Empty unless the model declares one. Nothing below requires a plan — a
        // run without one is the common case, and it renders exactly as it did
        // before plans existed.
        let mut plan = RunPlan::default();
        let collection = self
            .collect_evidence(
                &mut messages,
                &mut active_skills,
                writes,
                &mut youtube_session,
                &mut plan,
                &mut registry,
                &mut coverage,
                gate,
                sink,
            )
            .await?;
        let guard_tripped = match collection {
            EvidenceCollection::Answer { guard_tripped } => guard_tripped,
            EvidenceCollection::CompleteTurn => {
                sink.send(ChatEvent::Done);
                return Ok(());
            }
        };
        // The loop stopped the model mid-work. That is authoritative here — the UI
        // must never have to infer it from an answer that merely says "partial".
        if guard_tripped {
            sink.send(ChatEvent::PartialRun {
                reason: PARTIAL_RUN_GUARD_TRIPPED.to_string(),
            });
        }

        // Verify + answer phase. Verifying is the UI cue that the answer is being
        // grounded; the actual citation checks run once we have the streamed text.
        sink.send(ChatEvent::Verifying);
        // A fresh streaming generation produces the final answer. It re-generates
        // rather than reusing the loop's last (non-streamed) turn — the deliberate
        // cost of keeping tool-parsing non-streamed while the answer streams live.
        // No tools are advertised on this turn. Remove the protocol-level assistant
        // tool calls and `role:tool` results too: some providers stay in tool mode when
        // those turns remain in history even though the current request has no schemas.
        // Result content stays available as explicitly untrusted assistant context, so
        // evidence and failure details survive without priming another tool call.
        // The answer turn carries all accumulated evidence, so it is the send most
        // likely to overflow a small local window — budget it before streaming.
        let final_messages = prepare_final_answer_messages(&messages);
        let budgeted = fit_prompt_to_window(
            &final_messages,
            self.model,
            self.llm.context_window_tokens(),
        );
        coverage.truncated |= budgeted.lost;
        let (answer, thinking_count) = {
            let mut counting_sink = ThinkingCounter {
                inner: sink,
                count: 0,
            };
            let answer = self
                .stream_final_answer(&budgeted.messages, &mut counting_sink)
                .await?;
            (answer, counting_sink.count)
        };

        if answer.trim().is_empty() {
            let message = if thinking_count > 0 {
                "the model returned only reasoning and no answer — try again or switch model"
            } else {
                "the model returned an empty answer"
            };
            // Don't let the empty-answer return drop the truncation/skip signal — a
            // tripped guard is often WHY the answer came back empty. emit_coverage
            // otherwise runs only on the success path below; surface it here too, but
            // only when it carries that signal, so a plain searched-but-empty turn
            // stays a bare Error (whitespace_only_answer_after_search_emits_error_and_stops).
            if guard_tripped || coverage.truncated || coverage.skipped_files > 0 {
                emit_coverage(coverage, guard_tripped, sink);
            }
            sink.send(ChatEvent::Error {
                message: message.to_string(),
            });
            return Ok(());
        }

        self.emit_citations(&answer, &registry, sink);
        emit_coverage(coverage, guard_tripped, sink);
        sink.send(ChatEvent::Done);
        Ok(())
    }

    pub(super) fn request(
        &self,
        messages: &[LlmMessage],
        tools: &[serde_json::Value],
    ) -> LlmRequest {
        LlmRequest {
            model: self.model.to_string(),
            messages: messages.to_vec(),
            tools: tools.to_vec(),
        }
    }

    async fn stream_final_answer(
        &self,
        messages: &[LlmMessage],
        sink: &mut dyn EventSink,
    ) -> CoreResult<String> {
        self.llm
            .complete_streaming(&self.request(messages, &[]), sink)
            .await
    }

    /// Verify each evidence id the answer cited and emit a `Citation` for survivors,
    /// a `CitationDropped` (with reason) for the rest — a wrong citation is worse
    /// than no answer.
    fn emit_citations(&self, answer: &str, registry: &EvidenceRegistry, sink: &mut dyn EventSink) {
        let verifier = CitationVerifier::new(self.root);
        for id in extract_cited_ids(answer) {
            match registry.get(&id) {
                None => sink.send(ChatEvent::CitationDropped {
                    reason: format!("the answer cited an unknown evidence id '{id}'"),
                }),
                Some(span) => match verifier.verify(span) {
                    Ok(()) => sink.send(ChatEvent::Citation {
                        id: span.id.clone(),
                        rel_path: span.rel_path.clone(),
                        start_line: span.start_line,
                        end_line: span.end_line,
                        text: span.text.clone(),
                    }),
                    Err(reason) => sink.send(ChatEvent::CitationDropped { reason }),
                },
            }
        }
    }
}
