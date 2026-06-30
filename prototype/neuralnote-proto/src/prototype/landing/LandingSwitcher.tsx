import { useEffect } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { landings } from "./landings";
import { setLanding } from "./nav";

// Floating switcher for the three landing directions (not themed by the page).
// Cycles landings with ← / → and exits back to the app.
export function LandingSwitcher({ current }: { current: string }) {
  const index = Math.max(0, landings.findIndex((l) => l.id === current));
  const meta = landings[index];
  const go = (delta: number) =>
    setLanding(landings[(index + delta + landings.length) % landings.length].id);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement;
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return;
      go(e.key === "ArrowRight" ? 1 : -1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="fixed bottom-5 left-1/2 z-50 -translate-x-1/2">
      <div className="flex items-center gap-1 rounded-full border border-white/10 bg-neutral-900/95 px-1.5 py-1.5 text-neutral-100 shadow-2xl ring-1 ring-black/40 backdrop-blur">
        <button
          onClick={() => go(-1)}
          className="grid size-8 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Previous landing"
        >
          <ChevronLeft className="size-4" />
        </button>
        <div className="min-w-48 px-2 text-center">
          <div className="text-[13px] font-semibold leading-none">
            <span className="text-neutral-500">{index + 1}/3 · </span>
            {meta.label}
          </div>
          <div className="mt-1 text-[11px] leading-none text-neutral-500">Landing · {meta.hero}</div>
        </div>
        <button
          onClick={() => go(1)}
          className="grid size-8 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Next landing"
        >
          <ChevronRight className="size-4" />
        </button>
        <button
          onClick={() => setLanding(null)}
          className="ml-1 grid size-8 place-items-center rounded-full text-neutral-400 transition hover:bg-white/10 hover:text-white"
          aria-label="Exit to app"
          title="Exit to app"
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="mt-1.5 text-center text-[10px] text-neutral-500">← / → switch · ✕ back to app</div>
    </div>
  );
}
