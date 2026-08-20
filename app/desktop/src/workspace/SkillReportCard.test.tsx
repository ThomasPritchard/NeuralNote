// SkillReportCard: the run's written-notes ledger and its Undo. Undo reports
// per-file outcomes (deleted / kept-edited / already gone / failed) — never a
// bare "done" — and a failure keeps a "Retry undo" affordance, because the
// backend restores its authority over failed runs.
//
// Undo is the app's ONE unconfirmed destructive verb, and unlike the file-tree
// delete it does not route through the Trash (#208). So the card owes the user
// the permanence in words, tied to the button, every time the button is
// offered — and the per-file outcome must not read as recoverable.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UndoReport } from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, undoSkillRun: vi.fn() };
});

import * as api from "../lib/api";
import { SkillReportCard } from "./SkillReportCard";

const mockUndo = vi.mocked(api.undoSkillRun);

const FILES = [
  { relPath: "Literature/Zettelkasten talk.md", kind: "literature" as const },
  { relPath: "Atomic/Atomic notes.md", kind: "atomic" as const },
];

const ALL_DELETED: UndoReport = {
  files: [
    { relPath: "Literature/Zettelkasten talk.md", status: "deleted", message: null },
    { relPath: "Atomic/Atomic notes.md", status: "deleted", message: null },
  ],
};

beforeEach(() => {
  mockUndo.mockReset();
  mockUndo.mockResolvedValue(ALL_DELETED);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillReportCard", () => {
  it("opens every authoritative written-note path", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(
      <SkillReportCard files={FILES} runId={null} done={false} onOpen={onOpen} />,
    );

    await user.click(
      screen.getByRole("button", { name: "Open Literature/Zettelkasten talk.md" }),
    );
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(
      "Literature/Zettelkasten talk.md",
    );
    expect(
      screen.getByRole("button", { name: "Open Literature/Zettelkasten talk.md" }),
    ).toHaveClass("min-h-6");
  });

  it("lists every written note with its kind chip and path", () => {
    render(<SkillReportCard files={FILES} runId={null} done={false} />);
    expect(screen.getByText("2 notes written")).toBeInTheDocument();
    expect(screen.getByText("literature")).toBeInTheDocument();
    expect(screen.getByText("atomic")).toBeInTheDocument();
    // Paths render dir + protected basename (middle-ellipsis idiom).
    expect(screen.getByText("Zettelkasten talk.md")).toBeInTheDocument();
    expect(screen.getByText("Atomic notes.md")).toBeInTheDocument();
  });

  it("truncates an overlong filename without hiding its full path", () => {
    const relPath =
      "Literature/2026-07-10 The New GPT 5.6 Sol is Insanely Capable and This Filename Keeps Going.md";
    render(
      <SkillReportCard
        files={[{ relPath, kind: "literature" }]}
        runId={null}
        done={false}
      />,
    );

    const filename = screen.getByText(/The New GPT 5\.6 Sol/);
    expect(filename).toHaveClass("min-w-0", "truncate");
    expect(filename.closest("[title]")).toHaveAttribute("title", relPath);
    expect(filename.closest("li")).toHaveClass("min-w-0");
  });

  it("keeps notes that already existed apart from the ones this run wrote", () => {
    render(
      <SkillReportCard
        files={FILES}
        existing={[{ relPath: "Literature/Already here.md", kind: "literature" }]}
        runId="run-1"
        done
      />,
    );

    // Counted apart, listed apart, and said out loud: a create-only write that
    // hit an existing note wrote nothing, and the no-op must still reach the user.
    expect(screen.getByText("2 notes written")).toBeInTheDocument();
    expect(screen.getByText("1 note already in your vault")).toBeInTheDocument();
    const existing = screen.getByRole("list", { name: "Notes that already existed" });
    expect(within(existing).getByText("Already here.md")).toBeInTheDocument();
    expect(within(existing).getByText(/Left as it was/)).toBeInTheDocument();
    // It is still the user's note, so it opens like any other.
    expect(
      within(existing).getByRole("button", { name: "Open Literature/Already here.md" }),
    ).toBeEnabled();
    // The already-present note never appears among the written ones.
    const written = screen.getByRole("list", { name: "Written notes" });
    expect(within(written).queryByText("Already here.md")).not.toBeInTheDocument();
  });

  it("offers no Undo when the run wrote nothing because every note already existed", () => {
    render(
      <SkillReportCard
        files={[]}
        existing={[{ relPath: "Literature/Already here.md", kind: "literature" }]}
        runId="run-1"
        done
      />,
    );

    // Nothing landed on disk, so there is nothing of this run's to remove —
    // an Undo here would delete the user's own note.
    expect(screen.queryByRole("button", { name: "Undo" })).not.toBeInTheDocument();
    expect(screen.queryByText(/permanently deletes/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/notes? written/)).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Written notes" })).not.toBeInTheDocument();
    expect(screen.getByText("1 note already in your vault")).toBeInTheDocument();
  });

  it("labels a partial playlist result and keeps transcript provenance inspectable", () => {
    render(
      <SkillReportCard
        files={[
          ...FILES,
          { relPath: "Transcripts/Zettelkasten talk transcript.md", kind: "transcript" },
        ]}
        runId="run-1"
        done
        partial
        provenance={["captions:en-auto", "whisper:small.en"]}
      />,
    );

    expect(screen.getByText("Model-reported partial run")).toBeInTheDocument();
    expect(
      screen.getByText(/The model reports that 3 notes were kept before the run stopped/),
    ).toBeInTheDocument();
    expect(screen.getByText("Model-reported provenance")).toBeInTheDocument();
    expect(screen.queryByText("Transcript provenance")).not.toBeInTheDocument();
    expect(screen.getByText("captions:en-auto")).toBeInTheDocument();
    expect(screen.getByText("whisper:small.en")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("offers Undo only once the run has settled and its run id is known", () => {
    const { rerender } = render(
      <SkillReportCard files={FILES} runId={null} done={false} />,
    );
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();

    // Done but the id hasn't resolved yet (sub-tick window) — still no button.
    rerender(<SkillReportCard files={FILES} runId={null} done={true} />);
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();

    rerender(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
  });

  it("warns that Undo permanently deletes, wherever the button is offered", () => {
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);

    // Everywhere else the app teaches that deleting means the Trash — the
    // file-tree delete literally confirms with "Move to Trash". This path
    // unlinks instead, so the card has to say so BEFORE the click.
    const caveat = screen.getByText(/permanently deletes/i);
    expect(caveat).toHaveTextContent(/don't go to the Trash/i);
    // True of the backend, not decoration: an edited note fails the hash check
    // and is kept (undo.rs `CheckedUnlink::Edited` -> SkippedEdited).
    expect(caveat).toHaveTextContent(/edited since are kept/i);

    // Tied to the control, so a screen-reader user meets the warning when they
    // reach the button rather than only if they read past it.
    expect(screen.getByRole("button", { name: "Undo" })).toHaveAccessibleDescription(
      /permanently deletes/i,
    );

    // Supporting copy, not an announcement: the always-mounted <output> below
    // owns the polite summary, and a second live region would fight it.
    expect(
      caveat.closest("[aria-live], output, [role='status'], [role='alert']"),
    ).toBeNull();
  });

  it("undoes the run and reports each file's outcome plus a polite summary", async () => {
    const user = userEvent.setup();
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(mockUndo).toHaveBeenCalledExactlyOnceWith("run-1");
    const outcomes = await screen.findAllByText(/Deleted permanently/i);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome).toHaveTextContent(/not in the Trash/i);
    }
    // The soft word is gone: "Removed" is what the recoverable file-tree delete
    // earns, and this deletion is not recoverable.
    expect(screen.queryByText("Removed")).not.toBeInTheDocument();
    expect(screen.getByText(/Undo finished — 2 notes deleted\./)).toBeInTheDocument();
    // Everything reached a terminal, non-failed outcome: nothing left to undo.
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
    // ...so the warning goes with it — it belongs to the offer, not the card.
    expect(screen.queryByText(/permanently deletes/i)).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Open Literature/Zettelkasten talk.md" }),
    ).toBeDisabled();
  });

  it("keeps per-file honesty on a partial undo and offers a retry after a failure", async () => {
    mockUndo.mockResolvedValue({
      files: [
        {
          relPath: "Literature/Zettelkasten talk.md",
          status: "skippedEdited",
          message: "You edited this note after the run wrote it.",
        },
        { relPath: "Atomic/Atomic notes.md", status: "failed", message: null },
      ],
    });
    const user = userEvent.setup();
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));

    // The backend's own message wins where present; the fallback copy is used
    // otherwise — and a failure is destructive, never folded into "done".
    expect(
      await screen.findByText("You edited this note after the run wrote it."),
    ).toBeInTheDocument();
    expect(screen.getByText("Couldn't be removed")).toBeInTheDocument();
    expect(screen.getByText(/0 notes deleted, 2 notes kept\./)).toBeInTheDocument();
    const retry = screen.getByRole("button", { name: "Retry undo" });
    expect(retry).toBeEnabled();
    expect(retry).toHaveAccessibleDescription(/permanently deletes/i);
    expect(
      screen.getByRole("button", { name: "Open Literature/Zettelkasten talk.md" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Open Atomic/Atomic notes.md" }),
    ).toBeEnabled();
  });

  it("surfaces a rejected undo command and keeps the retry affordance", async () => {
    mockUndo.mockRejectedValue({ kind: "io", message: "vault is read-only" });
    const user = userEvent.setup();
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("vault is read-only");
    expect(screen.getByRole("button", { name: "Retry undo" })).toBeEnabled();

    // The retry actually re-runs the command.
    mockUndo.mockResolvedValue(ALL_DELETED);
    await user.click(screen.getByRole("button", { name: "Retry undo" }));
    expect(mockUndo).toHaveBeenCalledTimes(2);
    expect(await screen.findAllByText(/Deleted permanently/i)).toHaveLength(2);
  });

  it("blocks double-fire while an undo is in flight", async () => {
    let resolve!: (r: UndoReport) => void;
    mockUndo.mockImplementation(
      () => new Promise<UndoReport>((res) => { resolve = res; }),
    );
    const user = userEvent.setup();
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    const undo = screen.getByRole("button", { name: "Undo" });
    await user.click(undo);
    expect(undo).toBeDisabled();
    await user.click(undo);
    expect(mockUndo).toHaveBeenCalledTimes(1);
    resolve(ALL_DELETED);
  });
});
