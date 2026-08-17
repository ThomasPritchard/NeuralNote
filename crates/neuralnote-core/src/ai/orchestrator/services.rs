//! Host-wired seams for one chat run: skills, writes, YouTube, approval, retry.

use crate::ai::approval::{
    ApprovalClassifier, ApprovalPolicy, ApprovalPrompt, DenyingApprovalPrompt,
    UnavailableApprovalClassifier,
};
use crate::ai::llm::UserPrompt;
use crate::ai::skills::{SkillEnvironment, SkillRegistry};
use crate::ai::write_policy::NoteWriteBackend;
use crate::ai::youtube::{
    CaptureCancellation, ExtractorUpdateSession, YoutubeIo, UNAVAILABLE_YOUTUBE_IO,
};
use crate::capture::{PricingInput, UnavailableVaultProfileIo, VaultProfileIo};
use async_trait::async_trait;
use std::time::Duration;

/// Host seam for the retry backoff pause. The core owns *how long* to wait (its retry
/// policy) but never owns a clock — every timer in the app lives in the host — so it
/// hands the duration to this seam and awaits it. The shell backs it with its async
/// runtime timer; tests supply a deterministic double so backoff is exercised without
/// real time passing.
#[async_trait]
pub trait RetryDelay: Send + Sync {
    /// Await `duration` before the caller retries. Must not block the executor thread.
    async fn delay(&self, duration: Duration);
}

/// The no-op default: retry immediately. Used by non-host callers and any run that does
/// not wire a real timer; the desktop shell overrides it with a runtime-backed delay.
pub struct NoRetryDelay;

#[async_trait]
impl RetryDelay for NoRetryDelay {
    async fn delay(&self, _duration: Duration) {}
}

static NO_RETRY_DELAY: NoRetryDelay = NoRetryDelay;

/// Shell-supplied seams and pure skill policy for one chat run.
pub struct SkillServices<'a> {
    pub(super) registry: &'a SkillRegistry,
    pub(super) environment: &'a SkillEnvironment,
    pub(super) user_prompt: &'a dyn UserPrompt,
    pub(super) note_writer: &'a dyn NoteWriteBackend,
    pub(super) work_items: usize,
    pub(super) youtube_io: &'a dyn YoutubeIo,
    pub(super) youtube_requirements: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    pub(super) vault_profile_io: &'a dyn VaultProfileIo,
    pub(super) capture_cancellation: CaptureCancellation,
    pub(super) pricing: Option<&'a PricingInput>,
    pub(super) extractor_updates: ExtractorUpdateSession,
    pub(super) retry_delay: &'a dyn RetryDelay,
    pub(super) approval_policy: ApprovalPolicy,
    pub(super) approval_prompt: &'a dyn ApprovalPrompt,
    pub(super) approval_classifier: &'a dyn ApprovalClassifier,
}

static DENYING_APPROVAL_PROMPT: DenyingApprovalPrompt = DenyingApprovalPrompt;
static UNAVAILABLE_APPROVAL_CLASSIFIER: UnavailableApprovalClassifier =
    UnavailableApprovalClassifier;

static UNAVAILABLE_VAULT_PROFILE_IO: UnavailableVaultProfileIo = UnavailableVaultProfileIo;

impl<'a> SkillServices<'a> {
    pub fn new(
        registry: &'a SkillRegistry,
        environment: &'a SkillEnvironment,
        user_prompt: &'a dyn UserPrompt,
        note_writer: &'a dyn NoteWriteBackend,
        work_items: usize,
    ) -> Self {
        Self {
            registry,
            environment,
            user_prompt,
            note_writer,
            work_items,
            youtube_io: &UNAVAILABLE_YOUTUBE_IO,
            youtube_requirements: &crate::ai::youtube::UNAVAILABLE_YOUTUBE_REQUIREMENT_INSTALLER,
            vault_profile_io: &UNAVAILABLE_VAULT_PROFILE_IO,
            capture_cancellation: CaptureCancellation::default(),
            pricing: None,
            // Non-host callers get an isolated allowance; the desktop shell overrides
            // this with its app-session-owned update state through the builder below.
            extractor_updates: ExtractorUpdateSession::default(),
            // No-op backoff by default; the desktop shell wires its runtime timer.
            retry_delay: &NO_RETRY_DELAY,
            // Fail-closed defaults: ask about everything, deny when nobody is
            // listening, and have no judge. A client that forgets to wire the
            // approval seams therefore cannot run gated tools unattended — the
            // opposite default would turn a missed wiring step into silent
            // unattended vault writes.
            approval_policy: ApprovalPolicy::default(),
            approval_prompt: &DENYING_APPROVAL_PROMPT,
            approval_classifier: &UNAVAILABLE_APPROVAL_CLASSIFIER,
        }
    }

    /// Wire the tool-approval gate: the persisted policy, the host's approval
    /// sheet, and the judge.
    pub fn with_approval(
        mut self,
        policy: ApprovalPolicy,
        prompt: &'a dyn ApprovalPrompt,
        classifier: &'a dyn ApprovalClassifier,
    ) -> Self {
        self.approval_policy = policy;
        self.approval_prompt = prompt;
        self.approval_classifier = classifier;
        self
    }

    pub fn with_youtube_io(mut self, youtube_io: &'a dyn YoutubeIo) -> Self {
        self.youtube_io = youtube_io;
        self
    }

    pub fn with_youtube_requirements(
        mut self,
        installer: &'a dyn crate::ai::youtube::YoutubeRequirementInstaller,
    ) -> Self {
        self.youtube_requirements = installer;
        self
    }

    pub fn with_vault_profile_io(mut self, profile_io: &'a dyn VaultProfileIo) -> Self {
        self.vault_profile_io = profile_io;
        self
    }

    pub fn with_capture_cancellation(mut self, cancellation: CaptureCancellation) -> Self {
        self.capture_cancellation = cancellation;
        self
    }

    pub fn with_pricing(mut self, pricing: &'a PricingInput) -> Self {
        self.pricing = Some(pricing);
        self
    }

    /// Override the current per-run default with update state retained by a host.
    pub fn with_extractor_update_session(mut self, updates: ExtractorUpdateSession) -> Self {
        self.extractor_updates = updates;
        self
    }

    /// Wire the host's runtime-backed retry backoff. Without this, retries fire
    /// immediately (the [`NoRetryDelay`] default).
    pub fn with_retry_delay(mut self, retry_delay: &'a dyn RetryDelay) -> Self {
        self.retry_delay = retry_delay;
        self
    }
}
