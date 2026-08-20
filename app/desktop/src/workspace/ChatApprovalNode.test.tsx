// The approval gate's rail nodes: the five states of §9.5.1, the four ways a
// request can settle without the call running, and the two rules the rail has to
// hold whatever else changes —
//
//   • `checking` is never terminal, and never wears the warning tone or the ping.
//   • Nothing the gate did that the user could act on hides behind a fold.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ApprovalResolution, ApprovalRule } from "../lib/types";
import { ApprovalDegradedNode, ToolApprovalNode } from "./ChatApprovalNode";
import { ChatTimeline } from "./ChatTimeline";
import { emptyAssistant, type ToolApprovalView, type ToolCallView } from "./chatMessage";

function approval(patch: Partial<ToolApprovalView> = {}): ToolApprovalView {
  return {
    id: "call-1",
    tool: "writeNote",
    relPath: "Atomic/Spaced recall.md",
    reason: "modeAlwaysAsk",
    expiresInSecs: 120,
    checking: false,
    resolution: null,
    autoApprovedRule: null,
    ...patch,
  };
}

function renderNode(view: ToolApprovalView) {
  return render(
    <ol>
      <ToolApprovalNode approval={view} last />
    </ol>,
  );
}

/** The node's own `<li>`, so a tone assertion cannot pick up a sibling. */
function node(): HTMLElement {
  return screen.getByRole("listitem");
}

describe("the approval node's five states", () => {
  it("says it is checking, without the warning tone and without the ping", () => {
    const { container } = renderNode(approval({ checking: true }));

    expect(node()).toHaveTextContent("Checking this action…");
    // The whole reason this state is quiet: a pane that pings three times a
    // turn for something you cannot act on trains you to ignore the one ping
    // that matters.
    expect(container.querySelector(".animate-ping")).toBeNull();
    expect(container.querySelector(".text-warning")).toBeNull();
    // Motion without alarm — the glyph breathes so the pause is not mistaken
    // for a hang.
    expect(container.querySelector(".animate-pulse")).not.toBeNull();
  });

  it("is the only state that pings while it waits on the user", () => {
    const { container } = renderNode(approval());

    expect(node()).toHaveTextContent("Waiting for your approval");
    expect(container.querySelector(".animate-ping")).not.toBeNull();
    expect(container.querySelector(".text-warning")).not.toBeNull();
  });

  it.each<[ApprovalRule, string]>([
    ["yolo", "Approved automatically (YOLO)"],
    ["newNoteInVault", "Approved automatically (new note in your vault)"],
    ["cachedAllow", "Approved automatically (same as one you already allowed)"],
  ])("records an automatic approval under rule %s", (rule, line) => {
    // YOLO skips the prompt, never the record. A skipped prompt that leaves no
    // trace is the failure the visibility clause exists to prevent.
    renderNode(approval({ resolution: "approved", autoApprovedRule: rule }));

    expect(node()).toHaveTextContent(line);
  });

  it("credits the user when the user is the one who approved it", () => {
    // No rule means nobody decided for them. Telling someone the app approved
    // something they approved themselves is the same false account as the four
    // refusals collapsing into one.
    renderNode(approval({ resolution: "approved", autoApprovedRule: null }));

    expect(node()).toHaveTextContent("You allowed this");
    expect(node()).not.toHaveTextContent("automatically");
  });

  it("reports automatic checking switching off for the rest of the turn", () => {
    render(
      <ol>
        <ApprovalDegradedNode reason="providerUnsupported" last />
      </ol>,
    );

    expect(node()).toHaveTextContent(
      "Automatic checking is off for the rest of this turn — this provider cannot run it.",
    );
  });

  it("names the failure when the judge is the thing that gave up", () => {
    render(
      <ol>
        <ApprovalDegradedNode reason="judgeUnreliable" last />
      </ol>,
    );

    expect(node()).toHaveTextContent("it failed twice");
  });

  it("never leaves checking as the terminal state", () => {
    // A resolution that lands while the stale `checking` flag is still set must
    // settle the node. Reading the flag first is exactly how `checking` becomes
    // terminal, which §9.5.1 forbids.
    renderNode(approval({ checking: true, resolution: "denied" }));

    expect(node()).toHaveTextContent("You said no. Nothing ran.");
    expect(node()).not.toHaveTextContent("Checking this action");
  });

  it("shows the human the real path, not the digest the judge was given", () => {
    renderNode(approval());

    expect(node()).toHaveTextContent("Atomic/Spaced recall.md");
  });

  it("names the tool in plain language, never its identifier", () => {
    renderNode(approval({ tool: "resolveDistilRoute" }));

    expect(node()).toHaveTextContent("Saving how it files your notes");
    expect(node()?.textContent ?? "").not.toMatch(/resolve_distil_route|resolveDistilRoute/);
  });
});

describe("the four ways a request settles without the call running", () => {
  // Each names the party responsible. Collapsing them told users they had denied
  // something they never saw, which is the one account that is definitely false.
  it.each<[Exclude<ApprovalResolution, "approved">, string]>([
    ["denied", "You said no. Nothing ran."],
    ["timedOut", "Nobody answered in time. Nothing ran."],
    ["cancelled", "The run ended before this was answered. Nothing ran."],
    ["unavailable", "Automatic checking could not answer — asking you instead."],
  ])("reads %s as its own account", (resolution, line) => {
    renderNode(approval({ resolution }));

    expect(node()).toHaveTextContent(line);
  });

  it("gives all four different wording", () => {
    const lines = (["denied", "timedOut", "cancelled", "unavailable"] as const).map(
      (resolution) => {
        const view = render(
          <ol>
            <ToolApprovalNode approval={approval({ resolution })} last />
          </ol>,
        );
        const text = view.container.textContent ?? "";
        view.unmount();
        return text;
      },
    );

    expect(new Set(lines).size).toBe(4);
  });

  it("keeps a cancelled run out of the warning register", () => {
    // Nobody refused anything — the run simply went away underneath the
    // question, so blaming someone for it with a warning colour would be wrong.
    const { container } = renderNode(approval({ resolution: "cancelled" }));

    expect(container.querySelector(".text-warning")).toBeNull();
  });
});

// ── On the rail ──────────────────────────────────────────────────────────────

function call(patch: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
    name: "write_note",
    title: "Write note",
    arguments: '{"rel_path":"Atomic/Spaced recall.md"}',
    status: null,
    summary: null,
    detail: null,
    stepId: null,
    ...patch,
  };
}

function renderTimeline(turn: ReturnType<typeof emptyAssistant>, answering = false) {
  return render(
    <ChatTimeline turn={turn} answering={answering} suppressLive={false} />,
  );
}

describe("the approval node on the timeline rail", () => {
  it("sits directly above the call it decided", () => {
    renderTimeline({
      ...emptyAssistant(),
      toolCalls: [call()],
      toolApprovals: [approval({ resolution: "approved", autoApprovedRule: "yolo" })],
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Approved automatically (YOLO)");
    expect(rows[1]).toHaveTextContent("Write note");
  });

  it("keeps the approval node when the tool node stands down for a write card", () => {
    // A previewed write hands its node to `ChatNoteEditCard`, which carries no
    // account of the approval — so the approval node must not stand down with it.
    renderTimeline({
      ...emptyAssistant(),
      toolCalls: [call()],
      noteEdits: [
        {
          id: "call-1",
          relPath: "Atomic/Spaced recall.md",
          kind: "atomic",
          body: "line\n",
          complete: true,
          abandoned: null,
        },
      ],
      toolApprovals: [approval({ resolution: "denied" })],
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent("You said no. Nothing ran.");
  });

  it("opens the fold rather than hiding a request the user has to answer", () => {
    // `answering` normally folds the whole process away. A live security prompt
    // must never be one collapsed disclosure out of sight.
    const { container } = renderTimeline(
      {
        ...emptyAssistant(),
        answer: "Streaming…",
        toolCalls: [call()],
        toolApprovals: [approval()],
      },
      true,
    );

    expect(container.querySelector("details")).toHaveAttribute("open");
  });

  it("lets the fold close once every gated call settled automatically", () => {
    const { container } = renderTimeline(
      {
        ...emptyAssistant(),
        answer: "Streaming…",
        activity: [
          { kind: "search", query: "recall" },
          { kind: "reading", relPath: "A.md", startLine: 1, endLine: 4 },
        ],
        toolCalls: [call({ status: "ok" })],
        toolApprovals: [approval({ resolution: "approved", autoApprovedRule: "yolo" })],
      },
      true,
    );

    expect(container.querySelector("details")).not.toHaveAttribute("open");
  });

  it("reports a denied call as one that never ran, not one that failed", () => {
    renderTimeline(
      {
        ...emptyAssistant(),
        done: true,
        answer: "Streaming…",
        toolCalls: [call({ status: "denied" })],
        toolApprovals: [approval({ resolution: "denied" })],
      },
      true,
    );

    const summary = screen.getByRole("group").querySelector("summary");
    expect(summary).not.toBeNull();
    expect(within(summary!).getByText(/never ran/)).toBeInTheDocument();
    expect(summary?.textContent ?? "").not.toMatch(/failed/);
  });

  it("puts the degraded notice ahead of the prompts it explains", () => {
    renderTimeline({
      ...emptyAssistant(),
      approvalDegraded: "providerUnsupported",
      toolCalls: [call()],
      toolApprovals: [approval()],
    });

    const rows = screen.getAllByRole("listitem");
    expect(rows[0]).toHaveTextContent("Automatic checking is off");
    expect(rows[1]).toHaveTextContent("Waiting for your approval");
  });
});
