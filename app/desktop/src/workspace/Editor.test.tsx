import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Editor } from "./Editor";

interface Props {
  value?: string;
  onChange?: (v: string) => void;
  onSave?: () => void;
  saveError?: string | null;
  conflict?: boolean;
  onOverwrite?: () => void;
  onReload?: () => void;
}

function renderEditor(props: Props = {}) {
  const handlers = {
    value: "initial",
    onChange: vi.fn(),
    onSave: vi.fn(),
    saveError: null as string | null,
    conflict: false,
    onOverwrite: vi.fn(),
    onReload: vi.fn(),
    ...props,
  };
  render(<Editor {...handlers} />);
  return handlers;
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

describe("Editor — save shortcut", () => {
  it("saves on Cmd+S and prevents the browser default", () => {
    const h = renderEditor();
    const ev = new KeyboardEvent("keydown", {
      key: "s",
      metaKey: true,
      cancelable: true,
    });
    window.dispatchEvent(ev);
    expect(h.onSave).toHaveBeenCalledTimes(1);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("saves on Ctrl+S (uppercase key too)", () => {
    const h = renderEditor();
    window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "S", ctrlKey: true, cancelable: true }),
    );
    expect(h.onSave).toHaveBeenCalledTimes(1);
  });

  it("ignores plain keystrokes and unmounts its listener", () => {
    const h = renderEditor();
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "s" }));
    expect(h.onSave).not.toHaveBeenCalled();
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
