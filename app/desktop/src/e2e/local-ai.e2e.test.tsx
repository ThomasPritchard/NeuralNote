// Journey 8: local-AI provider, end-to-end through the REAL Tauri IPC seam.
//
// Complements the AiSettingsPage/ChatPane/SettingsModal component tests (which
// stub `../lib/api`): this drives the full cross-component flow — cog / first-run
// picker → Settings modal → detect/recommend/pull commands → provider switch →
// ChatPane reflecting the new provider — against the stateful `mockVault` backend,
// including the `pull_local_model` Channel stream (same mechanism as `chat`, see
// mockVault's `emitToChannel`).
//
//   1. Unsupported hardware → the exact "unsupported specs" copy, verbatim.
//   2. First-run → pick Local → download the recommended model → it becomes the
//      active provider → the chat pane chats locally.
//   3. Reconfigure from the Settings cog → switch to an installed local model.

import { describe, it, expect } from "vitest";
import { screen, within } from "@testing-library/react";
import { renderApp } from "./renderApp";
import {
  VAULT_ROOT,
  type CreateMockVaultOptions,
} from "./mockVault";
import type { ChatEvent, HardwareSpec, InstalledModel } from "../lib/types";

const recents = [{ name: "My Brain", path: VAULT_ROOT, lastOpened: 1_700_000_000_000 }];

/** Render the app and open the recent vault, resolving once the chat pane mounts. */
async function openWorkspace(opts: CreateMockVaultOptions = {}) {
  const result = renderApp({ recents, ...opts });
  await result.user.click(await screen.findByRole("button", { name: "Open My Brain" }));
  await screen.findByText("Cited recall"); // the chat pane header, in every view
  return result;
}

const WEAK_HARDWARE: HardwareSpec = {
  totalRamBytes: 4 * 1024 ** 3,
  cpuCores: 4,
  cpuBrand: "Intel Core i5",
  gpuLabel: null,
  arch: "x86_64",
  os: "macos",
};

describe("Journey 8: local AI — unsupported hardware", () => {
  it("shows the exact 'unsupported specs' copy, not a raw error", async () => {
    const { user } = await openWorkspace({
      apiKey: { hasKey: false }, // nothing configured → first-run picker
      hardware: WEAK_HARDWARE,
      recommendation: {
        status: "unsupported",
        reason: "Local AI is unsupported due to your computer specs.",
      },
    });

    // First-run picker → choose Local → the Settings modal opens on the AI page.
    await user.click(await screen.findByRole("button", { name: /Set up Local AI/ }));

    const dialog = await screen.findByRole("dialog");
    // The verdict renders verbatim — the backend copy is the user-facing contract.
    expect(
      await within(dialog).findByText(
        "Local AI is unsupported due to your computer specs.",
      ),
    ).toBeInTheDocument();
    // The weak machine's specs are shown so the verdict is legible, not opaque.
    expect(within(dialog).getByText(/4 GB RAM/)).toBeInTheDocument();
  });
});

describe("Journey 8: local AI — download then chat locally", () => {
  const successScript: ChatEvent[] = [
    { type: "searching", query: "mitochondria" },
    { type: "answer", delta: "The mitochondrion is the " },
    { type: "answer", delta: "powerhouse of the cell." },
    { type: "done" },
  ];

  it("downloads the recommended model, makes it active, and chats locally", async () => {
    const { user } = await openWorkspace({
      apiKey: { hasKey: false }, // → first-run picker
      chatScript: successScript,
      // hardware/recommendation/candidates/pullScript all default to the supported
      // Apple-Silicon path (recommended: qwen2.5:7b, a progress→success pull).
    });

    // Picker → Local → Settings modal (AI page).
    await user.click(await screen.findByRole("button", { name: /Set up Local AI/ }));
    const dialog = await screen.findByRole("dialog");
    expect(
      await within(dialog).findByText(/Recommended for this machine/),
    ).toBeInTheDocument();

    // Download the recommended model from its catalogue row.
    const catalogue = within(dialog).getByRole("list", { name: "Model catalogue" });
    const qwenRow = within(catalogue).getByText("qwen2.5:7b").closest("li");
    expect(qwenRow).not.toBeNull();
    await user.click(within(qwenRow!).getByRole("button", { name: /Download/ }));

    // The stream ends in success → the model installs and becomes the active
    // provider. It now appears under "Installed on this machine" as Active.
    const installed = await within(dialog).findByRole("list", {
      name: "Installed on this machine",
    });
    expect(await within(installed).findByText("qwen2.5:7b")).toBeInTheDocument();
    expect(within(installed).getByText("Active")).toBeInTheDocument();

    // Close Settings → the chat pane re-reads status and lands on local chat, with
    // the model tag in its status pill (never OpenRouter's default).
    await user.click(within(dialog).getByRole("button", { name: "Close settings" }));
    const composer = await screen.findByLabelText("Ask across your vault");
    expect(screen.getByText("qwen2.5:7b")).toBeInTheDocument();

    // A real cited-chat turn runs against the local provider.
    await user.type(composer, "what is the mitochondrion?");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(
      await screen.findByText(/powerhouse of the cell\./),
    ).toBeInTheDocument();
  });
});

describe("Journey 8: local AI — reconfigure from the Settings cog", () => {
  it("switches an OpenRouter user to an already-installed local model", async () => {
    const installedModels: InstalledModel[] = [
      {
        tag: "llama3.2:3b",
        sizeBytes: 2_000_000_000,
        family: "llama",
        parameterSize: "3.2B",
        quantization: "Q4_K_M",
      },
    ];
    const { user } = await openWorkspace({
      apiKey: { hasKey: true, model: "anthropic/claude-sonnet-4.5" }, // OpenRouter active
      installedModels,
    });

    // The ribbon Settings cog is now a live control (not the inert placeholder).
    await user.click(screen.getByRole("button", { name: "Settings" }));
    const dialog = await screen.findByRole("dialog");

    // The installed local model offers "Use this model"; switch to it.
    const installed = await within(dialog).findByRole("list", {
      name: "Installed on this machine",
    });
    const row = within(installed).getByText("llama3.2:3b").closest("li");
    expect(row).not.toBeNull();
    await user.click(within(row!).getByRole("button", { name: "Use this model" }));

    // It becomes the active model — the row now reads Active rather than offering
    // the switch.
    expect(await within(row!).findByText("Active")).toBeInTheDocument();
    expect(
      within(row!).queryByRole("button", { name: "Use this model" }),
    ).not.toBeInTheDocument();
  });
});
