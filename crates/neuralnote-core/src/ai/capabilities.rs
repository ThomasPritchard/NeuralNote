//! What reasoning to offer the user, and what to ask the provider for.
//!
//! The decision, and only the decision. Each provider's payload is read by its
//! own module — `openrouter` for the `/models` body, `ollama` for `/api/show` —
//! and nothing here knows a wire format. That is the seam: a capability record
//! arrives already parsed, and what leaves is a control to render or an ask to
//! send.

mod ollama;
mod openrouter;

pub use ollama::{ollama_reasoning_support, parse_ollama_capabilities, supports_thinking};
pub use openrouter::{
    openrouter_reasoning_capability, openrouter_reasoning_support,
    parse_openrouter_context_windows, parse_openrouter_input_pricing, parse_openrouter_models,
    parse_openrouter_reasoning_controls, supports_reasoning, ModelCapabilities,
    RawReasoningCapability,
};

use crate::ai::openai::ReasoningAsk;
use crate::ai::provider_config::ReasoningPreference;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Whether the selected model can emit reasoning tokens. `Unknown` when the
/// probe could not run (offline, a hand-typed model id, a 5xx) — callers FAIL OPEN.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ReasoningSupport {
    Supported,
    Unsupported,
    Unknown,
}

/// What the reasoning control should offer for the selected model.
///
/// A closed set, because the control is a rendering decision and every state the
/// probe can produce needs exactly one: an unanswered probe is not the same as a
/// model that cannot reason, and neither is a model whose reasoning is forced on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[ts(export)]
pub enum ReasoningControl {
    /// The model cannot reason. Show nothing.
    Hidden,
    /// The probe has not answered yet. Show the control disabled rather than
    /// guessing at a shape it may not have.
    Pending,
    /// Reasoning is on or off, with no effort menu behind it.
    Toggle { default_on: bool },
    /// The model always reasons. Show that it is on, and that it cannot be
    /// turned off.
    Locked,
    /// The model publishes an effort menu. `options` is that menu VERBATIM, in
    /// the model's own words and its own order.
    Efforts {
        options: Vec<String>,
        default_effort: Option<String>,
        can_disable: bool,
    },
}

impl ReasoningControl {
    /// Whether the menu this control is showing lists `effort` **right now**.
    ///
    /// The single answer to "may this effort be used", asked by the send path
    /// before it puts a stored preference on the wire and by the effort-setting
    /// command before it persists one. Both ask it of the same control value, so
    /// a menu that moved underneath the user cannot be refused by one and
    /// accepted by the other — which is the drift a second copy of this rule
    /// would let in.
    ///
    /// Only [`Efforts`](ReasoningControl::Efforts) publishes a menu, so every
    /// other control answers `false`: they have nothing to pick from. That is
    /// membership alone, and deliberately not policy — [`Pending`] means the
    /// catalogue has not answered rather than that the menu shrank, and what to
    /// do about that difference belongs to the callers, which read it in
    /// opposite directions (amendment E2 keeps a stored value on the send path;
    /// the write path refuses a new one).
    ///
    /// The variants are named one by one rather than caught by a `_`, so a
    /// control variant added later — a `max_tokens` budget is already parsed and
    /// documented as the other half of this knob — has to answer this question
    /// explicitly instead of silently answering "offers nothing".
    ///
    /// [`Pending`]: ReasoningControl::Pending
    pub fn offers(&self, effort: &str) -> bool {
        match self {
            Self::Efforts { options, .. } => menu_lists(options, effort),
            Self::Hidden | Self::Pending | Self::Toggle { .. } | Self::Locked => false,
        }
    }
}

/// Membership of a raw effort menu, for the one caller that has no control to
/// ask: [`reasoning_control`] checks a record's published `default_effort`
/// against the menu it is still assembling. Everything else goes through
/// [`ReasoningControl::offers`], which is this rule with the variants in front
/// of it.
///
/// Compared verbatim — never case-folded, never trimmed. The values are the
/// model's own words (21 distinct menus in the live catalogue), so normalising
/// one here would quietly accept an effort the provider will reject.
fn menu_lists(options: &[String], effort: &str) -> bool {
    options.iter().any(|option| option == effort)
}

/// The value a model uses inside its own effort menu to mean "do not reason".
/// It is a sentinel, not an effort, so it never reaches the user as a menu item.
const OFF_SENTINEL: &str = "none";

/// Decide which reasoning control a model's capability record calls for.
///
/// `None` means the model published no reasoning block. It is NOT "the probe has
/// not answered" — that is [`ReasoningControl::Pending`], which only the caller
/// can know and which this function therefore never returns.
///
/// The precedence, in order, and why (amendment D1):
///
/// 1. **A menu with something to pick wins.** `supported_efforts` is the only
///    field that offers the user a choice, so a record carrying one renders
///    [`Efforts`] even when it also carries `mandatory` or `supports_max_tokens`.
///    `mandatory: true` alongside a menu is not a contradiction — the user picks
///    how hard the model thinks without being able to stop it thinking — and a
///    `max_tokens` budget is a different knob that OpenRouter documents as
///    mutually exclusive with `effort`. A menu holding nothing but the off
///    sentinel is not one of these: stripping leaves nothing to pick, so it
///    takes the menu-less path below (see [`offerable_efforts`]).
/// 2. **Off gets exactly one representation.** The catalogue spells "reasoning
///    can be turned off" two ways: `none` inside the menu, and `mandatory:
///    false` beside it. Both fold into `can_disable`, so two models that behave
///    identically render an identical control. Only `mandatory: true` takes the
///    off switch away.
/// 3. **Nothing to pick, `mandatory: true` → [`Locked`].** On is the only state.
/// 4. **Nothing to pick otherwise → [`Toggle`]**, following `default_enabled`
///    where the record publishes one and starting **off** where it does not.
///    Absent means the server never told us, reasoning tokens bill as output,
///    and the existing opt-in already starts false.
///
/// The effort VALUES are never touched: not lower-cased, not reordered, not
/// checked against a compiled-in list. The live catalogue carries 21 distinct
/// menus, so any list compiled in here would be wrong for some model and would
/// silently downgrade its reasoning. Stripping [`OFF_SENTINEL`] is the single
/// permitted normalisation, and it removes a state — not a value.
///
/// See the captured fixture at
/// `crates/neuralnote-core/src/ai/fixtures/openrouter_models_reasoning.json`.
pub fn reasoning_control(capability: Option<&RawReasoningCapability>) -> ReasoningControl {
    let Some(capability) = capability else {
        return ReasoningControl::Hidden;
    };
    let mandatory = capability.mandatory == Some(true);
    let options = offerable_efforts(capability);

    if options.is_empty() {
        return menuless_control(capability, mandatory);
    }
    ReasoningControl::Efforts {
        // A default that is not on the menu is not a default. A record naming
        // the off sentinel as its `default_effort` would otherwise preselect a
        // value the menu no longer offers — which the effort-setting command
        // then refuses, leaving a control whose own default it will not accept.
        default_effort: capability
            .default_effort
            .clone()
            .filter(|effort| menu_lists(&options, effort)),
        options,
        can_disable: !mandatory,
    }
}

/// The efforts a user may actually pick, with the off sentinel removed.
///
/// Empty for a record that published no menu, and equally empty for one whose
/// menu held nothing but the sentinel — neither leaves anything to choose
/// between, so both take the menu-less path.
fn offerable_efforts(capability: &RawReasoningCapability) -> Vec<String> {
    capability
        .supported_efforts
        .iter()
        .flatten()
        .filter(|effort| effort.as_str() != OFF_SENTINEL)
        .cloned()
        .collect()
}

/// The control for a record with no effort to offer: on-only when reasoning is
/// mandatory, otherwise an on/off switch starting where the record says (and off
/// where it says nothing).
fn menuless_control(capability: &RawReasoningCapability, mandatory: bool) -> ReasoningControl {
    if mandatory {
        ReasoningControl::Locked
    } else {
        ReasoningControl::Toggle {
            default_on: capability.default_enabled.unwrap_or(false),
        }
    }
}

/// Map an optional capability array to a verdict. An ABSENT array (`None`) fails
/// OPEN to `Unknown` — the server never told us (spec §2). A PRESENT array is
/// authoritative: `has_capability` decides `Supported` vs `Unsupported`.
fn capability_verdict(
    capabilities: Option<&[String]>,
    has_capability: fn(&[String]) -> bool,
) -> ReasoningSupport {
    match capabilities {
        None => ReasoningSupport::Unknown,
        Some(caps) if has_capability(caps) => ReasoningSupport::Supported,
        Some(_) => ReasoningSupport::Unsupported,
    }
}

/// The call-site rule: only send a reasoning request when the user opted in and
/// the model is not known to lack the capability.
///
/// if a user enables reasoning then switches to a non-reasoning model,
/// `config.reasoning_preference.enabled` stays `true`; sending the request anyway would
/// make Phase A's empty-answer / zero-`Thinking` backstop fire on a perfectly
/// normal turn. `Unknown` still sends (fail open).
pub fn effective_reasoning(opt_in: bool, support: ReasoningSupport) -> bool {
    opt_in && support != ReasoningSupport::Unsupported
}

/// What to ask the provider for on every turn of this run, from the user's
/// stored preference and the selected model's probed verdict. `None` sends no
/// `reasoning` object at all.
///
/// The two halves fail in opposite directions, deliberately (§4.2):
///
/// * **Whether to reason at all fails OPEN.** [`effective_reasoning`] decides it
///   and is unchanged: an `Unknown` verdict still reasons, because the probe not
///   having answered is not evidence the model cannot.
/// * **The effort fails CLOSED.** A value is named only when the verdict is
///   `Supported`, which is the only state in which the menu it came from was
///   actually read. There is no fallback effort, no remembered effort from a
///   previous model, and no compiled-in default — omitting one simply takes the
///   provider's own.
///
/// The asymmetry is the point: guessing a menu invents user-facing options that
/// may not exist, while omitting an effort costs nothing but a default.
///
/// `effort` must already be one the model's **current** menu offers — nothing
/// here checks it, and a `Supported` verdict sends whatever is named verbatim.
/// [`resolve_effort`] is what reconciles a stored preference against a menu
/// that moved underneath it (amendment E3), so callers resolving an ask from
/// persisted config go through it first.
pub fn effective_reasoning_ask(
    opt_in: bool,
    effort: Option<&str>,
    support: ReasoningSupport,
) -> Option<ReasoningAsk> {
    if !effective_reasoning(opt_in, support) {
        return None;
    }
    match (support, effort) {
        (ReasoningSupport::Supported, Some(effort)) => {
            Some(ReasoningAsk::Effort(effort.to_string()))
        }
        _ => Some(ReasoningAsk::Enabled),
    }
}

/// What to ask the provider for on every turn of this run: the user's stored
/// preference, resolved against the model's probed verdict and reconciled
/// against the menu the catalogue offers *right now*.
///
/// This is the whole decision, in one place, deliberately. The two halves it
/// composes read different facts that arrive at different times — the verdict is
/// persisted, the menu cache is not — and resolving an ask without consulting
/// the menu is exactly the bug amendment E3 rules out. [`resolve_effort`] is
/// therefore private and reachable only from here and from
/// [`reasoning_effort_override`], both after the opt-in gate: a preference the
/// user switched off is not overridden by anything, so a turn that sends no
/// `reasoning` object at all must neither report nor log one.
pub fn reasoning_ask(
    preference: &ReasoningPreference,
    support: ReasoningSupport,
    control: &ReasoningControl,
) -> Option<ReasoningAsk> {
    if !effective_reasoning(preference.enabled, support) {
        return None;
    }
    let resolved = resolve_effort(control, preference.effort.as_deref());
    resolved.warn_if_overridden();
    effective_reasoning_ask(preference.enabled, resolved.sending(), support)
}

/// The substitution the send path is applying to the stored effort right now, or
/// `None` when what the user chose is what goes out.
///
/// The same three facts, the same gate and the same resolution as
/// [`reasoning_ask`] — this is that decision *reported* rather than acted on, so
/// the status and the request are one rule read twice rather than two rules that
/// happen to agree today. What can still move between a status read and a turn
/// is the menu itself, and the next read reports that.
///
/// It exists because amendment E3's fallback is otherwise invisible to the
/// person paying for it: a stored `xhigh` against a menu that shrank to
/// `["high", "low"]` leaves Settings rendering a blank effort dropdown while
/// every turn quietly sends `high`, and the only witness is a log line no
/// desktop user opens. What is rendered from this is a UI decision; that the
/// truth is available to render is this function's job.
///
/// Deliberately silent, unlike its sibling: this is a status read the UI polls,
/// and a warning per poll is how the real one at the send path becomes
/// ignorable.
pub fn reasoning_effort_override(
    preference: &ReasoningPreference,
    support: ReasoningSupport,
    control: &ReasoningControl,
) -> Option<ReasoningEffortOverride> {
    if !effective_reasoning(preference.enabled, support) {
        return None;
    }
    resolve_effort(control, preference.effort.as_deref()).reported()
}

/// A stored reasoning effort this model's current menu will not accept, and the
/// value going out in its place (amendment E3).
///
/// Both halves travel together because the sentence a reader needs is one
/// sentence — "you chose X; this model no longer offers it, so turns are asking
/// for Y" — and a consumer diffing two separate fields to work that out would be
/// re-deriving a decision the core already made.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ReasoningEffortOverride {
    /// The effort the user picked, still persisted and still theirs. It comes
    /// back on its own if the menu does.
    pub stored: String,
    /// The effort actually being sent instead. Null for "name no effort and take
    /// the provider's own default", which is what null means on the stored
    /// preference beside it too.
    pub sending: Option<String>,
}

/// What the send path does with a stored effort, decided once so that the
/// request, the log line and the status read cannot drift apart.
enum ResolvedEffort<'a> {
    /// Send exactly what is stored — including nothing, when nothing was chosen.
    AsStored(Option<&'a str>),
    /// The stored effort is not one this control offers, so `sending` goes in
    /// its place (`None` meaning no effort at all).
    Overridden {
        stored: &'a str,
        sending: Option<&'a str>,
        cause: OverrideCause,
    },
}

/// Why a stored effort could not be sent. The two read differently to whoever
/// finds the log line — one sends them to the model's menu, the other to a model
/// that no longer has one — so they are not collapsed into a single message.
enum OverrideCause {
    /// The model still publishes a menu; this effort is no longer on it.
    DroppedFromMenu,
    /// The model publishes no effort menu at all any more.
    NoMenuAtAll,
}

impl<'a> ResolvedEffort<'a> {
    /// The effort this turn names, if any. `None` is sent by
    /// [`effective_reasoning_ask`] as plain [`ReasoningAsk::Enabled`].
    fn sending(&self) -> Option<&'a str> {
        match self {
            Self::AsStored(effort) => *effort,
            Self::Overridden { sending, .. } => *sending,
        }
    }

    /// The override as something a caller outside this module can hold on to.
    fn reported(self) -> Option<ReasoningEffortOverride> {
        match self {
            Self::AsStored(_) => None,
            Self::Overridden {
                stored, sending, ..
            } => Some(ReasoningEffortOverride {
                stored: stored.to_string(),
                sending: sending.map(str::to_string),
            }),
        }
    }

    /// **Tolerated, not silent**, same shape as `openrouter::lenient_reasoning`: a
    /// billed preference being overridden is exactly the quiet degradation this
    /// project forbids, so the send path says so where it decides it.
    fn warn_if_overridden(&self) {
        let Self::Overridden {
            stored,
            sending,
            cause,
        } = self
        else {
            return;
        };
        match cause {
            OverrideCause::DroppedFromMenu => log::warn!(
                "capabilities: this model's menu no longer offers the stored reasoning effort \
                 {stored:?}; asking for {} instead",
                sending.unwrap_or("the provider's own default")
            ),
            OverrideCause::NoMenuAtAll => log::warn!(
                "capabilities: this model publishes no effort menu any more, so the stored \
                 reasoning effort {stored:?} cannot be sent; asking for the provider's own \
                 default instead"
            ),
        }
    }
}

/// Reconcile the stored effort against the menu the catalogue offers *right now*
/// (amendment E3).
///
/// A model can keep its id while its published `supported_efforts` shrinks,
/// leaving a stored effort the provider would reject outright — failing a whole
/// run over a preference. So an effort survives only while the current control
/// still offers it. Otherwise it falls back to the menu's own `default_effort`,
/// and to `None` when the model publishes no default.
///
/// Nothing is invented and §4.2 still holds: [`reasoning_control`] has already
/// filtered `default_effort` down to a value the menu carries, so every effort
/// that leaves here was read off this model's own menu.
///
/// [`ReasoningControl::Pending`] is the one control that leaves the stored value
/// alone (amendment E2): it means the catalogue has not answered, which is not
/// evidence the menu shrank. Discarding a value read off this same model's
/// probed menu would silently ignore the user's setting for every turn of the
/// cold-launch probe window.
///
/// The remaining three controls are menu-less rather than shrunken, and they are
/// named one by one rather than caught by a `_`, so the day a control variant is
/// added — a `max_tokens` budget is already parsed and documented as the other
/// half of this knob — this function fails to compile instead of silently
/// absorbing it.
fn resolve_effort<'a>(
    control: &'a ReasoningControl,
    stored: Option<&'a str>,
) -> ResolvedEffort<'a> {
    let Some(stored) = stored else {
        return ResolvedEffort::AsStored(None);
    };
    match control {
        ReasoningControl::Pending => ResolvedEffort::AsStored(Some(stored)),
        ReasoningControl::Efforts { default_effort, .. } => {
            if control.offers(stored) {
                return ResolvedEffort::AsStored(Some(stored));
            }
            ResolvedEffort::Overridden {
                stored,
                sending: default_effort.as_deref(),
                cause: OverrideCause::DroppedFromMenu,
            }
        }
        ReasoningControl::Toggle { .. } | ReasoningControl::Locked | ReasoningControl::Hidden => {
            ResolvedEffort::Overridden {
                stored,
                sending: None,
                cause: OverrideCause::NoMenuAtAll,
            }
        }
    }
}

#[cfg(test)]
mod tests;
