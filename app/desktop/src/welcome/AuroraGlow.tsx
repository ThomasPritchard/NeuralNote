// Decorative violet aurora glow that sits behind the welcome content. Purely
// presentational: non-interactive and hidden from assistive tech.
export function AuroraGlow() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div className="absolute left-1/2 top-1/4 h-[28rem] w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary opacity-20 blur-[140px]" />
      <div className="absolute left-1/2 top-1/2 h-[18rem] w-[34rem] -translate-x-1/2 rounded-full bg-accent opacity-30 blur-[120px]" />
    </div>
  );
}
