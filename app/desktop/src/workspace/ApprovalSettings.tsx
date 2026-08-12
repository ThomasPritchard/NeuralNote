// "What NeuralNote can do without asking" — the approval controls, under
// "Configure the AI" (§9.6.7).
//
// Three things here are load-bearing rather than cosmetic:
//
//   1. **Every value rendered comes from Rust.** The global mode, the stored
//      overrides and — critically — the EFFECTIVE mode per tool are all computed
//      by `build_ai_status` and echoed back by each write. The UI never derives a
//      security value for itself, so what this page shows and what the gate does
//      cannot disagree.
//   2. **An inert override is shown as inactive, with its reason, not hidden.**
//      An override that silently does nothing is its own small lie, and hiding
//      it makes the user's own configuration unreadable to them.
//   3. **An unavailable mode never overwrites the stored preference.** On the
//      local lane "Approve for me" cannot run, so it renders disabled with its
//      reason inline — and the stored choice survives, ready for the moment the
//      user switches back to a cloud provider. Silently rewriting a stored value
//      because it is momentarily unusable is a bug this repo has been bitten by.
//
// The rows are built from the backend's own key set, not from a hard-coded list:
// a tool this build gates but this UI has not been taught about still gets a row
// (in the catch-all group, under its raw key). A gated action the settings page
// declined to render is an action the user cannot govern.

import { useId, useState } from "react";
import { ChevronRight, ShieldCheck } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import { cn } from "../lib/cn";
import type { AiStatus, ApprovalMode } from "../lib/types";
import { InlineError } from "./ProviderCard";
import { YoloConfirmDialog } from "./YoloConfirmDialog";
import {
  APPROVAL_GROUPS,
  APPROVAL_MODE_BADGE,
  APPROVAL_MODES,
  CLASSIFIER_UNAVAILABLE_REASON,
  gatedToolCopyForKey,
  type ApprovalGroupId,
  type GatedToolCopy,
} from "./approvalCopy";

/** "Follow the global setting" — the absence of a stored override, which is NOT
 *  the same as storing the current global (§9.6.6): clearing restores the tool's
 *  compiled-in default, and for the one tool that spawns a host process that
 *  default is a pin the global can never loosen. */
const INHERIT = "";

interface ToolRow extends GatedToolCopy {
  stored: ApprovalMode | undefined;
  effective: ApprovalMode;
  /** Stored, but the global mode is stricter — so it does nothing right now. */
  inert: boolean;
  /** No stored override, yet the effective mode is stricter than the global:
   *  the compiled-in default is holding it there. Derived from the backend's own
   *  two values, so it needs no hard-coded tool name to find. */
  pinned: boolean;
}

function toolRows(approval: AiStatus["approval"]): ToolRow[] {
  return Object.keys(approval.effectiveModes).map((key) => {
    const stored = approval.toolOverrides[key];
    const effective = approval.effectiveModes[key];
    return {
      ...gatedToolCopyForKey(key),
      stored,
      effective,
      inert: stored !== undefined && stored !== effective,
      pinned: stored === undefined && effective !== approval.mode,
    };
  });
}

function ModeRadio({
  option,
  checked,
  disabledReason,
  saving,
  onPick,
}: Readonly<{
  option: (typeof APPROVAL_MODES)[number];
  checked: boolean;
  /** Non-null renders the option unavailable, with this as its consequence
   *  line — a VISIBLE, adjacent explanation, never a tooltip. Native `disabled`
   *  is only tolerable here because that line is already on screen and already
   *  the row's accessible description. */
  disabledReason: string | null;
  saving: boolean;
  onPick: (mode: ApprovalMode) => void;
}>) {
  const unavailable = disabledReason !== null;
  // No `aria-describedby`: the consequence line lives INSIDE the label, so it is
  // already part of the radio's accessible name and is announced on focus for
  // free. That is the property that matters for the unavailable option — its
  // reason must reach a keyboard user, not just a mouse pointer — and adding a
  // description pointing at the same text would announce it twice.
  return (
    <label
      className={cn(
        "flex items-start gap-2.5 rounded-lg px-2.5 py-2 ring-1 ring-inset transition-colors motion-reduce:transition-none",
        checked ? "bg-primary/10 ring-primary/40" : "ring-border",
        unavailable
          ? "cursor-not-allowed opacity-70"
          : "cursor-pointer hover:bg-muted/40 hover:ring-primary/30",
      )}
    >
      <input
        type="radio"
        name="approval-mode"
        value={option.mode}
        checked={checked}
        disabled={unavailable || saving}
        onChange={() => onPick(option.mode)}
        className="mt-0.5 size-3.5 shrink-0 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-[0.75rem] font-medium leading-snug text-foreground/90">
          {option.label}
        </span>
        <span
          className={cn(
            "mt-0.5 block text-[0.6875rem] leading-snug",
            unavailable ? "text-warning" : "text-muted-foreground",
          )}
        >
          {disabledReason ?? option.consequence}
        </span>
        {/* A stored preference that cannot apply right now is still the user's
            preference. Saying so is what stops the disabled control reading as
            "your choice was thrown away". */}
        {unavailable && checked && (
          <span className="mt-0.5 block text-[0.6875rem] leading-snug text-muted-foreground">
            Your choice is kept — it applies again on a cloud provider.
          </span>
        )}
      </span>
    </label>
  );
}

function ToolOverrideRow({
  row,
  classifierAvailable,
  saving,
  onChange,
}: Readonly<{
  row: ToolRow;
  classifierAvailable: boolean;
  saving: boolean;
  onChange: (key: string, mode: ApprovalMode | null) => void;
}>) {
  const selectId = useId();
  return (
    <li className="flex flex-col gap-1 border-t border-border/60 py-2 first:border-t-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label
          htmlFor={selectId}
          className="min-w-0 flex-1 text-[0.75rem] leading-snug text-foreground/90"
        >
          {row.title}
        </label>
        <span className="shrink-0 rounded-full bg-muted/60 px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
          {APPROVAL_MODE_BADGE[row.effective]}
        </span>
      </div>
      <select
        id={selectId}
        value={row.stored ?? INHERIT}
        disabled={saving}
        onChange={(event) =>
          onChange(row.key, event.target.value === INHERIT ? null : (event.target.value as ApprovalMode))
        }
        className="w-full rounded-md border border-border bg-input px-2 py-1 text-[0.6875rem] text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
      >
        <option value={INHERIT}>Follow the global setting</option>
        {APPROVAL_MODES.map((option) => (
          <option
            key={option.mode}
            value={option.mode}
            disabled={option.mode === "approveForMe" && !classifierAvailable}
          >
            {option.label}
          </option>
        ))}
      </select>
      {row.inert && (
        <p className="text-[0.625rem] leading-snug text-warning">
          Not in effect — the global setting above is stricter. It applies again if you
          loosen that.
        </p>
      )}
      {row.pinned && (
        <p className="text-[0.625rem] leading-snug text-muted-foreground">
          Always asks whatever the global setting is. Choose a setting here to change
          that.
        </p>
      )}
    </li>
  );
}

function OverrideGroup({
  id,
  title,
  rows,
  classifierAvailable,
  saving,
  onChange,
}: Readonly<{
  id: ApprovalGroupId;
  title: string;
  rows: ToolRow[];
  classifierAvailable: boolean;
  saving: boolean;
  onChange: (key: string, mode: ApprovalMode | null) => void;
}>) {
  const members = rows.filter((row) => row.group === id);
  if (members.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h6 className="nn-heading text-[0.6875rem] font-semibold text-foreground/80">
        {title}
      </h6>
      <ul className="flex flex-col">
        {members.map((row) => (
          <ToolOverrideRow
            key={row.key}
            row={row}
            classifierAvailable={classifierAvailable}
            saving={saving}
            onChange={onChange}
          />
        ))}
      </ul>
    </section>
  );
}

export function ApprovalSettings({
  status,
  onStatusChange,
}: Readonly<{
  status: AiStatus | null;
  /** Applies the freshly persisted status each write returns. Rendering the
   *  echo rather than re-reading matters more here than anywhere else on this
   *  page: a read that failed after the write landed would show "ask me" while
   *  the config said "yolo". */
  onStatusChange: (next: AiStatus) => void;
}>) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingYolo, setConfirmingYolo] = useState(false);

  if (status === null) return null;
  const { approval } = status;
  const rows = toolRows(approval);

  const write = async (run: () => Promise<AiStatus>) => {
    setSaving(true);
    setError(null);
    try {
      onStatusChange(await run());
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  };

  const pickMode = (mode: ApprovalMode) => {
    // Already there: no write, and — the point of the clause — no confirmation.
    // A mode that re-asks is a mode you click-train yourself out of reading.
    if (mode === approval.mode) return;
    if (mode === "yolo") {
      setConfirmingYolo(true);
      return;
    }
    void write(() => api.setApprovalMode(mode));
  };

  return (
    <section className="rounded-xl bg-background/40 p-4 ring-1 ring-inset ring-border">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          <ShieldCheck className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="nn-heading text-[0.8125rem] font-semibold text-foreground">
            What it can do without asking
          </h4>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
            NeuralNote checks with you before it writes to your vault, reaches the
            internet, or runs a program. Choose how often.
          </p>
        </div>
      </header>

      <div className="mt-4 flex flex-col gap-3">
        <fieldset className="flex flex-col gap-1.5">
          <legend className="sr-only">How often NeuralNote asks before it acts</legend>
          {APPROVAL_MODES.map((option) => (
            <ModeRadio
              key={option.mode}
              option={option}
              checked={approval.mode === option.mode}
              disabledReason={
                option.mode === "approveForMe" && !approval.classifierAvailable
                  ? CLASSIFIER_UNAVAILABLE_REASON
                  : null
              }
              saving={saving}
              onPick={pickMode}
            />
          ))}
        </fieldset>

        {error && <InlineError alert>Couldn&apos;t save that: {error}</InlineError>}

        <details className="group rounded-lg border border-border/60 bg-background/30 px-2.5 py-1.5">
          <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 text-[0.6875rem] font-medium text-muted-foreground/90 [&::-webkit-details-marker]:hidden">
            <ChevronRight
              className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open:rotate-90 motion-reduce:transition-none"
              aria-hidden
            />
            Advanced — change one kind of action on its own
          </summary>
          <div className="mt-2 flex flex-col gap-3">
            <p className="text-[0.625rem] leading-snug text-muted-foreground">
              A setting here can only make NeuralNote ask more often than the global
              setting above, never less.
              {!approval.classifierAvailable && ` ${CLASSIFIER_UNAVAILABLE_REASON}`}
            </p>
            {APPROVAL_GROUPS.map((group) => (
              <OverrideGroup
                key={group.id}
                id={group.id}
                title={group.title}
                rows={rows}
                classifierAvailable={approval.classifierAvailable}
                saving={saving}
                onChange={(key, mode) =>
                  void write(() => api.setToolApprovalOverride(key, mode))
                }
              />
            ))}
          </div>
        </details>
      </div>

      {confirmingYolo && (
        <YoloConfirmDialog
          irreversibleActions={approval.irreversibleActions}
          onCancel={() => setConfirmingYolo(false)}
          onConfirm={() => {
            setConfirmingYolo(false);
            void write(() => api.setApprovalMode("yolo"));
          }}
        />
      )}
    </section>
  );
}
