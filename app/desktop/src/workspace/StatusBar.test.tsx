import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
  };
}

describe("StatusBar", () => {
  it("renders pluralised note and folder counts", () => {
    const tree = [folder("A", [file("a.md", "/v/A/a.md")]), file("b.md", "/v/b.md")];
    render(<StatusBar vaultName="MyVault" tree={tree} note={null} />);
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
    render(<StatusBar vaultName="V" tree={tree} note={null} />);
    expect(screen.getByText("1 note")).toBeInTheDocument();
    expect(screen.getByText("2 folders")).toBeInTheDocument();
  });

  it("shows the open note's word count, and hides it when no note is open", () => {
    const { rerender } = render(
      <StatusBar vaultName="V" tree={[]} note={note("one two three")} />,
    );
    expect(screen.getByText("3 words")).toBeInTheDocument();
    rerender(<StatusBar vaultName="V" tree={[]} note={null} />);
    expect(screen.queryByText(/words/)).not.toBeInTheDocument();
  });

  it("labels the healthy vault as local-only, never cloud 'Synced'", () => {
    render(<StatusBar vaultName="V" tree={[]} note={null} />);
    expect(screen.getByText("Local only")).toBeInTheDocument();
    expect(screen.queryByText("Synced")).not.toBeInTheDocument();
  });
});
