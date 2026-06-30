import { Loader2 } from "lucide-react";

// Themed stand-in for a direction that hasn't been built yet. Renders inside
// the active [data-direction] wrapper so it still shows that direction's tokens.
export default function Placeholder({ label }: { label: string }) {
  return (
    <div className="grid h-full w-full place-items-center bg-background text-foreground">
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2 className="size-6 animate-spin text-primary" />
        <div className="nn-heading text-2xl font-semibold">{label}</div>
        <div className="text-sm text-muted-foreground">direction in progress…</div>
      </div>
    </div>
  );
}
