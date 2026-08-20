// SkillReportCard: the run's written-notes ledger and its Undo. Undo reports
// per-file outcomes (deleted / kept-edited / already gone / failed) — never a
// bare "done" — and a failure keeps a "Retry undo" affordance, because the
// backend restores its authority over failed runs.
//
// Undo is the app's ONE unconfirmed destructive verb, and unlike the file-tree
// delete it does not route through the Trash (#208). So the card owes the user
// the permanence in words, tied to the button, every time the button is
// offered — and the per-file outcome must not read as recoverable.
//
// The announced summary is the whole story for a screen-reader user: the rows
// are static text nothing reads out. So it owes the same honesty the rows do —
// a note that could not be removed is never counted among the notes that were
// kept.

import { render, screen, waitFor, within } from "@testing-library/react";
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

/** Four files, so one report can carry all four outcomes at once. */
const MIXED_FILES = [
  ...FILES,
  { relPath: "Atomic/Second thought.md", kind: "atomic" as const },
  { relPath: "Transcripts/Talk transcript.md", kind: "transcript" as const },
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

/** The card's one live region: an always-mounted `<output>` that is empty until
 *  an undo settles. Everything a screen-reader user learns about the undo is in
 *  here, so the tests read it rather than the static rows. */
async function announcement(): Promise<HTMLElement> {
  const announced = screen.getByRole("status");
  await waitFor(() => expect(announced).not.toBeEmptyDOMElement());
  return announced;
}

/** Run one undo to completion and hand back what it announced. */
async function undoAndAnnounce(
  report: UndoReport,
  files: typeof FILES | typeof MIXED_FILES = FILES,
): Promise<HTMLElement> {
  mockUndo.mockResolvedValue(report);
  const user = userEvent.setup();
  render(<SkillReportCard files={files} runId="run-1" done />);
  await user.click(screen.getByRole("button", { name: "Undo" }));
  return announcement();
}

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
    // The failure is announced as a failure. Counting it among the "kept" notes
    // would describe a deliberate, clean outcome — the exact opposite of what
    // happened to Atomic notes.md.
    expect(await announcement()).toHaveTextContent(
      "Undo incomplete — 1 note couldn't be removed, 1 kept.",
    );
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

  it("announces a clean undo as deletions and nothing else", async () => {
    expect(await undoAndAnnounce(ALL_DELETED)).toHaveTextContent(
      "Undo finished — 2 notes deleted.",
    );
  });

  it("counts a deliberately kept note apart from a deleted one", async () => {
    const announced = await undoAndAnnounce({
      files: [
        { relPath: FILES[0].relPath, status: "deleted", message: null },
        { relPath: FILES[1].relPath, status: "skippedEdited", message: null },
      ],
    });
    expect(announced).toHaveTextContent(
      "Undo finished — 1 note deleted, 1 kept.",
    );
  });

  it("announces a total failure as a failure, never as notes kept", async () => {
    const announced = await undoAndAnnounce({
      files: FILES.map((file) => ({
        relPath: file.relPath,
        status: "failed" as const,
        message: null,
      })),
    });

    // Nothing worked. "0 notes deleted, 2 notes kept" describes a clean,
    // intentional outcome, and this <output> is the only part of the card that
    // is ever announced.
    expect(announced).toHaveTextContent(
      "Undo incomplete — 2 notes couldn't be removed.",
    );
    expect(announced).not.toHaveTextContent(/kept/);
    expect(announced).not.toHaveTextContent(/finished/);
    // ...and it is not whispered in the grey the clean summary is written in.
    expect(announced).toHaveClass("text-foreground/90");
  });

  it("says so plainly when the report carries no files at all", async () => {
    // The sentence is assembled from non-zero counts, so an empty report must
    // not announce as a dangling "Undo finished — .".
    expect(await undoAndAnnounce({ files: [] })).toHaveTextContent(
      "Undo finished — no notes to remove.",
    );
  });

  it("keeps all four outcomes distinct in one readable sentence", async () => {
    const announced = await undoAndAnnounce(
      {
        files: [
          { relPath: MIXED_FILES[0].relPath, status: "deleted", message: null },
          { relPath: MIXED_FILES[1].relPath, status: "skippedEdited", message: null },
          { relPath: MIXED_FILES[2].relPath, status: "skippedMissing", message: null },
          { relPath: MIXED_FILES[3].relPath, status: "failed", message: null },
        ],
      },
      MIXED_FILES,
    );

    // The failure leads, every category keeps its own word, and the noun rides
    // the first clause only.
    expect(announced).toHaveTextContent(
      "Undo incomplete — 1 note couldn't be removed, 1 deleted, 1 kept, 1 already gone.",
    );
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
