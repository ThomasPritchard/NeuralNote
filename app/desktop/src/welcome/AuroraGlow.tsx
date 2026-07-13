// Reserved presentation layer for the welcome surface. It stays neutral so the
// application chrome, rather than a decorative glow, carries the hierarchy.
export function AuroraGlow() {
  return (
    <div aria-hidden="true" className="pointer-events-none absolute inset-0 bg-background" />
  );
}
