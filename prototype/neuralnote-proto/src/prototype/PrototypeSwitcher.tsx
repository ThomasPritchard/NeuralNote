import { ChevronLeft, ChevronRight } from "lucide-react";
import { directions } from "./directions";

// Floating variant switcher — deliberately NOT themed by the active direction
// (sits outside the [data-direction] wrapper) so it reads as scaffolding, not
// part of the design under evaluation. Hidden in production builds.
export function PrototypeSwitcher({
  current,
  onChange,
}: {
  current: string;
  onChange: (id: string) => void;
}) {
  const index = Math.max(0, directions.findIndex((d) => d.id === current));
  const meta = directions[index];
  const go = (delta: number) =>
    onChange(directions[(index + delta + directions.length) % directions.length].id);

  return (
    <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-900/95 px-1.5 py-1.5 text-neutral-100 shadow-2xl ring-1 ring-black/40 backdrop-blur">
        <button
          onClick={() => go(-1)}
          className="grid size-8 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Previous direction"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-52 px-2 text-center">
          <div className="text-[13px] font-semibold leading-none">
            <span className="text-neutral-500">{index + 1}/6 · </span>
            {meta.label}
          </div>
          <div className="mt-1 text-[11px] leading-none text-neutral-500">{meta.soul}</div>
        </div>
        <button
          onClick={() => go(1)}
          className="grid size-8 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Next direction"
        >
          <ChevronRight className="size-4" />
        </button>
      </div>
      <div className="mt-1.5 text-center text-[10px] text-neutral-500">← / → to switch</div>
    </div>
  );
}
