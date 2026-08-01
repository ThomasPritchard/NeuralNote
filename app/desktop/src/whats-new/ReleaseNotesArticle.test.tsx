import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

describe("v0.3.0 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.3.0",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.3.0",
    );
    for (const heading of [
      "Tables you can edit in place",
      "Editing and Markdown",
      "Neural Assistant AI",
      "Large notes and reliability",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(article).getByText(/stay drawn as a table while you type/i)).toBeInTheDocument();
    expect(within(article).getByText(/fonts finish loading/i)).toBeInTheDocument();
    expect(within(article).getByText(/real context window/i)).toBeInTheDocument();
    expect(within(article).getByText(/no longer freezes the window/i)).toBeInTheDocument();
    // The record holds the CURRENT release only: the workflow contract greps the
    // whole file for `items:`, so a superseded entry left behind fails the release.
    expect(within(article).queryByText(/plain-text notes/i)).not.toBeInTheDocument();
  });
});
