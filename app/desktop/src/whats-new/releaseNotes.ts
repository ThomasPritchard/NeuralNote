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
// Source: docs/releases/v0.4.3.md. Regenerate with `npm run gen:release-notes`.
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
  "0.4.3": {
    version: "0.4.3",
    title: "What's new in NeuralNote 0.4.3",
    introduction:
      "NeuralNote 0.4.3 makes longer assistant runs easier to follow. The conversation now reports the work actually in progress, shows elapsed time and honest round or playlist progress, and exposes each OpenRouter model's own reasoning controls. This release also fixes several cases where notes, settings, vault counts or citations could be reported incorrectly or put at risk. Your vault format and saved settings are unchanged.",
    groups: [
      {
        title: "Following an assistant run",
        items: [
          "The live heading now says whether NeuralNote is sending your message, planning, searching your vault, reading notes or verifying citations.",
          "Thinking appears only while reasoning is actually arriving, rather than standing in for every part of a run.",
          "A running turn now shows the time passing and the current planning round.",
          "A playlist reports which video is in progress, shows that video's title, channel, duration and thumbnail when available, and does not pretend its round limit predicts when the playlist will finish.",
          "Reasoning from separate planning rounds and the final answer is kept in separate disclosures instead of being joined into one block.",
          "Tool rows now show what they are acting on, their latest progress and how long they took, including search queries, note ranges and result counts.",
          "A slow run distinguishes a provider that has gone quiet from one that is still connected but has produced nothing new.",
          "YouTube lookup, caption fetching, local transcription, extractor updates and retries now report what they are doing while they run.",
        ],
      },
      {
        title: "Reasoning controls",
        items: [
          "The selected OpenRouter model now offers the effort names published by that model, in the order it publishes them, rather than a fixed list chosen by NeuralNote.",
          "A model that always reasons is shown as always on, one that cannot return reasoning is shown as unavailable, and a capability check that has not finished can be run again.",
          "A chosen effort applies to every planning round as well as the final answer, and Settings explains that the extra reasoning tokens are billed on every step.",
          "Changing model or provider clears an effort that belonged to the previous model, while turning reasoning off and back on for the same model restores the effort you chose.",
          "If a model stops offering a stored effort, the run falls back to the model's current default instead of failing, and keeps your original choice in case it returns.",
        ],
      },
      {
        title: "Protecting your vault and settings",
        items: [
          "The vault itself is no longer accepted as something to delete, rename or move, while ordinary notes and folders continue to work as before.",
          "Creating or saving a note now refuses a planted or dangling symlink instead of following it to a file outside the vault.",
          "Temporary writes for notes, recent vaults, preferences and provider settings now reserve a new file rather than writing through a path another process has occupied.",
          "If saved preferences cannot be read, NeuralNote uses defaults for that launch but refuses to overwrite the intact settings file and explains why the change was not saved.",
          "Installing an update now passes through the unsaved-note confirmation before NeuralNote relaunches.",
          "Undo now warns before the click that notes written by the run are deleted permanently and do not go to the Trash, and reports failed, kept and deleted files separately.",
        ],
      },
      {
        title: "Citations and vault reads",
        items: [
          "Backlinks now use file line numbers, including YAML frontmatter, so they agree with Search for the same passage.",
          "A citation shortened to fit its byte limit now ends on the last line it actually quotes, and any future mismatch is dropped with a reason rather than shown as valid.",
          "A note over the readable size limit, or one whose bytes are not valid UTF-8, is refused with the real reason instead of being described as an empty note that was read.",
          "If the vault index cannot be read, the footer now says Counts unavailable and offers Retry instead of showing zero notes and zero folders beside a healthy indicator.",
          "Wikilink completion and the template destination picker now say when their vault information may be incomplete rather than presenting a failed read as the whole vault.",
        ],
      },
      {
        title: "YouTube and local transcription",
        items: [
          "A video being processed can now appear beside the live progress with its metadata and a bounded, host-fetched thumbnail; a failed thumbnail fetch leaves a useful text-only card and does not fail the run.",
          "The macOS source installer now produces a self-contained Whisper executable, verifies that it launches, and repairs an older local Whisper install that cannot launch.",
          "A single-video run can write its note without an unnecessary second approval caused by treating its work item as playlist-only.",
        ],
      },
      {
        title: "For anyone running NeuralNote from source",
        items: [
          "Pull requests now compile and test the Rust workspace on macOS so cfg(macos) code cannot merge unchecked.",
          "Chromium and Ubuntu native journeys remain required; hosted WebKit and native macOS and Windows journeys run weekly or manually while their runners remain informational.",
        ],
      },
      {
        title: "Upgrading",
        items: [
          "Your vault, its notes and your saved settings are carried over unchanged.",
          "Application packages, updater checks, and the upgrade journey are aligned on version 0.4.3.",
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
