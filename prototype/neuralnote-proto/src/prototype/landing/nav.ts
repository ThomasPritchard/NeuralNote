// Landing surface navigation via ?landing=<id>, reusing the shared "nn-nav"
// event the route already listens for.
export function getLanding(): string | null {
  return new URLSearchParams(window.location.search).get("landing");
}

export function setLanding(id: string | null): void {
  const url = new URL(window.location.href);
  if (id) url.searchParams.set("landing", id);
  else url.searchParams.delete("landing");
  window.history.pushState(null, "", url);
  window.dispatchEvent(new Event("nn-nav"));
}
