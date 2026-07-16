import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";
import { ReleaseNotesArticle } from "./ReleaseNotesArticle";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

describe("v0.2.1 release notes", () => {
  it("matches the build version and renders the full shared changelog", () => {
    expect(CURRENT_RELEASE_NOTES.version).toBe(packageJson.version);
    render(<ReleaseNotesArticle />);

    const article = screen.getByRole("article", {
      name: "What's new in NeuralNote 0.2.1",
    });
    expect(within(article).getByRole("heading", { level: 1 })).toHaveTextContent(
      "What's new in NeuralNote 0.2.1",
    );
    for (const heading of [
      "Editing and search",
      "Neural Assistant AI",
      "Accessibility and interface",
      "Reliability and release readiness",
    ]) {
      expect(within(article).getByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(within(article).getByText(/plain-text notes/i)).toBeInTheDocument();
    expect(within(article).getByText(/flags the answer as truncated/i)).toBeInTheDocument();
    expect(within(article).getByText(/best-effort for citation fidelity/i)).toBeInTheDocument();
    expect(within(article).getByText(/keyboard-accessible Move to action/i)).toBeInTheDocument();
    expect(within(article).queryByText(/resolved Obsidian wikilinks/i)).not.toBeInTheDocument();
  });
});
