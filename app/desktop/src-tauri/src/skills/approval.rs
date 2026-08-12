//! The desktop side of the tool-approval gate: a pause machine for security
//! prompts, separate from the elicitation one.
//!
//! **Why not reuse `PendingElicitations`.** `ask_user` lets the *model* author the
//! question text and the option labels, so a security prompt sharing that
//! registry would be one where the model writes the copy. The separation also
//! means a webview `answer_elicitation` call can never satisfy an approval: they
//! are different commands over different maps carrying different types. Reusing
//! `Elicit` with a reserved id namespace was considered and rejected, because it
//! rests a security boundary on a string convention.
//!
//! The *mechanics* are the elicitation registry's, deliberately — a composite
//! `(run_id, call_id)` key, a registration counter, a parked `oneshot`, a
//! per-run close signal, and a drop guard. **One thing is inverted, and it is the
//! point of `resolve_interrupted_registration` below.**

use async_trait::async_trait;
use neuralnote_core::ai::approval::{
    ApprovalAnswer, ApprovalPrompt, ApprovalPromptRequest, APPROVAL_TIMEOUT_SECS,
};
use neuralnote_core::{CoreError, CoreResult};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;
use uuid::Uuid;

/// 120 seconds, from the core constant, so the number the UI counts down and the
/// number Rust enforces cannot drift apart. **Rust is the only expiry authority**
/// — the webview's countdown is decoration.
const APPROVAL_TIMEOUT: Duration = Duration::from_secs(APPROVAL_TIMEOUT_SECS as u64);

/// One approval parked at the Rust/UI boundary.
struct PendingApproval {
    sender: oneshot::Sender<ApprovalAnswer>,
    registration: u64,
}

/// The receiver half returned to [`ShellApprovalPrompt`].
struct ParkedApproval {
    registration: u64,
    receiver: oneshot::Receiver<ApprovalAnswer>,
}

/// What became of a waiter's own registration when it tried to claim it back.
///
/// **Three answers, not two, and the third is the whole reason this is not a
/// `bool`.** The `bool` it replaced returned `true` both for "I removed mine"
/// and for "the run's map is not there at all" — and
/// [`answer`](PendingApprovals::answer) drops that map as soon as it empties,
/// which is the *usual* case, because a turn parks one approval at a time. So
/// the two states a waiter most needs told apart were the two the return value
/// merged, and a guard keyed on it engaged almost never.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[must_use]
enum RegistrationClaim {
    /// Our registration was still parked and is now removed. Nothing else has
    /// touched it, so this waiter owns the outcome outright.
    Claimed,
    /// The slot no longer holds our registration: `answer` took it under the
    /// registry mutex, or a later park replaced it. Ours is gone either way, and
    /// the channel — not the registry — is now the authority on the decision.
    TakenByAnswer,
    /// The run's whole map is gone. **Not proof that no answer is in flight**:
    /// `answer` prunes the map as it empties, so this is precisely what the
    /// common race looks like from here. Reading it as "nothing to wait for" is
    /// the mistake the `bool` invited.
    RunGone,
}

#[derive(Default)]
struct ApprovalRegistryState {
    /// Keyed by run, then by the provider's tool-call id. Two runs can carry the
    /// same call id, so the run scopes it — one run's answer, timeout, or purge
    /// can never reach a sibling.
    entries: HashMap<Uuid, HashMap<String, PendingApproval>>,
    next_registration: u64,
}

/// Process-local pending approvals, shared by chat runs and the answer command.
///
/// The mutex guards only short synchronous map operations and is never held
/// while a prompt awaits its answer.
#[derive(Default)]
pub(crate) struct PendingApprovals {
    state: Mutex<ApprovalRegistryState>,
}

impl PendingApprovals {
    fn park(&self, run_id: Uuid, call_id: &str) -> CoreResult<ParkedApproval> {
        if call_id.trim().is_empty() {
            return Err(CoreError::InvalidName("approval id cannot be blank".into()));
        }
        let mut state = self.state.lock().map_err(|_| poisoned())?;
        state.next_registration = state.next_registration.wrapping_add(1);
        let registration = state.next_registration;
        let (sender, receiver) = oneshot::channel();
        state.entries.entry(run_id).or_default().insert(
            call_id.to_string(),
            PendingApproval {
                sender,
                registration,
            },
        );
        Ok(ParkedApproval {
            registration,
            receiver,
        })
    }

    /// Deliver the user's decision. `Err` when the decision did not land, which
    /// is three things: no such run, no such approval, and — the one a caller is
    /// most likely to forget — an approval whose waiter is no longer there to
    /// receive it. All three read identically to the UI, so a stale sheet cannot
    /// probe which runs exist, and `answer_tool_approval` returns this straight
    /// to the webview: `Ok` here is the UI confirming the click to the user.
    pub(crate) fn answer(
        &self,
        run_id: Uuid,
        call_id: &str,
        answer: ApprovalAnswer,
    ) -> CoreResult<()> {
        let pending = {
            let mut state = self.state.lock().map_err(|_| poisoned())?;
            let run = state
                .entries
                .get_mut(&run_id)
                .ok_or_else(|| not_live(call_id))?;
            let pending = run.remove(call_id).ok_or_else(|| not_live(call_id))?;
            if run.is_empty() {
                state.entries.remove(&run_id);
            }
            pending
        };
        // A closed receiver means nobody is left to receive this decision, so
        // the command must NOT report that it landed: `answer_tool_approval`
        // returns this straight to the webview, and a success there is the UI
        // confirming a click the run never saw. The error is the same "not live"
        // a missing entry produces, so a stale sheet still learns nothing about
        // which runs exist.
        pending.sender.send(answer).map_err(|_| not_live(call_id))?;
        Ok(())
    }

    /// Take back the entry this waiter parked, reporting which of the three
    /// states in [`RegistrationClaim`] the registry was actually in.
    ///
    /// **Only [`Claimed`](RegistrationClaim::Claimed) means "no answer got in
    /// first".** [`answer`](Self::answer) claims the entry under this mutex and
    /// sends *after* releasing it, so each of the other two can be a decision
    /// already in flight — including [`RunGone`](RegistrationClaim::RunGone),
    /// which is what `answer` leaves behind in the ordinary single-approval turn.
    /// A caller that treats anything but `Claimed` as an absence of an answer is
    /// re-introducing the bug this contract replaced.
    ///
    /// Guarded by `the_registry_tells_a_claim_apart_from_an_answer_that_took_it`.
    fn claim_registration(
        &self,
        run_id: Uuid,
        call_id: &str,
        registration: u64,
    ) -> RegistrationClaim {
        let Ok(mut state) = self.state.lock() else {
            // The registry cannot be consulted at all, so nothing about an
            // in-flight answer can be established from it. The waiter takes the
            // outcome, which for a security control means expiry — it denies.
            // Attribution survives without the registry: an answer whose value
            // nobody receives now fails its `send` and is reported as not
            // accepted rather than as success.
            return RegistrationClaim::Claimed;
        };
        let Some(run) = state.entries.get_mut(&run_id) else {
            return RegistrationClaim::RunGone;
        };
        match run.get(call_id) {
            Some(pending) if pending.registration == registration => {
                run.remove(call_id);
                if run.is_empty() {
                    state.entries.remove(&run_id);
                }
                RegistrationClaim::Claimed
            }
            // Somebody else's entry, or none — leave it alone.
            _ => RegistrationClaim::TakenByAnswer,
        }
    }

    /// Drop every approval belonging to a finished run.
    fn finish_run(&self, run_id: Uuid) {
        if let Ok(mut state) = self.state.lock() {
            state.entries.remove(&run_id);
        }
    }

    #[cfg(test)]
    fn live_count(&self, run_id: Uuid) -> usize {
        self.state
            .lock()
            .map(|state| state.entries.get(&run_id).map_or(0, HashMap::len))
            .unwrap_or(0)
    }
}

fn poisoned() -> CoreError {
    CoreError::Io("the approval registry lock is poisoned".into())
}

fn not_live(call_id: &str) -> CoreError {
    CoreError::NotFound(format!(
        "approval '{call_id}' is not live (it may have timed out or ended)"
    ))
}

/// What the `select!` in [`ask_approval`](ShellApprovalPrompt::ask_approval)
/// came out with.
///
/// Expiry cannot always answer on its own, which is why this is not simply an
/// [`ApprovalAnswer`]: when an answer claimed the registration first, the
/// decision is in the channel and has to be read — and the arm itself cannot
/// read it, because the `select!` still borrows the receiver.
enum PromptOutcome {
    /// A final answer for the turn.
    Settled(ApprovalAnswer),
    /// The deadline fired, but an answer had already claimed the registration
    /// under the registry mutex, so its value is on its way. Read it.
    AwaitCommittedAnswer,
}

/// Desktop implementation of core's approval seam.
pub(crate) struct ShellApprovalPrompt {
    pending: Arc<PendingApprovals>,
    run_id: Uuid,
    timeout: Duration,
    close_signal: Arc<crate::ai::ChatRunCloseSignal>,
}

impl ShellApprovalPrompt {
    pub(crate) fn new(
        pending: Arc<PendingApprovals>,
        run_id: Uuid,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> Self {
        Self {
            pending,
            run_id,
            timeout: APPROVAL_TIMEOUT,
            close_signal,
        }
    }

    #[cfg(test)]
    fn with_timeout(
        pending: Arc<PendingApprovals>,
        run_id: Uuid,
        timeout: Duration,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> Self {
        Self {
            pending,
            run_id,
            timeout,
            close_signal,
        }
    }

    /// Resolve a prompt interrupted by teardown or expiry.
    ///
    /// **This is the deliberate opposite of the elicitation path's resolver, and
    /// the inversion is the whole reason this function is not a copy of it.**
    ///
    /// `ShellUserPrompt::resolve_interrupted_registration` (`skills/elicitation.rs`)
    /// honours an answer that raced teardown: an ordinary question whose command
    /// already returned success should not lose the user's choice. For an
    /// **approval** the safe resolution is the reverse. Honouring a yes that
    /// landed as the run was being torn down means writing into a vault that may
    /// already be unmounted, on consent the user gave for a run that no longer
    /// exists. So the teardown wins and the answer is discarded — the receiver is
    /// dropped without being read.
    ///
    /// **This function is only half of that guarantee, and the smaller half.** It
    /// decides what a teardown resolves TO; what decides whether teardown is
    /// reached at all is the arm order of the `biased` `select!` in
    /// [`ask_approval`](ShellApprovalPrompt::ask_approval), which is where a
    /// simultaneously-ready answer either wins or loses. This function returning
    /// a literal `Cancelled` is trivially true and proves nothing on its own —
    /// the tests below have to drive the race.
    ///
    /// Guarded by
    /// [`a_yes_that_races_teardown_is_discarded_rather_than_honoured`](self#tests)
    /// and its denial mirror. Both make the answer and the close signal ready in
    /// the same poll on the current-thread runtime and assert `Cancelled`, so
    /// reordering the select arms — or "simplifying" this to match its
    /// elicitation sibling — fails them with the committed answer.
    fn resolve_interrupted(&self, call_id: &str, registration: u64) -> ApprovalAnswer {
        // Clear our own entry if it is still ours. Whether or not it is, the
        // outcome is the same: cancelled. The removal is housekeeping, not a
        // decision, so the claim is deliberately discarded here — teardown, unlike
        // expiry, does not defer to an answer that raced it, for the reason
        // documented above.
        let _ = self
            .pending
            .claim_registration(self.run_id, call_id, registration);
        ApprovalAnswer::Cancelled
    }

    /// The last word on a committed answer, applied after the `select!` has
    /// already chosen the answer arm.
    ///
    /// **Arm order alone is not enough, and this is where that stops being a
    /// theoretical objection.** A `biased` `select!` only arbitrates arms that are
    /// ready *in the same poll*. Production runs on a multi-threaded runtime, so
    /// another thread can close the signal in the window after the close arm has
    /// already returned `Pending` and before the ready receiver is read — and the
    /// approval would then be honoured on a run that is being torn down, which is
    /// exactly what the ordering exists to prevent. Re-reading the signal here
    /// closes that window: whatever the scheduler did, this function is the last
    /// thing to run before an answer becomes a return value.
    ///
    /// What goes red: `a_committed_answer_is_discarded_when_the_signal_closed_after_the_select_chose_it`.
    fn honour_unless_torn_down(&self, answer: ApprovalAnswer) -> ApprovalAnswer {
        if self.close_signal.is_closed() {
            return ApprovalAnswer::Cancelled;
        }
        answer
    }

    /// The 120-second deadline fired. Decide whether expiry actually gets to
    /// settle the prompt.
    ///
    /// **It only does if it still owned the registration.**
    /// [`answer`](PendingApprovals::answer) claims the entry under the registry
    /// mutex and *then* sends, so anything other than
    /// [`RegistrationClaim::Claimed`] means an answer won that mutex and its
    /// value is already on its way. Settling `TimedOut` regardless would drop a
    /// decision the user made — and drop it silently, because
    /// `answer_tool_approval` has by then already returned success to the
    /// webview. The user would be told the click landed while the run reported a
    /// timeout: safe in outcome (a dropped `Approved` denies) and wrong in
    /// attribution, which is not a thing a security control may be.
    ///
    /// The mutex is what orders the two. This respects that order rather than
    /// letting poll timing overrule it.
    ///
    /// What goes red: `an_answer_committing_as_the_deadline_lands_is_delivered_not_expired`.
    fn settle_expiry(&self, call_id: &str, registration: u64) -> PromptOutcome {
        match self
            .pending
            .claim_registration(self.run_id, call_id, registration)
        {
            RegistrationClaim::Claimed => PromptOutcome::Settled(ApprovalAnswer::TimedOut),
            RegistrationClaim::TakenByAnswer | RegistrationClaim::RunGone => {
                PromptOutcome::AwaitCommittedAnswer
            }
        }
    }
}

#[async_trait]
impl ApprovalPrompt for ShellApprovalPrompt {
    async fn ask_approval(&self, request: &ApprovalPromptRequest) -> CoreResult<ApprovalAnswer> {
        if self.close_signal.is_closed() {
            return Ok(ApprovalAnswer::Cancelled);
        }
        let parked = self.pending.park(self.run_id, &request.id)?;
        let registration = parked.registration;
        let mut receiver = parked.receiver;
        let timeout = tokio::time::sleep(self.timeout);
        tokio::pin!(timeout);

        // `biased`, and the ORDER of these arms is the polarity itself.
        //
        // A `select!` arbitrates the case where more than one arm is ready in the
        // same poll, and for an approval that case is not hypothetical: the user
        // clicks yes as the window closes, and both the answer and the close
        // signal land before this future is next polled. Teardown is listed FIRST
        // so it wins that tie, because honouring the yes would mean writing into
        // a vault that may already be unmounted, on consent given for a run that
        // no longer exists.
        //
        // Expiry stays behind the answer on purpose, and it is a different
        // judgement: a timeout does not tear the run down, so an answer that
        // commits in the same poll as the 120s deadline is a user who clicked at
        // the last moment on a run that is still live. There is nothing unsafe to
        // honour there.
        //
        // What goes red: `a_yes_that_races_teardown_is_discarded_rather_than_honoured`
        // and `a_denial_that_races_teardown_also_resolves_to_cancelled` drive both
        // arms to ready in one poll on the current-thread runtime, so moving the
        // receiver back above the close arm fails them with the committed answer.
        let settled = tokio::select! {
            biased;
            () = self.close_signal.wait_closed() => {
                PromptOutcome::Settled(self.resolve_interrupted(&request.id, registration))
            }
            answer = &mut receiver => PromptOutcome::Settled(self.honour_unless_torn_down(
                answer.unwrap_or(ApprovalAnswer::Cancelled),
            )),
            // Rust owns expiry; the webview's countdown is decoration. Whether
            // expiry gets to settle the prompt is `settle_expiry`'s call.
            () = &mut timeout => self.settle_expiry(&request.id, registration),
        };

        match settled {
            PromptOutcome::Settled(answer) => Ok(answer),
            // The registry mutex put an answer ahead of this deadline, so the
            // decision is on its way and this reads it rather than overruling it.
            //
            // The wait is bounded by the sender, not by hope: `answer` sends
            // within a few instructions of claiming, and a claimed sender dropped
            // without sending closes the channel — which is the ordinary expiry
            // after all, so that is what it resolves to.
            PromptOutcome::AwaitCommittedAnswer => Ok(
                self.honour_unless_torn_down(receiver.await.unwrap_or(ApprovalAnswer::TimedOut))
            ),
        }
    }
}

/// Drop guard owned by one chat invocation: every return and cancellation path
/// drops it, which clears that run's parked approvals.
pub(crate) struct RunApprovalGuard {
    pending: Arc<PendingApprovals>,
    run_id: Uuid,
}

impl RunApprovalGuard {
    pub(crate) fn new(pending: Arc<PendingApprovals>, run_id: Uuid) -> Self {
        Self { pending, run_id }
    }
}

impl Drop for RunApprovalGuard {
    fn drop(&mut self) {
        self.pending.finish_run(self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neuralnote_core::ai::approval::{ApprovalReason, GatedTool};

    fn request(id: &str) -> ApprovalPromptRequest {
        ApprovalPromptRequest {
            id: id.into(),
            tool: GatedTool::WriteNote,
            rel_path: Some("Notes/New.md".into()),
            reason: ApprovalReason::ModeAlwaysAsk,
            expires_in_secs: APPROVAL_TIMEOUT_SECS,
        }
    }

    #[tokio::test]
    async fn an_answer_reaches_the_waiting_run() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(1);
        let prompt = ShellApprovalPrompt::new(
            Arc::clone(&pending),
            run_id,
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        );
        let answering = {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                pending
                    .answer(run_id, "call-1", ApprovalAnswer::Approved)
                    .unwrap();
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        answering.await.unwrap();
        assert_eq!(answer, ApprovalAnswer::Approved);
        assert_eq!(pending.live_count(run_id), 0);
    }

    #[tokio::test]
    async fn a_denial_reaches_the_waiting_run() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(2);
        let prompt = ShellApprovalPrompt::new(
            Arc::clone(&pending),
            run_id,
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        );
        let answering = {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                pending
                    .answer(run_id, "call-1", ApprovalAnswer::Denied)
                    .unwrap();
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        answering.await.unwrap();
        assert_eq!(answer, ApprovalAnswer::Denied);
    }

    #[tokio::test]
    async fn expiry_resolves_to_timed_out_and_clears_the_entry() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(3);
        let prompt = ShellApprovalPrompt::with_timeout(
            Arc::clone(&pending),
            run_id,
            Duration::from_millis(1),
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        );
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        assert_eq!(answer, ApprovalAnswer::TimedOut);
        assert_eq!(pending.live_count(run_id), 0);
    }

    #[tokio::test]
    async fn a_closed_window_resolves_to_cancelled_without_asking() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(4);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        close_signal.close();
        let prompt =
            ShellApprovalPrompt::new(Arc::clone(&pending), run_id, Arc::clone(&close_signal));
        assert_eq!(
            prompt.ask_approval(&request("call-1")).await.unwrap(),
            ApprovalAnswer::Cancelled
        );
        assert_eq!(pending.live_count(run_id), 0, "nothing was ever parked");
    }

    #[tokio::test]
    async fn a_committed_answer_is_discarded_when_the_signal_closed_after_the_select_chose_it() {
        // The window arm ORDER cannot reach, and the one that actually matters in
        // production. `biased` only arbitrates arms ready in the same poll; the
        // shipped runtime is multi-threaded, so another thread can close the
        // signal after the close arm returned `Pending` and before the ready
        // receiver is read. Staging that interleaving deterministically is not
        // possible from a test, so the guard it needs is a named function and
        // this exercises both of its branches directly.
        //
        // What goes red: delete the `is_closed` re-check in
        // `honour_unless_torn_down` and the first assertion returns `Approved`.
        let pending = Arc::new(PendingApprovals::default());
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let prompt = ShellApprovalPrompt::new(
            Arc::clone(&pending),
            Uuid::from_u128(13),
            Arc::clone(&close_signal),
        );

        // Live run: the answer stands, or the guard would be a blanket refusal
        // that passes the test above for the wrong reason.
        for answer in [
            ApprovalAnswer::Approved,
            ApprovalAnswer::Denied,
            ApprovalAnswer::TimedOut,
        ] {
            assert_eq!(prompt.honour_unless_torn_down(answer), answer);
        }

        close_signal.close();
        for answer in [
            ApprovalAnswer::Approved,
            ApprovalAnswer::Denied,
            ApprovalAnswer::TimedOut,
        ] {
            assert_eq!(
                prompt.honour_unless_torn_down(answer),
                ApprovalAnswer::Cancelled,
                "{answer:?} must not survive a run that has been torn down"
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_yes_that_races_teardown_is_discarded_rather_than_honoured() {
        // THE polarity test, and it drives the real race rather than asserting a
        // literal against itself. The elicitation path deliberately honours an
        // answer that races teardown, because losing an ordinary choice whose
        // command returned success is the worse outcome there. For an APPROVAL
        // the safe resolution is the opposite: honouring it means writing into a
        // vault that may already be unmounted, on consent given for a run that is
        // gone.
        //
        // The race is made DETERMINISTIC rather than left to chance. `#[tokio::test]`
        // runs on a current-thread runtime, so the racer cannot be preempted: it
        // commits the answer and closes the signal with no `.await` between them,
        // and neither can be observed until this task is polled again. Both arms
        // of the `select!` are therefore ready in the same poll, which is exactly
        // the case `biased` arbitrates — and the case that decides the polarity.
        //
        // What goes red: put the receiver arm ahead of the close arm (the
        // ordering this file shipped with) and the committed `Approved` wins,
        // which is this assertion failing with `Approved`.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(5);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let prompt = ShellApprovalPrompt::with_timeout(
            Arc::clone(&pending),
            run_id,
            Duration::from_secs(30),
            Arc::clone(&close_signal),
        );

        let racer = {
            let pending = Arc::clone(&pending);
            let close_signal = Arc::clone(&close_signal);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                // The user's "yes" commits, and the window closes in the same
                // breath. The command returns success either way.
                pending
                    .answer(run_id, "call-1", ApprovalAnswer::Approved)
                    .unwrap();
                close_signal.close();
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        racer.await.unwrap();

        assert_eq!(
            answer,
            ApprovalAnswer::Cancelled,
            "a committed approval must not outlive the run it was given for"
        );
        assert_eq!(pending.live_count(run_id), 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn a_denial_that_races_teardown_also_resolves_to_cancelled() {
        // The mirror of the test above, and it is not redundant: it separates
        // "teardown wins" from "the answer happened to be a no". Without it, a
        // regression that returned the committed answer would still look correct
        // for every denial, which is most of the corpus.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(11);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let prompt = ShellApprovalPrompt::with_timeout(
            Arc::clone(&pending),
            run_id,
            Duration::from_secs(30),
            Arc::clone(&close_signal),
        );
        let racer = {
            let pending = Arc::clone(&pending);
            let close_signal = Arc::clone(&close_signal);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                pending
                    .answer(run_id, "call-1", ApprovalAnswer::Denied)
                    .unwrap();
                close_signal.close();
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        racer.await.unwrap();
        assert_eq!(answer, ApprovalAnswer::Cancelled);
    }

    #[tokio::test]
    async fn an_answer_with_no_teardown_in_flight_is_still_honoured() {
        // The other half of the polarity, so "teardown wins" cannot be satisfied
        // by a resolver that simply never reads the receiver. An ordinary answer
        // on a live run must still reach the waiting turn.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(12);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let prompt = ShellApprovalPrompt::with_timeout(
            Arc::clone(&pending),
            run_id,
            Duration::from_secs(30),
            Arc::clone(&close_signal),
        );
        let answering = {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                pending
                    .answer(run_id, "call-1", ApprovalAnswer::Approved)
                    .unwrap();
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        answering.await.unwrap();
        assert_eq!(answer, ApprovalAnswer::Approved);
    }

    /// Stage the state [`PendingApprovals::answer`] occupies between claiming the
    /// entry under the registry mutex and sending its value: the registration is
    /// gone, the sender is alive, and the channel is still empty.
    ///
    /// Production sits in that state for the handful of instructions between
    /// `answer`'s removal and its `send`, and no test can suspend itself inside
    /// them. So the claim is staged here — mirroring `answer` step for step,
    /// pruning the run map as it empties, exactly as it does — while everything
    /// the defect actually lives in stays real: the parked `ask_approval`, its
    /// `select!`, the expiry arm, and the registry itself.
    fn claim_as_answer_does(
        pending: &PendingApprovals,
        run_id: Uuid,
        call_id: &str,
    ) -> PendingApproval {
        let mut state = pending.state.lock().expect("the registry lock is healthy");
        let run = state
            .entries
            .get_mut(&run_id)
            .expect("the run must still be parked");
        let claimed = run
            .remove(call_id)
            .expect("the approval must still be parked");
        if run.is_empty() {
            state.entries.remove(&run_id);
        }
        claimed
    }

    /// Park one approval through the real `ask_approval` and hand back its task.
    fn spawn_waiting_turn(
        pending: &Arc<PendingApprovals>,
        run_id: Uuid,
        close_signal: &Arc<crate::ai::ChatRunCloseSignal>,
    ) -> tokio::task::JoinHandle<CoreResult<ApprovalAnswer>> {
        let pending = Arc::clone(pending);
        let close_signal = Arc::clone(close_signal);
        tokio::spawn(async move {
            ShellApprovalPrompt::new(pending, run_id, close_signal)
                .ask_approval(&request("call-1"))
                .await
        })
    }

    /// Yield until the spawned turn has parked its approval, without ever leaving
    /// the runtime idle — under a paused clock an idle runtime auto-advances, and
    /// the deadline would fire before the race could be staged.
    async fn wait_until_parked(pending: &PendingApprovals, run_id: Uuid) {
        while pending.live_count(run_id) == 0 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn an_answer_committing_as_the_deadline_lands_is_delivered_not_expired() {
        // THE race this file's `TODO(approval-late-answer)` described. The user
        // clicks yes at the last second: `answer` takes the registration under
        // the registry mutex, and the 120s deadline lands before its value
        // reaches the channel. Expiry must not overrule an answer the mutex
        // already ordered ahead of it — `answer_tool_approval` has by then told
        // the UI the click succeeded, so settling `TimedOut` makes the security
        // control tell the user one thing and the run another.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(14);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let waiting = spawn_waiting_turn(&pending, run_id, &close_signal);
        wait_until_parked(&pending, run_id).await;

        let committing = claim_as_answer_does(&pending, run_id, "call-1");
        assert_eq!(
            pending.live_count(run_id),
            0,
            "the staged claim must leave the registry exactly as `answer` leaves it"
        );

        // The deadline lands inside that window.
        tokio::time::advance(APPROVAL_TIMEOUT + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;

        // ...and now the send lands, which is what `answer` does next.
        assert!(
            committing.sender.send(ApprovalAnswer::Approved).is_ok(),
            "expiry settled and dropped the receiver while the answer was in flight, \
             so the user's click disappears into a closed channel"
        );
        assert_eq!(
            waiting.await.unwrap().unwrap(),
            ApprovalAnswer::Approved,
            "the registry mutex ordered this answer ahead of the deadline; poll timing must not overrule it"
        );
    }

    #[tokio::test(flavor = "current_thread", start_paused = true)]
    async fn a_committing_answer_that_never_arrives_falls_back_to_expiry() {
        // The bound on the test above, and it is what keeps deferring to a
        // committing answer from being an unbounded wait. Expiry hands over to
        // the channel, and the channel is what closes it: a claimed sender
        // dropped without sending (its caller panicked, say) resolves the wait
        // rather than parking the turn forever, and resolves it as the expiry it
        // is. The sender is dropped only AFTER the deadline has landed — drop it
        // sooner and the ready-but-closed receiver wins the `select!` outright,
        // which is a different path settling `Cancelled`.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(15);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let waiting = spawn_waiting_turn(&pending, run_id, &close_signal);
        wait_until_parked(&pending, run_id).await;

        let committing = claim_as_answer_does(&pending, run_id, "call-1");
        tokio::time::advance(APPROVAL_TIMEOUT + Duration::from_secs(1)).await;
        tokio::task::yield_now().await;
        drop(committing);

        assert_eq!(waiting.await.unwrap().unwrap(), ApprovalAnswer::TimedOut);
    }

    #[tokio::test]
    async fn an_answer_no_waiter_can_receive_is_reported_as_not_accepted() {
        // The other half of the attribution. A decision that reaches nobody is
        // not a decision that landed, and `answer_tool_approval` returns this
        // result straight to the webview — so reporting success here is the UI
        // confirming a click the run never saw. The turn is torn out from under
        // the sheet (its future dropped) while its registration is still parked,
        // which is the one way `answer` can hold an entry nobody is listening to.
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(16);
        let close_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let waiting = spawn_waiting_turn(&pending, run_id, &close_signal);
        wait_until_parked(&pending, run_id).await;

        waiting.abort();
        assert!(waiting.await.unwrap_err().is_cancelled());
        assert_eq!(
            pending.live_count(run_id),
            1,
            "the registration outlives the dropped turn — only the run guard clears it"
        );

        let error = pending
            .answer(run_id, "call-1", ApprovalAnswer::Approved)
            .expect_err("an answer nobody received must not be reported as accepted");
        assert!(
            matches!(error, CoreError::NotFound(_)),
            "the same `not live` a stale sheet already gets, so this leaks nothing new: {error:?}"
        );
        assert_eq!(pending.live_count(run_id), 0, "the claim still happened");
    }

    #[tokio::test]
    async fn an_answer_for_a_different_run_does_not_resolve_this_one() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(6);
        let other_run = Uuid::from_u128(7);
        let prompt = ShellApprovalPrompt::with_timeout(
            Arc::clone(&pending),
            run_id,
            Duration::from_millis(40),
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        );
        let meddling = {
            let pending = Arc::clone(&pending);
            tokio::spawn(async move {
                while pending.live_count(run_id) == 0 {
                    tokio::task::yield_now().await;
                }
                // Same call id, different run: the composite key is what stops
                // one run's approval satisfying another's.
                assert!(pending
                    .answer(other_run, "call-1", ApprovalAnswer::Approved)
                    .is_err());
            })
        };
        let answer = prompt.ask_approval(&request("call-1")).await.unwrap();
        meddling.await.unwrap();
        assert_eq!(answer, ApprovalAnswer::TimedOut);
    }

    #[test]
    fn answering_an_unknown_approval_is_an_error_the_ui_can_show() {
        let pending = PendingApprovals::default();
        let error = pending
            .answer(Uuid::from_u128(8), "never-parked", ApprovalAnswer::Approved)
            .unwrap_err();
        assert!(matches!(error, CoreError::NotFound(_)));
    }

    #[test]
    fn the_registry_tells_a_claim_apart_from_an_answer_that_took_it() {
        // The contract the expiry arm reads. A `bool` could not separate the
        // first case from the third — and the third is exactly what `answer`
        // leaves behind in the ordinary one-approval turn, so a guard keyed on
        // that `bool` read "an answer is in flight" as "there is nothing here"
        // almost every time it mattered.
        let pending = PendingApprovals::default();
        let run_id = Uuid::from_u128(17);

        let mine = pending.park(run_id, "call-1").unwrap();
        assert_eq!(
            pending.claim_registration(run_id, "call-1", mine.registration),
            RegistrationClaim::Claimed
        );
        // The same claim again: the run map went with its last entry.
        assert_eq!(
            pending.claim_registration(run_id, "call-1", mine.registration),
            RegistrationClaim::RunGone
        );

        let newer = pending.park(run_id, "call-1").unwrap();
        assert_eq!(
            pending.claim_registration(run_id, "call-1", mine.registration),
            RegistrationClaim::TakenByAnswer
        );
        assert_eq!(
            pending.live_count(run_id),
            1,
            "a registration that is not ours must be left alone"
        );
        assert_eq!(
            pending.claim_registration(run_id, "call-1", newer.registration),
            RegistrationClaim::Claimed
        );
    }

    #[test]
    fn a_blank_approval_id_is_refused_at_park_time() {
        let pending = PendingApprovals::default();
        assert!(pending.park(Uuid::from_u128(9), "   ").is_err());
    }

    #[test]
    fn the_run_guard_clears_every_parked_approval_for_its_run() {
        let pending = Arc::new(PendingApprovals::default());
        let run_id = Uuid::from_u128(10);
        let _parked = pending.park(run_id, "call-1").unwrap();
        assert_eq!(pending.live_count(run_id), 1);
        {
            let _guard = RunApprovalGuard::new(Arc::clone(&pending), run_id);
        }
        assert_eq!(pending.live_count(run_id), 0);
    }

    #[test]
    fn the_shell_timeout_is_the_core_constant() {
        // Two countdowns that disagree would let the UI show a live sheet Rust has
        // already expired, or the reverse.
        assert_eq!(APPROVAL_TIMEOUT.as_secs(), u64::from(APPROVAL_TIMEOUT_SECS));
    }
}
