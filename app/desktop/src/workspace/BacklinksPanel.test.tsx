import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Backlinks } from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, readBacklinks: vi.fn() };
});

import * as api from "../lib/api";
import { BacklinksPanel } from "./BacklinksPanel";

const mockApi = vi.mocked(api);

const backlinks = (over: Partial<Backlinks> = {}): Backlinks => ({
  linked: [
    {
      sourceRel: "Areas/Plan.md",
      sourceTitle: "The Plan",
      snippet: "builds on [[Deep Work]] daily",
      line: 12,
    },
  ],
  unlinked: [
    {
      sourceRel: "Daily.md",
      sourceTitle: "Daily",
      snippet: "more deep work today",
      line: 3,
    },
  ],
  skippedFiles: 0,
  ...over,
});

/** A promise resolvable from the test body. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  mockApi.readBacklinks.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("BacklinksPanel — states", () => {
  it("shows a loading state while the fetch is in flight", () => {
    mockApi.readBacklinks.mockReturnValue(new Promise(() => {}));
    render(<BacklinksPanel notePath="/v/n.md" />);
    expect(screen.getByText(/Finding backlinks/)).toBeInTheDocument();
  });

  it("renders linked and unlinked sections with counts", async () => {
    mockApi.readBacklinks.mockResolvedValue(backlinks());
    render(<BacklinksPanel notePath="/v/n.md" />);

    const linked = await screen.findByRole("button", { name: /Linked mentions/ });
    expect(within(linked).getByText("1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Unlinked mentions/ })).toBeInTheDocument();
    // Linked mentions are open by default…
    expect(screen.getByText("The Plan")).toBeInTheDocument();
    expect(screen.getByText("builds on [[Deep Work]] daily")).toBeInTheDocument();
    expect(screen.getByText(":12")).toBeInTheDocument();
    // …unlinked start collapsed.
    expect(screen.queryByText("more deep work today")).not.toBeInTheDocument();
  });

  it("expands unlinked mentions on toggle", async () => {
    mockApi.readBacklinks.mockResolvedValue(backlinks());
    render(<BacklinksPanel notePath="/v/n.md" />);

    const toggle = await screen.findByRole("button", { name: /Unlinked mentions/ });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("more deep work today")).toBeInTheDocument();
  });

  it("opens the source note through onOpenLink", async () => {
    const onOpenLink = vi.fn();
    mockApi.readBacklinks.mockResolvedValue(backlinks());
    render(<BacklinksPanel notePath="/v/n.md" onOpenLink={onOpenLink} />);

    await userEvent.click(await screen.findByRole("button", { name: /The Plan/ }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Areas/Plan.md");
  });

  it("shows the empty state when there are no mentions at all", async () => {
    mockApi.readBacklinks.mockResolvedValue(
      backlinks({ linked: [], unlinked: [] }),
    );
    render(<BacklinksPanel notePath="/v/n.md" />);
    expect(await screen.findByText(/No backlinks yet/)).toBeInTheDocument();
  });

  it("surfaces skipped files even when the result is empty", async () => {
    mockApi.readBacklinks.mockResolvedValue(
      backlinks({ linked: [], unlinked: [], skippedFiles: 2 }),
    );
    render(<BacklinksPanel notePath="/v/n.md" />);
    expect(await screen.findByText("2 files couldn't be read")).toBeInTheDocument();
    expect(screen.getByText(/No backlinks yet/)).toBeInTheDocument();
  });

  it("surfaces a fetch failure inline and recovers via Retry", async () => {
    mockApi.readBacklinks
      .mockRejectedValueOnce({ kind: "io", message: "permission denied" })
      .mockResolvedValueOnce(backlinks());
    render(<BacklinksPanel notePath="/v/n.md" />);

    expect(
      await screen.findByText(/Backlinks couldn't be loaded: permission denied/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Retry/ }));
    expect(await screen.findByText("The Plan")).toBeInTheDocument();
  });
});

describe("BacklinksPanel — stale responses", () => {
  it("ignores a slow response for a note that is no longer open", async () => {
    const slow = deferred<Backlinks>();
    mockApi.readBacklinks.mockReturnValueOnce(slow.promise).mockResolvedValueOnce(
      backlinks({
        linked: [
          {
            sourceRel: "New.md",
            sourceTitle: "Newer Source",
            snippet: "fresh",
            line: 1,
          },
        ],
        unlinked: [],
      }),
    );

    const { rerender } = render(<BacklinksPanel notePath="/v/old.md" />);
    rerender(<BacklinksPanel notePath="/v/new.md" />);

    // The newer note's result lands first…
    expect(await screen.findByText("Newer Source")).toBeInTheDocument();

    // …then the stale one resolves and must NOT overwrite it.
    await act(async () => {
      slow.resolve(
        backlinks({
          linked: [
            {
              sourceRel: "Old.md",
              sourceTitle: "Stale Source",
              snippet: "stale",
              line: 9,
            },
          ],
          unlinked: [],
        }),
      );
    });
    expect(screen.queryByText("Stale Source")).not.toBeInTheDocument();
    expect(screen.getByText("Newer Source")).toBeInTheDocument();
  });
});
