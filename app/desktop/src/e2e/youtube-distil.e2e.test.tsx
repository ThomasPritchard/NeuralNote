// Slice 5 journeys through the real React tree and mockIPC seam. These scripts
// mirror the shell/core event contract: every failure is visible, elicitation
// parks the chat invoke, and only validated choices resume it.

import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import type { ChatEvent, SkillListing } from "../lib/types";
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

const pixel =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function openWorkspace(opts: CreateMockVaultOptions) {
  const result = renderApp({ recents, skills: [youtubeSkill], ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Neural Assistant AI");
  return result;
}

async function startDistil(
  user: Awaited<ReturnType<typeof openWorkspace>>["user"],
  prompt: string,
) {
  const composer = await screen.findByLabelText("Ask across your vault");
  await user.type(composer, "@you");
  await user.click(await screen.findByRole("option", { name: /YouTube distil/ }));
  await user.type(composer, prompt);
  await user.click(screen.getByRole("button", { name: "Send" }));
}

describe("Journey 9: YouTube distil failures and fallbacks", () => {
  it("installs a first-use yt-dlp requirement from the failed skill turn", async () => {
    const missingRequirement =
      "Skill 'youtube-distil' could not be activated: skill 'youtube-distil' is not eligible: unmet requirements: required binary 'yt-dlp' is missing from the app-data bin directory — continuing without it";
    const script: ChatEvent[] = [
      { type: "skillStep", message: missingRequirement },
      { type: "done" },
    ];
    const { user, backend } = await openWorkspace({
      chatScript: script,
      requirementDownloadScript: [
        {
          type: "progress",
          status: "Downloading verified yt-dlp…",
          digest: null,
          completed: 40,
          total: 100,
          percent: 40,
        },
        { type: "success" },
      ],
    });

    await startDistil(user, "distil https://youtu.be/jNQXAC9IVRw");

    const card = await screen.findByRole("region", { name: "Set up YouTube imports" });
    await user.click(within(card).getByRole("button", { name: "Download yt-dlp" }));
    expect(await within(card).findByText("Downloading verified yt-dlp…")).toBeInTheDocument();
    expect(within(card).getByRole("progressbar", { name: "Downloading yt-dlp" })).toHaveValue(40);
    expect(await within(card).findByText(/yt-dlp is ready/i)).toBeInTheDocument();
    expect(backend.calls).toContain("download_requirement");
  });

  it("surfaces a caption 403 as terminal and never offers Whisper", async () => {
    const script: ChatEvent[] = [
      { type: "skillActivated", id: "youtube-distil", name: "YouTube distil" },
      { type: "skillStep", message: "Fetching English captions…" },
      {
        type: "error",
        message:
          "YouTube is blocking caption downloads right now (HTTP 403). Try again later; yt-dlp updates automatically. Whisper was not started.",
      },
    ];
    const { user } = await openWorkspace({ chatScript: script });

    await startDistil(user, "distil https://youtu.be/jNQXAC9IVRw");

    expect(await screen.findByRole("alert")).toHaveTextContent("HTTP 403");
    expect(screen.getByRole("alert")).toHaveTextContent("Try again later");
    expect(screen.queryByRole("button", { name: /Whisper|compile/i })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByLabelText("Ask across your vault")).toBeEnabled(),
    );
  });

  it("offers honest first-time Whisper setup only after genuine caption absence", async () => {
    const script: ChatEvent[] = [
      { type: "skillActivated", id: "youtube-distil", name: "YouTube distil" },
      { type: "skillStep", message: "No human or automatic captions were found." },
      {
        type: "elicit",
        id: "whisper-offer",
        question:
          "Set up local Whisper? NeuralNote compiles whisper-cli locally from pinned source; first-time setup can take several minutes. Transcription also takes minutes, not seconds.",
        options: [
          {
            id: "continue",
            label: "Compile and transcribe",
            description: "Installs the verified source build and small.en model.",
            imageDataUri: null,
          },
          { id: "cancel", label: "Not now", description: null, imageDataUri: null },
        ],
        multiSelect: false,
      },
      { type: "skillStep", message: "Compiling whisper-cli locally…" },
      { type: "skillStep", message: "Transcribing locally with whisper:small.en…" },
      { type: "noteWritten", relPath: "Transcripts/Quiet talk transcript.md", kind: "transcript" },
      { type: "answer", delta: "Transcript provenance: whisper:small.en." },
      {
        type: "citation",
        id: "e1",
        relPath: "Transcripts/Quiet talk transcript.md",
        startLine: 9,
        endLine: 9,
        text: "[00:02:03](https://youtu.be/jNQXAC9IVRw?t=123) A cited moment.",
      },
      { type: "done" },
    ];
    const { user, backend } = await openWorkspace({ chatScript: script });

    await startDistil(user, "distil the quiet talk");

    expect(await screen.findByText(/compiles whisper-cli locally from pinned source/i)).toBeInTheDocument();
    expect(screen.getByText(/first-time setup can take several minutes/i)).toBeInTheDocument();
    expect(screen.getByText(/Transcription also takes minutes, not seconds/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Compile and transcribe/ }));

    expect(await screen.findByText("Compiling whisper-cli locally…")).toBeInTheDocument();
    expect(await screen.findByText(/Transcribing locally with whisper:small\.en/)).toBeInTheDocument();
    expect(await screen.findByText("Model-reported provenance")).toBeInTheDocument();
    expect(screen.queryByText("Transcript provenance")).not.toBeInTheDocument();
    expect(screen.getByText("whisper:small.en")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Watch at 02:03 on YouTube" }));
    expect(backend.openedYoutubeUrls).toEqual([
      "https://youtu.be/jNQXAC9IVRw?t=123",
    ]);
    expect(backend.calls.filter((call) => call === "answer_elicitation")).toHaveLength(1);
  });
});

describe("Journey 10: YouTube playlist selection", () => {
  it("warns only after 21 selections, then cancels mid-run with a partial report", async () => {
    const options = Array.from({ length: 21 }, (_, index) => ({
      id: `video-${String(index + 1).padStart(4, "0")}`,
      label: `Agent talk ${index + 1}`,
      description: `${12 + index}:00`,
      imageDataUri: index < 2 ? pixel : null,
    }));
    const script: ChatEvent[] = [
      { type: "skillActivated", id: "youtube-distil", name: "YouTube distil" },
      {
        type: "elicit",
        id: "playlist-page-1",
        question: "Choose videos from 'Agent talks' (page 1 of 1).",
        options,
        multiSelect: true,
      },
      {
        type: "elicit",
        id: "playlist-high-usage",
        question:
          "You selected 21 videos. Are you sure? This can incur high usage. Rough estimate: 189,000 input tokens, about £0.57. Method: selected duration × 150 spoken words/minute.",
        options: [
          { id: "continue", label: "Continue", description: "Process sequentially.", imageDataUri: null },
          { id: "cancel", label: "Cancel", description: null, imageDataUri: null },
        ],
        multiSelect: false,
      },
      { type: "skillStep", message: "Video 1 of 21: Agent talk 1 — captions:en-auto" },
      { type: "noteWritten", relPath: "Literature/Agent talk 1.md", kind: "literature" },
      { type: "noteWritten", relPath: "Transcripts/Agent talk 1 transcript.md", kind: "transcript" },
    ];
    const { user, backend } = await openWorkspace({
      chatScript: script,
      cancelChatAfterEvents: 6,
      cancelChatTail: [
        { type: "skillStep", message: "Cancelled after video 1 of 21." },
        {
          type: "answer",
          delta:
            "The playlist was cancelled. Kept the completed video with captions:en-auto provenance.",
        },
        { type: "done" },
      ],
    });

    await startDistil(user, "distil the Agent talks playlist");

    expect(await screen.findByText("0 selected on this page")).toBeInTheDocument();
    expect(document.querySelectorAll('img[src^="data:image/png"]').length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Select page" }));
    expect(screen.getByText("21 selected on this page")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Confirm selection" }));

    expect(await screen.findByText(/You selected 21 videos/)).toBeInTheDocument();
    expect(screen.getByText(/189,000 input tokens/)).toBeInTheDocument();
    expect(screen.getByText(/Method: selected duration/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Continue/ }));

    expect(await screen.findByText(/Video 1 of 21/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Stop response" }));

    expect(await screen.findByText("Model-reported partial run")).toBeInTheDocument();
    expect(screen.getByText("Stopped")).toBeInTheDocument();
    expect(
      screen.getByText(/The model reports that 2 notes were kept before the run stopped/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/The playlist was cancelled\. Kept the completed video/),
    ).not.toBeInTheDocument();
    expect(screen.getByText("captions:en-auto")).toBeInTheDocument();
    expect(screen.getByText("Agent talk 1.md")).toBeInTheDocument();
    expect(screen.queryByText("Agent talk 2.md")).not.toBeInTheDocument();
    expect(backend.calls.filter((call) => call === "answer_elicitation")).toHaveLength(2);
    expect(backend.calls.filter((call) => call === "cancel_chat_run")).toHaveLength(1);
  });
});

describe("Journey 11: unknown vault routing", () => {
  it("uses the folder picker once and persists the selected route in the vault profile", async () => {
    const script: ChatEvent[] = [
      { type: "skillActivated", id: "youtube-distil", name: "YouTube distil" },
      { type: "skillStep", message: "I couldn't confidently identify this vault's organising scheme." },
      {
        type: "elicit",
        id: "youtube-route-folder",
        question: "Where should YouTube literature notes go in this vault?",
        options: [
          { id: "Inbox", label: "Inbox", description: "4 notes", imageDataUri: null },
          { id: "Research/AI", label: "Research / AI", description: "18 notes", imageDataUri: null },
        ],
        multiSelect: false,
      },
      { type: "skillStep", message: "Saved Research/AI to .neuralnote/profile.json." },
      { type: "answer", delta: "I'll use Research/AI for this vault from now on." },
      { type: "done" },
    ];
    const { user, backend } = await openWorkspace({
      chatScript: script,
      profileFolderElicitationId: "youtube-route-folder",
    });

    await startDistil(user, "distil this into my unknown vault");
    expect(await screen.findByText(/couldn't confidently identify/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Research \/ AI/ }));

    expect(await screen.findByText(/Saved Research\/AI to \.neuralnote\/profile\.json/)).toBeInTheDocument();
    expect(backend.profileFolder).toBe("Research/AI");
  });
});
