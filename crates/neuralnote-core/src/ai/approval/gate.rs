//! The gate itself: per-run state, the host prompt seam, and [`decide`] — the
//! single door every gated call passes through.

use crate::ai::approval::classifier::{ApprovalClassifier, ApprovalRule, ClassifierVerdict};
use crate::ai::approval::digest::{PathDigest, PathDigestSalt};
use crate::ai::approval::gated::{GatedTool, Reversibility};
use crate::ai::approval::mode::{effective_mode, ApprovalMode};
use crate::ai::approval::outcome::{
    ApprovalAnswer, ApprovalDecision, ApprovalDegradedReason, ApprovalReason, ApprovalResolution,
    ApprovedCall, APPROVAL_TIMEOUT_SECS,
};
use crate::ai::approval::subject::{
    build_subject, eligible, BuiltSubject, HardDeny, OperationKind, ToolApprovalSubject,
};
use crate::ai::events::{ChatEvent, EventSink};
use crate::ai::llm::ToolCall;
use crate::error::CoreResult;
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::path::Path;

/// The stable identity of one request: which tool, what class of effect, and the
/// salted digest of its target. Deliberately coarser than the full subject — a
/// reworded body or a spent write must not read as a new question.
type SubjectKey = (GatedTool, OperationKind, PathDigest);

/// Consecutive judge failures that switch automatic checking off for the rest of
/// the run.
const MAX_CONSECUTIVE_JUDGE_FAILURES: u32 = 2;

/// Denials of one subject after which the gate stops asking and refuses outright.
///
/// Consent fatigue is the attack to expect: injected content will certainly
/// instruct the model to try again, reworded. Note the real backstop is the write
/// budget, because a *different* path each retry defeats this counter entirely.
const MAX_SUBJECT_DENIALS: u32 = 2;

/// What one gated call is being asked about. Every field is compiled in or
/// app-computed; nothing here is model-authored.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPromptRequest {
    /// The `ToolCall` id, so the UI can attach the sheet to the right node.
    pub id: String,
    pub tool: GatedTool,
    /// The vault-relative path, **for the human**. A person can read a deceptive
    /// filename and is the right party to judge it; the classifier gets a digest.
    pub rel_path: Option<String>,
    pub reason: ApprovalReason,
    pub expires_in_secs: u32,
}

/// Host seam for a security approval prompt.
///
/// Deliberately **not** [`UserPrompt`](crate::ai::llm::UserPrompt): `ask_user`
/// lets the *model* author the question text and the option labels, and a
/// security prompt whose copy the model writes is a social-engineering surface.
/// The type separation also means a webview `answer_elicitation` call can never
/// satisfy an approval.
#[async_trait]
pub trait ApprovalPrompt: Send + Sync {
    async fn ask_approval(&self, request: &ApprovalPromptRequest) -> CoreResult<ApprovalAnswer>;
}

/// The explicit "no prompt is wired" implementation: it denies.
///
/// A client that has not wired an approval sheet cannot run gated calls
/// unattended, which is the fail-closed direction. The other default — approving
/// when nobody is listening — is the one that turns a forgotten wiring step into
/// silent unattended vault writes.
#[derive(Debug, Default)]
pub struct DenyingApprovalPrompt;

#[async_trait]
impl ApprovalPrompt for DenyingApprovalPrompt {
    async fn ask_approval(&self, _request: &ApprovalPromptRequest) -> CoreResult<ApprovalAnswer> {
        Ok(ApprovalAnswer::Denied)
    }
}

/// The persisted policy, resolved for one run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalPolicy {
    /// The global default.
    pub mode: ApprovalMode,
    /// Per-tool exceptions, keyed by the `TOOL_*` constants.
    pub overrides: BTreeMap<String, ApprovalMode>,
    /// Whether the active provider can run the judge.
    ///
    /// **Enforced here in Rust, not in the UI.** The webview disabling a radio
    /// button is a presentation detail; a stale config or a direct IPC call walks
    /// straight through a settings-layer-only guard.
    pub classifier_available: bool,
}

impl Default for ApprovalPolicy {
    /// `AlwaysAsk`, no overrides, no judge — today's behaviour plus a visible
    /// prompt. Nobody is opted into automation by omission.
    fn default() -> Self {
        Self {
            mode: ApprovalMode::AlwaysAsk,
            overrides: BTreeMap::new(),
            classifier_available: false,
        }
    }
}

impl ApprovalPolicy {
    pub fn new(
        mode: ApprovalMode,
        overrides: BTreeMap<String, ApprovalMode>,
        classifier_available: bool,
    ) -> Self {
        Self {
            mode,
            overrides,
            classifier_available,
        }
    }

    /// The mode in force for one tool, after the per-tool clamp.
    pub fn effective_mode(&self, tool: GatedTool) -> ApprovalMode {
        effective_mode(self.mode, &self.overrides, tool)
    }
}

/// Per-run approval state. Dies with the run, by design.
///
/// Nothing here is serialised: vault state changes between runs and
/// `target_exists` is one of the classified scalars, so a cross-run cache would
/// serve a verdict derived from a world that no longer exists. It also means an
/// approval cannot survive a restart.
pub struct ApprovalGate {
    policy: ApprovalPolicy,
    salt: PathDigestSalt,
    /// Allow-verdicts only, keyed on the full serialised subject. An `ask` outcome
    /// is not cached, because the user's answer to it is the thing that matters
    /// and that has its own state.
    ///
    /// The value is the subject's *denial* key, which is coarser than the cache
    /// key: the subject includes volatile scalars (budget headroom moves as
    /// writes land) while the denial key is the stable `(tool, operation,
    /// digest)` triple. Keeping it lets a denial purge **every** cached variant of
    /// the same subject rather than only the byte-identical one.
    allow_cache: BTreeMap<String, SubjectKey>,
    denials: BTreeMap<SubjectKey, u32>,
    consecutive_failures: u32,
    degraded: bool,
    degraded_announced: bool,
}

impl ApprovalGate {
    pub fn new(policy: ApprovalPolicy) -> Self {
        Self {
            policy,
            salt: PathDigestSalt::fresh(),
            allow_cache: BTreeMap::new(),
            denials: BTreeMap::new(),
            consecutive_failures: 0,
            degraded: false,
            degraded_announced: false,
        }
    }

    /// A gate with a fixed salt, so a test can assert on an exact digest.
    pub fn with_fixed_salt(policy: ApprovalPolicy, seed: u8) -> Self {
        Self {
            salt: PathDigestSalt::fixed(seed),
            ..Self::new(policy)
        }
    }

    pub fn policy(&self) -> &ApprovalPolicy {
        &self.policy
    }

    /// Whether automatic checking has been switched off for the rest of this run.
    pub fn is_degraded(&self) -> bool {
        self.degraded
    }

    fn subject_key(subject: &ToolApprovalSubject) -> SubjectKey {
        (subject.tool, subject.operation, subject.path_digest)
    }

    fn denial_count(&self, subject: &ToolApprovalSubject) -> u32 {
        self.denials
            .get(&Self::subject_key(subject))
            .copied()
            .unwrap_or(0)
    }

    /// Record a denial and drop every cached allow for the same subject.
    ///
    /// The `DeniedSet` takes precedence over a cached allow, always — and it does
    /// so twice over, deliberately. The denial check runs *before* the cache
    /// lookup in [`decide`], so ordering alone already makes a cached allow
    /// unreachable for a denied subject; this purge means the entry does not even
    /// survive to be reached. Without both, a cached allow could quietly outlive
    /// the user saying no, which is a genuine bypass rather than a stale
    /// optimisation.
    fn record_denial(&mut self, subject: &ToolApprovalSubject) {
        let key = Self::subject_key(subject);
        *self.denials.entry(key).or_insert(0) += 1;
        self.allow_cache.retain(|_, cached| *cached != key);
    }
}

/// The run-scoped collaborators [`decide`] needs.
pub struct ApprovalContext<'a> {
    /// The vault root, for the advisory path probe.
    pub root: &'a Path,
    pub classifier: &'a dyn ApprovalClassifier,
    pub prompt: &'a dyn ApprovalPrompt,
}

/// Decide whether one call may run, emitting the timeline events as it goes.
///
/// The **only** way to produce an [`ApprovedCall`] for a gated tool. The
/// classifier's authority here is one bit in one direction: it may narrow
/// `Ask → Allow`, and only inside the set the deterministic eligibility rule
/// already blessed. It can never move an unconditional-ask call to allow, and it
/// is never even *reached* for one — that is the claim the spy-classifier
/// call-count tests check.
pub async fn decide(
    gate: &mut ApprovalGate,
    context: &ApprovalContext<'_>,
    call: &ToolCall,
    writes_remaining: usize,
    sink: &mut dyn EventSink,
) -> ApprovalDecision {
    let Some(tool) = GatedTool::from_name(&call.name) else {
        // Not gated: `ApprovedCall::ungated` is the constructor for these, and it
        // is the caller's job to have used it. Reaching here means the caller
        // routed an ungated call into the gate; approve it rather than inventing
        // a security event for a read-only tool.
        return match ApprovedCall::ungated(call) {
            Some(approved) => ApprovalDecision::Approved(approved),
            // Unreachable: `from_name` already said the tool is not gated, and
            // that is the only condition under which `ungated` returns `None`.
            // Denying rather than unwrapping keeps the impossible case
            // fail-closed instead of a panic on the security path.
            None => ApprovalDecision::Denied(ApprovalResolution::Denied),
        };
    };

    // Hard-deny runs FIRST and in EVERY mode, YOLO included. A vault escape, an
    // invalid path, or arguments that never parsed are input validation and
    // confinement, not authorisation — there is no prompt to skip (§9.6.2).
    let built = match build_subject(tool, call, context.root, &gate.salt, writes_remaining) {
        Ok(built) => built,
        Err(denial) => return hard_deny(sink, call, denial),
    };
    let BuiltSubject { subject, rel_path } = built;
    let mode = gate.policy.effective_mode(tool);

    if mode == ApprovalMode::Yolo {
        // No eligibility filter, no judge, no unconditional list — that is the
        // whole point of the mode (§9.6.1). The RECORD is not removed with the
        // gate: the node still renders, and Undo still applies (§9.6.3).
        return auto_approve(sink, call, tool, ApprovalRule::Yolo);
    }

    let cache_key = serde_json::to_string(&subject).unwrap_or_default();
    match gate.denial_count(&subject) {
        0 => {}
        count if count >= MAX_SUBJECT_DENIALS => {
            return hard_deny(sink, call, HardDeny::RepeatedlyDenied);
        }
        // Asked and declined once already: this repeat is unconditional, whatever
        // the mode and whatever the judge would have said.
        _ => {
            return ask(
                gate,
                context,
                sink,
                call,
                tool,
                &subject,
                rel_path,
                ApprovalReason::PreviouslyDenied,
            )
            .await
        }
    }

    if mode == ApprovalMode::AlwaysAsk {
        return ask(
            gate,
            context,
            sink,
            call,
            tool,
            &subject,
            rel_path,
            ApprovalReason::ModeAlwaysAsk,
        )
        .await;
    }

    // ── ApproveForMe ─────────────────────────────────────────────────────────
    // The unconditional floor comes first, and the judge is not consulted for
    // anything it catches. The claim is unreachability, not override.
    if tool.reversibility() == Reversibility::Irreversible {
        return ask(
            gate,
            context,
            sink,
            call,
            tool,
            &subject,
            rel_path,
            ApprovalReason::Irreversible,
        )
        .await;
    }
    if !eligible(&subject) {
        return ask(
            gate,
            context,
            sink,
            call,
            tool,
            &subject,
            rel_path,
            ApprovalReason::NotEligible,
        )
        .await;
    }

    // TODO(local-classifier): this guard is keyed on MEASURED structured-output
    // reliability, not on an architectural law. The bundled `qwen3.5:9b` passes
    // the repo's citation eval roughly one run in three, and a model that returns
    // well-formed JSON a third of the time is not a security control — under
    // fail-closed it is a 3s pause before the prompt the user was going to get
    // anyway. Re-measure with that eval when the bundled model ladder moves; if
    // it passes reliably, this guard should go rather than be grandfathered.
    if !gate.policy.classifier_available {
        announce_degraded(gate, sink, ApprovalDegradedReason::ProviderUnsupported);
        return ask(
            gate,
            context,
            sink,
            call,
            tool,
            &subject,
            rel_path,
            ApprovalReason::ProviderUnsupported,
        )
        .await;
    }
    if gate.degraded {
        return ask(
            gate,
            context,
            sink,
            call,
            tool,
            &subject,
            rel_path,
            ApprovalReason::JudgeUnavailable,
        )
        .await;
    }
    // A cache hit is reported under its own rule id rather than replaying the
    // judge's, so the timeline distinguishes "the judge said yes" from "the judge
    // said yes to this same subject earlier in this run".
    if gate.allow_cache.contains_key(&cache_key) {
        return auto_approve(sink, call, tool, ApprovalRule::CachedAllow);
    }

    sink.send(ChatEvent::ToolApprovalChecking {
        id: call.id.clone(),
    });
    match context.classifier.classify(&subject).await {
        Ok(ClassifierVerdict::Allow(rule)) => {
            gate.consecutive_failures = 0;
            gate.allow_cache
                .insert(cache_key, ApprovalGate::subject_key(&subject));
            auto_approve(sink, call, tool, rule)
        }
        Ok(ClassifierVerdict::Ask) => {
            gate.consecutive_failures = 0;
            ask(
                gate,
                context,
                sink,
                call,
                tool,
                &subject,
                rel_path,
                ApprovalReason::JudgeAsked,
            )
            .await
        }
        Err(_) => {
            // Exceeding the budget, erroring, or returning something unparseable
            // all land here. There is no path from a failure to an allow.
            gate.consecutive_failures += 1;
            if gate.consecutive_failures >= MAX_CONSECUTIVE_JUDGE_FAILURES {
                gate.degraded = true;
                announce_degraded(gate, sink, ApprovalDegradedReason::JudgeUnreliable);
            }
            sink.send(ChatEvent::ToolApprovalResolved {
                id: call.id.clone(),
                decision: ApprovalResolution::Unavailable,
            });
            ask(
                gate,
                context,
                sink,
                call,
                tool,
                &subject,
                rel_path,
                ApprovalReason::JudgeUnavailable,
            )
            .await
        }
    }
}

fn hard_deny(sink: &mut dyn EventSink, call: &ToolCall, denial: HardDeny) -> ApprovalDecision {
    sink.send(ChatEvent::ToolApprovalResolved {
        id: call.id.clone(),
        decision: ApprovalResolution::Denied,
    });
    ApprovalDecision::HardDenied(denial)
}

fn auto_approve(
    sink: &mut dyn EventSink,
    call: &ToolCall,
    tool: GatedTool,
    rule: ApprovalRule,
) -> ApprovalDecision {
    // "Approve for me" — and YOLO — must never be invisible. The user can always
    // see what ran unattended, and under which rule.
    sink.send(ChatEvent::ToolAutoApproved {
        id: call.id.clone(),
        tool,
        rule,
    });
    ApprovalDecision::Approved(ApprovedCall::granted(call, tool))
}

fn announce_degraded(
    gate: &mut ApprovalGate,
    sink: &mut dyn EventSink,
    reason: ApprovalDegradedReason,
) {
    // Once per run, not once per call: the timeline should say it, not chant it.
    if gate.degraded_announced {
        return;
    }
    gate.degraded_announced = true;
    sink.send(ChatEvent::ToolApprovalDegraded { reason });
}

#[allow(clippy::too_many_arguments)]
async fn ask(
    gate: &mut ApprovalGate,
    context: &ApprovalContext<'_>,
    sink: &mut dyn EventSink,
    call: &ToolCall,
    tool: GatedTool,
    subject: &ToolApprovalSubject,
    rel_path: Option<String>,
    reason: ApprovalReason,
) -> ApprovalDecision {
    let request = ApprovalPromptRequest {
        id: call.id.clone(),
        tool,
        rel_path,
        reason,
        expires_in_secs: APPROVAL_TIMEOUT_SECS,
    };
    sink.send(ChatEvent::ToolApprovalRequested {
        id: request.id.clone(),
        tool,
        rel_path: request.rel_path.clone(),
        reason,
        expires_in_secs: request.expires_in_secs,
    });
    // A prompt-channel failure is a failure to obtain consent, so it denies.
    let answer = context
        .prompt
        .ask_approval(&request)
        .await
        .unwrap_or(ApprovalAnswer::Cancelled);
    let resolution = answer.resolution();
    sink.send(ChatEvent::ToolApprovalResolved {
        id: call.id.clone(),
        decision: resolution,
    });
    if answer.approves() {
        return ApprovalDecision::Approved(ApprovedCall::granted(call, tool));
    }
    // A timeout, a cancel and a refusal are all "no" for authorisation purposes
    // and are all recorded as a denial — consent fatigue does not care which one
    // it was. They stop being interchangeable at the point they are REPORTED, so
    // the resolution rides along to the caller rather than being folded here.
    gate.record_denial(subject);
    ApprovalDecision::Denied(resolution)
}
