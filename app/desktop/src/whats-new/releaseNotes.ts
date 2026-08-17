import { version } from "../../package.json";

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

// GENERATED FILE — do not edit by hand.
// Source: docs/releases/v0.4.2.md. Regenerate with `npm run gen:release-notes`.
//
// One release only. The workflow contract greps this WHOLE file for `items:` and
// compares the result with the single-version `.md`, so a superseded entry left
// behind here fails the release, not just this file's own test. Generating the file
// is what guarantees that: the .md holds one release, so this can only hold one.
//
// Exported so a test can assert the key set directly. Asserting that a superseded
// release's PROSE is absent from the DOM cannot work — the component renders only
// CURRENT_RELEASE_NOTES, so a stale entry is never rendered and the query passes
// whether or not the entry is there.
export const RELEASE_NOTES: Readonly<Record<string, ReleaseNotes>> = {
  "0.4.2": {
    version: "0.4.2",
    title: "What's new in NeuralNote 0.4.2",
    introduction:
      "NeuralNote 0.4.2 is a corrections release. A YouTube video with a very large caption list now gets through metadata inspection instead of stalling, and the choice you make about where its notes are filed is remembered in your vault. Pressing Enter inside a code fence types a newline again, the welcome screen stops growing as you collect vaults, and a notification can no longer hide part of the note you are editing. Your vault format and saved settings are unchanged.",
    groups: [
      {
        title: "Capturing from YouTube",
        items: [
          "A video whose automatic captions run to thousands of entries now completes metadata inspection instead of stopping at an output limit.",
          "Only the handful of details NeuralNote actually uses are read from a video, so signed caption links are no longer carried any further.",
          "The choice you make about where a video's notes are filed is now remembered in your vault, so capture continues on to fetching captions and writing the note.",
          "Stopping a YouTube capture now reads as the run ending before the step, rather than as NeuralNote refusing to do it.",
          "A playlist whose entries have no title is handled by falling back to the video id instead of failing outright.",
          "Work that arrives just after you press Stop is still recorded, so the timeline does not lose the last thing that happened.",
        ],
      },
      {
        title: "Writing",
        items: [
          "Pressing Enter on a tag inside a fenced code block now types a new line instead of opening tag search and discarding the keystroke.",
          "Pressing Enter on an ordinary tag still opens tag search, as before.",
        ],
      },
      {
        title: "The window",
        items: [
          "A notification can no longer clip the note editor: at small window sizes the note stays reachable by scrolling instead of being cut off with no way to see the rest.",
          "The welcome screen's list of recent vaults now scrolls inside its own panel, so the card keeps a steady size and the Open vault and New vault buttons stop moving as vaults accumulate.",
          "A part-visible row at the bottom of that list shows there are more vaults below it.",
          "The running cost of a turn is now shown beneath an error rather than above it.",
        ],
      },
      {
        title: "Settings",
        items: [
          "Every action listed under what the assistant may do is named in plain English, so a newly added one can no longer appear as a raw internal identifier.",
        ],
      },
      {
        title: "For anyone running NeuralNote from source",
        items: [
          "A development build now keeps its own API key rather than sharing the installed app's, so clearing the key while developing no longer deletes the real one.",
        ],
      },
      {
        title: "Upgrading",
        items: [
          "Your vault, its notes and your saved settings are carried over unchanged.",
          "Application packages, updater checks, and the upgrade journey are aligned on version 0.4.2.",
        ],
      },
    ],
  },
};

function releaseNotesFor(releaseVersion: string): ReleaseNotes {
  const notes = RELEASE_NOTES[releaseVersion];
  if (!notes) {
    throw new Error(`No bundled release notes exist for NeuralNote ${releaseVersion}.`);
  }
  return notes;
}

export const CURRENT_RELEASE_NOTES = releaseNotesFor(version);
