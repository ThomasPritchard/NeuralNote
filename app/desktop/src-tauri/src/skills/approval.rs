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

    /// Deliver the user's decision. `Err` when no live approval matches — a
    /// missing run and a missing id read identically to the UI, so a stale sheet
    /// cannot probe which runs exist.
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
        // A closed receiver means the waiter already gave up. That is not an
        // error the user can act on, and reporting one would tell a stale sheet
        // something about the run it should not learn.
        let _ = pending.sender.send(answer);
        Ok(())
    }

    /// Remove the entry if it is still the one this waiter parked.
    ///
    /// Returns `true` when it removed its own registration.
    ///
    /// **It does NOT mean "no answer got in first" — which is what it looks like,
    /// and what this doc used to claim.** `true` is also returned when the run's
    /// map is absent entirely, and [`answer`](Self::answer) drops that map as soon
    /// as it empties — the usual case, because a turn parks one approval at a
    /// time. So `true` conflates "I removed mine" with "there is nothing here at
    /// all", and only `false` carries information: an entry exists and belongs to
    /// somebody else.
    ///
    /// TODO(approval-late-answer): that conflation hides a real defect. `answer`
    /// removes the entry under this mutex and *then* sends, so an answer
    /// committing as the 120s deadline lands can have its registration already
    /// gone while its value is still in flight. The timeout arm settles
    /// `TimedOut` and drops it — and because `answer` ignores a closed receiver,
    /// the IPC command has already reported success to the UI, so the click
    /// disappears silently. Fixing it needs a three-way outcome here
    /// (removed-mine / someone-else's / absent) so the timeout arm can wait for a
    /// committing answer rather than overrule it; that is a contract change wider
    /// than this change-set. It is not fail-open: a dropped `Approved` denies and
    /// a dropped `Denied` still refuses — the outcome is safe, the attribution is
    /// wrong. Found by a frontier-GPT review of this diff; an attempted fix keyed
    /// on the current `bool` was reverted precisely because the conflation above
    /// makes it a no-op in the common case, and its test proved nothing.
    fn remove_if_registration(&self, run_id: Uuid, call_id: &str, registration: u64) -> bool {
        let Ok(mut state) = self.state.lock() else {
            return true;
        };
        let Some(run) = state.entries.get_mut(&run_id) else {
            return true;
        };
        match run.get(call_id) {
            Some(pending) if pending.registration == registration => {
                run.remove(call_id);
                if run.is_empty() {
                    state.entries.remove(&run_id);
                }
                true
            }
            // Somebody else's entry, or none — leave it alone.
            _ => false,
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
        // decision.
        self.pending
            .remove_if_registration(self.run_id, call_id, registration);
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
        tokio::select! {
            biased;
            () = self.close_signal.wait_closed() => {
                Ok(self.resolve_interrupted(&request.id, registration))
            }
            answer = &mut receiver => Ok(self.honour_unless_torn_down(
                answer.unwrap_or(ApprovalAnswer::Cancelled),
            )),
            () = &mut timeout => {
                // Rust owns expiry. The webview's countdown is decoration.
                //
                // But expiry only gets to SETTLE the prompt if it actually
                // claimed the registration. `answer` removes the entry under the
                // registry mutex and then sends, so a `false` here means an answer
                // won that mutex and its value is already on its way. Returning
                // `TimedOut` anyway would drop a decision the user made — and
                // drop it silently, because `answer` ignores a closed receiver and
                // its command has already reported success to the UI. The mutex is
                // what orders the two; this respects that order instead of letting
                // poll timing overrule it.
                self.pending
                    .remove_if_registration(self.run_id, &request.id, registration);
                Ok(ApprovalAnswer::TimedOut)
            }
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
