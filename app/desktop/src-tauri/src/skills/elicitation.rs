use async_trait::async_trait;
use neuralnote_core::ai::{Elicitation, UserPrompt};
use neuralnote_core::{CoreError, CoreResult};
use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;
use tokio::sync::oneshot;
use ts_rs::TS;
use uuid::Uuid;

const ELICITATION_TIMEOUT: Duration = Duration::from_secs(300);
const MAX_COMPLETED_CHAT_RUNS: usize = 64;
const MAX_PENDING_CHAT_STOPS: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) enum CancelChatRunStatus {
    Cancelled,
    AlreadyCompleted,
    // Kept in the frozen 0.2.0 wire vocabulary for forward-compatible callers.
    #[allow(dead_code)]
    NotCurrent,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub(crate) struct CancelChatRunOutcome {
    pub(crate) turn_id: String,
    pub(crate) status: CancelChatRunStatus,
}

impl CancelChatRunOutcome {
    fn new(turn_id: Uuid, status: CancelChatRunStatus) -> Self {
        Self {
            turn_id: turn_id.to_string(),
            status,
        }
    }
}

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
    run_signals: HashMap<Uuid, Arc<crate::ai::ChatRunCloseSignal>>,
    pending_stops: VecDeque<Uuid>,
    completed_runs: VecDeque<Uuid>,
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
    #[cfg(test)]
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
        run_id: Uuid,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
        expected_generation: u64,
    ) -> CoreResult<()> {
        let mut state = self.lock();
        if state.lifecycle_generation != expected_generation {
            drop(state);
            close_signal.close();
            return Err(CoreError::Conflict(format!(
                "chat run '{run_id}' cannot start because the workspace changed"
            )));
        }
        if state.completed_runs.contains(&run_id) {
            return Err(CoreError::Conflict(format!(
                "chat run '{run_id}' has already completed"
            )));
        }
        if state.run_signals.contains_key(&run_id) {
            return Err(CoreError::Conflict(format!(
                "chat run '{run_id}' is already registered"
            )));
        }
        if take_pending_stop(&mut state, run_id) {
            close_signal.stop_by_user();
            remember_completed(&mut state, run_id);
            return Ok(());
        }
        state.run_signals.insert(run_id, close_signal);
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
            state.pending_stops.clear();
            let active_runs = state.run_signals.drain().collect::<Vec<_>>();
            for (run_id, _) in &active_runs {
                remember_completed(&mut state, *run_id);
            }
            let signals = active_runs
                .into_iter()
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

    /// Stop only the caller's exact UUID, retaining a bounded stop when its chat
    /// command has not registered yet. Completion and cancellation move the id to
    /// the bounded completed set under this mutex, so their race has one winner.
    pub(crate) fn cancel_run(&self, turn_id: Uuid) -> CancelChatRunOutcome {
        let (status, parked) = {
            let mut state = self.lock();
            let Some(signal) = state.run_signals.remove(&turn_id) else {
                let status = if state.completed_runs.contains(&turn_id)
                    || state.pending_stops.contains(&turn_id)
                {
                    CancelChatRunStatus::AlreadyCompleted
                } else {
                    remember_pending_stop(&mut state, turn_id);
                    CancelChatRunStatus::Cancelled
                };
                return CancelChatRunOutcome::new(turn_id, status);
            };
            let status = if signal.stop_by_user() {
                CancelChatRunStatus::Cancelled
            } else {
                CancelChatRunStatus::AlreadyCompleted
            };
            remember_completed(&mut state, turn_id);
            let run_id = turn_id.to_string();
            let ids = state
                .entries
                .iter()
                .filter_map(|(id, pending)| (pending.run_id == run_id).then_some(id.clone()))
                .collect::<Vec<_>>();
            let parked = ids
                .into_iter()
                .filter_map(|id| state.entries.remove(&id))
                .collect::<Vec<_>>();
            (status, parked)
        };
        drop(parked);
        log::debug!("resolved stop request for chat turn {turn_id}: {status:?}");
        CancelChatRunOutcome::new(turn_id, status)
    }

    /// Snapshot the workspace lifecycle used to reject a run that was paused
    /// while its vault was replaced or closed.
    pub(crate) fn lifecycle_generation(&self) -> u64 {
        self.lock().lifecycle_generation
    }

    fn finish_run(&self, run_id: Uuid, owned_signal: &Arc<crate::ai::ChatRunCloseSignal>) {
        let removed = {
            let mut state = self.lock();
            let owns_registration = state
                .run_signals
                .get(&run_id)
                .is_some_and(|registered| Arc::ptr_eq(registered, owned_signal));
            if !owns_registration {
                return;
            }
            state.run_signals.remove(&run_id);
            remember_completed(&mut state, run_id);
            let run_id = run_id.to_string();
            let ids = state
                .entries
                .iter()
                .filter_map(|(id, pending)| (pending.run_id == run_id).then_some(id.clone()))
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| state.entries.remove(&id))
                .collect::<Vec<_>>()
        };
        drop(removed);
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

    #[cfg(test)]
    fn completed_len(&self) -> usize {
        self.lock().completed_runs.len()
    }

    fn lock(&self) -> MutexGuard<'_, RegistryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn remember_completed(state: &mut RegistryState, run_id: Uuid) {
    state.completed_runs.retain(|stored| stored != &run_id);
    while state.completed_runs.len() >= MAX_COMPLETED_CHAT_RUNS {
        state.completed_runs.pop_front();
    }
    state.completed_runs.push_back(run_id);
}

fn remember_pending_stop(state: &mut RegistryState, run_id: Uuid) {
    state.pending_stops.retain(|stored| stored != &run_id);
    while state.pending_stops.len() >= MAX_PENDING_CHAT_STOPS {
        state.pending_stops.pop_front();
    }
    state.pending_stops.push_back(run_id);
}

fn take_pending_stop(state: &mut RegistryState, run_id: Uuid) -> bool {
    let Some(index) = state
        .pending_stops
        .iter()
        .position(|stored| stored == &run_id)
    else {
        return false;
    };
    state.pending_stops.remove(index);
    true
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
    run_id: Uuid,
    close_signal: Arc<crate::ai::ChatRunCloseSignal>,
}

impl RunElicitationGuard {
    pub(crate) fn try_new(
        pending: Arc<PendingElicitations>,
        run_id: Uuid,
        close_signal: Arc<crate::ai::ChatRunCloseSignal>,
        expected_generation: u64,
    ) -> CoreResult<Self> {
        pending.register_run(run_id, Arc::clone(&close_signal), expected_generation)?;
        Ok(Self {
            pending,
            run_id,
            close_signal,
        })
    }
}

impl Drop for RunElicitationGuard {
    fn drop(&mut self) {
        self.pending.finish_run(self.run_id, &self.close_signal);
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
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e11");
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&closed),
            pending.lifecycle_generation(),
        )
        .unwrap();
        let prompt = ShellUserPrompt::with_timeout_and_close(
            Arc::clone(&pending),
            id.to_string(),
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
            turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e12"),
            Arc::clone(&first_closed),
            generation,
        )
        .unwrap();
        let _second_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e13"),
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
                turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e14"),
                Arc::clone(&stale_closed),
                stale_generation,
            ),
            Err(CoreError::Conflict(message)) if message.contains("workspace changed")
        ));
        assert!(stale_closed.is_closed());

        let fresh_closed = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let fresh = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e15"),
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
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e16");
        pending
            .register_run(id, Arc::clone(&signal), generation)
            .unwrap();

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );
        assert!(signal.is_closed());
        assert_eq!(pending.lifecycle_generation(), generation);
        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::AlreadyCompleted
        );
    }

    fn turn_id(value: &str) -> uuid::Uuid {
        uuid::Uuid::parse_str(value).unwrap()
    }

    #[test]
    fn cancellation_targets_only_the_exact_uuid_and_echoes_it() {
        let pending = PendingElicitations::default();
        let active = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e01");
        let pending_id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e02");
        let later = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e0a");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        pending
            .register_run(active, Arc::clone(&signal), pending.lifecycle_generation())
            .unwrap();

        let queued = pending.cancel_run(pending_id);
        assert_eq!(queued.turn_id, pending_id.to_string());
        assert_eq!(queued.status, CancelChatRunStatus::Cancelled);
        assert!(!signal.is_closed());

        let cancelled = pending.cancel_run(active);
        assert_eq!(cancelled.turn_id, active.to_string());
        assert_eq!(cancelled.status, CancelChatRunStatus::Cancelled);
        assert_eq!(
            signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );

        let repeated = pending.cancel_run(active);
        assert_eq!(repeated.status, CancelChatRunStatus::AlreadyCompleted);

        let later_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        pending
            .register_run(
                later,
                Arc::clone(&later_signal),
                pending.lifecycle_generation(),
            )
            .unwrap();
        assert_eq!(
            pending.cancel_run(active).status,
            CancelChatRunStatus::AlreadyCompleted
        );
        assert!(
            !later_signal.is_closed(),
            "a delayed stop for the completed id must not reach the later turn"
        );
    }

    #[test]
    fn stop_requested_before_registration_is_consumed_by_that_exact_run() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e07");

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );

        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        assert_eq!(
            signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );
        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::AlreadyCompleted
        );
        drop(guard);
    }

    #[test]
    fn stop_requested_before_registration_survives_an_unrelated_active_run() {
        let pending = Arc::new(PendingElicitations::default());
        let active_id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e17");
        let pending_id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e18");
        let active_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let active_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            active_id,
            Arc::clone(&active_signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        assert_eq!(
            pending.cancel_run(pending_id).status,
            CancelChatRunStatus::Cancelled
        );

        let pending_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let pending_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            pending_id,
            Arc::clone(&pending_signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        assert!(!active_signal.is_closed());
        assert_eq!(
            pending_signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );
        drop(active_guard);
        drop(pending_guard);
    }

    #[test]
    fn pending_stop_memory_is_bounded_and_evicts_the_oldest_uuid() {
        let pending = Arc::new(PendingElicitations::default());
        for sequence in 1..=65 {
            assert_eq!(
                pending.cancel_run(uuid::Uuid::from_u128(sequence)).status,
                CancelChatRunStatus::Cancelled
            );
        }

        let oldest_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let oldest_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            uuid::Uuid::from_u128(1),
            Arc::clone(&oldest_signal),
            pending.lifecycle_generation(),
        )
        .unwrap();
        assert!(!oldest_signal.is_closed());

        let newest_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let newest_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            uuid::Uuid::from_u128(65),
            Arc::clone(&newest_signal),
            pending.lifecycle_generation(),
        )
        .unwrap();
        assert_eq!(
            newest_signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );

        drop(oldest_guard);
        drop(newest_guard);
    }

    #[test]
    fn lifecycle_cancellation_discards_pre_registration_stops() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e09");
        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );

        assert_eq!(pending.cancel_all_runs(), 0);

        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&signal),
            pending.lifecycle_generation(),
        )
        .unwrap();
        assert!(!signal.is_closed());
        drop(guard);
    }

    #[test]
    fn lifecycle_cancelled_active_uuid_is_remembered_as_completed() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e19");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        assert_eq!(pending.cancel_all_runs(), 1);

        assert!(signal.is_closed());
        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::AlreadyCompleted
        );
        drop(guard);
    }

    #[test]
    fn an_old_guard_cannot_finish_a_later_registration_reusing_its_uuid() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e08");
        let old_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::new(crate::ai::ChatRunCloseSignal::default()),
            pending.lifecycle_generation(),
        )
        .unwrap();
        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );

        for sequence in 1..=MAX_COMPLETED_CHAT_RUNS {
            let other = uuid::Uuid::from_u128(sequence as u128);
            let guard = RunElicitationGuard::try_new(
                Arc::clone(&pending),
                other,
                Arc::new(crate::ai::ChatRunCloseSignal::default()),
                pending.lifecycle_generation(),
            )
            .unwrap();
            drop(guard);
        }

        let later_signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let later_guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&later_signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        drop(old_guard);

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );
        assert_eq!(
            later_signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );
        drop(later_guard);
    }

    #[test]
    fn a_completed_uuid_cannot_be_registered_again() {
        let pending = PendingElicitations::default();
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e06");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        pending
            .register_run(id, Arc::clone(&signal), pending.lifecycle_generation())
            .unwrap();
        pending.finish_run(id, &signal);

        assert!(matches!(
            pending.register_run(
                id,
                Arc::new(crate::ai::ChatRunCloseSignal::default()),
                pending.lifecycle_generation(),
            ),
            Err(CoreError::Conflict(_))
        ));
    }

    #[test]
    fn normal_completion_wins_before_a_later_cancel() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e03");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        drop(guard);

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::AlreadyCompleted
        );
        assert_eq!(signal.reason(), None);
    }

    #[test]
    fn user_cancel_wins_before_a_later_normal_finish() {
        let pending = Arc::new(PendingElicitations::default());
        let id = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e0b");
        let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
        let guard = RunElicitationGuard::try_new(
            Arc::clone(&pending),
            id,
            Arc::clone(&signal),
            pending.lifecycle_generation(),
        )
        .unwrap();

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::Cancelled
        );
        drop(guard);

        assert_eq!(
            pending.cancel_run(id).status,
            CancelChatRunStatus::AlreadyCompleted
        );
        assert_eq!(
            signal.reason(),
            Some(crate::ai::ChatRunCloseReason::UserStop)
        );
    }

    #[tokio::test]
    async fn cancelling_an_exact_run_purges_only_its_elicitations() {
        let pending = PendingElicitations::default();
        let stopped = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e04");
        let retained = turn_id("018f5f6c-8d5f-7c64-b8e7-8f9f238d9e05");
        pending
            .register_run(
                stopped,
                Arc::new(crate::ai::ChatRunCloseSignal::default()),
                pending.lifecycle_generation(),
            )
            .unwrap();
        pending
            .register_run(
                retained,
                Arc::new(crate::ai::ChatRunCloseSignal::default()),
                pending.lifecycle_generation(),
            )
            .unwrap();
        let stopped_prompt = pending
            .park(&stopped.to_string(), elicitation("stopped-q", false))
            .unwrap();
        let retained_prompt = pending
            .park(&retained.to_string(), elicitation("retained-q", false))
            .unwrap();

        assert_eq!(
            pending.cancel_run(stopped).status,
            CancelChatRunStatus::Cancelled
        );
        assert!(stopped_prompt.receiver.await.is_err());
        assert_eq!(pending.len(), 1);
        pending.answer("retained-q", vec!["yes".into()]).unwrap();
        assert_eq!(
            retained_prompt.receiver.await.unwrap(),
            Some(vec!["yes".into()])
        );
    }

    #[test]
    fn completed_turn_memory_is_bounded() {
        let pending = PendingElicitations::default();
        for sequence in 1..=(MAX_COMPLETED_CHAT_RUNS + 1) {
            let id = uuid::Uuid::from_u128(sequence as u128);
            let signal = Arc::new(crate::ai::ChatRunCloseSignal::default());
            pending
                .register_run(id, Arc::clone(&signal), pending.lifecycle_generation())
                .unwrap();
            pending.finish_run(id, &signal);
        }

        assert_eq!(pending.completed_len(), MAX_COMPLETED_CHAT_RUNS);
        assert_eq!(
            pending.cancel_run(uuid::Uuid::from_u128(1)).status,
            CancelChatRunStatus::Cancelled
        );
        assert_eq!(
            pending
                .cancel_run(uuid::Uuid::from_u128((MAX_COMPLETED_CHAT_RUNS + 1) as u128))
                .status,
            CancelChatRunStatus::AlreadyCompleted
        );
    }
}
