// SearchPanel: debounce + min-chars gating, the stale-token race, every UI
// state (idle / loading / results / empty / truncated / skipped-files / error),
// Escape + focusSignal behaviours, click-through to onOpen, and the
// code-point-safe highlightSnippet helper (emoji before a match must not drift).

import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FileHit, SearchResponse } from "../lib/types";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

// SearchPanel only consumes reportError from the vault store.
vi.mock("../lib/store", () => ({ useVault: () => ({ reportError }) }));

// Mock only searchVault; keep errorMessage real so surfaced text is honest.
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, searchVault: vi.fn() };
});

import * as api from "../lib/api";
import { highlightSnippet, SearchPanel } from "./SearchPanel";

const mockSearch = vi.mocked(api.searchVault);

const response = (over: Partial<SearchResponse> = {}): SearchResponse => ({
  hits: [],
  truncated: false,
  skippedFiles: 0,
  ...over,
});

const fileHit = (over: Partial<FileHit> = {}): FileHit => ({
  path: "/v/Notes/Alpha.md",
  relPath: "Notes/Alpha.md",
  title: "Alpha Note",
  nameMatch: false,
  matches: [],
  ...over,
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup(over: {
  focusSignal?: number;
  queryRequest?: { id: number; query: string } | null;
} = {}) {
  const onOpen = vi.fn();
  const view = render(
    <SearchPanel
      focusSignal={over.focusSignal ?? 0}
      queryRequest={over.queryRequest ?? null}
      onOpen={onOpen}
    />,
  );
  return { onOpen, ...view };
}

const input = () =>
  screen.getByLabelText("Search vault") as HTMLInputElement;

const type = (value: string) =>
  fireEvent.change(input(), { target: { value } });

/** Let the 200 ms debounce elapse and flush any settled promises. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(200);
  });

/** Flush microtasks (fulfilled search promises) without advancing the clock. */
const flush = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

/** Type a query and resolve its (debounced) search with `res`. */
async function searchFor(query: string, res: SearchResponse) {
  mockSearch.mockResolvedValueOnce(res);
  type(query);
  await settle();
}

beforeEach(() => {
  vi.useFakeTimers();
  mockSearch.mockReset();
  reportError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SearchPanel — shell & field", () => {
  it("renders the sidebar shell with the prototype field and an idle hint", () => {
    setup();
    expect(
      screen.getByRole("complementary", { name: "Search" }),
    ).toBeInTheDocument();
    expect(input()).toHaveAttribute("placeholder", "Search vault…");
    expect(screen.getByText("⌘K")).toBeInTheDocument();
    expect(screen.getByText(/type at least two characters/i)).toBeInTheDocument();
    expect(mockSearch).not.toHaveBeenCalled();
  });
});

describe("SearchPanel — debounce & min-chars gating", () => {
  it("never searches below 2 trimmed characters", async () => {
    setup();
    type("a");
    await settle();
    type("  b  "); // trims to 1 char
    await settle();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(screen.getByText(/type at least two characters/i)).toBeInTheDocument();
  });

  it("waits the full 200 ms before searching", async () => {
    mockSearch.mockResolvedValue(response());
    setup();
    type("ab");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(mockSearch).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mockSearch).toHaveBeenCalledExactlyOnceWith("ab");
  });

  it("coalesces rapid typing into one trailing call with the trimmed query", async () => {
    mockSearch.mockResolvedValue(response());
    setup();
    type("al");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
    type("  alpha  ");
    await settle();
    expect(mockSearch).toHaveBeenCalledExactlyOnceWith("alpha");
  });
});

describe("SearchPanel — states", () => {
  it("shows a loading state while a request is in flight", async () => {
    const d = deferred<SearchResponse>();
    mockSearch.mockReturnValueOnce(d.promise);
    setup();
    type("alpha");
    await settle();
    expect(screen.getByText(/searching/i)).toBeInTheDocument();
  });

  it("renders hits grouped by file: header (title + relPath) and match rows", async () => {
    const { container } = setup();
    await searchFor(
      "alpha",
      response({
        hits: [
          fileHit({
            nameMatch: true,
            matches: [
              { line: 3, snippet: "alpha beta alpha", ranges: [[0, 5], [11, 16]] },
            ],
          }),
          fileHit({
            path: "/v/Other.md",
            relPath: "Other.md",
            title: "Other",
            matches: [], // name-only hit
          }),
        ],
      }),
    );

    expect(screen.getByText("Alpha Note")).toBeInTheDocument();
    expect(screen.getByText("Notes/Alpha.md")).toBeInTheDocument();
    expect(screen.getByText("Other")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument(); // line number

    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0]).toHaveTextContent("alpha");
    expect(marks[1]).toHaveTextContent("alpha");
  });

  it("shows the empty state, keeping the skipped-files notice visible beside it", async () => {
    setup();
    await searchFor("zebra", response({ hits: [], skippedFiles: 1 }));
    expect(screen.getByText('No notes match "zebra"')).toBeInTheDocument();
    // A permissions problem must never masquerade as a genuinely empty result.
    expect(screen.getByText(/1 file couldn't be read/i)).toBeInTheDocument();
  });

  it("shows the truncated banner alongside results", async () => {
    setup();
    await searchFor("alpha", response({ hits: [fileHit()], truncated: true }));
    expect(screen.getByText("Showing first 200 matches")).toBeInTheDocument();
    expect(screen.getByText("Alpha Note")).toBeInTheDocument();
  });

  it("shows a non-blocking skipped-files notice alongside results (pluralised)", async () => {
    setup();
    await searchFor("alpha", response({ hits: [fileHit()], skippedFiles: 2 }));
    expect(screen.getByText(/2 files couldn't be read/i)).toBeInTheDocument();
    expect(screen.getByText("Alpha Note")).toBeInTheDocument();
  });

  it("reports search failures to the shared error channel and shows an inline state", async () => {
    mockSearch.mockRejectedValueOnce({ kind: "io", message: "disk exploded" });
    setup();
    type("alpha");
    await settle();
    expect(reportError).toHaveBeenCalledExactlyOnceWith("disk exploded");
    expect(screen.getByText(/search failed/i)).toBeInTheDocument();
  });
});

describe("SearchPanel — stale-token race", () => {
  it("invalidates an in-flight response as soon as a replacement query enters debounce", async () => {
    const older = deferred<SearchResponse>();
    const newer = deferred<SearchResponse>();
    mockSearch
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    setup();

    type("alpha");
    await settle();
    type("beta");

    older.resolve(
      response({ hits: [fileHit({ title: "Older", relPath: "o.md", path: "/v/o.md" })] }),
    );
    await flush();
    expect(screen.queryByText("Older")).not.toBeInTheDocument();

    await settle();
    newer.resolve(
      response({ hits: [fileHit({ title: "Newer", relPath: "n.md", path: "/v/n.md" })] }),
    );
    await flush();
    expect(screen.getByText("Newer")).toBeInTheDocument();
  });

  it("discards an older slow response that resolves after a newer one", async () => {
    const d1 = deferred<SearchResponse>();
    const d2 = deferred<SearchResponse>();
    mockSearch
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    setup();

    type("alpha");
    await settle();
    type("alphabet");
    await settle();
    expect(mockSearch).toHaveBeenCalledTimes(2);

    // Newer resolves first…
    d2.resolve(
      response({ hits: [fileHit({ title: "Newer", relPath: "n.md", path: "/v/n.md" })] }),
    );
    await flush();
    expect(screen.getByText("Newer")).toBeInTheDocument();

    // …then the older, slower response lands and must be discarded.
    d1.resolve(
      response({ hits: [fileHit({ title: "Older", relPath: "o.md", path: "/v/o.md" })] }),
    );
    await flush();
    expect(screen.queryByText("Older")).not.toBeInTheDocument();
    expect(screen.getByText("Newer")).toBeInTheDocument();
  });
});

describe("SearchPanel — interaction", () => {
  it("opens the file when the header or a match row is clicked", async () => {
    const { onOpen } = setup();
    await searchFor(
      "alpha",
      response({
        hits: [
          fileHit({
            matches: [{ line: 7, snippet: "the alpha ray", ranges: [[4, 9]] }],
          }),
        ],
      }),
    );

    fireEvent.click(screen.getByRole("button", { name: /Alpha Note/ }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("/v/Notes/Alpha.md");

    fireEvent.click(screen.getByRole("button", { name: /the alpha ray/ }));
    expect(onOpen).toHaveBeenCalledTimes(2);
    expect(onOpen).toHaveBeenLastCalledWith("/v/Notes/Alpha.md");
  });

  it("Escape clears a non-empty query, then blurs when already empty", async () => {
    setup();
    await searchFor("alpha", response({ hits: [fileHit()] }));

    act(() => input().focus());
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).toHaveValue("");
    expect(screen.getByText(/type at least two characters/i)).toBeInTheDocument();
    expect(input()).toHaveFocus();

    fireEvent.keyDown(input(), { key: "Escape" });
    expect(input()).not.toHaveFocus();
  });

  it("focuses the input when focusSignal bumps (not on mount at 0)", () => {
    const onOpen = vi.fn();
    const { rerender } = render(<SearchPanel focusSignal={0} onOpen={onOpen} />);
    expect(input()).not.toHaveFocus();
    rerender(<SearchPanel focusSignal={1} onOpen={onOpen} />);
    expect(input()).toHaveFocus();
  });

  it("accepts and focuses an external tag query request", async () => {
    mockSearch.mockResolvedValue(response());
    setup({ queryRequest: { id: 1, query: "tag:#SaaS" } });

    expect(input()).toHaveValue("tag:#SaaS");
    expect(input()).toHaveFocus();
    await settle();
    expect(mockSearch).toHaveBeenCalledExactlyOnceWith("tag:#SaaS");
  });

  it("re-runs and refocuses when the same tag arrives with a new request id", async () => {
    mockSearch.mockResolvedValue(response());
    const onOpen = vi.fn();
    const { rerender } = render(
      <SearchPanel
        focusSignal={0}
        queryRequest={{ id: 1, query: "tag:#SaaS" }}
        onOpen={onOpen}
      />,
    );
    await settle();
    input().blur();

    rerender(
      <SearchPanel
        focusSignal={0}
        queryRequest={{ id: 2, query: "tag:#SaaS" }}
        onOpen={onOpen}
      />,
    );
    await settle();

    expect(input()).toHaveFocus();
    expect(mockSearch).toHaveBeenCalledTimes(2);
    expect(mockSearch).toHaveBeenNthCalledWith(2, "tag:#SaaS");
  });
});

describe("highlightSnippet", () => {
  it("returns the plain snippet untouched when there are no ranges", () => {
    const { container } = render(<p>{highlightSnippet("plain text", [])}</p>);
    expect(container.textContent).toBe("plain text");
    expect(container.querySelector("mark")).toBeNull();
  });

  it("wraps multiple ranges in <mark> and preserves the full text", () => {
    const { container } = render(
      <p>{highlightSnippet("alpha beta alpha", [[0, 5], [11, 16]])}</p>,
    );
    const marks = container.querySelectorAll("mark");
    expect(marks).toHaveLength(2);
    expect(marks[0].textContent).toBe("alpha");
    expect(marks[1].textContent).toBe("alpha");
    expect(container.textContent).toBe("alpha beta alpha");
  });

  it("slices by code points: an emoji before the match must not drift the range", () => {
    // ranges are code-point offsets: ["🦄","🦄"," ","a","l","p","h","a"] → [3, 8).
    // UTF-16 .slice(3, 8) would yield "\u{1F984} al" garbage instead.
    const { container } = render(
      <p>{highlightSnippet("🦄🦄 alpha", [[3, 8]])}</p>,
    );
    const mark = container.querySelector("mark");
    expect(mark?.textContent).toBe("alpha");
    expect(container.textContent).toBe("🦄🦄 alpha");
  });
});
