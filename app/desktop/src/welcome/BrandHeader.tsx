import neuralNoteMark from "../../../../assets/brand/marks/neuralnote-mark-128.png";

// The product identity block: restrained AI mark, wordmark, and an honest
// one-line tagline. No fabricated stats or claims.
export function BrandHeader() {
  return (
    <header className="flex flex-col items-center gap-4">
      <img
        src={neuralNoteMark}
        alt=""
        className="size-14 object-contain"
      />
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
