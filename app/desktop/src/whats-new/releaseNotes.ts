import packageJson from "../../package.json";

export interface ReleaseNotesGroup {
  readonly title: string;
  readonly items: readonly string[];
}

export interface ReleaseNotes {
  readonly version: string;
  readonly title: string;
  readonly introduction: string;
  readonly groups: readonly ReleaseNotesGroup[];
}

const RELEASE_NOTES: Readonly<Record<string, ReleaseNotes>> = {
  "0.2.1": {
    version: "0.2.1",
    title: "What's new in NeuralNote 0.2.1",
    introduction:
      "NeuralNote 0.2.1 is a reliability and polish release. Search reaches more of your vault, open notes stay in step with changes made outside the app, the assistant is more honest about cut-off answers and evidence, and keyboard and screen-reader access improve. The vault format and your saved settings are unchanged.",
    groups: [
      {
        title: "Editing and search",
        items: [
          "Search now covers plain-text notes, so a .txt or .text file is found and cited on the exact line the reader shows.",
          "Vault search matches accented and non-Latin text consistently, using full Unicode-aware case folding.",
          "Notes saved in non-UTF-8 encodings read and search the same way, with no mismatch between the reader and search results.",
          "Open notes reload safely when their file changes outside NeuralNote, keeping your place instead of showing stale text.",
          "Fixes to the Markdown source editor correct rendering and interaction glitches during live-preview editing.",
        ],
      },
      {
        title: "Neural Assistant AI",
        items: [
          "When a provider stops an answer at its length limit, NeuralNote now flags the answer as truncated instead of presenting it as complete.",
          "Cited answers stay trustworthy: reused note text is re-verified before it is cited, so a stale span is dropped rather than attributed to the wrong line.",
          "A citation's supporting evidence widens automatically when a later step needs more surrounding context.",
          "The local AI option is now clearly labelled best-effort for citation fidelity, and points you to the API-key path when reliable citations matter most.",
          "Transient failures in the assistant's tool steps retry with a short backoff instead of surfacing as an error.",
        ],
      },
      {
        title: "Accessibility and interface",
        items: [
          "File-tree entries gain a keyboard-accessible Move to action, so notes can be reorganised without a pointer.",
          "Settings pages, the pane splitter, the ribbon, and the title bar expose clearer, more semantic roles to screen readers.",
          "The title bar's drag region is hit-tested accurately, so window dragging responds where you expect.",
        ],
      },
      {
        title: "Reliability and release readiness",
        items: [
          "Undo history recovers cleanly after an unexpected shutdown, restoring quarantined entries instead of losing them.",
          "Undo records resolve to the latest write for a note, so a stale entry can never authorise deleting newer content.",
          "Local-model downloads check free disk space first and report accurate overall progress across multi-part model pulls.",
          "Vault paths are validated through one stricter, shared check, closing edge cases around unusual path components.",
          "Application packages, updater checks, and the upgrade journey are aligned on version 0.2.1.",
        ],
      },
    ],
  },
};

function releaseNotesFor(version: string): ReleaseNotes {
  const notes = RELEASE_NOTES[version];
  if (!notes) {
    throw new Error(`No bundled release notes exist for NeuralNote ${version}.`);
  }
  return notes;
}

export const CURRENT_RELEASE_NOTES = releaseNotesFor(packageJson.version);
