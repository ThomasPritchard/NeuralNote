// The first-run fork of the chat pane: nothing is configured yet, so the user
// chooses where cited chat runs — an OpenRouter key or a local model. Purely
// presentational; the parent owns what each choice does (inline key setup vs
// opening the AI settings page). Mirrors KeySetupPanel's centered, inviting
// aesthetic so the two first-run bodies read as one family.

import {
  ChevronRight,
  Cpu,
  KeyRound,
  Sparkles,
  type LucideIcon,
} from "lucide-react";

function ProviderOption({
  icon: Icon,
  title,
  description,
  onClick,
}: Readonly<{
  icon: LucideIcon;
  title: string;
  description: string;
  onClick: () => void;
}>) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex w-full items-center gap-3 rounded-xl bg-background/40 p-3 text-left ring-1 ring-inset ring-border transition hover:bg-background/60 hover:ring-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
    >
      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
        <Icon className="size-4" aria-hidden />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-[13px] font-medium text-foreground/90">{title}</span>
        <span className="text-[11px] leading-snug text-muted-foreground">
          {description}
        </span>
      </span>
      <ChevronRight
        className="size-4 shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}

/** Two ways into cited chat, plus the honest escape hatch. */
export function ProviderPicker({
  onPickOpenRouter,
  onPickLocal,
  onSkip,
}: Readonly<{
  onPickOpenRouter: () => void;
  onPickLocal: () => void;
  onSkip: () => void;
}>) {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-6 py-8">
      <div className="flex flex-col items-center gap-2.5 text-center">
        <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary shadow-[0_0_24px_-8px_var(--color-primary)] ring-1 ring-inset ring-primary/20">
          <Sparkles className="size-5" aria-hidden />
        </span>
        <p className="text-[14px] font-medium text-foreground/90">Choose your AI</p>
        <p className="mx-auto max-w-[17rem] text-[12px] leading-relaxed text-muted-foreground">
          Cited chat needs a model. Bring an OpenRouter key, or run one privately
          on this machine.
        </p>
      </div>

      <div className="flex flex-col gap-2.5">
        <ProviderOption
          icon={KeyRound}
          title="Connect an OpenRouter key"
          description="Bring your own key — answers come from a cloud model."
          onClick={onPickOpenRouter}
        />
        <ProviderOption
          icon={Cpu}
          title="Set up Local AI"
          description="Download a model that runs entirely on this machine."
          onClick={onPickLocal}
        />
      </div>

      <button
        type="button"
        onClick={onSkip}
        className="mx-auto rounded text-[12px] text-muted-foreground underline decoration-muted-foreground/40 underline-offset-2 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
      >
        Skip for now
      </button>
    </div>
  );
}
