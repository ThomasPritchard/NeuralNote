import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { NoteDoc, TreeNode } from "../lib/types";
import { StatusBar } from "./StatusBar";

const file = (name: string, path: string): TreeNode => ({
  kind: "file",
  name,
  path,
  relPath: name,
  ext: "md",
  children: null,
});

const folder = (name: string, children: TreeNode[]): TreeNode => ({
  kind: "folder",
  name,
  path: `/v/${name}`,
  relPath: name,
  ext: null,
  children,
});

function note(body: string): NoteDoc {
  return {
    path: "/v/n.md",
    relPath: "n.md",
    title: "N",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body,
    raw: body,
    contentHash: "h",
    binary: false,
    lossyText: false,
    exceedsEditableSize: false,
    sizeBytes: 0,
  };
}

const noop = () => {};

describe("StatusBar", () => {
  it("renders pluralised note and folder counts", () => {
    const tree = [folder("A", [file("a.md", "/v/A/a.md")]), file("b.md", "/v/b.md")];
    render(<StatusBar vaultName="MyVault" tree={tree} status="ready" onRetry={noop} note={null} />);
    expect(screen.getByText("MyVault")).toBeInTheDocument();
    expect(screen.getByText("2 notes")).toBeInTheDocument();
    expect(screen.getByText("1 folder")).toBeInTheDocument();
  });

  it("uses singular labels for a single note and plural for folders", () => {
    const tree = [
      folder("A", []),
      folder("B", []),
      file("only.md", "/v/only.md"),
    ];
    render(<StatusBar vaultName="V" tree={tree} status="ready" onRetry={noop} note={null} />);
    expect(screen.getByText("1 note")).toBeInTheDocument();
    expect(screen.getByText("2 folders")).toBeInTheDocument();
  });

  it("shows the open note's word count, and hides it when no note is open", () => {
    const { rerender } = render(
      <StatusBar vaultName="V" tree={[]} status="ready" onRetry={noop} note={note("one two three")} />,
    );
    expect(screen.getByText("3 words")).toBeInTheDocument();
    rerender(<StatusBar vaultName="V" tree={[]} status="ready" onRetry={noop} note={null} />);
    expect(screen.queryByText(/words/)).not.toBeInTheDocument();
  });

  it("labels the healthy vault as local-only, never cloud 'Synced'", () => {
    render(<StatusBar vaultName="V" tree={[]} status="ready" onRetry={noop} note={null} />);
    expect(screen.getByText("Local only")).toBeInTheDocument();
    expect(screen.queryByText("Synced")).not.toBeInTheDocument();
  });

  it("holds the counts back while the read for this vault is still in flight", () => {
    const stale = [folder("A", [file("a.md", "/v/A/a.md")])];
    render(
      <StatusBar
        vaultName="V"
        tree={stale}
        status="loading"
        onRetry={noop}
        note={null}
      />,
    );

    // The tree in hand still describes the PREVIOUS vault during a switch, so
    // neither its counts nor a healthy dot may appear under this vault's name.
    expect(screen.getByText("Reading vault…")).toBeInTheDocument();
    expect(screen.queryByText("1 note")).not.toBeInTheDocument();
    expect(screen.queryByText("1 folder")).not.toBeInTheDocument();
    expect(screen.getByTestId("vault-health")).toHaveAttribute("data-health", "unknown");
  });

  it("offers a keyboard-operable retry when the read failed", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    render(
      <StatusBar vaultName="V" tree={[]} status="failed" onRetry={onRetry} note={null} />,
    );

    const retry = screen.getByRole("button", { name: "Retry reading the vault" });
    retry.focus();
    await user.keyboard("{Enter}");

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Counts unavailable")).toBeInTheDocument();
    expect(screen.queryByText("0 notes")).not.toBeInTheDocument();
  });
});
