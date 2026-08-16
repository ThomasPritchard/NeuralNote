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
// Source: docs/releases/v0.4.1.md. Regenerate with `npm run gen:release-notes`.
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
  "0.4.1": {
    version: "0.4.1",
    title: "What's new in NeuralNote 0.4.1",
    introduction:
      "NeuralNote 0.4.1 is a corrections release. It fixes a two-minute freeze when a note could not be deleted, and a run of places where NeuralNote told you something different from what actually happened — an approval you granted reported as a timeout, an action NeuralNote attempted and failed reported as one it refused, and a stopped response announced for a run that finished. Tables, the editor and the notification dock get a set of fixes too. Your vault format and saved settings are unchanged.",
    groups: [
      {
        title: "Deleting a note",
        items: [
          "Deleting a note the system refuses to move to the Trash now fails immediately instead of leaving the app unresponsive for two minutes.",
          "The refusal explains itself: it reports the reason the system gave, rather than arriving as a timeout after the wait.",
          "A note that could not be deleted stays where it is, and stays visible in the file tree.",
          "On macOS a deleted note goes to the Trash as before, but is restored by dragging it out rather than by Finder's Put Back.",
          "Deleting also no longer depends on NeuralNote having permission to control Finder, so it works on machines where that permission was declined.",
        ],
      },
      {
        title: "What NeuralNote tells you it did",
        items: [
          "An approval you granted is no longer reported as a timeout when your answer arrives at the same moment the request expires.",
          "A decision that never reached the run is now reported as an error rather than confirmed as accepted.",
          "An action that ran and failed is now told apart from one NeuralNote refused, instead of both reading as a refusal.",
          "A response that was stopped is announced only when the run actually stopped, so a run that went on to finish is no longer announced as stopped.",
          "The assistant keeps its final answer and the context it needs to continue, instead of losing them between steps.",
          "A vault error now reads the same whichever part of the assistant hit it.",
          "If a change to your API key does not reach your other open windows, NeuralNote now says so instead of leaving them disagreeing until a restart.",
          "Two open windows no longer disagree about your API key until one of them is restarted.",
          "A model list that arrives after you have moved on is discarded rather than replacing the current one.",
        ],
      },
      {
        title: "Writing and tables",
        items: [
          "The macOS table shortcuts now respond to the characters the Option key actually produces.",
          "A table shortcut works whenever the cursor is inside a table, rather than only in some positions.",
          "Emoji are measured as two columns when a table's widths are worked out, so a table containing them lines up.",
          "A wide table scrolls sideways as expected.",
          "Revealing a table's source and returning now repaints the table rather than leaving the previous rendering.",
          "Pressing Enter inside an unfinished code fence no longer leaks a tag into the note.",
          "A heading written with closing hashes is read correctly.",
          "Notes with very large numbers of links open faster.",
        ],
      },
      {
        title: "Notifications and the window",
        items: [
          "Notifications now sit in the layout rather than floating over the chat pane, so they can no longer cover what you are reading.",
          "The notification area is named for screen readers.",
          "Launching straight into full screen on macOS no longer paints the window controls in the wrong place for the first frame before snapping into position.",
          "A development or unsigned build no longer raises a permanent error about updates being unavailable, which is expected for those builds rather than a fault.",
        ],
      },
      {
        title: "Upgrading",
        items: [
          "Your vault, its notes and your saved settings are carried over unchanged.",
          "Application packages, updater checks, and the upgrade journey are aligned on version 0.4.1.",
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
