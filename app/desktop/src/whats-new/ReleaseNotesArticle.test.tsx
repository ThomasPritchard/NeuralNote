import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES, RELEASE_NOTES } from "./releaseNotes";

describe("v0.4.0 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.4.0",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.4.0",
    );
    for (const heading of [
      "What the assistant is doing",
      "Approving what the assistant does",
      "Note previews in the graph",
      "Moving around the panes",
      "Upgrading",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    // Each phrase below must be unique to its bullet: the introduction paraphrases
    // all four sections, so a substring it shares with a bullet matches twice and
    // `getByText` throws on the ambiguity rather than the absence.
    expect(
      within(article).getByText(/ordered account of everything it did/i),
    ).toBeInTheDocument();
    expect(within(article).getByText(/or runs a program on your machine/i)).toBeInTheDocument();
    expect(
      within(article).getByText(/worked out on your own machine from the note itself/i),
    ).toBeInTheDocument();
    expect(within(article).getByText(/follows an answer as it streams/i)).toBeInTheDocument();
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
