import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { updatePreferences, checkUpdates, updateContext } = vi.hoisted(() => ({
  updatePreferences: vi.fn(),
  checkUpdates: vi.fn(),
  updateContext: {
    lastAutomaticError: null as string | null,
  },
}));

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({
    preferences: { automaticUpdateChecks: true },
    saving: false,
    update: updatePreferences,
  }),
}));
vi.mock("../updates/UpdateCoordinator", () => ({
  useUpdateCoordinator: () => ({
    state: { status: "upToDate" },
    lastAutomaticError: updateContext.lastAutomaticError,
    check: checkUpdates,
    review: vi.fn(),
  }),
}));
vi.mock("../updater", () => ({
  getAutostartEnabled: vi.fn(),
  setAutostartEnabled: vi.fn(),
}));

import { getAutostartEnabled, setAutostartEnabled } from "../updater";
import { ToastProvider } from "../notifications";
import { GeneralSettingsPage } from "./GeneralSettingsPage";

beforeEach(() => {
  updatePreferences.mockReset().mockResolvedValue(true);
  checkUpdates.mockReset().mockResolvedValue(undefined);
  vi.mocked(getAutostartEnabled).mockReset().mockResolvedValue(false);
  vi.mocked(setAutostartEnabled).mockReset().mockResolvedValue(true);
  updateContext.lastAutomaticError = null;
});

function setup() {
  const user = userEvent.setup();
  render(<ToastProvider><GeneralSettingsPage /></ToastProvider>);
  return user;
}

describe("GeneralSettingsPage", () => {
  it("shows manual update status and checks only on explicit click", async () => {
    const user = setup();
    expect(screen.getByText("NeuralNote is up to date.")).toBeInTheDocument();
    expect(checkUpdates).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "Check for updates" }));
    expect(checkUpdates).toHaveBeenCalledWith("manual");
  });

  it("persists automatic checks and drives login startup from OS state", async () => {
    const user = setup();
    const automatic = screen.getByRole("checkbox", { name: "Automatically check for updates" });
    expect(automatic).toBeChecked();
    await user.click(automatic);
    expect(updatePreferences).toHaveBeenCalledWith(
      { automaticUpdateChecks: false },
      "Update preference saved",
    );

    const startup = await screen.findByRole("checkbox", { name: "Start NeuralNote on login" });
    expect(startup).not.toBeChecked();
    await user.click(startup);
    expect(setAutostartEnabled).toHaveBeenCalledWith(true);
  });

  it("retains the last automatic-check failure in Settings", () => {
    updateContext.lastAutomaticError = "Manifest unavailable.";

    setup();

    expect(
      screen.getByText("Last automatic update check failed: Manifest unavailable."),
    ).toBeInTheDocument();
  });
});
