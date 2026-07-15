import { render, screen } from "@testing-library/react";
import { FileQuestion, FolderTree } from "lucide-react";
import { describe, expect, it } from "vitest";
import { AiMark, EmptyState, InlineNotice, PanelHeader, StatusPill } from "./patterns";

describe("NeuralNote composed patterns", () => {
  it("uses the native output status semantics for non-error notices", () => {
    render(<InlineNotice>Indexing vault…</InlineNotice>);

    const notice = screen.getByRole("status");
    expect(notice.tagName).toBe("OUTPUT");
    expect(notice).not.toHaveAttribute("role");
  });

  it("escalates a danger notice to an assertive alert", () => {
    render(<InlineNotice tone="danger">Vault index failed</InlineNotice>);

    const alert = screen.getByRole("alert");
    expect(alert.tagName).toBe("DIV");
    expect(alert).toHaveTextContent("Vault index failed");
    expect(alert).toHaveClass("text-destructive");
  });

  it("renders a titled panel header with its icon and trailing meta", () => {
    render(
      <PanelHeader icon={FolderTree} title="Files" meta={<span>12 notes</span>} />,
    );

    expect(screen.getByRole("heading", { name: "Files" })).toBeInTheDocument();
    expect(screen.getByText("12 notes")).toBeInTheDocument();
  });

  it("gives a status pill its tone badge and pill shape", () => {
    render(<StatusPill status="healthy">Indexed</StatusPill>);

    const pill = screen.getByText("Indexed");
    expect(pill).toHaveClass("rounded-full", "text-healthy");
  });

  it("marks the AI glyph as decorative", () => {
    const { container } = render(<AiMark />);

    const icon = container.querySelector("svg");
    expect(icon).toHaveAttribute("aria-hidden");
  });

  it("shows an empty state with its message and optional action", () => {
    render(
      <EmptyState
        icon={FileQuestion}
        title="No results"
        description="Nothing matched that search."
        action={<button type="button">Clear search</button>}
      />,
    );

    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText("Nothing matched that search.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Clear search" })).toBeInTheDocument();
  });
});
