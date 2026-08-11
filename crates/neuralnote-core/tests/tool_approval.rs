//! Behaviour of the tool-approval gate: the three modes, the unconditional floor
//! inside `ApproveForMe`, the local-lane guard, the within-run verdict cache, and
//! the consent-fatigue counter.
//!
//! The adversarial corpus (groups A–F) lives next door in
//! `tool_approval_adversarial.rs`. This file is the "does it behave" half.

use futures::executor::block_on;
use neuralnote_core::ai::approval::{
    decide, ApprovalAnswer, ApprovalClassifier, ApprovalContext, ApprovalDecision,
    ApprovalDegradedReason, ApprovalGate, ApprovalMode, ApprovalPolicy, ApprovalPrompt,
    ApprovalPromptRequest, ApprovalReason, ApprovalResolution, ApprovalRule, ClassifierVerdict,
    DenyingApprovalPrompt, GatedTool, Reversibility, ToolApprovalSubject, ALL_GATED_TOOLS,
};
use neuralnote_core::ai::{ChatEvent, EventSink, ToolCall};
use neuralnote_core::{CoreError, CoreResult};
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Mutex;

/* ─────────────────────────────  test doubles  ───────────────────────────── */

#[derive(Default)]
pub struct VecSink(pub Vec<ChatEvent>);

impl EventSink for VecSink {
    fn send(&mut self, event: ChatEvent) {
        self.0.push(event);
    }
}

/// A judge that counts how often it was reached.
///
/// The count is the point: several claims in this design are that the judge is
/// **unreachable** for a class of call, not that its answer was overridden.
/// Those are different properties and only the counter tells them apart.
pub struct SpyClassifier {
    calls: AtomicUsize,
    verdicts: Mutex<Vec<CoreResult<ClassifierVerdict>>>,
    subjects: Mutex<Vec<ToolApprovalSubject>>,
}

impl SpyClassifier {
    fn new(verdicts: Vec<CoreResult<ClassifierVerdict>>) -> Self {
        Self {
            calls: AtomicUsize::new(0),
            verdicts: Mutex::new(verdicts),
            subjects: Mutex::new(Vec::new()),
        }
    }

    fn always(verdict: ClassifierVerdict) -> Self {
        Self::new(vec![Ok(verdict); 16])
    }

    fn always_failing() -> Self {
        Self::new(Vec::new())
    }

    pub fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }

    pub fn subjects(&self) -> Vec<ToolApprovalSubject> {
        self.subjects.lock().unwrap().clone()
    }
}

#[async_trait::async_trait]
impl ApprovalClassifier for SpyClassifier {
    async fn classify(&self, subject: &ToolApprovalSubject) -> CoreResult<ClassifierVerdict> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.subjects.lock().unwrap().push(subject.clone());
        let mut queued = self.verdicts.lock().unwrap();
        if queued.is_empty() {
            // The judge's budget expired, or the provider was down. Either way it
            // is an error, and an error must never become an allow.
            return Err(CoreError::Llm("the judge did not answer in time".into()));
        }
        queued.remove(0)
    }
}

/// A scripted approval sheet that records every request it was shown.
pub struct ScriptedPrompt {
    answers: Mutex<Vec<ApprovalAnswer>>,
    seen: Mutex<Vec<ApprovalPromptRequest>>,
}

impl ScriptedPrompt {
    fn new(answers: Vec<ApprovalAnswer>) -> Self {
        Self {
            answers: Mutex::new(answers),
            seen: Mutex::new(Vec::new()),
        }
    }

    fn always(answer: ApprovalAnswer) -> Self {
        Self::new(vec![answer; 16])
    }

    pub fn seen(&self) -> Vec<ApprovalPromptRequest> {
        self.seen.lock().unwrap().clone()
    }

    pub fn asked(&self) -> usize {
        self.seen.lock().unwrap().len()
    }
}

#[async_trait::async_trait]
impl ApprovalPrompt for ScriptedPrompt {
    async fn ask_approval(&self, request: &ApprovalPromptRequest) -> CoreResult<ApprovalAnswer> {
        self.seen.lock().unwrap().push(request.clone());
        let mut queued = self.answers.lock().unwrap();
        if queued.is_empty() {
            return Err(CoreError::Io("the approval channel closed".into()));
        }
        Ok(queued.remove(0))
    }
}

/* ─────────────────────────────  fixtures  ───────────────────────────── */

fn vault() -> tempfile::TempDir {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("Notes")).unwrap();
    std::fs::write(dir.path().join("Notes/Existing.md"), "already here").unwrap();
    dir
}

pub fn write_call(id: &str, rel_path: &str, content: &str) -> ToolCall {
    ToolCall {
        id: id.into(),
        name: GatedTool::WriteNote.name().into(),
        arguments: serde_json::json!({
            "rel_path": rel_path,
            "content": content,
            "kind": "atomic",
        })
        .to_string(),
    }
}

fn call_for(tool: GatedTool) -> ToolCall {
    match tool {
        GatedTool::WriteNote => write_call("call-1", "Notes/New.md", "body"),
        other => ToolCall {
            id: "call-1".into(),
            name: other.name().into(),
            arguments: r#"{"url":"https://example.invalid/watch?v=abc"}"#.into(),
        },
    }
}

fn policy(mode: ApprovalMode, classifier_available: bool) -> ApprovalPolicy {
    ApprovalPolicy::new(mode, BTreeMap::new(), classifier_available)
}

/// Run one call through the gate and return the decision plus the events.
fn run(
    gate: &mut ApprovalGate,
    root: &Path,
    classifier: &dyn ApprovalClassifier,
    prompt: &dyn ApprovalPrompt,
    call: &ToolCall,
    writes_remaining: usize,
) -> (ApprovalDecision, Vec<ChatEvent>) {
    let mut sink = VecSink::default();
    let context = ApprovalContext {
        root,
        classifier,
        prompt,
    };
    let decision = block_on(decide(gate, &context, call, writes_remaining, &mut sink));
    (decision, sink.0)
}

fn approved(decision: &ApprovalDecision) -> bool {
    matches!(decision, ApprovalDecision::Approved(_))
}

fn auto_approval_rules(events: &[ChatEvent]) -> Vec<ApprovalRule> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolAutoApproved { rule, .. } => Some(*rule),
            _ => None,
        })
        .collect()
}

fn resolutions(events: &[ChatEvent]) -> Vec<ApprovalResolution> {
    events
        .iter()
        .filter_map(|event| match event {
            ChatEvent::ToolApprovalResolved { decision, .. } => Some(*decision),
            _ => None,
        })
        .collect()
}

/* ─────────────────────────────  AlwaysAsk  ───────────────────────────── */

#[test]
fn always_ask_asks_about_every_gated_tool_and_never_reaches_the_judge() {
    let dir = vault();
    for tool in ALL_GATED_TOOLS {
        let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
        let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
        let mut gate = ApprovalGate::new(policy(ApprovalMode::AlwaysAsk, true));
        let (decision, events) = run(&mut gate, dir.path(), &judge, &prompt, &call_for(tool), 8);

        assert!(approved(&decision), "{tool:?}");
        assert_eq!(prompt.asked(), 1, "{tool:?} must be asked about");
        assert_eq!(
            judge.calls(),
            0,
            "{tool:?}: ask-me mode must never spend the user's tokens on a judge"
        );
        assert_eq!(prompt.seen()[0].reason, ApprovalReason::ModeAlwaysAsk);
        assert_eq!(resolutions(&events), vec![ApprovalResolution::Approved]);
    }
}

#[test]
fn a_denial_settles_as_denied_and_does_not_approve() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::AlwaysAsk, false));
    let (decision, events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/New.md", "body"),
        8,
    );
    assert_eq!(
        decision,
        ApprovalDecision::Denied(ApprovalResolution::Denied)
    );
    assert_eq!(resolutions(&events), vec![ApprovalResolution::Denied]);
}

#[test]
fn a_timeout_a_cancel_and_a_closed_channel_all_resolve_to_deny() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    for (answers, expected) in [
        (vec![ApprovalAnswer::TimedOut], ApprovalResolution::TimedOut),
        (
            vec![ApprovalAnswer::Cancelled],
            ApprovalResolution::Cancelled,
        ),
        // An empty script makes the prompt return `Err`, i.e. the channel closed
        // under it. A failure to OBTAIN consent is not consent.
        (Vec::new(), ApprovalResolution::Cancelled),
    ] {
        let prompt = ScriptedPrompt::new(answers);
        let mut gate = ApprovalGate::new(policy(ApprovalMode::AlwaysAsk, false));
        let (decision, events) = run(
            &mut gate,
            dir.path(),
            &judge,
            &prompt,
            &write_call("call-1", "Notes/New.md", "body"),
            8,
        );
        // The decision CARRIES which no it was, so a timeout is not reported
        // as the user having declined. Fold the three back into one bare
        // `Denied` and this is the assertion that fails.
        assert_eq!(decision, ApprovalDecision::Denied(expected));
        assert_eq!(resolutions(&events), vec![expected]);
    }
}

#[test]
fn the_prompt_shows_the_human_the_path_the_judge_never_sees() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::AlwaysAsk, false));
    run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/Deceptively named.md", "body"),
        8,
    );
    // Two audiences, two trust profiles: a person can read a deceptive filename
    // and is the right party to judge it.
    assert_eq!(
        prompt.seen()[0].rel_path.as_deref(),
        Some("Notes/Deceptively named.md")
    );
    assert_eq!(prompt.seen()[0].expires_in_secs, 120);
}

/* ───────────────────────────  ApproveForMe  ─────────────────────────── */

#[test]
fn within_approve_for_me_every_irreversible_tool_is_asked_and_the_judge_is_unreachable() {
    // The claim is unreachability, not override: a judge that returns "allow" for
    // everything must still not be consulted for these.
    let dir = vault();
    for tool in ALL_GATED_TOOLS {
        if tool.reversibility() != Reversibility::Irreversible {
            continue;
        }
        let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
        let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
        let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
        run(&mut gate, dir.path(), &judge, &prompt, &call_for(tool), 8);

        assert_eq!(judge.calls(), 0, "{tool:?} must never reach the judge");
        assert_eq!(prompt.asked(), 1, "{tool:?} must be asked about");
        assert!(matches!(
            prompt.seen()[0].reason,
            // `transcribe_audio` is pinned to always-ask, so it never even gets
            // as far as the irreversibility check — both are unconditional.
            ApprovalReason::Irreversible | ApprovalReason::ModeAlwaysAsk
        ));
    }
}

#[test]
fn within_approve_for_me_an_ineligible_reversible_tool_is_asked_and_the_judge_is_unreachable() {
    // `ApprovalReason::NotEligible` had no test at all, and it guards the two
    // tools that WIDEN the gate itself: `use_skill` grows the tool grant set and
    // `select_playlist_videos` grows the write budget. Both are classified
    // Reversible, so they walk straight past the irreversibility floor, and the
    // eligibility rule is the only thing between them and an unattended run.
    //
    // The claim is unreachability, not override, so the judge is scripted to
    // allow everything and the assertion is that it was never asked. A judge
    // scripted to say "ask" would make this pass for the wrong reason.
    //
    // What goes red: delete the `!eligible(&subject)` branch in `decide` and the
    // judge gets consulted, so `calls()` becomes 1. Reclassify either tool's
    // operation as eligible in `subject::eligible` and the same thing happens.
    let dir = vault();
    for tool in [GatedTool::UseSkill, GatedTool::SelectPlaylistVideos] {
        assert_eq!(
            tool.reversibility(),
            Reversibility::Reversible,
            "{tool:?} is only interesting here while it clears the irreversible floor"
        );
        let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
        let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
        let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
        let (decision, _) = run(&mut gate, dir.path(), &judge, &prompt, &call_for(tool), 8);

        assert_eq!(judge.calls(), 0, "{tool:?} must never reach the judge");
        assert_eq!(prompt.asked(), 1, "{tool:?} must be asked about");
        assert_eq!(
            prompt.seen()[0].reason,
            ApprovalReason::NotEligible,
            "{tool:?} is asked about because it is not the KIND of call that may \
             ever run unattended — not because a judge said so"
        );
        assert!(!approved(&decision), "{tool:?}");
    }
}

#[test]
fn an_eligible_create_reaches_the_judge_and_an_allow_runs_it_unattended() {
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
    let (decision, events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/New.md", "body"),
        8,
    );
    assert!(approved(&decision));
    assert_eq!(judge.calls(), 1);
    assert_eq!(prompt.asked(), 0, "an allowed call must not also prompt");
    assert_eq!(
        auto_approval_rules(&events),
        vec![ApprovalRule::NewNoteInVault]
    );
    assert!(events
        .iter()
        .any(|event| matches!(event, ChatEvent::ToolApprovalChecking { .. })));
}

#[test]
fn a_judge_that_says_ask_falls_through_to_the_user() {
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Ask);
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
    let (decision, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/New.md", "body"),
        8,
    );
    assert!(approved(&decision));
    assert_eq!(judge.calls(), 1);
    assert_eq!(prompt.seen()[0].reason, ApprovalReason::JudgeAsked);
}

#[test]
fn a_judge_timeout_results_in_a_user_prompt_and_never_an_allow() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
    let (decision, events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/New.md", "body"),
        8,
    );
    assert_eq!(
        decision,
        ApprovalDecision::Denied(ApprovalResolution::Denied)
    );
    assert_eq!(prompt.seen()[0].reason, ApprovalReason::JudgeUnavailable);
    // The timeline explains the pause before the sheet appears, so the user is
    // not left wondering why a mode called "approve for me" is asking.
    assert_eq!(
        resolutions(&events),
        vec![ApprovalResolution::Unavailable, ApprovalResolution::Denied]
    );
    assert!(auto_approval_rules(&events).is_empty());
}

#[test]
fn two_consecutive_judge_failures_switch_automatic_checking_off_for_the_run() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));

    for index in 0..4 {
        let call = write_call(&format!("call-{index}"), &format!("Notes/N{index}.md"), "b");
        let (_, events) = run(&mut gate, dir.path(), &judge, &prompt, &call, 8);
        if index == 1 {
            assert!(
                events.iter().any(|event| matches!(
                    event,
                    ChatEvent::ToolApprovalDegraded {
                        reason: ApprovalDegradedReason::JudgeUnreliable
                    }
                )),
                "the second failure must announce the degradation"
            );
        }
        if index > 1 {
            assert!(
                !events
                    .iter()
                    .any(|event| matches!(event, ChatEvent::ToolApprovalDegraded { .. })),
                "the timeline says it once per run, not once per call"
            );
        }
    }

    assert!(gate.is_degraded());
    // Two attempts, then it stops spending the user's tokens on a judge that is
    // not answering.
    assert_eq!(judge.calls(), 2);
    assert_eq!(prompt.asked(), 4);
}

/* ─────────────────────────  the local-lane guard  ───────────────────── */

#[test]
fn the_local_lane_guard_lives_in_rust_and_refuses_to_reach_the_judge() {
    // Not "the Settings radio renders disabled" — a settings-layer-only guard is
    // one a stale config or a direct IPC call walks straight through.
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, false));
    let (decision, events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("call-1", "Notes/New.md", "body"),
        8,
    );

    assert!(approved(&decision), "the user approved it themselves");
    assert_eq!(
        judge.calls(),
        0,
        "the judge must be unreachable, not merely ignored"
    );
    assert_eq!(prompt.seen()[0].reason, ApprovalReason::ProviderUnsupported);
    assert!(events.iter().any(|event| matches!(
        event,
        ChatEvent::ToolApprovalDegraded {
            reason: ApprovalDegradedReason::ProviderUnsupported
        }
    )));
}

#[test]
fn the_provider_unsupported_notice_is_emitted_once_per_run() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, false));
    let mut degraded = 0;
    for index in 0..3 {
        let call = write_call(&format!("c{index}"), &format!("Notes/N{index}.md"), "b");
        let (_, events) = run(&mut gate, dir.path(), &judge, &prompt, &call, 8);
        degraded += events
            .iter()
            .filter(|event| matches!(event, ChatEvent::ToolApprovalDegraded { .. }))
            .count();
    }
    assert_eq!(degraded, 1);
}

#[test]
fn yolo_is_not_downgraded_on_the_local_lane() {
    // The guard keys on whether the JUDGE would be called, not on the mode name.
    // YOLO never calls it, so it must work identically without a cloud provider —
    // silently restricting a mode the user explicitly confirmed is the same class
    // of bug as silently reverting it.
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::Yolo, false));
    for tool in ALL_GATED_TOOLS {
        if tool == GatedTool::TranscribeAudio {
            continue; // pinned to always-ask by its compiled default, in every mode
        }
        let (decision, events) = run(&mut gate, dir.path(), &judge, &prompt, &call_for(tool), 8);
        assert!(approved(&decision), "{tool:?} must run unprompted on local");
        assert_eq!(auto_approval_rules(&events), vec![ApprovalRule::Yolo]);
    }
    assert_eq!(prompt.asked(), 0);
    assert_eq!(judge.calls(), 0);
}

/* ─────────────────────────────  Yolo  ───────────────────────────── */

#[test]
fn under_yolo_an_irreversible_operation_does_not_prompt_and_does_run() {
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Ask);
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::Yolo, true));

    for tool in ALL_GATED_TOOLS {
        if tool.reversibility() != Reversibility::Irreversible || tool == GatedTool::TranscribeAudio
        {
            continue;
        }
        let (decision, events) = run(&mut gate, dir.path(), &judge, &prompt, &call_for(tool), 8);
        assert!(approved(&decision), "{tool:?} must run under YOLO");
        // Visibility is the compensating control: the prompt is skipped, the
        // RECORD is not.
        assert_eq!(
            auto_approval_rules(&events),
            vec![ApprovalRule::Yolo],
            "{tool:?} must still render a node"
        );
    }
    assert_eq!(prompt.asked(), 0);
    assert_eq!(judge.calls(), 0, "YOLO never spends tokens on a judge");
}

#[test]
fn under_yolo_a_vault_escape_is_still_hard_denied() {
    // YOLO removes the approval gate and NOTHING else. If a future change routes
    // confinement through the gate to simplify the code, YOLO silently becomes a
    // vault escape — so this clause gets a test, not a comment.
    let dir = vault();
    let outside = tempfile::tempdir().unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(outside.path(), dir.path().join("Escape")).unwrap();
    #[cfg(not(unix))]
    return;

    #[cfg(unix)]
    {
        let judge = SpyClassifier::always_failing();
        let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
        let mut gate = ApprovalGate::new(policy(ApprovalMode::Yolo, false));
        let (decision, _) = run(
            &mut gate,
            dir.path(),
            &judge,
            &prompt,
            &write_call("call-1", "Escape/Sneaky.md", "body"),
            8,
        );
        assert!(matches!(decision, ApprovalDecision::HardDenied(_)));
        assert_eq!(prompt.asked(), 0, "a footgun is refused, never offered");
    }
}

#[test]
fn under_yolo_an_invalid_path_is_still_hard_denied() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::Yolo, false));
    for bad in ["../escape.md", "Notes/../../escape.md", "/etc/passwd", ""] {
        let (decision, _) = run(
            &mut gate,
            dir.path(),
            &judge,
            &prompt,
            &write_call("call-1", bad, "body"),
            8,
        );
        assert!(
            matches!(decision, ApprovalDecision::HardDenied(_)),
            "{bad:?} must be refused under YOLO too"
        );
    }
    assert_eq!(prompt.asked(), 0);
}

#[test]
fn transcribe_audio_stays_pinned_even_under_a_yolo_global() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::Yolo, false));
    let (decision, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &call_for(GatedTool::TranscribeAudio),
        8,
    );
    assert_eq!(
        decision,
        ApprovalDecision::Denied(ApprovalResolution::Denied)
    );
    assert_eq!(prompt.asked(), 1);
    assert_eq!(prompt.seen()[0].reason, ApprovalReason::ModeAlwaysAsk);
}

#[test]
fn a_per_tool_always_ask_claws_one_tool_back_under_a_yolo_global() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Approved);
    let mut gate = ApprovalGate::new(ApprovalPolicy::new(
        ApprovalMode::Yolo,
        BTreeMap::from([(
            GatedTool::WriteNote.name().to_string(),
            ApprovalMode::AlwaysAsk,
        )]),
        false,
    ));

    let (write, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c1", "Notes/New.md", "body"),
        8,
    );
    assert!(approved(&write));
    assert_eq!(prompt.asked(), 1, "the clawed-back tool is asked about");

    let (fetch, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &call_for(GatedTool::FetchCaptions),
        8,
    );
    assert!(approved(&fetch));
    assert_eq!(prompt.asked(), 1, "the others still run unprompted");
}

/* ─────────────────────  cache and consent fatigue  ──────────────────── */

#[test]
fn a_second_identical_subject_is_served_from_the_within_run_cache() {
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault));
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));

    let (first, first_events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c1", "Notes/New.md", "body"),
        8,
    );
    let (second, second_events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c2", "Notes/New.md", "body"),
        8,
    );

    assert!(approved(&first) && approved(&second));
    assert_eq!(judge.calls(), 1, "the second call must not be re-judged");
    assert_eq!(
        auto_approval_rules(&first_events),
        vec![ApprovalRule::NewNoteInVault]
    );
    assert_eq!(
        auto_approval_rules(&second_events),
        vec![ApprovalRule::CachedAllow]
    );
}

#[test]
fn a_denial_invalidates_a_cached_allow_for_the_same_subject_within_a_run() {
    // Without this a cached allow could quietly survive the user saying no to
    // the same subject, which is a genuine bypass rather than a stale
    // optimisation.
    //
    // Note the route the denial arrives by. The cache key is the FULL serialised
    // subject, which carries budget headroom, so a spent write changes the key
    // while leaving the subject's identity — `(tool, operation, path digest)` —
    // untouched. That is precisely the gap a naive exact-key invalidation would
    // leave open, so the test drives it deliberately: cache at one budget, deny
    // at another, then come back to the first.
    let dir = vault();
    let judge = SpyClassifier::new(vec![
        Ok(ClassifierVerdict::Allow(ApprovalRule::NewNoteInVault)),
        Ok(ClassifierVerdict::Ask),
    ]);
    let prompt = ScriptedPrompt::new(vec![ApprovalAnswer::Denied, ApprovalAnswer::Approved]);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));
    let subject_call = |id: &str| write_call(id, "Notes/New.md", "body");

    // 1. judged, allowed, cached at budget 8.
    let (first, first_events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &subject_call("c1"),
        8,
    );
    assert!(approved(&first));
    assert_eq!(
        auto_approval_rules(&first_events),
        vec![ApprovalRule::NewNoteInVault]
    );

    // 2. one write later the budget is 7, so this is a different cache key but
    //    the same subject identity. The judge asks; the user says no.
    let (second, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &subject_call("c2"),
        7,
    );
    assert_eq!(second, ApprovalDecision::Denied(ApprovalResolution::Denied));

    // 3. back at budget 8 — the byte-identical cached entry — the call must NOT
    //    be auto-approved. The denial outranks the cache.
    let (third, third_events) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &subject_call("c3"),
        8,
    );
    assert!(
        approved(&third),
        "the user approved it themselves this time"
    );
    assert!(
        auto_approval_rules(&third_events).is_empty(),
        "a denied subject must not be auto-approved from a surviving cache entry"
    );
    assert_eq!(
        prompt.seen().last().unwrap().reason,
        ApprovalReason::PreviouslyDenied
    );
}

#[test]
fn a_repeat_after_one_denial_is_unconditional_and_a_second_denial_hard_rejects() {
    // Consent fatigue is the attack to expect: injected content will certainly
    // instruct the model to try again, reworded.
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Ask);
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));

    // A reworded body is the SAME subject — the digest covers the path only.
    let (first, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c1", "Notes/New.md", "one body"),
        8,
    );
    assert_eq!(first, ApprovalDecision::Denied(ApprovalResolution::Denied));

    let (second, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c2", "Notes/New.md", "a completely reworded body"),
        8,
    );
    assert_eq!(second, ApprovalDecision::Denied(ApprovalResolution::Denied));
    assert_eq!(
        prompt.seen()[1].reason,
        ApprovalReason::PreviouslyDenied,
        "the retry must be unconditional, not re-judged"
    );

    let (third, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c3", "Notes/New.md", "a third wording"),
        8,
    );
    assert!(
        matches!(third, ApprovalDecision::HardDenied(_)),
        "two refusals of the same subject stop the gate relaying the question"
    );
    assert_eq!(prompt.asked(), 2, "the third retry is not put to the user");
    assert_eq!(judge.calls(), 1, "only the first attempt was ever judged");
}

#[test]
fn a_different_path_each_retry_defeats_the_counter_and_the_write_budget_is_the_backstop() {
    // Stated honestly rather than papered over: the denial counter is keyed on
    // the subject, so a different path each time is a different subject. What
    // actually bounds the attack is the write budget, which is why the eligibility
    // rule reads it.
    let dir = vault();
    let judge = SpyClassifier::always(ClassifierVerdict::Ask);
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::ApproveForMe, true));

    for index in 0..5 {
        let call = write_call(&format!("c{index}"), &format!("Notes/N{index}.md"), "body");
        let (decision, _) = run(&mut gate, dir.path(), &judge, &prompt, &call, 8);
        assert_eq!(
            decision,
            ApprovalDecision::Denied(ApprovalResolution::Denied)
        );
    }
    assert_eq!(prompt.asked(), 5, "each distinct path is its own question");

    // With no budget left, the same class of call is no longer eligible at all,
    // so the judge is never reached however the path is varied.
    let before = judge.calls();
    let (spent, _) = run(
        &mut gate,
        dir.path(),
        &judge,
        &prompt,
        &write_call("c9", "Notes/N9.md", "body"),
        0,
    );
    assert_eq!(spent, ApprovalDecision::Denied(ApprovalResolution::Denied));
    assert_eq!(judge.calls(), before, "an over-budget call is not judged");
}

/* ─────────────────────────  ungated tools  ──────────────────────────── */

#[test]
fn an_ungated_tool_is_never_prompted_and_emits_no_approval_events() {
    let dir = vault();
    let judge = SpyClassifier::always_failing();
    let prompt = ScriptedPrompt::always(ApprovalAnswer::Denied);
    let mut gate = ApprovalGate::new(policy(ApprovalMode::AlwaysAsk, false));
    for name in ["search_notes", "list_notes", "read_note_span", "ask_user"] {
        let call = ToolCall {
            id: "c1".into(),
            name: name.into(),
            arguments: r#"{"query":"x"}"#.into(),
        };
        let (decision, events) = run(&mut gate, dir.path(), &judge, &prompt, &call, 8);
        assert!(approved(&decision), "{name} must not be gated");
        assert!(events.is_empty(), "{name} must emit no approval events");
    }
    assert_eq!(prompt.asked(), 0);
}

/* ────────────────────  the unwired-client default  ───────────────────── */

#[test]
fn a_client_with_no_approval_sheet_wired_denies_every_gated_call() {
    // `DenyingApprovalPrompt` is the fail-closed default for a client that has
    // not plumbed an approval sheet, and its return had never once executed in a
    // test: every harness that wires it runs under `Yolo`, where the prompt is
    // unreachable by construction. So the one line that decides what an
    // unwired client does was covered by nothing.
    //
    // The other default — approving when nobody is listening — is the one that
    // turns a forgotten wiring step into silent unattended vault writes, which
    // is why this direction is worth a test of its own rather than an
    // assumption.
    //
    // What goes red: make `DenyingApprovalPrompt::ask_approval` return
    // `Approved` and both assertions fail — the decision becomes an approval and
    // the timeline reports it as one.
    let dir = vault();
    // The judge says ASK, so the eligible create actually reaches the prompt
    // under `ApproveForMe` instead of being auto-approved before it. Scripting
    // it to allow made this test green on `write_note` for the wrong reason —
    // the prompt was never consulted at all.
    let judge = SpyClassifier::always(ClassifierVerdict::Ask);
    for tool in ALL_GATED_TOOLS {
        // Every mode that asks at all, so this is not accidentally a statement
        // about `AlwaysAsk` alone. `Yolo` is excluded on purpose: it skips the
        // prompt entirely, which is the documented behaviour and the reason this
        // return was unreachable in the existing harnesses.
        for mode in [ApprovalMode::AlwaysAsk, ApprovalMode::ApproveForMe] {
            let mut gate = ApprovalGate::new(policy(mode, true));
            let (decision, events) = run(
                &mut gate,
                dir.path(),
                &judge,
                &DenyingApprovalPrompt,
                &call_for(tool),
                8,
            );
            assert_eq!(
                decision,
                ApprovalDecision::Denied(ApprovalResolution::Denied),
                "{tool:?} under {mode:?} must not run without a wired sheet"
            );
            assert!(
                resolutions(&events).contains(&ApprovalResolution::Denied),
                "{tool:?} under {mode:?} must say so in the timeline"
            );
        }
    }
}
