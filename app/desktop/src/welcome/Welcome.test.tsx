import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Drive Welcome through a fully-controlled useVault so each branch is deterministic.
const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));
vi.mock("../lib/store", () => ({ useVault: mockUseVault }));

import type { VaultContextValue } from "../lib/store";
import { Welcome } from "./Welcome";

function ctx(over: Partial<VaultContextValue> = {}): VaultContextValue {
  return {
    status: "welcome",
    vault: null,
    tree: [],
    recents: [],
    error: null,
    clearError: vi.fn(),
    reportError: vi.fn(),
    refreshRecents: vi.fn().mockResolvedValue(undefined),
    openExisting: vi.fn().mockResolvedValue(undefined),
    openByPath: vi.fn().mockResolvedValue(undefined),
    pickNewLocation: vi.fn().mockResolvedValue(null),
    createVault: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    refreshTree: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

beforeEach(() => {
  mockUseVault.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Welcome — default state", () => {
  it("shows brand, actions, recents and the non-destructive footer", () => {
    mockUseVault.mockReturnValue(
      ctx({ recents: [{ name: "Brain", path: "/Brain", lastOpened: 1 }] }),
    );
    render(<Welcome />);
    expect(screen.getByRole("heading", { name: "NeuralNote" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open vault/i })).toBeInTheDocument();
    expect(screen.getByText("Brain")).toBeInTheDocument();
    expect(screen.getByText(/non-destructive/i)).toBeInTheDocument();
  });

  it("opens an existing vault and a recent vault", async () => {
    const value = ctx({ recents: [{ name: "Brain", path: "/Brain", lastOpened: 1 }] });
    mockUseVault.mockReturnValue(value);
    render(<Welcome />);

    await userEvent.click(screen.getByRole("button", { name: /Open vault/i }));
    expect(value.openExisting).toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Open Brain" }));
    expect(value.openByPath).toHaveBeenCalledWith("/Brain");
  });
});

describe("Welcome — window chrome", () => {
  it("exposes a titlebar drag region with no content of its own", () => {
    // With the overlay titlebar this screen has no chrome, so the drag strip
    // is what keeps the window movable from the welcome state.
    mockUseVault.mockReturnValue(ctx());
    const { container } = render(<Welcome />);
    const strip = container.querySelector("[data-tauri-drag-region]");
    expect(strip).not.toBeNull();
    expect(strip).toHaveAttribute("aria-hidden");
    expect(strip?.childElementCount).toBe(0);
  });

  it("keeps the populated welcome content scrollable at the minimum window height", () => {
    mockUseVault.mockReturnValue(
      ctx({
        recents: [
          { name: "Brain", path: "/Brain", lastOpened: 2 },
          { name: "Archive", path: "/Archive", lastOpened: 1 },
        ],
      }),
    );
    const { container } = render(<Welcome />);

    expect(container.firstElementChild).toHaveClass("nn-welcome");
    expect(container.firstElementChild).toHaveClass("overflow-y-auto");
  });
});

describe("Welcome — error channel", () => {
  it("renders a dismissible error alert", async () => {
    const value = ctx({ error: "Not a vault" });
    mockUseVault.mockReturnValue(value);
    render(<Welcome />);
    expect(screen.getByRole("alert")).toHaveTextContent("Not a vault");
    await userEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(value.clearError).toHaveBeenCalled();
  });
});

describe("Welcome — loading", () => {
  it("shows the opening-vault panel and hides recents", () => {
    mockUseVault.mockReturnValue(ctx({ status: "loading" }));
    render(<Welcome />);
    expect(screen.getByText("Opening vault…")).toBeInTheDocument();
    expect(screen.queryByText("Recent")).not.toBeInTheDocument();
  });
});

describe("Welcome — create flow", () => {
  it("steps from picking a parent to naming and creating the vault", async () => {
    const value = ctx({ pickNewLocation: vi.fn().mockResolvedValue("/parent") });
    mockUseVault.mockReturnValue(value);
    render(<Welcome />);

    await userEvent.click(screen.getByRole("button", { name: /New vault/i }));
    // The naming step appears once a parent is chosen.
    expect(await screen.findByText("/parent")).toBeInTheDocument();

    await userEvent.type(screen.getByLabelText("Vault name"), "Fresh");
    await userEvent.click(screen.getByRole("button", { name: /Create vault/i }));
    expect(value.createVault).toHaveBeenCalledWith("/parent", "Fresh");
  });

  it("returns to the action buttons when the naming step is cancelled", async () => {
    const value = ctx({ pickNewLocation: vi.fn().mockResolvedValue("/parent") });
    mockUseVault.mockReturnValue(value);
    render(<Welcome />);

    await userEvent.click(screen.getByRole("button", { name: /New vault/i }));
    await screen.findByText("/parent");
    await userEvent.click(screen.getByRole("button", { name: /Back/i }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: /Open vault/i })).toBeInTheDocument(),
    );
  });

  it("stays on the action buttons when the picker is cancelled", async () => {
    const value = ctx({ pickNewLocation: vi.fn().mockResolvedValue(null) });
    mockUseVault.mockReturnValue(value);
    render(<Welcome />);

    await userEvent.click(screen.getByRole("button", { name: /New vault/i }));
    await waitFor(() => expect(value.pickNewLocation).toHaveBeenCalled());
    expect(screen.queryByLabelText("Vault name")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Open vault/i })).toBeInTheDocument();
  });
});
