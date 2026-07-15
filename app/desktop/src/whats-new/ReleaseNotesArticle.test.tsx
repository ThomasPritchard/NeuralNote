import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

describe("v0.2.0 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.2.0",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.2.0",
    );
    for (const heading of [
      "Source-native editing",
      "Neural Assistant AI",
      "Workspace and presentation",
      "Reliability and release readiness",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(article).getByText(/leading H1 title/i)).toBeInTheDocument();
    expect(within(article).getByText(/resolved Obsidian wikilinks/i)).toBeInTheDocument();
    expect(
      within(article).getByText(/choose a note.*duplicate paths.*add a heading or block fragment/i),
    ).toBeInTheDocument();
    expect(within(article).queryByText(/completion with aliases/i)).not.toBeInTheDocument();
    expect(within(article).getByText(/Stop response/i)).toBeInTheDocument();
  });
});
