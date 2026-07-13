// SkillReportCard: the run's written-notes ledger and its Undo. Undo reports
// per-file outcomes (removed / kept-edited / already gone / failed) — never a
// bare "done" — and a failure keeps a "Retry undo" affordance, because the
// backend restores its authority over failed runs.

import { render, screen } from "@testing-library/react";
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

  it("undoes the run and reports each file's outcome plus a polite summary", async () => {
    const user = userEvent.setup();
    render(<SkillReportCard files={FILES} runId="run-1" done={true} />);
    await user.click(screen.getByRole("button", { name: "Undo" }));

    expect(mockUndo).toHaveBeenCalledExactlyOnceWith("run-1");
    expect(await screen.findAllByText("Removed")).toHaveLength(2);
    expect(screen.getByText(/Undo finished — 2 notes removed\./)).toBeInTheDocument();
    // Everything reached a terminal, non-failed outcome: nothing left to undo.
    expect(screen.queryByRole("button", { name: /Undo/ })).not.toBeInTheDocument();
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
    expect(screen.getByText(/0 notes removed, 2 notes kept\./)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry undo" })).toBeEnabled();
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
    expect(await screen.findAllByText("Removed")).toHaveLength(2);
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
