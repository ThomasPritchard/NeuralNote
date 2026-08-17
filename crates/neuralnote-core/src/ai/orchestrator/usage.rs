//! Sink wrappers that meter cost, count thinking deltas, and bar a retry after
//! anything the user can already see.

use crate::ai::events::{ChatEvent, EventSink, TokenUsage};
use std::time::Instant;

pub(super) struct ThinkingCounter<'a> {
    pub(super) inner: &'a mut dyn EventSink,
    pub(super) count: usize,
}

/// A pass-through sink that remembers whether anything went out through it.
///
/// The one fact `complete_tool_turn` needs before it may retry: nothing the user
/// can already see was published. Watching the sink means the answer holds for
/// any client, including one whose streaming implementation this crate has never
/// seen — rather than trusting each implementation to report it honestly.
pub(super) struct EmissionGuard<'a> {
    pub(super) inner: &'a mut dyn EventSink,
    pub(super) emitted: bool,
}

impl EventSink for EmissionGuard<'_> {
    fn send(&mut self, event: ChatEvent) {
        self.emitted = true;
        self.inner.send(event);
    }

    /// Metering is not an emission: a token report is not something the user can
    /// see, so it must not bar the retry this guard exists to bar.
    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        self.inner.record_usage(usage);
    }
}

/// Totals what the run's model calls cost, and emits the one user-facing
/// [`ChatEvent::Usage`] immediately before the event that ends the run — either
/// [`ChatEvent::Done`] or [`ChatEvent::Error`].
///
/// It wraps the run's sink rather than being called at the end of `drive`
/// because a run has several terminal sites — `Done` and `Error` alike, some of
/// them outside `drive` entirely — and one more would forget. Intercepting the
/// terminal events makes "exactly once, immediately before the run ends" a
/// property of the type instead of a rule every site has to remember.
///
/// **A total is reported only when every model call reported.** One unmetered
/// call and the whole run's counts go absent, because a total that silently
/// omits a turn is a wrong number — and a wrong number in a cost footer is worse
/// than no number, for the same reason a wrong citation is worse than no answer.
pub(super) struct UsageMeter<'a> {
    inner: &'a mut dyn EventSink,
    started: Instant,
    model: String,
    tokens_in: u64,
    tokens_out: u64,
    /// How many model calls reported a real measurement. Zero means nothing to
    /// total; the run still gets its elapsed time and model.
    metered_calls: usize,
    /// Set by the first call that reported no usage. From then on the run's
    /// counts are unknowable, and no later report can un-set it.
    incomplete: bool,
    emitted: bool,
}

impl<'a> UsageMeter<'a> {
    pub(super) fn new(inner: &'a mut dyn EventSink, started: Instant, model: &str) -> Self {
        Self {
            inner,
            started,
            model: model.to_string(),
            tokens_in: 0,
            tokens_out: 0,
            metered_calls: 0,
            incomplete: false,
            emitted: false,
        }
    }

    /// The run's totals, or `None` when they would be a guess.
    ///
    /// `u32` is the wire type; a run that somehow exceeded it reports absent
    /// rather than a wrapped number — saturating would invent a measurement.
    fn totals(&self) -> Option<(u32, u32)> {
        if self.incomplete || self.metered_calls == 0 {
            return None;
        }
        Some((
            u32::try_from(self.tokens_in).ok()?,
            u32::try_from(self.tokens_out).ok()?,
        ))
    }

    fn emit(&mut self) {
        if self.emitted {
            return;
        }
        self.emitted = true;
        let (tokens_in, tokens_out) = match self.totals() {
            Some((tokens_in, tokens_out)) => (Some(tokens_in), Some(tokens_out)),
            None => (None, None),
        };
        self.inner.send(ChatEvent::Usage {
            elapsed_ms: u64::try_from(self.started.elapsed().as_millis()).unwrap_or(u64::MAX),
            tokens_in,
            tokens_out,
            model: self.model.clone(),
        });
    }
}

impl EventSink for UsageMeter<'_> {
    fn send(&mut self, event: ChatEvent) {
        // `Done` is not the only terminal event: an `Error` ends the run too, and
        // the UI settles the turn on either. Metering only `Done` lost the cost of
        // every failed run (#123) — the run whose cost a user most wants, since it
        // spent tokens and produced no answer. `emit` is idempotent, so a run that
        // somehow ended twice over still reports once.
        if matches!(event, ChatEvent::Done | ChatEvent::Error { .. }) {
            self.emit();
        }
        self.inner.send(event);
    }

    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        match usage {
            Some(usage) => {
                self.metered_calls += 1;
                self.tokens_in += u64::from(usage.tokens_in);
                self.tokens_out += u64::from(usage.tokens_out);
            }
            None => self.incomplete = true,
        }
    }
}

impl EventSink for ThinkingCounter<'_> {
    fn send(&mut self, event: ChatEvent) {
        if matches!(&event, ChatEvent::Thinking { .. }) {
            self.count += 1;
        }
        self.inner.send(event);
    }

    /// Forwarded, not defaulted: the answer turn is the run's largest model call,
    /// and a wrapper that swallowed its report would cost every run its footer.
    fn record_usage(&mut self, usage: Option<TokenUsage>) {
        self.inner.record_usage(usage);
    }
}
