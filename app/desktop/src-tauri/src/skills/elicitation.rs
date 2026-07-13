use async_trait::async_trait;
use neuralnote_core::ai::{Elicitation, UserPrompt};
use neuralnote_core::{CoreError, CoreResult};
use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;

const ELICITATION_TIMEOUT: Duration = Duration::from_secs(300);

/// One responder parked at the Rust/UI boundary.
///
/// The offered ids and selection mode are copied from the core-authored
/// [`Elicitation`] before control reaches the webview. `answer_elicitation` can
/// therefore validate the untrusted command arguments against this record rather
/// than accepting a caller-supplied option set.
struct PendingElicitation {
    sender: oneshot::Sender<Option<Vec<String>>>,
    offered_ids: BTreeSet<String>,
    multi_select: bool,
    run_id: String,
    registration: u64,
}

/// The receiver half returned to [`ShellUserPrompt`]. `registration` prevents a
/// timed-out waiter from deleting a newer prompt that reused the same model tool
/// id at the exact answer/timeout boundary.
pub(crate) struct ParkedResponse {
    registration: u64,
    receiver: oneshot::Receiver<Option<Vec<String>>>,
}

#[derive(Default)]
struct RegistryState {
    // TODO(elicit-run-scope): key PendingElicitations by (run_id, id) to close cross-run id collision.
    entries: HashMap<String, PendingElicitation>,
    run_signals: HashMap<String, Arc<crate::ai::ChatRunCloseSignal>>,
    next_registration: u64,
    lifecycle_generation: u64,
}

/// Process-local pending structured questions shared by chat runs and the answer
/// command. The mutex guards only short, synchronous map operations and is never
/// held while a prompt awaits its response.
#[derive(Default)]
pub(crate) struct PendingElicitations {
    state: Mutex<RegistryState>,
}

impl PendingElicitations {
    /// Park one responder without emitting an event. Core's `elicit_user` already
    /// sent `ChatEvent::Elicit` before calling `UserPrompt::ask`; sending here would
    /// duplicate the question in the UI.
    pub(crate) fn park(
        &self,
        run_id: &str,
        elicitation: Elicitation,
    ) -> CoreResult<ParkedResponse> {
        if run_id.trim().is_empty() {
            return Err(CoreError::InvalidName(
                "elicitation run id cannot be blank".into(),
            ));
        }
        if elicitation.id.trim().is_empty() {
            return Err(CoreError::InvalidName(
                "elicitation id cannot be blank".into(),
            ));
        }
        if elicitation.options.is_empty() {
            return Err(CoreError::InvalidName(format!(
                "elicitation '{}' has no offered options",
                elicitation.id
            )));
        }

        let mut offered_ids = BTreeSet::new();
        for option in elicitation.options {
            if option.id.trim().is_empty() {
                return Err(CoreError::InvalidName(format!(
                    "elicitation '{}' contains a blank option id",
                    elicitation.id
                )));
            }
            if !offered_ids.insert(option.id.clone()) {
                return Err(CoreError::InvalidName(format!(
                    "elicitation '{}' offers option '{}' more than once",
                    elicitation.id, option.id
                )));
            }
        }

        let (sender, receiver) = oneshot::channel();
        let mut state = self.lock();
        if state.entries.contains_key(&elicitation.id) {
            return Err(CoreError::Conflict(format!(
                "elicitation '{}' is already awaiting an answer",
                elicitation.id
            )));
        }
        let registration = state.next_registration;
        state.next_registration = state.next_registration.checked_add(1).ok_or_else(|| {
            CoreError::Conflict("pending elicitation registration counter overflowed".into())
        })?;
        state.entries.insert(
            elicitation.id,
            PendingElicitation {
                sender,
                offered_ids,
                multi_select: elicitation.multi_select,
                run_id: run_id.to_string(),
                registration,
            },
        );

        Ok(ParkedResponse {
            registration,
            receiver,
        })
    }

    /// Validate and deliver an IPC answer. Choice-validation failures deliberately
    /// leave the sender parked so a stale/double UI click cannot destroy the live
    /// question and the user may immediately choose again.
    pub(crate) fn answer(&self, id: &str, choices: Vec<String>) -> CoreResult<()> {
        let pending = {
            let mut state = self.lock();
            let entry = state.entries.get(id).ok_or_else(|| {
                CoreError::NotFound(format!(
                    "elicitation '{id}' is not live (it may have timed out or ended)"
                ))
            })?;

            if !entry.multi_select && choices.len() != 1 {
                return Err(CoreError::InvalidName(format!(
                    "elicitation '{id}' is single-select and requires exactly one choice"
                )));
            }
            let mut selected = BTreeSet::new();
            for choice in &choices {
                if !entry.offered_ids.contains(choice) {
                    return Err(CoreError::InvalidName(format!(
                        "choice '{choice}' was not offered by elicitation '{id}'"
                    )));
                }
                if !selected.insert(choice) {
                    return Err(CoreError::InvalidName(format!(
                        "choice '{choice}' was supplied more than once for elicitation '{id}'"
                    )));
                }
            }

            state
                .entries
                .remove(id)
                .expect("a validated live elicitation remains present under the lock")
        };

        pending.sender.send(Some(choices)).map_err(|_| {
            CoreError::Conflict(format!(
                "elicitation '{id}' ended before its answer could be delivered"
            ))
        })
    }

    /// Remove every pending question owned by `run_id`. Dropping the senders wakes
    /// their inline `ask` futures as `None`, so an early return cannot strand an
    /// asynchronous task behind a response the UI can no longer send.
    pub(crate) fn purge_run(&self, run_id: &str) -> usize {
        let removed = {
            let mut state = self.lock();
            let ids = state
                .entries
                .iter()
                .filter(|(_, pending)| pending.run_id == run_id)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.entries.remove(&id))
                .collect::<Vec<_>>()
        };
        let count = removed.len();
        drop(removed);
        count
    }

    fn register_run(
        &self,
        run_id: &str,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
        expected_generation: u64,
    ) -> CoreResult<()> {
        if run_id.trim().is_empty() {
            return Err(CoreError::InvalidName("chat run id cannot be blank".into()));
        }
        let mut state = self.lock();
        if state.lifecycle_generation != expected_generation {
            drop(state);
            close_signal.close();
            return Err(CoreError::Conflict(format!(
                "chat run '{run_id}' cannot start because the workspace changed"
            )));
        }
        if state.run_signals.contains_key(run_id) {
            return Err(CoreError::Conflict(format!(
                "chat run '{run_id}' is already registered"
            )));
        }
        state.run_signals.insert(run_id.to_string(), close_signal);
        Ok(())
    }

    /// Cancel every registered run before a vault/webview lifecycle teardown.
    /// Signals are retained values, so a run that has not reached `ask` yet sees
    /// the close before it can park; already-parked senders are dropped together.
    pub(crate) fn cancel_all_runs(&self) -> usize {
        let (signals, parked) = {
            let mut state = self.lock();
            // Pair this generation bump with the vault root snapshot in `chat`.
            // A command paused between those operations cannot register against
            // a workspace that has since been replaced. Wrapping would require
            // 2^64 vault lifecycle changes during one process lifetime.
            state.lifecycle_generation = state.lifecycle_generation.wrapping_add(1);
            let signals = state
                .run_signals
                .drain()
                .map(|(_, signal)| signal)
                .collect::<Vec<_>>();
            let parked = state
                .entries
                .drain()
                .map(|(_, pending)| pending)
                .collect::<Vec<_>>();
            (signals, parked)
        };
        let count = signals.len();
        for signal in signals {
            signal.close();
        }
        drop(parked);
        count
    }

    /// Cancel the UI's sole active chat run without changing the vault lifecycle
    /// generation. A second concurrent run is an explicit conflict rather than
    /// an arbitrary cancellation target.
    pub(crate) fn cancel_active_run(&self) -> CoreResult<bool> {
        let (run_id, signal, parked) = {
            let mut state = self.lock();
            if state.run_signals.len() > 1 {
                return Err(CoreError::Conflict(
                    "more than one chat run is active; refusing an ambiguous cancellation".into(),
                ));
            }
            let Some(run_id) = state.run_signals.keys().next().cloned() else {
                return Ok(false);
            };
            let signal = state
                .run_signals
                .remove(&run_id)
                .expect("active run id came from the same map");
            let ids = state
                .entries
                .iter()
                .filter_map(|(id, pending)| (pending.run_id == run_id).then_some(id.clone()))
                .collect::<Vec<_>>();
            let parked = ids
                .into_iter()
                .filter_map(|id| state.entries.remove(&id))
                .collect::<Vec<_>>();
            (run_id, signal, parked)
        };
        signal.close();
        drop(parked);
        log::debug!("cancelled chat run {run_id}");
        Ok(true)
    }

    /// Snapshot the workspace lifecycle used to reject a run that was paused
    /// while its vault was replaced or closed.
    pub(crate) fn lifecycle_generation(&self) -> u64 {
        self.lock().lifecycle_generation
    }

    fn finish_run(&self, run_id: &str) {
        self.lock().run_signals.remove(run_id);
        self.purge_run(run_id);
    }

    /// Win timeout ownership only if `id` still names the exact registration this
    /// waiter parked. A successful answer may remove it and a subsequent run may
    /// reuse the id before the timer branch gets the mutex; generation matching
    /// keeps that newer sender alive.
    fn remove_if_registration(&self, id: &str, registration: u64) -> bool {
        let removed = {
            let mut state = self.lock();
            let owns_registration = state
                .entries
                .get(id)
                .is_some_and(|pending| pending.registration == registration);
            owns_registration
                .then(|| state.entries.remove(id))
                .flatten()
        };
        removed.is_some()
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.lock().entries.len()
    }

    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Desktop implementation of core's structured-question seam. It parks exactly
/// one responder and awaits inline; it never spawns and never emits `Elicit`.
pub(crate) struct ShellUserPrompt {
    pending: Arc<PendingElicitations>,
    run_id: String,
    timeout: Duration,
    close_signal: Arc<crate::ai::ChatRunCloseSignal>,
}

impl ShellUserPrompt {
    pub(crate) fn new(
        pending: Arc<PendingElicitations>,
        run_id: impl Into<String>,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> Self {
        Self {
            pending,
            run_id: run_id.into(),
            timeout: ELICITATION_TIMEOUT,
            close_signal,
        }
    }

    #[cfg(test)]
    fn with_timeout(
        pending: Arc<PendingElicitations>,
        run_id: impl Into<String>,
        timeout: Duration,
    ) -> Self {
        Self::with_timeout_and_close(
            pending,
            run_id,
            timeout,
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        )
    }

    #[cfg(test)]
    fn with_timeout_and_close(
        pending: Arc<PendingElicitations>,
        run_id: impl Into<String>,
        timeout: Duration,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
    ) -> Self {
        Self {
            pending,
            run_id: run_id.into(),
            timeout,
            close_signal,
        }
    }

    async fn resolve_interrupted_registration(
        &self,
        id: &str,
        registration: u64,
        receiver: &mut oneshot::Receiver<Option<Vec<String>>>,
    ) -> Option<Vec<String>> {
        if self.pending.remove_if_registration(id, registration) {
            return None;
        }

        // An answer or run purge removed the entry at the exact interruption
        // boundary. The receiver is still owned here, so observe that committed
        // outcome rather than discarding an answer whose command returned success.
        receiver.await.unwrap_or(None)
    }
}

#[async_trait]
impl UserPrompt for ShellUserPrompt {
    async fn ask(&self, elicitation: Elicitation) -> CoreResult<Option<Vec<String>>> {
        if self.close_signal.is_closed() {
            return Ok(None);
        }
        let id = elicitation.id.clone();
        let parked = self.pending.park(&self.run_id, elicitation)?;
        let registration = parked.registration;
        let mut receiver = parked.receiver;
        let timeout = tokio::time::sleep(self.timeout);
        tokio::pin!(timeout);

        tokio::select! {
            biased;
            answer = &mut receiver => Ok(answer.unwrap_or(None)),
            () = self.close_signal.wait_closed() => {
                Ok(self.resolve_interrupted_registration(&id, registration, &mut receiver).await)
            }
            () = &mut timeout => {
                Ok(self.resolve_interrupted_registration(&id, registration, &mut receiver).await)
            }
        }
    }
}

/// Drop guard owned by one chat invocation. Every return/cancellation path drops
/// it, which closes all response senders belonging to that run.
pub(crate) struct RunElicitationGuard {
    pending: Arc<PendingElicitations>,
    run_id: String,
}

impl RunElicitationGuard {
    pub(crate) fn try_new(
        pending: Arc<PendingElicitations>,
        run_id: impl Into<String>,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
        expected_generation: u64,
    ) -> CoreResult<Self> {
        let run_id = run_id.into();
        pending.register_run(&run_id, close_signal, expected_generation)?;
        Ok(Self { pending, run_id })
    }
}

impl Drop for RunElicitationGuard {
    fn drop(&mut self) {
        self.pending.finish_run(&self.run_id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use neuralnote_core::ai::{ElicitOption, Elicitation, UserPrompt};
    use neuralnote_core::CoreError;
    use std::sync::Arc;
    use std::time::Duration;

    fn elicitation(id: &str, multi_select: bool) -> Elicitation {
        Elicitation {
            id: id.into(),
            question: "Continue?".into(),
            options: vec![
                ElicitOption {
                    id: "yes".into(),
                    label: "Yes".into(),
                    description: None,
                    image_data_uri: None,
                },
                ElicitOption {
                    id: "no".into(),
                    label: "No".into(),
                    description: None,
                    image_data_uri: None,
                },
            ],
            multi_select,
        }
    }

    #[test]
    fn production_prompt_timeout_is_five_minutes() {
        let prompt = ShellUserPrompt::new(
            Arc::new(PendingElicitations::default()),
            "run-1",
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
        );

        assert_eq!(prompt.timeout, Duration::from_secs(300));
    }

    #[tokio::test]
    async fn valid_answer_removes_entry_and_resolves_the_parked_prompt() {
        let pending = Arc::new(PendingElicitations::default());
        let prompt =
            ShellUserPrompt::with_timeout(Arc::clone(&pending), "run-1", Duration::from_secs(1));
        let answer = tokio::spawn(async move { prompt.ask(elicitation("q-1", false)).await });
        tokio::task::yield_now().await;

        pending.answer("q-1", vec!["yes".into()]).unwrap();

        assert_eq!(answer.await.unwrap().unwrap(), Some(vec!["yes".into()]));
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn invalid_choices_leave_the_entry_parked_for_a_retry() {
        let pending = Arc::new(PendingElicitations::default());
        let prompt =
            ShellUserPrompt::with_timeout(Arc::clone(&pending), "run-1", Duration::from_secs(1));
        let answer = tokio::spawn(async move { prompt.ask(elicitation("q-1", false)).await });
        tokio::task::yield_now().await;

        for choices in [
            Vec::<String>::new(),
            vec!["yes".into(), "no".into()],
            vec!["unknown".into()],
            vec!["yes".into(), "yes".into()],
        ] {
            assert!(matches!(
                pending.answer("q-1", choices),
                Err(CoreError::InvalidName(_))
            ));
            assert_eq!(pending.len(), 1, "validation must not consume the prompt");
        }

        pending.answer("q-1", vec!["no".into()]).unwrap();
        assert_eq!(answer.await.unwrap().unwrap(), Some(vec!["no".into()]));
    }

    #[tokio::test]
    async fn multi_select_accepts_distinct_offered_choices_and_allows_empty() {
        let pending = Arc::new(PendingElicitations::default());
        let prompt =
            ShellUserPrompt::with_timeout(Arc::clone(&pending), "run-1", Duration::from_secs(1));
        let answer = tokio::spawn(async move { prompt.ask(elicitation("q-1", true)).await });
        tokio::task::yield_now().await;

        pending
            .answer("q-1", vec!["yes".into(), "no".into()])
            .unwrap();

        assert_eq!(
            answer.await.unwrap().unwrap(),
            Some(vec!["yes".into(), "no".into()])
        );

        let parked = pending.park("run-1", elicitation("q-2", true)).unwrap();
        pending.answer("q-2", vec![]).unwrap();
        assert_eq!(parked.receiver.await.unwrap(), Some(vec![]));

        let duplicate = pending.park("run-1", elicitation("q-3", true)).unwrap();
        assert!(matches!(
            pending.answer("q-3", vec!["yes".into(), "yes".into()]),
            Err(CoreError::InvalidName(_))
        ));
        assert_eq!(pending.len(), 1);
        pending.answer("q-3", vec!["yes".into()]).unwrap();
        assert_eq!(duplicate.receiver.await.unwrap(), Some(vec!["yes".into()]));
    }

    #[test]
    fn unknown_or_dead_id_is_rejected_explicitly() {
        let pending = PendingElicitations::default();

        assert!(matches!(
            pending.answer("missing", vec!["yes".into()]),
            Err(CoreError::NotFound(message)) if message.contains("missing")
        ));
    }

    #[tokio::test]
    async fn duplicate_live_id_is_rejected_without_replacing_the_first_sender() {
        let pending = PendingElicitations::default();
        let first = pending
            .park("run-1", elicitation("same-id", false))
            .unwrap();

        assert!(matches!(
            pending.park("run-2", elicitation("same-id", false)),
            Err(CoreError::Conflict(_))
        ));

        pending.answer("same-id", vec!["yes".into()]).unwrap();
        assert_eq!(first.receiver.await.unwrap(), Some(vec!["yes".into()]));
    }

    #[tokio::test]
    async fn timeout_removes_entry_and_a_late_answer_is_dead() {
        let pending = Arc::new(PendingElicitations::default());
        let prompt = ShellUserPrompt::with_timeout(Arc::clone(&pending), "run-1", Duration::ZERO);

        assert_eq!(prompt.ask(elicitation("q-1", false)).await.unwrap(), None);
        assert_eq!(pending.len(), 0);
        assert!(matches!(
            pending.answer("q-1", vec!["yes".into()]),
            Err(CoreError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn timeout_cleanup_cannot_remove_a_newer_registration_with_the_same_id() {
        let pending = PendingElicitations::default();
        let old = pending.park("old-run", elicitation("q-1", false)).unwrap();
        pending.answer("q-1", vec!["yes".into()]).unwrap();
        assert_eq!(old.receiver.await.unwrap(), Some(vec!["yes".into()]));
        let newer = pending.park("new-run", elicitation("q-1", false)).unwrap();

        assert!(!pending.remove_if_registration("q-1", old.registration));
        pending.answer("q-1", vec!["no".into()]).unwrap();
        assert_eq!(newer.receiver.await.unwrap(), Some(vec!["no".into()]));
    }

    #[tokio::test]
    async fn purge_run_closes_only_that_runs_parked_receivers() {
        let pending = PendingElicitations::default();
        let first = pending.park("run-1", elicitation("q-1", false)).unwrap();
        let second = pending.park("run-2", elicitation("q-2", false)).unwrap();

        assert_eq!(pending.purge_run("run-1"), 1);
        assert!(first.receiver.await.is_err());
        assert_eq!(pending.len(), 1);

        pending.answer("q-2", vec!["no".into()]).unwrap();
        assert_eq!(second.receiver.await.unwrap(), Some(vec!["no".into()]));
    }

    #[tokio::test]
    async fn run_guard_drop_wakes_shell_prompt_with_none() {
        let pending = Arc::new(PendingElicitations::default());
        let closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            "run-1",
            Arc::clone(&closed),
            pending.lifecycle_generation(),
        )
        .unwrap();
        let prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            "run-1",
            Duration::from_secs(10),
            closed,
        );
        let answer = tokio::spawn(async move { prompt.ask(elicitation("q-1", false)).await });
        tokio::task::yield_now().await;

        drop(guard);

        assert_eq!(answer.await.unwrap().unwrap(), None);
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn closed_chat_channel_wakes_and_removes_a_parked_prompt() {
        let pending = Arc::new(PendingElicitations::default());
        let closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            "run-1",
            Duration::from_secs(10),
            Arc::clone(&closed),
        );
        let answer = tokio::spawn(async move { prompt.ask(elicitation("q-1", false)).await });
        tokio::task::yield_now().await;

        closed.close();

        assert_eq!(answer.await.unwrap().unwrap(), None);
        assert_eq!(pending.len(), 0);
        assert!(matches!(
            pending.answer("q-1", vec!["yes".into()]),
            Err(CoreError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn channel_close_before_ask_is_retained_without_parking() {
        let pending = Arc::new(PendingElicitations::default());
        let closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        closed.close();
        let prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            "run-1",
            Duration::from_secs(10),
            closed,
        );

        assert_eq!(prompt.ask(elicitation("q-1", false)).await.unwrap(), None);
        assert_eq!(pending.len(), 0);
    }

    #[tokio::test]
    async fn cancelling_all_runs_wakes_live_prompts_and_blocks_later_parking() {
        let pending = Arc::new(PendingElicitations::default());
        let first_closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let second_closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let generation = pending.lifecycle_generation();
        let _first_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            "run-1",
            Arc::clone(&first_closed),
            generation,
        )
        .unwrap();
        let _second_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            "run-2",
            Arc::clone(&second_closed),
            generation,
        )
        .unwrap();
        let first_prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            "run-1",
            Duration::from_secs(10),
            first_closed,
        );
        let first_answer =
            tokio::spawn(async move { first_prompt.ask(elicitation("q-1", false)).await });
        tokio::task::yield_now().await;

        assert_eq!(pending.cancel_all_runs(), 2);

        assert_eq!(first_answer.await.unwrap().unwrap(), None);
        let second_prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            "run-2",
            Duration::from_secs(10),
            second_closed,
        );
        assert_eq!(
            second_prompt.ask(elicitation("q-2", false)).await.unwrap(),
            None
        );
        assert_eq!(pending.len(), 0);
    }

    #[test]
    fn stale_vault_snapshot_cannot_register_after_lifecycle_cancellation() {
        let pending = Arc::new(PendingElicitations::default());
        let stale_generation = pending.lifecycle_generation();

        assert_eq!(pending.cancel_all_runs(), 0);

        let stale_closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        assert!(matches!(
            RunElicitationGuard::try_new(
                Arc::clone(&pending),
                "stale-run",
                Arc::clone(&stale_closed),
                stale_generation,
            ),
            Err(CoreError::Conflict(message)) if message.contains("workspace changed")
        ));
        assert!(stale_closed.is_closed());

        let fresh_closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let fresh = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            "fresh-run",
            Arc::clone(&fresh_closed),
            pending.lifecycle_generation(),
        )
        .unwrap();
        assert!(!fresh_closed.is_closed());
        drop(fresh);
    }

    #[test]
    fn cancelling_the_single_active_run_closes_it_without_advancing_vault_generation() {
        let pending = PendingElicitations::default();
        let generation = pending.lifecycle_generation();
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        pending
            .register_run("run-1", Arc::clone(&signal), generation)
            .unwrap();

        assert!(pending.cancel_active_run().unwrap());
        assert!(signal.is_closed());
        assert_eq!(pending.lifecycle_generation(), generation);
        assert!(!pending.cancel_active_run().unwrap());
    }
}
