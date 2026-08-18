// What the NEXT request is allowed to carry: the prior conversation as plain
// turns, the host-authored continuation record beside it, and the three things
// that deliberately never travel — stale citation markers, provider prose, and
// the turn's reasoning.

import { describe, expect, it } from "vitest";
import { emptyAssistant, userMessage, type ChatMessage } from "./chatMessage";
import { stripCitationMarkers, toHistory } from "./chatHistory";

describe("toHistory", () => {
  it("maps turns to ChatTurns and preserves an answerless failure as status", () => {
    const messages: ChatMessage[] = [
      userMessage("what is spacing?"),
      { ...emptyAssistant(), answer: "It's spacing.", done: true },
      userMessage("and recall?"),
      { ...emptyAssistant(), error: "boom", done: true }, // errored, no answer
    ];
    expect(toHistory(messages)).toEqual([
      { role: "user", content: "what is spacing?" },
      { role: "assistant", content: "It's spacing." },
      { role: "user", content: "and recall?" },
      {
        role: "assistant",
        content: [
          "NeuralNote continuation record:",
          "The run failed before producing a final answer.",
          "Use this status when responding to the next turn.",
        ].join("\n"),
      },
    ]);
  });

  it("windows history to the most recent turns so it can't grow unbounded (PA-003)", () => {
    // 60 non-empty turns in → only the last 20 come out, and they're the newest.
    const messages: ChatMessage[] = Array.from({ length: 30 }, (_, i) => [
      userMessage(`q${i}`),
      { ...emptyAssistant(), answer: `a${i}`, done: true } as ChatMessage,
    ]).flat();
    const history = toHistory(messages);
    expect(history).toHaveLength(20);
    // The window keeps the tail: last entry is the final assistant answer.
    expect(history.at(-1)).toEqual({ role: "assistant", content: "a29" });
    expect(history[0]).toEqual({ role: "user", content: "q20" });
  });

  it("strips [eN] markers from assistant answers so stale ids can't re-enter (SUS-1)", () => {
    // Evidence ids reset per run, so a turn-1 marker means nothing in turn 2 — and
    // could collide with an unrelated new span. History must carry the prose, not the ids.
    const messages: ChatMessage[] = [
      userMessage("q"),
      { ...emptyAssistant(), answer: "Spacing is 8px [e1] and grids use it [e2].", done: true },
    ];
    expect(toHistory(messages)).toEqual([
      { role: "user", content: "q" },
      { role: "assistant", content: "Spacing is 8px and grids use it." },
    ]);
  });

  it("preserves durable progress when a failed run produced no prose answer", () => {
    const failed = {
      ...emptyAssistant(),
      done: true,
      error: "the model returned an empty answer",
      writtenNotes: [
        { relPath: "Areas/OpSec/Reference/Literature.md", kind: "literature" as const },
        { relPath: "Areas/OpSec/Reference/Transcript.md", kind: "transcript" as const },
      ],
      planSteps: [
        { id: "collect", label: "Collect the source", status: "done" as const },
        { id: "write", label: "Write the remaining note", status: "running" as const },
      ],
      partialRun: "the run reached a work limit before finishing",
    };

    const history = toHistory([userMessage("Distil this video"), failed]);

    expect(history).toEqual([
      { role: "user", content: "Distil this video" },
      {
        role: "assistant",
        content: [
          "NeuralNote continuation record:",
          "Completed note writes:",
          "- Areas/OpSec/Reference/Literature.md (literature)",
          "- Areas/OpSec/Reference/Transcript.md (transcript)",
          "Plan state:",
          "- [done] Collect the source",
          "- [running] Write the remaining note",
          "Run ended early: the run reached a work limit before finishing",
          "The final answer failed after the recorded work.",
          "Continue from this record without repeating completed note writes.",
        ].join("\n"),
      },
    ]);
    expect(history[1].content).not.toContain("the model returned an empty answer");
  });

  it("flattens and bounds model-authored plan labels in continuation history", () => {
    const failed = {
      ...emptyAssistant(),
      done: true,
      error: "provider failed",
      planSteps: [
        {
          id: "hostile",
          label: `Keep context\n${"x".repeat(2_000)}`,
          status: "running" as const,
        },
      ],
    };

    const history = toHistory([userMessage("continue"), failed]);
    const content = history[1].content;

    expect(content.split("\n")).toHaveLength(5);
    expect(Array.from(content).length).toBeLessThan(500);
    expect(content).toContain("- [running] Keep context ");
    expect(content).toContain("…\nThe final answer failed after the recorded work.");
  });

  // Reasoning is LIVE-ONLY. Planning rounds reason out loud now, so a turn can
  // hold thousands of reasoning characters — none of which the model may ever be
  // shown again. Today `assistantHistoryContent` holds that by never reading
  // `thinking`, which nothing would notice if it stopped being true. These two
  // are what notices.
  it("never returns a turn's reasoning to the model, even when nothing else was said", () => {
    const reasoning = "The user wants two things; let me search the vault first.";
    const history = toHistory([
      userMessage("what is spacing?"),
      { ...emptyAssistant(), thinking: reasoning, answer: "", done: true },
    ]);

    expect(history).toEqual([{ role: "user", content: "what is spacing?" }]);
  });

  it("sends the answer and the continuation record, never the reasoning beside them", () => {
    const reasoning = "Round 3: the transcript note is already written, so skip it.";
    const history = toHistory([
      userMessage("distil this"),
      {
        ...emptyAssistant(),
        thinking: reasoning,
        answer: "Done — the note is in Literature.",
        done: true,
        writtenNotes: [{ relPath: "Literature/One.md", kind: "literature" as const }],
      },
    ]);

    expect(history[1].content).toContain("Done — the note is in Literature.");
    expect(history[1].content).toContain("Completed note writes:");
    // Both branches of the history content, one assertion: whatever it built,
    // the reasoning is not in it.
    expect(history.map((turn) => turn.content).join("\n")).not.toContain(reasoning);
  });
});

describe("stripCitationMarkers", () => {
  it("removes every [eN] marker (verified or not) with its leading space", () => {
    expect(stripCitationMarkers("A [e1] and B [e9].")).toBe("A and B.");
  });

  it("matches uppercase markers, mirroring the Rust extractor's case-folding", () => {
    expect(stripCitationMarkers("A [E1] then [e2]!")).toBe("A then!");
  });

  it("leaves marker-free text untouched", () => {
    expect(stripCitationMarkers("No citations here.")).toBe("No citations here.");
  });
});
