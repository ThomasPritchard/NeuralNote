import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "./Editor";
import type { NoteIndexEntry } from "./linkResolve";

// The Editor subscribes to menu://action for the Format commands; mock the event
// bus so listen() resolves to a no-op unlisten and tests can drive the handler.
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(() => Promise.resolve(() => {})),
}));
import { listen } from "@tauri-apps/api/event";
const mockListen = vi.mocked(listen);

interface Props {
  value?: string;
  onChange?: (v: string) => void;
  saveError?: string | null;
  conflict?: boolean;
  onOverwrite?: () => void;
  onReload?: () => void;
  noteIndex?: NoteIndexEntry[];
}

function renderEditor(props: Props = {}) {
  const handlers = {
    value: "initial",
    onChange: vi.fn(),
    saveError: null as string | null,
    conflict: false,
    onOverwrite: vi.fn(),
    onReload: vi.fn(),
    ...props,
  };
  render(<Editor {...handlers} />);
  return handlers;
}

/** The menu-action handler the Editor's onMenu subscription registered (latest
 *  mount). onMenu wraps it as `(e) => cb(e.payload)`, so drive it with a
 *  `{ payload }` envelope. */
function fireMenu(action: string) {
  const call = mockListen.mock.calls.at(-1);
  const handler = call![1] as (e: { payload: { action: string } }) => void;
  handler({ payload: { action } });
}

beforeEach(() => {
  // Real timers; nothing async beyond user events here.
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Editor — buffer", () => {
  it("seeds the textarea from value and reports edits via onChange", async () => {
    const h = renderEditor({ value: "seed" });
    const ta = screen.getByLabelText("Note source") as HTMLTextAreaElement;
    expect(ta.value).toBe("seed");
    await userEvent.type(ta, "X");
    expect(h.onChange).toHaveBeenLastCalledWith("seedX");
  });
});

describe("Editor — format actions", () => {
  it("wraps the focused selection in bold on format-bold", () => {
    const h = renderEditor({ value: "word" });
    const ta = screen.getByLabelText("Note source") as HTMLTextAreaElement;
    ta.focus();
    ta.setSelectionRange(0, 4);
    fireMenu("format-bold");
    expect(ta.value).toBe("**word**");
    expect([ta.selectionStart, ta.selectionEnd]).toEqual([2, 6]);
    expect(h.onChange).toHaveBeenLastCalledWith("**word**");
  });

  it("ignores format actions when its textarea isn't focused", () => {
    const h = renderEditor({ value: "word" });
    const ta = screen.getByLabelText("Note source") as HTMLTextAreaElement;
    ta.blur();
    fireMenu("format-bold");
    expect(ta.value).toBe("word");
    expect(h.onChange).not.toHaveBeenCalled();
  });
});

describe("Editor — conflict + error banners", () => {
  it("renders the conflict banner with reload and overwrite actions", async () => {
    const h = renderEditor({ conflict: true });
    expect(screen.getByRole("alert")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Reload/i }));
    expect(h.onReload).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Overwrite/i }));
    expect(h.onOverwrite).toHaveBeenCalled();
  });

  it("shows the save error inline", () => {
    renderEditor({ saveError: "permission denied" });
    expect(screen.getByText(/Couldn't save: permission denied/i)).toBeInTheDocument();
  });

  it("shows no banners in the happy path", () => {
    renderEditor();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/Couldn't save/i)).not.toBeInTheDocument();
  });
});

// userEvent.type treats brackets as key-descriptor delimiters; "[[" must be
// escaped by doubling, so typing a literal "[[" is "[[[[".
const INDEX: NoteIndexEntry[] = [
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
  { relPath: "Daily.md", stem: "daily" },
];

const textarea = () => screen.getByLabelText("Note source") as HTMLTextAreaElement;

describe("Editor — [[ autocomplete", () => {
  it("opens on [[ , filters by the typed prefix, and inserts on Enter", async () => {
    const h = renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();

    await userEvent.type(ta, "see [[[[");
    const listbox = screen.getByRole("listbox", { name: "Link to note" });
    expect(within(listbox).getAllByRole("option")).toHaveLength(2);

    await userEvent.type(ta, "dee");
    expect(within(listbox).getAllByRole("option")).toHaveLength(1);
    expect(within(listbox).getByRole("option", { name: /Deep Work/ })).toBeInTheDocument();

    await userEvent.keyboard("{Enter}");
    expect(ta.value).toBe("see [[Deep Work]]");
    expect(h.onChange).toHaveBeenLastCalledWith("see [[Deep Work]]");
    // The caret lands after the inserted link, ready to keep typing.
    expect(ta.selectionStart).toBe("see [[Deep Work]]".length);
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("keeps the textarea uncontrolled — typing continues after an insert", async () => {
    // onChange is a plain mock (no value fed back); if the textarea were
    // controlled, the DOM value would snap back after every keystroke.
    renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "[[[[da");
    await userEvent.keyboard("{Enter}");
    expect(ta.value).toBe("[[Daily]]");
    await userEvent.type(ta, " more");
    expect(ta.value).toBe("[[Daily]] more");
  });

  it("navigates with arrows (aria-activedescendant follows) and inserts with Tab", async () => {
    renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "[[[[");
    // Alphabetical: Daily first, Deep Work second.
    expect(ta).toHaveAttribute("aria-activedescendant", "nn-wikilink-option-0");
    await userEvent.keyboard("{ArrowDown}");
    expect(ta).toHaveAttribute("aria-activedescendant", "nn-wikilink-option-1");
    const active = screen.getByRole("option", { selected: true });
    expect(active).toHaveTextContent("Deep Work");
    await userEvent.keyboard("{Tab}");
    expect(ta.value).toBe("[[Deep Work]]");
  });

  it("inserts on click", async () => {
    const h = renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "[[[[");
    await userEvent.click(screen.getByRole("option", { name: /Daily/ }));
    expect(ta.value).toBe("[[Daily]]");
    expect(h.onChange).toHaveBeenLastCalledWith("[[Daily]]");
  });

  it("dismisses on Escape without touching the buffer", async () => {
    renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "[[[[da");
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(ta.value).toBe("[[da");
  });

  it("never traps typing while closed — Enter stays a newline", async () => {
    renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "a{Enter}b");
    expect(ta.value).toBe("a\nb");
  });

  it("closes once the link is closed by hand", async () => {
    renderEditor({ value: "", noteIndex: INDEX });
    const ta = textarea();
    await userEvent.type(ta, "[[[[da]]");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });

  it("shows nothing without a note index (chatless editors stay plain)", async () => {
    renderEditor({ value: "" });
    await userEvent.type(textarea(), "[[[[");
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
  });
});
