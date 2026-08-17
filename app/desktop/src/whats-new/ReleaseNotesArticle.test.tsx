import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES } from "./releaseNotes";

describe("v0.4.2 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.4.2",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.4.2",
    );
    // Headings and phrases are THIS release's and must be re-pointed at each bump,
    // here and in scripts/check-release-workflow.mjs. Neither is a version string,
    // so the runbook's version sweep cannot catch them going stale.
    for (const heading of [
      "Capturing from YouTube",
      "Writing",
      "The window",
      "Settings",
      "For anyone running NeuralNote from source",
      "Upgrading",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    // Each phrase below must be unique to its bullet: the introduction paraphrases
    // all six sections, so a substring it shares with a bullet matches twice and
    // `getByText` throws on the ambiguity rather than the absence. "metadata
    // inspection" and "welcome screen" are exactly such phrases this release — both
    // appear in the introduction too, so the assertions below reach past them.
    expect(
      within(article).getByText(/signed caption links are no longer carried any further/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/opening tag search and discarding the keystroke/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/shown beneath an error rather than above it/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/can no longer appear as a raw internal identifier/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/keeps its own API key rather than sharing the installed app's/i),
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
