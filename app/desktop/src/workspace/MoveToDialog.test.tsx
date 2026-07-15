import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../lib/types";
import {
  MoveToDialog,
  isValidMoveTarget,
  type MoveDestination,
} from "./MoveToDialog";

const fileNode = (relPath: string): TreeNode => ({
  kind: "file",
  name: relPath.split("/").pop() ?? relPath,
  path: `/v/${relPath}`,
  relPath,
  ext: "md",
  children: null,
});

const folderNode = (relPath: string): TreeNode => ({
  kind: "folder",
  name: relPath.split("/").pop() ?? relPath,
  path: `/v/${relPath}`,
  relPath,
  ext: null,
  children: null,
});

const dest = (path: string, label: string): MoveDestination => ({ path, label });

function setup(node: TreeNode, destinations: MoveDestination[]) {
  const onMove = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <MoveToDialog
      node={node}
      destinations={destinations}
      onMove={onMove}
      onClose={onClose}
    />,
  );
  return { onMove, onClose, user };
}

describe("isValidMoveTarget", () => {
  it("rejects a no-op move into the entry's current parent", () => {
    // a.md lives at the vault root, so the root is a no-op destination.
    expect(isValidMoveTarget("/v/a.md", "/v")).toBe(false);
  });

  it("rejects moving a folder into itself", () => {
    expect(isValidMoveTarget("/v/Notes", "/v/Notes")).toBe(false);
  });

  it("rejects moving a folder into one of its own descendants", () => {
    expect(isValidMoveTarget("/v/Notes", "/v/Notes/Sub")).toBe(false);
  });

  it("accepts a genuine move to an unrelated folder", () => {
    expect(isValidMoveTarget("/v/Notes/a.md", "/v/Other")).toBe(true);
  });

  it("accepts moving a nested entry out to the vault root", () => {
    expect(isValidMoveTarget("/v/Notes/a.md", "/v")).toBe(true);
  });

  it("is separator-agnostic (Windows paths)", () => {
    expect(isValidMoveTarget("\\v\\Notes", "\\v\\Notes\\Sub")).toBe(false);
    expect(isValidMoveTarget("\\v\\Notes\\a.md", "\\v\\Other")).toBe(true);
  });
});

describe("MoveToDialog", () => {
  it("names the entry being moved and labels the destination list", () => {
    setup(fileNode("Notes/a.md"), [
      dest("/v", "Vault root"),
      dest("/v/Other", "Other"),
    ]);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/a\.md/)).toBeInTheDocument();
    expect(
      screen.getByRole("list", { name: /destination folders/i }),
    ).toBeInTheDocument();
  });

  it("offers only valid destinations, filtering out parent, self and descendants", () => {
    // Moving the Notes folder: its parent (root) is a no-op, Notes is itself,
    // Notes/Sub is a descendant — only Other survives.
    setup(folderNode("Notes"), [
      dest("/v", "Vault root"),
      dest("/v/Notes", "Notes"),
      dest("/v/Notes/Sub", "Notes/Sub"),
      dest("/v/Other", "Other"),
    ]);
    expect(screen.getByRole("button", { name: /Other/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Vault root/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Notes$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notes\/Sub/ })).not.toBeInTheDocument();
  });

  it("moves into the chosen destination when a folder is activated", async () => {
    const { onMove, user } = setup(fileNode("Notes/a.md"), [
      dest("/v", "Vault root"),
      dest("/v/Other", "Other"),
    ]);
    await user.click(screen.getByRole("button", { name: /Other/ }));
    expect(onMove).toHaveBeenCalledExactlyOnceWith("/v/Other");
  });

  it("cancels via the cancel control", async () => {
    const { onClose, user } = setup(fileNode("a.md"), [dest("/v/Other", "Other")]);
    await user.click(screen.getByRole("button", { name: /cancel move/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows an empty state when the entry has no valid destination", () => {
    // The only folder offered is the entry's own parent (a no-op).
    setup(fileNode("Notes/a.md"), [dest("/v/Notes", "Notes")]);
    expect(screen.getByText(/no available destinations/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Notes/ })).not.toBeInTheDocument();
  });
});
