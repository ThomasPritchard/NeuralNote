// The shared action-button idioms for the violet CTA and its quiet sibling.
// Exported as class-string consts (the same precedent as KeySetupPanel's
// FIELD/LABEL) so the surfaces that render them — ChatPane, KeySetupPanel,
// the AI settings cards — can never drift apart again. Compose per-site
// deltas with `cn(BTN_PRIMARY, "…")` (tailwind-merge resolves conflicts).

/** The violet CTA glow. One value — the copies had already drifted
 *  (18px/-6px and 18px/-5px variants); 16px/-8px was the 4-site majority. */
export const GLOW_PRIMARY = "shadow-[0_0_16px_-8px_var(--color-primary)]";

/** Primary action button (padded text form). */
export const BTN_PRIMARY = `rounded-lg bg-primary px-3 py-1.5 text-[12px] font-semibold text-primary-foreground ${GLOW_PRIMARY} transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none`;

/** Quiet secondary button — ring only, fills on hover. */
export const BTN_QUIET =
  "rounded-lg px-3 py-1.5 text-[12px] font-medium text-muted-foreground ring-1 ring-inset ring-border transition hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50";
