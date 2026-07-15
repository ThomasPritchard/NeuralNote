import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import type { AppPreferencesLoad } from "./lib/types";

const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));

vi.mock("./lib/api", async (importActual) => {
  const actual = await importActual<typeof import("./lib/api")>();
  return { ...actual, saveAppPreferences: vi.fn() };
});

vi.mock("./lib/store", () => ({
  VaultProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useVault: mockUseVault,
}));
vi.mock("./welcome/Welcome", () => ({
  Welcome: () => <div>welcome-screen</div>,
}));
vi.mock("./workspace/Workspace", () => ({
  Workspace: () => <div>workspace-screen</div>,
}));
vi.mock("./updates/UpdateCoordinator", () => ({
  UpdateCoordinator: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import * as api from "./lib/api";
import App from "./App";

const SEEN_0_2: AppPreferencesLoad = {
  preferences: {
    automaticUpdateChecks: true,
    theme: "neuralVioletDark",
    fontScale: "default",
    fontFamily: "inter",
    lastSeenWhatsNewVersion: "0.2.0",
  },
  recoveredFromCorrupt: false,
  recoveryMessage: null,
};

afterEach(() => {
  mockUseVault.mockReset();
  vi.mocked(api.saveAppPreferences).mockReset();
});

describe("App router", () => {
  it("renders the welcome screen when no vault is open", () => {
    mockUseVault.mockReturnValue({ status: "welcome" });
    render(<App initialPreferences={SEEN_0_2} />);
    expect(screen.getByText("welcome-screen")).toBeInTheDocument();
    expect(screen.queryByText("workspace-screen")).not.toBeInTheDocument();
  });

  it("renders the welcome screen during the loading state", () => {
    mockUseVault.mockReturnValue({ status: "loading" });
    render(<App initialPreferences={SEEN_0_2} />);
    expect(screen.getByText("welcome-screen")).toBeInTheDocument();
  });

  it("renders the workspace once a vault is open", () => {
    mockUseVault.mockReturnValue({ status: "open" });
    render(<App initialPreferences={SEEN_0_2} />);
    expect(screen.getByText("workspace-screen")).toBeInTheDocument();
  });

  it("shows What's new before a vault is open when this version has not been seen", () => {
    mockUseVault.mockReturnValue({ status: "welcome" });
    render(
      <App
        initialPreferences={{
          ...SEEN_0_2,
          preferences: {
            ...SEEN_0_2.preferences,
            lastSeenWhatsNewVersion: null,
          },
        }}
      />,
    );

    const dialog = screen.getByRole("dialog", {
      name: "What's new in NeuralNote 0.2.0",
    });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveFocus();
    expect(screen.getByText("welcome-screen")).toBeInTheDocument();
  });

  it("does not reopen What's new when the installed version is already acknowledged", () => {
    mockUseVault.mockReturnValue({ status: "welcome" });
    render(<App initialPreferences={SEEN_0_2} />);

    expect(screen.queryByRole("dialog", { name: /what's new/i })).not.toBeInTheDocument();
  });

  it("dismisses What's new and persists the current version globally", async () => {
    vi.mocked(api.saveAppPreferences).mockResolvedValue(undefined);
    mockUseVault.mockReturnValue({ status: "welcome" });
    const user = userEvent.setup();
    render(
      <App
        initialPreferences={{
          ...SEEN_0_2,
          preferences: {
            ...SEEN_0_2.preferences,
            lastSeenWhatsNewVersion: "0.1.1",
          },
        }}
      />,
    );

    expect(api.saveAppPreferences).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Continue to NeuralNote" }));

    expect(screen.queryByRole("dialog", { name: /what's new/i })).not.toBeInTheDocument();
    await waitFor(() =>
      expect(api.saveAppPreferences).toHaveBeenCalledWith({
        ...SEEN_0_2.preferences,
        lastSeenWhatsNewVersion: "0.2.0",
      }),
    );
  });

  it("closes What's new but reports an acknowledgement write failure", async () => {
    vi.mocked(api.saveAppPreferences).mockRejectedValue(new Error("disk is read-only"));
    mockUseVault.mockReturnValue({ status: "welcome" });
    const user = userEvent.setup();
    render(
      <App
        initialPreferences={{
          ...SEEN_0_2,
          preferences: {
            ...SEEN_0_2.preferences,
            lastSeenWhatsNewVersion: null,
          },
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Continue to NeuralNote" }));

    expect(screen.queryByRole("dialog", { name: /what's new/i })).not.toBeInTheDocument();
    expect(await screen.findByText(/settings could not be saved.*disk is read-only/i)).toBeInTheDocument();
  });
});
