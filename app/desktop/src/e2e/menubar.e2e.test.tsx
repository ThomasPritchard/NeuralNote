// Journey: the native application menu drives the app.
//   The menu is built in Rust and emits `menu://action` over the same event
//   bridge the file-watcher uses. Here we drive that event through the real
//   mockIPC boundary and assert the app responds. Open Recent is handled in the
//   store (it must work before any vault is open); the rest are vault-scoped and
//   handled in the Workspace.

import { describe, it, expect } from "vitest";
import { act, screen } from "@testing-library/react";
import { emit } from "@tauri-apps/api/event";
import { MENU_ACTION } from "../lib/bindings/events";
import { renderApp, type RenderAppResult } from "./renderApp";
import { VAULT_ROOT, type SeedEntry } from "./mockVault";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];
const SEED: SeedEntry[] = [{ kind: "file", relPath: "Note.md", content: "hello" }];

/** Emit a native-menu action through the real event bus, flushed under act. */
async function fireMenu(action: string, extra: Record<string, unknown> = {}) {
  await act(async () => {
    await emit(MENU_ACTION, { action, ...extra });
  });
}

/** Open the recent vault via the welcome screen and wait for the workspace. */
async function openVault(): Promise<RenderAppResult> {
  const result = renderApp({ seed: SEED, recents });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByLabelText("Filter files by name");
  return result;
}

describe("Native menu → app actions", () => {
  it("Open Recent opens a vault from the welcome screen (before any vault is open)", async () => {
    renderApp({ seed: SEED, recents });
    // Still on the welcome screen — the Workspace isn't mounted yet, which is why
    // this action lives in the always-mounted store.
    await screen.findByRole("button", { name: "Open My Brain" });

    await fireMenu("open-recent", { path: VAULT_ROOT });

    expect(await screen.findByLabelText("Filter files by name")).toBeInTheDocument();
  });

  it("New Note opens the inline create input at the vault root", async () => {
    await openVault();
    await fireMenu("new-note");
    expect(await screen.findByPlaceholderText("Note name")).toBeInTheDocument();
  });

  it("Find in Vault switches the sidebar to the search panel", async () => {
    await openVault();
    await fireMenu("view-search");
    expect(await screen.findByLabelText("Search vault")).toBeInTheDocument();
  });

  it("Toggle Neural Assistant AI hides and re-shows the chat panel without unmounting it", async () => {
    await openVault();
    const heading = screen.getByText("Neural Assistant AI");
    const slot = heading.closest(".nn-chat-slot");
    expect(slot).toHaveAttribute("data-visible", "true");
    expect(slot).toHaveAttribute("aria-hidden", "false");

    // The webview owns visibility now, so each action is a bare flip (no `checked`
    // payload); the menu item just requests a toggle.
    await fireMenu("toggle-chat");
    expect(screen.getByText("Neural Assistant AI")).toBe(heading);
    expect(slot).toHaveAttribute("data-visible", "false");
    expect(slot).toHaveAttribute("aria-hidden", "true");
    expect(slot).toHaveAttribute("inert");

    await fireMenu("toggle-chat");
    expect(screen.getByText("Neural Assistant AI")).toBe(heading);
    expect(slot).toHaveAttribute("data-visible", "true");
    expect(slot).toHaveAttribute("aria-hidden", "false");
    expect(slot).not.toHaveAttribute("inert");
  });

  it("Toggle Navigation Sidebar compacts and expands navigation without resetting search", async () => {
    const { user } = await openVault();
    await fireMenu("view-search");
    const input = await screen.findByLabelText("Search vault");
    await user.type(input, "hello");
    await screen.findByRole("list", { name: "Search results" });

    await fireMenu("toggle-sidebar");
    expect(screen.getByLabelText("Search vault")).toBe(input);
    expect(input).toHaveValue("hello");
    expect(screen.getByRole("navigation", { name: "Workspace" })).toHaveAttribute(
      "data-navigation-expanded",
      "false",
    );

    await fireMenu("toggle-sidebar");
    expect(screen.getByLabelText("Search vault")).toBe(input);
    expect(input).toHaveValue("hello");
    expect(screen.getByRole("navigation", { name: "Workspace" })).toHaveAttribute(
      "data-navigation-expanded",
      "true",
    );
  });
});
