import { describe, expect, it, vi } from "vitest";

import { createPreviewErrorReporter } from "./sourceEditorPreviewErrorReporter";

describe("createPreviewErrorReporter", () => {
  it("keeps one channel's failure up while the other keeps succeeding", () => {
    // The whole point. The inline plugin recomputes on triggers the table field
    // never sees — a focus change, a vault-index refresh — so its success would
    // otherwise clear a banner it knows nothing about.
    const onError = vi.fn();
    const report = createPreviewErrorReporter(onError);

    report("table", "Table preview is temporarily unavailable.");
    report("inline", null);
    report("inline", null);

    expect(onError.mock.calls.map(([message]) => message))
      .toEqual(["Table preview is temporarily unavailable."]);
  });

  it("clears the banner only once the failing channel recovers", () => {
    const onError = vi.fn();
    const report = createPreviewErrorReporter(onError);

    report("table", "Table preview is temporarily unavailable.");
    report("table", null);

    expect(onError).toHaveBeenLastCalledWith(null);
  });

  it("shows the table failure ahead of a simultaneous inline one", () => {
    // The table message names the construct that broke; the inline message is
    // generic, and reported over it would send the user looking in the wrong
    // place.
    const onError = vi.fn();
    const report = createPreviewErrorReporter(onError);

    report("inline", "Live preview is temporarily unavailable.");
    report("table", "Table preview is temporarily unavailable.");

    expect(onError).toHaveBeenLastCalledWith("Table preview is temporarily unavailable.");
  });

  it("falls back to the inline failure once the table channel recovers", () => {
    const onError = vi.fn();
    const report = createPreviewErrorReporter(onError);

    report("inline", "Live preview is temporarily unavailable.");
    report("table", "Table preview is temporarily unavailable.");
    report("table", null);

    expect(onError).toHaveBeenLastCalledWith("Live preview is temporarily unavailable.");
  });

  it("reports the first null, then stays quiet while nothing changes", () => {
    // The first report always reaches the sink, so a newly mounted editor clears
    // whatever the previous note left on screen. After that, a pass that
    // succeeds on every keystroke must not re-render the banner.
    const onError = vi.fn();
    const report = createPreviewErrorReporter(onError);

    report("inline", null);
    report("inline", null);
    report("table", null);

    expect(onError.mock.calls).toEqual([[null]]);
  });
});
