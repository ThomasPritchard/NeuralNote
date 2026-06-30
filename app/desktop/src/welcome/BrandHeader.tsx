import { Brain } from "lucide-react";

// The product identity block: gradient brand mark, wordmark, and an honest
// one-line tagline. No fabricated stats or claims.
export function BrandHeader() {
  return (
    <header className="flex flex-col items-center gap-4">
      <div className="grid size-14 place-items-center rounded-2xl bg-linear-to-br from-primary to-primary/60 text-primary-foreground shadow-[0_0_22px_-4px_var(--color-primary)]">
        <Brain className="size-7" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h1 className="nn-heading text-3xl font-semibold tracking-tight">
          NeuralNote
        </h1>
        <p className="text-sm text-muted-foreground">
          Your vault. Plain markdown, yours to keep.
        </p>
      </div>
    </header>
  );
}
