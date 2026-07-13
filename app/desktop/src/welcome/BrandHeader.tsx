import { Brain } from "lucide-react";

// The product identity block: restrained AI mark, wordmark, and an honest
// one-line tagline. No fabricated stats or claims.
export function BrandHeader() {
  return (
    <header className="flex flex-col items-center gap-4">
      <div className="grid size-14 place-items-center rounded-2xl border border-primary/25 bg-primary/12 text-primary">
        <Brain className="size-7" aria-hidden="true" />
      </div>
      <div className="space-y-1.5">
        <h1 className="nn-heading text-3xl font-semibold tracking-[-0.04em]">
          NeuralNote
        </h1>
        <p className="text-sm text-muted-foreground">
          Your vault. Plain markdown, yours to keep.
        </p>
      </div>
    </header>
  );
}
