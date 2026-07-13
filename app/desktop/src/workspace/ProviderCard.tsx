// The shared presentation bits of the AI settings page: one provider section
// (icon tile + header + body), the Active badge, and the inline error /
// loading rows. Extracted so OpenRouterCard and LocalAiCard render one idiom
// instead of drifting copies.

import type { ReactNode } from "react";
import { AlertTriangle, Check, Loader2, type LucideIcon } from "lucide-react";

/** Inline failure notice — the page-level home for surfaced errors. Pass
 *  `alert` when the failure lands after a user action (a toggle that didn't
 *  persist), so screen readers hear it without re-traversing the page. */
export function InlineError({
  children,
  alert = false,
}: Readonly<{ children: ReactNode; alert?: boolean }>) {
  return (
    <p
      role={alert ? "alert" : undefined}
      className="flex items-start gap-1.5 rounded-lg border border-destructive/40 bg-destructive/10 px-2.5 py-2 text-[0.75rem] leading-snug text-destructive"
    >
      <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 break-words">{children}</span>
    </p>
  );
}

/** In-flight indicator (an <output> so it's announced, matching ChatPane). */
export function LoadingRow({ label }: Readonly<{ label: string }>) {
  return (
    <output className="flex items-center gap-2 text-[0.75rem] text-muted-foreground/70">
      <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
      {label}
    </output>
  );
}

export function ActiveBadge() {
  return (
    <span className="flex shrink-0 items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[0.6875rem] font-medium text-primary ring-1 ring-inset ring-primary/30">
      <Check className="size-3" aria-hidden />
      Active
    </span>
  );
}

/** One provider section: icon tile, title/description header, then children. */
export function ProviderCard({
  icon: Icon,
  title,
  description,
  active,
  children,
}: Readonly<{
  icon: LucideIcon;
  title: string;
  description: string;
  active: boolean;
  children: ReactNode;
}>) {
  return (
    <section className="rounded-xl bg-background/40 p-4 ring-1 ring-inset ring-border">
      <header className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <h4 className="nn-heading text-[0.8125rem] font-semibold text-foreground">
            {title}
          </h4>
          <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
            {description}
          </p>
        </div>
        {active && <ActiveBadge />}
      </header>
      <div className="mt-4 flex flex-col gap-3">{children}</div>
    </section>
  );
}
