import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

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
    // The record holds the CURRENT release only: the workflow contract greps the
    // whole file for `items:`, so a superseded entry left behind fails the release.
    // This phrase carried the whole of 0.3.0's headline section.
    expect(
      within(article).queryByText(/drawn as a table while you type/i),
    ).not.toBeInTheDocument();
  });
});
