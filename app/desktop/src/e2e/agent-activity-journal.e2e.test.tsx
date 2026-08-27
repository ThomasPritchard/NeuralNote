// Envelope-v1 agent activity journeys through the real App, api.chat invoke,
// mockIPC command seam, and Tauri Channel. The fixture factory receives the
// composer-generated turn id; envelopes themselves are never rewritten.

import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type {
  AgentActivityEnvelope,
  AgentActivityPayload,
  SkillListing,
} from "../lib/types";
import { VAULT_ROOT, type CreateMockVaultOptions } from "./mockVault";
import { renderApp } from "./renderApp";

const recents = [
  { name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 },
];

const youtubeSkill: SkillListing = {
  id: "youtube-distil",
  name: "YouTube distil",
  description: "Distil YouTube videos and playlists into cited vault notes.",
  icon: "youtube",
  enabled: true,
  requirements: [],
};

const longYoutubeNote = [
  "# Reliable agent interfaces",
  "",
  ...Array.from(
    { length: 36 },
    (_, index) =>
      `## Point ${index + 1}\n\nAgent interfaces stay legible when transient progress is bounded and settled work remains inspectable.`,
  ),
].join("\n");

interface ActivityFrame {
  payload: AgentActivityPayload;
  cycleId?: string;
  activityId?: string;
}

function envelopeScript(
  turnId: string,
  frames: readonly ActivityFrame[],
): AgentActivityEnvelope[] {
  return frames.map((frame, index) => ({
    schemaVersion: 1,
    turnId,
    sequence: index + 1,
    cycleId: frame.cycleId ?? null,
    activityId: frame.activityId ?? null,
    payload: frame.payload,
  }));
}

async function openWorkspace(opts: CreateMockVaultOptions) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(
    await screen.findByRole("button", { name: "Open My Brain" }),
  );
  await screen.findByText("Neural Assistant AI");
  return result;
}

async function ask(
  user: Awaited<ReturnType<typeof openWorkspace>>["user"],
  prompt: string,
) {
  await user.type(await screen.findByLabelText("Ask across your vault"), prompt);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

async function startYoutubeDistil(
  user: Awaited<ReturnType<typeof openWorkspace>>["user"],
) {
  const composer = await screen.findByLabelText("Ask across your vault");
  await user.type(composer, "@you");
  await user.click(await screen.findByRole("option", { name: /YouTube distil/u }));
  await user.type(composer, "distil https://youtu.be/jNQXAC9IVRw");
  await user.click(screen.getByRole("button", { name: "Send" }));
}

function expectBefore(left: Element, right: Element) {
  expect(
    left.compareDocumentPosition(right) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).not.toBe(0);
}

const genericTwoCycleScript = (turnId: string): AgentActivityEnvelope[] =>
  envelopeScript(turnId, [
    { payload: { type: "runStarted" } },
    {
      cycleId: "research-cycle",
      payload: {
        type: "cycleStarted",
        round: 1,
        maxRounds: 8,
        playlist: null,
      },
    },
    {
      cycleId: "research-cycle",
      payload: {
        type: "thinking",
        source: "toolTurn",
        delta: "I should inspect the brief and search the vault in parallel.",
      },
    },
    {
      cycleId: "research-cycle",
      payload: {
        type: "cycleSummary",
        source: "model",
        message: "I’ll inspect the project brief and search for related notes.",
        protocolIssues: [],
      },
    },
    {
      cycleId: "research-cycle",
      activityId: "search-notes",
      payload: {
        type: "activityStarted",
        name: "search_notes",
        title: "Search related notes",
        arguments: '{"query":"retrieval design"}',
        stepId: null,
      },
    },
    {
      cycleId: "research-cycle",
      activityId: "read-brief",
      payload: {
        type: "activityStarted",
        name: "read_note_span",
        title: "Read project brief",
        arguments: '{"rel_path":"Projects/Brief.md"}',
        stepId: null,
      },
    },
    {
      cycleId: "research-cycle",
      activityId: "search-notes",
      payload: { type: "activityProgress", message: "Searching related notes…" },
    },
    {
      cycleId: "research-cycle",
      activityId: "read-brief",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "Projects/Brief.md",
        detail: null,
        durationMs: 18,
      },
    },
    {
      cycleId: "research-cycle",
      activityId: "search-notes",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "4 relevant notes",
        detail: null,
        durationMs: 24,
      },
    },
    {
      cycleId: "capture-cycle",
      payload: {
        type: "cycleStarted",
        round: 2,
        maxRounds: 8,
        playlist: null,
      },
    },
    {
      cycleId: "capture-cycle",
      payload: {
        type: "thinking",
        source: "toolTurn",
        delta: "The source material is enough to capture the decision.",
      },
    },
    {
      cycleId: "capture-cycle",
      payload: {
        type: "cycleSummary",
        source: "model",
        message: "I found the supporting material. Next I’ll capture the decision.",
        protocolIssues: [],
      },
    },
    {
      cycleId: "capture-cycle",
      activityId: "write-decision",
      payload: {
        type: "activityStarted",
        name: "write_note",
        title: "Write decision note",
        arguments: '{"rel_path":"Decisions/Retrieval design.md"}',
        stepId: null,
      },
    },
    {
      cycleId: "capture-cycle",
      activityId: "write-decision",
      payload: { type: "activityProgress", message: "Writing the decision note…" },
    },
    {
      cycleId: "capture-cycle",
      activityId: "write-decision",
      payload: {
        type: "noteWritten",
        relPath: "Decisions/Retrieval design.md",
        kind: "atomic",
      },
    },
    {
      cycleId: "capture-cycle",
      activityId: "write-decision",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "Decision captured",
        detail: null,
        durationMs: 31,
      },
    },
    {
      payload: {
        type: "thinking",
        source: "finalAnswer",
        delta: "I should report the completed note without inventing provenance.",
      },
    },
    {
      payload: {
        type: "answer",
        delta: "I captured the retrieval decision in Decisions/Retrieval design.md.",
      },
    },
    { payload: { type: "runCompleted" } },
  ]);

const youtubeJournalScript = (turnId: string): AgentActivityEnvelope[] =>
  envelopeScript(turnId, [
    { payload: { type: "runStarted" } },
    {
      payload: {
        type: "skillActivated",
        id: "youtube-distil",
        name: "YouTube distil",
      },
    },
    {
      payload: {
        type: "plan",
        steps: [
          { id: "captions", label: "Fetch the video captions" },
          { id: "conventions", label: "Inspect vault conventions" },
          { id: "note", label: "Compose the literature note" },
        ],
      },
    },
    {
      cycleId: "captions-cycle",
      payload: {
        type: "cycleStarted",
        round: 1,
        maxRounds: 12,
        playlist: null,
      },
    },
    {
      cycleId: "captions-cycle",
      payload: {
        type: "thinking",
        source: "toolTurn",
        delta: "I need the source captions before I can make a faithful note.",
      },
    },
    {
      cycleId: "captions-cycle",
      payload: {
        type: "cycleSummary",
        source: "model",
        message: "I’ll fetch the captions and confirm their provenance first.",
        protocolIssues: [],
      },
    },
    { payload: { type: "planStepStatus", id: "captions", status: "running" } },
    {
      cycleId: "captions-cycle",
      activityId: "fetch-captions",
      payload: {
        type: "activityStarted",
        name: "fetch_captions",
        title: "Fetch captions",
        arguments: '{"url":"https://youtu.be/jNQXAC9IVRw"}',
        stepId: "captions",
      },
    },
    {
      cycleId: "captions-cycle",
      activityId: "fetch-captions",
      payload: {
        type: "activityProgress",
        message: "Fetching English captions…",
      },
    },
    {
      cycleId: "captions-cycle",
      activityId: "fetch-captions",
      payload: {
        type: "videoPreview",
        videoId: "jNQXAC9IVRw",
        title: "Me at the zoo",
        durationSecs: 19,
        channel: "jawed",
        thumbnailDataUri: null,
      },
    },
    {
      cycleId: "captions-cycle",
      activityId: "fetch-captions",
      payload: {
        type: "transcriptSource",
        label: "captions:en-auto",
        relPath: null,
      },
    },
    {
      cycleId: "captions-cycle",
      activityId: "fetch-captions",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "captions:en-auto",
        detail: null,
        durationMs: 72,
      },
    },
    { payload: { type: "planStepStatus", id: "captions", status: "done" } },
    {
      cycleId: "conventions-cycle",
      payload: {
        type: "cycleStarted",
        round: 2,
        maxRounds: 12,
        playlist: null,
      },
    },
    {
      cycleId: "conventions-cycle",
      payload: {
        type: "thinking",
        source: "toolTurn",
        delta: "The note should follow the vault's existing literature layout.",
      },
    },
    {
      cycleId: "conventions-cycle",
      payload: {
        type: "cycleSummary",
        source: "model",
        message: "I have the captions. Now I’ll inspect the vault’s note conventions.",
        protocolIssues: [],
      },
    },
    {
      payload: { type: "planStepStatus", id: "conventions", status: "running" },
    },
    {
      cycleId: "conventions-cycle",
      activityId: "inspect-conventions",
      payload: {
        type: "activityStarted",
        name: "list_notes",
        title: "Inspect vault conventions",
        arguments: '{"folder":"Literature"}',
        stepId: "conventions",
      },
    },
    {
      cycleId: "conventions-cycle",
      activityId: "inspect-conventions",
      payload: {
        type: "activityProgress",
        message: "Listing literature notes…",
      },
    },
    {
      cycleId: "conventions-cycle",
      activityId: "inspect-conventions",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "Literature notes use source frontmatter",
        detail: null,
        durationMs: 16,
      },
    },
    { payload: { type: "planStepStatus", id: "conventions", status: "done" } },
    {
      cycleId: "note-cycle",
      payload: {
        type: "cycleStarted",
        round: 3,
        maxRounds: 12,
        playlist: null,
      },
    },
    {
      cycleId: "note-cycle",
      payload: {
        type: "thinking",
        source: "toolTurn",
        delta: "I can now compose the note in the established shape.",
      },
    },
    {
      cycleId: "note-cycle",
      payload: {
        type: "cycleSummary",
        source: "model",
        message: "The conventions are clear. I’ll compose and write the literature note.",
        protocolIssues: [],
      },
    },
    { payload: { type: "planStepStatus", id: "note", status: "running" } },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "noteEditPreview",
        relPath: "Literature/Reliable agent interfaces.md",
        kind: "literature",
        body: longYoutubeNote.slice(0, -180),
        complete: false,
      },
    },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "activityStarted",
        name: "write_note",
        title: "Write literature note",
        arguments: '{"rel_path":"Literature/Reliable agent interfaces.md"}',
        stepId: "note",
      },
    },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "activityProgress",
        message: "Composing the literature note…",
      },
    },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "noteEditPreview",
        relPath: "Literature/Reliable agent interfaces.md",
        kind: "literature",
        body: longYoutubeNote,
        complete: true,
      },
    },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "noteWritten",
        relPath: "Literature/Reliable agent interfaces.md",
        kind: "literature",
      },
    },
    {
      cycleId: "note-cycle",
      activityId: "write-youtube-note",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "Literature note written",
        detail: null,
        durationMs: 84,
      },
    },
    { payload: { type: "planStepStatus", id: "note", status: "done" } },
    {
      payload: {
        type: "thinking",
        source: "finalAnswer",
        delta: "I should report the written path and caption provenance plainly.",
      },
    },
    {
      payload: {
        type: "answer",
        delta:
          "Wrote Literature/Reliable agent interfaces.md using captions:en-auto.",
      },
    },
    { payload: { type: "runCompleted" } },
  ]);

const partialSiblingFailureScript = (turnId: string): AgentActivityEnvelope[] =>
  envelopeScript(turnId, [
    { payload: { type: "runStarted" } },
    {
      cycleId: "parallel-cycle",
      payload: {
        type: "cycleStarted",
        round: 7,
        maxRounds: 20,
        playlist: null,
      },
    },
    {
      cycleId: "parallel-cycle",
      payload: {
        type: "cycleSummary",
        source: "fallback",
        message: "Continuing with the next step.",
        protocolIssues: [{ kind: "missing" }],
      },
    },
    {
      cycleId: "parallel-cycle",
      activityId: "healthy-sibling",
      payload: {
        type: "activityStarted",
        name: "read_note_span",
        title: "Read the retained source",
        arguments: '{"rel_path":"Sources/Retained.md"}',
        stepId: null,
      },
    },
    {
      cycleId: "parallel-cycle",
      activityId: "failed-sibling",
      payload: {
        type: "activityStarted",
        name: "fetch_captions",
        title: "Fetch secondary captions",
        arguments: '{"url":"https://youtu.be/unavailable"}',
        stepId: null,
      },
    },
    {
      cycleId: "parallel-cycle",
      activityId: "failed-sibling",
      payload: {
        type: "activitySettled",
        status: "error",
        summary: null,
        detail: "The caption service timed out.",
        durationMs: 40,
      },
    },
    {
      cycleId: "parallel-cycle",
      activityId: "healthy-sibling",
      payload: {
        type: "activitySettled",
        status: "ok",
        summary: "Sources/Retained.md",
        detail: null,
        durationMs: 44,
      },
    },
    {
      payload: {
        type: "partialRun",
        reason: "one parallel source could not be fetched",
      },
    },
    {
      payload: {
        type: "answer",
        delta: "I kept the source I could verify and reported the caption failure.",
      },
    },
    { payload: { type: "runCompleted" } },
  ]);

describe("Agent activity journal over mock IPC", () => {
  it("keeps two cycles causal and replaces the one live action line", async () => {
    const { user, advanceNextFrame, advanceAllFrames } = await openWorkspace({
      activityScriptFactory: genericTwoCycleScript,
    });

    await ask(user, "Research the retrieval decision and capture it");
    for (let index = 0; index < 6; index += 1) {
      expect(await advanceNextFrame()).toBe(true);
    }

    const firstSummary = screen.getByText(
      "I’ll inspect the project brief and search for related notes.",
    );
    const turn = firstSummary.closest('[class~="@container"]');
    expect(turn).not.toBeNull();
    const liveStatus = within(turn as HTMLElement).getByRole("status");
    expect(liveStatus).toHaveTextContent("Read project brief");
    expect(liveStatus).toHaveTextContent("+1 running");

    expect(await advanceNextFrame()).toBe(true);
    expect(liveStatus).toHaveTextContent("Searching related notes…");
    expect(liveStatus).toHaveTextContent("+1 running");

    await advanceAllFrames();

    const finalTurn = firstSummary.closest('[class~="@container"]') as HTMLElement;
    const thinking = within(finalTurn).getAllByText("Thinking", {
      selector: "summary",
    });
    const actions = within(finalTurn).getAllByText(/^Actions \(/u, {
      selector: "summary",
    });
    const secondSummary = within(finalTurn).getByText(
      "I found the supporting material. Next I’ll capture the decision.",
    );
    const answer = within(finalTurn).getByText(
      /I captured the retrieval decision in Decisions\/Retrieval design\.md\./u,
    );

    expect(thinking).toHaveLength(3);
    expect(actions).toHaveLength(2);
    expect(actions[0]).toHaveTextContent("Actions (2)");
    expect(actions[1]).toHaveTextContent("Actions (1)");
    expectBefore(thinking[0], firstSummary);
    expectBefore(firstSummary, actions[0]);
    expectBefore(actions[0], thinking[1]);
    expectBefore(thinking[1], secondSummary);
    expectBefore(secondSummary, actions[1]);
    expectBefore(actions[1], thinking[2]);
    expectBefore(thinking[2], answer);
    expect(finalTurn).not.toHaveTextContent(
      /\b(?:Reasoning|round\s+\d+|cycle\s+\d+)\b/iu,
    );

    await user.click(actions[0]);
    expect(within(finalTurn).getByText("Search related notes")).toBeInTheDocument();
    expect(within(finalTurn).getByText("Read project brief")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
    expect(screen.queryByRole("button", { name: "Stop response" })).toBeNull();
  });

  it("keeps a long YouTube note and full plan bounded until the written outcome", async () => {
    const { user, advanceNextFrame, advanceAllFrames } = await openWorkspace({
      skills: [youtubeSkill],
      activityScriptFactory: youtubeJournalScript,
    });

    await startYoutubeDistil(user);
    for (let guard = 0; guard < 30; guard += 1) {
      if (screen.queryByRole("region", { name: "Note draft content" }) !== null) {
        break;
      }
      expect(await advanceNextFrame()).toBe(true);
    }

    const viewport = screen.getByRole("region", { name: "Note draft content" });
    expect(viewport).toHaveClass("h-52", "min-h-52", "max-h-52", "overflow-y-auto");
    expect(viewport).toHaveTextContent("Reliable agent interfaces");
    expect(viewport).toHaveTextContent("Point 35");

    const plan = screen.getByRole("region", { name: "Task plan" });
    const planRows = within(plan).getAllByRole("listitem");
    expect(planRows).toHaveLength(3);
    expect(planRows[0]).toHaveTextContent("DoneFetch the video captions");
    expect(planRows[1]).toHaveTextContent("DoneInspect vault conventions");
    expect(planRows[2]).toHaveTextContent("In progressCompose the literature note");

    const chatPane = screen.getByText("Neural Assistant AI").closest("aside");
    expect(chatPane).not.toBeNull();
    expect(await advanceNextFrame()).toBe(true);
    expect(screen.getByRole("region", { name: "Note draft content" })).toBe(viewport);
    expect(within(chatPane as HTMLElement).getAllByRole("status")).toHaveLength(1);
    expect(within(chatPane as HTMLElement).getByRole("status"))
      .toHaveTextContent("Write literature note");
    expect(await advanceNextFrame()).toBe(true);
    expect(within(chatPane as HTMLElement).getAllByRole("status")).toHaveLength(1);
    expect(within(chatPane as HTMLElement).getByRole("status")).toHaveTextContent(
      "Composing the literature note…",
    );

    await advanceAllFrames();

    const answer = await screen.findByText(
      /Wrote Literature\/Reliable agent interfaces\.md using captions:en-auto\./u,
    );
    const turn = answer.closest('[class~="@container"]') as HTMLElement;
    expect(within(turn).getAllByText("Thinking", { selector: "summary" })).toHaveLength(4);
    expect(turn).not.toHaveTextContent(
      /\b(?:Reasoning|round\s+\d+|cycle\s+\d+)\b/iu,
    );
    expect(screen.queryByRole("region", { name: "Note draft content" })).toBeNull();
    expect(within(turn).getByText("Plan · 3 of 3 done", { selector: "summary" }))
      .toBeInTheDocument();
    expect(within(turn).getByText("1 note written")).toBeInTheDocument();
    expect(
      within(turn).getByRole("button", {
        name: "Open Literature/Reliable agent interfaces.md",
      }),
    ).toBeInTheDocument();

    const firstActions = within(turn).getAllByText(/^Actions \(/u, {
      selector: "summary",
    })[0];
    const firstAudit = firstActions.closest("details");
    expect(firstAudit).not.toBeNull();
    await user.click(firstActions);
    expect(within(firstAudit as HTMLElement).getByText("Fetch captions"))
      .toBeInTheDocument();
    expect(within(firstAudit as HTMLElement).getByText("captions:en-auto"))
      .toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });

  it("keeps a successful sibling beside a failed one when no reasoning was returned", async () => {
    const { user, advanceAllFrames } = await openWorkspace({
      activityScriptFactory: partialSiblingFailureScript,
    });

    await ask(user, "Check both sources");
    await advanceAllFrames();

    const summary = await screen.findByText("Continuing with the next step.");
    const turn = summary.closest('[class~="@container"]') as HTMLElement;
    expect(within(turn).queryByText("Thinking", { selector: "summary" })).toBeNull();
    expect(turn).not.toHaveTextContent(
      /\b(?:Reasoning|round\s+\d+|cycle\s+\d+)\b/iu,
    );
    expect(within(turn).getByText(/Run ended early: one parallel source/u))
      .toBeInTheDocument();
    expect(
      within(turn).getByText(
        "I kept the source I could verify and reported the caption failure.",
      ),
    ).toBeInTheDocument();

    const auditSummary = within(turn).getByText(/^Actions \(/u, {
      selector: "summary",
    });
    expect(auditSummary).toHaveTextContent(/Actions \(2\)\s*· 1 failed/u);
    await user.click(auditSummary);
    const audit = auditSummary.closest("details") as HTMLElement;
    expect(within(audit).getByText("Read the retained source")).toBeInTheDocument();
    expect(within(audit).getByText("Fetch secondary captions")).toBeInTheDocument();
    expect(within(audit).getByText("The caption service timed out."))
      .toBeInTheDocument();
    expect(within(audit).getByText("Cycle summary was missing."))
      .toBeInTheDocument();
    expect(within(turn).queryByRole("status")).toBeNull();
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });
});
