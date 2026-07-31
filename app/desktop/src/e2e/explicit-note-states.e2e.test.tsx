import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";

import { renderApp } from "./renderApp";
import { VAULT_ROOT } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

async function openFixture(relPath: string, scenario: string) {
  const result = renderApp({
    recents,
    mockIpcScenario: scenario,
    seed: [{ kind: "file", relPath, content: "fixture bytes stay Rust-owned" }],
  });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await result.user.click(await screen.findByRole("button", { name: relPath }));
  return result;
}

describe("MockIPC explicit note-read states", () => {
  it("keeps a binary attachment explicit and non-editable", async () => {
    const { backend } = await openFixture("binary.png", "note-read-binary");

    expect(await screen.findByText("Preview not available for .png files yet")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save" })).not.toBeInTheDocument();
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("warns that lossy text cannot be saved without permanent replacement", async () => {
    const { backend } = await openFixture("lossy.md", "note-read-lossy");

    expect(await screen.findByText(/isn't valid UTF-8/i)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent("�");
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("surfaces malformed frontmatter while preserving the source editor", async () => {
    const { backend } = await openFixture("malformed.md", "note-read-malformed");

    expect(await screen.findByText(/frontmatter block was opened/i)).toBeInTheDocument();
    expect(await screen.findByRole("textbox", { name: "Note content" })).toHaveTextContent(
      "title: broken",
    );
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("shows the actual Rust size-limit state without mounting an editor", async () => {
    const { backend } = await openFixture("oversized.md", "note-read-oversized");

    expect(await screen.findByText(/past the 8 MiB limit/i)).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "Note content" })).not.toBeInTheDocument();
    expect(backend.remainingContractExchanges()).toBe(0);
  });

  it("blocks workspace-state persistence until corrupt state is explicitly reset", async () => {
    const { user, backend } = renderApp({ recents, mockIpcScenario: "workspace-corrupt" });
    await user.click(await screen.findByRole("button", { name: "Open My Brain" }));

    const recovery = await screen.findByRole("alert", {
      name: /could not parse workspace state/i,
    });
    expect(recovery).toHaveTextContent("key must be a string");
    await user.click(screen.getByRole("button", { name: "Reset tab state" }));

    expect(backend.calls).toContain("reset_workspace_state");
    expect(backend.remainingContractExchanges()).toBe(0);
  });
});
