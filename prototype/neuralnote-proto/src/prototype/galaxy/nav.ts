// Tiny decoupled navigation between the workspace and the galaxy surface,
// via a ?galaxy=1 URL param + a custom event the route listens for. Keeps the
// direction components from having to know about route state.
export function isGalaxy(): boolean {
  return new URLSearchParams(window.location.search).has("galaxy");
}

export function setGalaxy(on: boolean): void {
  const url = new URL(window.location.href);
  if (on) url.searchParams.set("galaxy", "1");
  else url.searchParams.delete("galaxy");
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("nn-nav"));
}
