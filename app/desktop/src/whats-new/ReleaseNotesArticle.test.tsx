import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES } from "./releaseNotes";

describe("v0.4.1 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.4.1",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.4.1",
    );
    // Headings and phrases are THIS release's and must be re-pointed at each bump,
    // here and in scripts/check-release-workflow.mjs. Neither is a version string,
    // so the runbook's version sweep cannot catch them going stale.
    for (const heading of [
      "Deleting a note",
      "What NeuralNote tells you it did",
      "Writing and tables",
      "Notifications and the window",
      "Upgrading",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    // Each phrase below must be unique to its bullet: the introduction paraphrases
    // all four sections, so a substring it shares with a bullet matches twice and
    // `getByText` throws on the ambiguity rather than the absence. "reported as a
    // timeout" is exactly such a phrase this release — it appears in the
    // introduction too, so the second assertion reaches for the expiry wording.
    expect(
      within(article).getByText(/leaving the app unresponsive for two minutes/i),
    ).toBeInTheDocument();
    expect(
      within(article).getByText(/at the same moment the request expires/i),
    ).toBeInTheDocument();
    expect(within(article).getByText(/measured as two columns/i)).toBeInTheDocument();
    expect(
      within(article).getByText(/sit in the layout rather than floating over the chat pane/i),
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
