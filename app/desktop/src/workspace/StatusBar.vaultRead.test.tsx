// @vitest-environment jsdom
//
// Regression fixture for issue #209: a failed vault-index read must never render
// as a count.
//
// `StatusBar.test.tsx` cannot fail this. It hands the component a tree ARRAY, so
// `[]` is a legitimate "empty vault" input to it — and an empty vault versus a
// failed read are exactly the two inputs the bug conflated. The only way to tell
// them apart is to drive the failure through `useVaultTree`, so this fixture
// rejects the real `read_tree` call at the Tauri boundary and renders the footer
// on whatever the hook reports.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Same seam `useVaultTree.test.ts` mocks: the hook reads the tree through
// api.ts → invoke and subscribes to on-disk changes through listen.
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { TreeNode } from "../lib/types";
import { StatusBar } from "./StatusBar";
import { useVaultTree } from "./useVaultTree";

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

const NOTE: TreeNode = {
  kind: "file",
  name: "a.md",
  path: "/v/a.md",
  relPath: "a.md",
  ext: "md",
  children: null,
};

/** The real footer, fed by the real hook — nothing between them is stubbed. */
function VaultFooter({ vaultPath }: Readonly<{ vaultPath: string | undefined }>) {
  const { tree, status, refresh } = useVaultTree(vaultPath);
  return (
    <StatusBar
      vaultName="My Brain"
      tree={tree}
      status={status}
      onRetry={refresh}
      note={null}
    />
  );
}

const healthDot = () => screen.getByTestId("vault-health");

beforeEach(() => {
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(vi.fn());
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("StatusBar over a real vault read", () => {
  it("does not assert a count, or read as healthy, when the index read fails", async () => {
    mockInvoke.mockRejectedValue({ kind: "io", message: "vault root unreadable" });

    render(<VaultFooter vaultPath="/v" />);

    // The lie the bug shipped: zeroes beside a healthy dot.
    await screen.findByText("Counts unavailable");
    expect(screen.queryByText("0 notes")).not.toBeInTheDocument();
    expect(screen.queryByText("0 folders")).not.toBeInTheDocument();
    expect(healthDot()).toHaveAttribute("data-health", "unavailable");
  });

  it("still reads 0 notes · 0 folders for a genuinely empty vault", async () => {
    mockInvoke.mockResolvedValue([]);

    render(<VaultFooter vaultPath="/v" />);

    expect(await screen.findByText("0 notes")).toBeInTheDocument();
    expect(screen.getByText("0 folders")).toBeInTheDocument();
    expect(screen.queryByText("Counts unavailable")).not.toBeInTheDocument();
    expect(healthDot()).toHaveAttribute("data-health", "healthy");
  });

  it("offers a retry that re-reads the index without reopening the vault", async () => {
    const user = userEvent.setup();
    mockInvoke.mockRejectedValueOnce({ kind: "io", message: "vault root unreadable" });

    render(<VaultFooter vaultPath="/v" />);
    await screen.findByText("Counts unavailable");

    mockInvoke.mockResolvedValue([NOTE]);
    await user.click(screen.getByRole("button", { name: /^Retry/ }));

    expect(await screen.findByText("1 note")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByText("Counts unavailable")).not.toBeInTheDocument(),
    );
    expect(healthDot()).toHaveAttribute("data-health", "healthy");
  });
});
