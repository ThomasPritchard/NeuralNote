import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES } from "./releaseNotes";

describe("v0.4.3 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.4.3",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.4.3",
    );
    // Headings and phrases are THIS release's and must be re-pointed at each bump,
    // here and in scripts/check-release-workflow.mjs. Neither is a version string,
    // so the runbook's version sweep cannot catch them going stale.
    for (const heading of [
      "Following an assistant run",
      "Reasoning controls",
      "Protecting your vault and settings",
      "Citations and vault reads",
      "YouTube and local transcription",
      "For anyone running NeuralNote from source",
      "Upgrading",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    // Each phrase below must be unique to its bullet: the introduction paraphrases
    // every section, so a substring it shares with a bullet matches twice and
    // `getByText` throws on the ambiguity rather than the absence. The assertions
    // below use phrases that appear exactly once in the generated notes.
    expect(
      within(article).getByText(/shows the time passing and the current planning round/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/the effort names published by that model, in the order/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/the vault itself is no longer accepted as something to delete/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/Counts unavailable and offers Retry/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/repairs an older local Whisper install that cannot launch/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/cfg\(macos\) code cannot merge unchecked/i),
    ).toBeInTheDocument();
  });

  it("bundles the current release only", () => {
    // Asserted against the RECORD, not the DOM. The article renders only
    // CURRENT_RELEASE_NOTES, so a superseded entry left in the record is never
    // rendered — a `queryByText` for last release's prose passes whether or not
    // the stale entry is there, and cannot fail. This can.
    //
    // It matters because the release workflow greps the whole file for `items:`
    // and compares the result with the single-version `.md`; a second entry
    // silently fails the release rather than this test.
    expect(Object.keys(RELEASE_NOTES)).toEqual([packageJson.version]);
  });
});
