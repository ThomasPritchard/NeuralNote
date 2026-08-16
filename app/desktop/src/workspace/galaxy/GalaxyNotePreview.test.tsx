import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../../lib/types";
import { GalaxyNotePreview } from "./GalaxyNotePreview";
import type { GalaxyNode } from "./graph";
import { notePreviewMetrics } from "./notePreviewModel";

const mocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  useVault: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  readNote: mocks.readNote,
}));
vi.mock("../../lib/store", () => ({ useVault: mocks.useVault }));

const alpha: GalaxyNode = {
  id: "notes/alpha.md",
  title: "Alpha",
  cluster: "notes",
  val: 4,
  color: "#7d6fe0",
};
const beta: GalaxyNode = {
  id: "notes/beta.md",
  title: "Beta",
  cluster: "notes",
  val: 2,
  color: "#2f9d93",
};

function note(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/vault/notes/alpha.md",
    relPath: "notes/alpha.md",
    title: "Alpha",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "# Alpha\n\nThe first useful sentence explains this note. More follows.",
    raw: "# Alpha\n\nThe first useful sentence explains this note. More follows.",
    contentHash: "hash",
    binary: false,
    lossyText: false,
    exceedsEditableSize: false,
    sizeBytes: 0,
    ...overrides,
  };
}

function renderPreview(overrides: Partial<Parameters<typeof GalaxyNotePreview>[0]> = {}) {
  const props: Parameters<typeof GalaxyNotePreview>[0] = {
    selected: alpha,
    clusters: {
      notes: { label: "Notes", color: alpha.color, drillable: false },
    },
    neighbours: [{ node: beta, bridge: false }],
    onNodeClick: vi.fn(),
    onClose: vi.fn(),
    onOpenNote: vi.fn(),
    metrics: notePreviewMetrics(800, 600),
    ...overrides,
  };
  return { ...render(<GalaxyNotePreview {...props} />), props };
}

beforeEach(() => {
  mocks.readNote.mockReset();
  mocks.useVault.mockReturnValue({ vault: { name: "My Vault", path: "/vault" } });
});

describe("GalaxyNotePreview", () => {
  it("reads the selected note locally and presents the bounded digest", async () => {
    mocks.readNote.mockResolvedValue(note());

    renderPreview();

    expect(await screen.findByText("The first useful sentence explains this note.")).toBeInTheDocument();
    expect(mocks.readNote).toHaveBeenCalledWith("/vault/notes/alpha.md");
    expect(screen.getByText("Local digest")).toBeInTheDocument();
    expect(screen.getByText("Derived on this device")).toBeInTheDocument();
    expect(screen.getByText("No model called")).toBeInTheDocument();
    expect(screen.getByText("1 connected note")).toBeInTheDocument();
  });

  it("announces the pending read through a polite status live region", () => {
    // The loading notice is a native <output>; "status" is its implicit role and
    // the only reason a screen reader hears the wait at all. Pin the role, not
    // the copy — an implicit mapping can go quiet without changing any text.
    mocks.readNote.mockReturnValue(new Promise<NoteDoc>(() => {}));

    renderPreview();

    expect(screen.getByRole("status")).toHaveTextContent("Loading note…");
  });

  it("drops a late read when the selected node changes", async () => {
    let resolveAlpha!: (value: NoteDoc) => void;
    mocks.readNote
      .mockReturnValueOnce(new Promise<NoteDoc>((resolve) => { resolveAlpha = resolve; }))
      .mockResolvedValueOnce(note({
        path: "/vault/notes/beta.md",
        relPath: "notes/beta.md",
        title: "Beta",
        body: "Beta is the current selection.",
        raw: "Beta is the current selection.",
      }));
    const { rerender, props } = renderPreview();

    rerender(<GalaxyNotePreview {...props} selected={beta} />);
    expect(await screen.findByText("Beta is the current selection.")).toBeInTheDocument();

    await act(async () => {
      resolveAlpha(note({ body: "Stale Alpha content.", raw: "Stale Alpha content." }));
    });
    await waitFor(() => {
      expect(screen.queryByText("Stale Alpha content.")).not.toBeInTheDocument();
      expect(screen.getByText("Beta is the current selection.")).toBeInTheDocument();
    });
  });

  it("surfaces a read failure and retries the same note", async () => {
    mocks.readNote
      .mockRejectedValueOnce({ kind: "io", message: "note unreadable" })
      .mockResolvedValueOnce(note());
    const user = userEvent.setup();
    renderPreview();

    expect(await screen.findByRole("alert")).toHaveTextContent("note unreadable");
    await user.click(screen.getByRole("button", { name: "Retry preview" }));

    expect(await screen.findByText("The first useful sentence explains this note.")).toBeInTheDocument();
    expect(mocks.readNote).toHaveBeenCalledTimes(2);
  });

  it("keeps exceptional note states explicit", async () => {
    mocks.readNote.mockResolvedValue(note({
      body: "",
      raw: "",
      exceedsEditableSize: true,
      sizeBytes: 2_500_000,
    }));

    renderPreview();

    expect(await screen.findByText(/too large for an inline preview/i)).toBeInTheDocument();
    expect(screen.getByText(/file remains untouched/i)).toBeInTheDocument();
  });

  it("shows parse and decoding degradation without hiding the digest", async () => {
    mocks.readNote.mockResolvedValue(note({
      lossyText: true,
      frontmatterError: "invalid yaml",
    }));

    renderPreview();

    expect(await screen.findByText(/decoded lossily/i)).toBeInTheDocument();
    expect(screen.getByText(/frontmatter could not be parsed/i)).toBeInTheDocument();
    expect(screen.getByText("The first useful sentence explains this note.")).toBeInTheDocument();
  });

  it("surfaces a missing vault without attempting a read", async () => {
    mocks.useVault.mockReturnValue({ vault: null });

    renderPreview();

    expect(await screen.findByRole("alert")).toHaveTextContent("vault is no longer open");
    expect(mocks.readNote).not.toHaveBeenCalled();
  });

  it("states when a graph node has no text preview", async () => {
    mocks.readNote.mockResolvedValue(note({ body: "", raw: "", binary: true }));

    renderPreview();

    expect(await screen.findByText("This graph node does not have a text preview.")).toBeInTheDocument();
  });

  it("states when the note body is empty", async () => {
    mocks.readNote.mockResolvedValue(note({ body: "# Alpha", raw: "# Alpha" }));

    renderPreview();

    expect(await screen.findByText("This note has no body content yet.")).toBeInTheDocument();
  });

  it("renders hostile note markup as inert text", async () => {
    mocks.readNote.mockResolvedValue(note({
      body: '<img src=x onerror="alert(1)"> remains inert.',
      raw: '<img src=x onerror="alert(1)"> remains inert.',
    }));
    const { container } = renderPreview();

    expect(await screen.findByText(/<img src=x onerror="alert\(1\)"> remains inert\./)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("supports keyboard movement and Escape without trapping graph focus", () => {
    mocks.readNote.mockResolvedValue(note());
    const { container, props } = renderPreview();
    const move = screen.getByRole("button", { name: /Move note preview/ });

    fireEvent.keyDown(move, { key: "ArrowRight" });
    expect(container.querySelector(".nn-graph-preview-layer")).toHaveAttribute("data-drag-x", "12");

    fireEvent.keyDown(screen.getByRole("complementary", { name: "Alpha" }), { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("moves the preview through pointer capture and releases the drag", () => {
    mocks.readNote.mockResolvedValue(note());
    const { container } = renderPreview();
    const layer = container.querySelector<HTMLElement>(".nn-graph-preview-layer")!;
    layer.style.setProperty("--nn-graph-preview-bubble-x", "100px");
    layer.style.setProperty("--nn-graph-preview-bubble-y", "80px");
    const move = screen.getByRole("button", { name: /Move note preview/ });
    const capturedPointers = new Set<number>();
    const setPointerCapture = vi.fn((pointerId: number) => capturedPointers.add(pointerId));
    const releasePointerCapture = vi.fn((pointerId: number) => capturedPointers.delete(pointerId));
    Object.defineProperties(move, {
      setPointerCapture: { value: setPointerCapture },
      hasPointerCapture: {
        value: (pointerId: number) => capturedPointers.has(pointerId),
      },
      releasePointerCapture: { value: releasePointerCapture },
    });

    fireEvent.pointerDown(move, { pointerId: 7, clientX: 20, clientY: 30 });
    fireEvent.pointerMove(move, { pointerId: 7, clientX: 50, clientY: 70 });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(layer).toHaveAttribute("data-drag-x", "130");
    expect(layer).toHaveAttribute("data-drag-y", "120");
    fireEvent.pointerUp(move, { pointerId: 7 });
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
  });

  it("keeps reader navigation and close actions available", async () => {
    mocks.readNote.mockResolvedValue(note());
    const user = userEvent.setup();
    const { props } = renderPreview();

    await user.click(screen.getByRole("button", { name: "Open in reader" }));
    await user.click(screen.getByRole("button", { name: "Close note preview" }));

    expect(props.onOpenNote).toHaveBeenCalledWith("notes/alpha.md");
    expect(props.onClose).toHaveBeenCalledOnce();
  });

  it("keeps neighbour dots as labelled controls with non-overlapping hit areas", async () => {
    mocks.readNote.mockResolvedValue(note());
    renderPreview();

    const neighbour = screen.getByRole("button", { name: "Preview connected note Beta" });
    expect(neighbour).toHaveClass("nn-graph-preview-neighbour-target");
    expect(neighbour.querySelector(".nn-graph-preview-neighbour-dot")).not.toBeNull();
  });
});
