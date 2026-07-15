import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../updater";

// A configurable coordinator so every UpdateStatus branch and the autostart
// error paths can be driven, complementing the happy-path GeneralSettingsPage
// suite (which pins the coordinator to "upToDate").
const { coordinator, reviewUpdate } = vi.hoisted(() => ({
  coordinator: { state: { status: "idle" } as UpdateState },
  reviewUpdate: vi.fn(),
}));

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({
    preferences: { automaticUpdateChecks: true },
    saving: false,
    update: vi.fn().mockResolvedValue(true),
  }),
}));
vi.mock("../updates/UpdateCoordinator", () => ({
  useUpdateCoordinator: () => ({
    state: coordinator.state,
    lastAutomaticError: null,
    check: vi.fn().mockResolvedValue(undefined),
    review: reviewUpdate,
  }),
}));
vi.mock("../updater", () => ({
  getAutostartEnabled: vi.fn(),
  setAutostartEnabled: vi.fn(),
}));

import { getAutostartEnabled, setAutostartEnabled } from "../updater";
import { ToastProvider } from "../notifications";
import { GeneralSettingsPage } from "./GeneralSettingsPage";

const UPDATE = { version: "9.9.9" };

beforeEach(() => {
  coordinator.state = { status: "idle" };
  reviewUpdate.mockReset();
  vi.mocked(getAutostartEnabled).mockReset().mockResolvedValue(false);
  vi.mocked(setAutostartEnabled).mockReset().mockResolvedValue(true);
});

function renderPage() {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <GeneralSettingsPage />
    </ToastProvider>,
  );
  return user;
}

describe("GeneralSettingsPage — update status branches", () => {
  const cases: ReadonlyArray<readonly [string, UpdateState, string]> = [
    ["idle", { status: "idle" }, "Ready to check."],
    ["upToDate", { status: "upToDate" }, "NeuralNote is up to date."],
    ["checking", { status: "checking", source: "manual" }, "Checking for updates…"],
    [
      "installing",
      { status: "installing", update: UPDATE, downloadedBytes: 0 },
      "Installing update…",
    ],
    ["relaunching", { status: "relaunching", update: UPDATE }, "Relaunching…"],
    [
      "checkFailed",
      { status: "checkFailed", message: "network down" },
      "Update check failed: network down",
    ],
    [
      "installFailed",
      { status: "installFailed", update: UPDATE, message: "bad signature" },
      "Install failed: bad signature",
    ],
  ];

  it.each(cases)("renders the %s status message", (_name, state, message) => {
    coordinator.state = state;
    renderPage();
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("disables the check button while a check is running", () => {
    coordinator.state = { status: "checking", source: "manual" };
    renderPage();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeDisabled();
  });

  it("offers a Review update action when a version is available", async () => {
    coordinator.state = { status: "available", update: UPDATE };
    const user = renderPage();

    expect(screen.getByText("Version 9.9.9 is available.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Review update" }));
    expect(reviewUpdate).toHaveBeenCalledOnce();
  });
});

describe("GeneralSettingsPage — startup registration failures", () => {
  it("falls back to disabled and warns when startup state cannot be read", async () => {
    vi.mocked(getAutostartEnabled).mockRejectedValue({
      kind: "io",
      message: "registration unreadable",
    });
    renderPage();

    const startup = await screen.findByRole("checkbox", {
      name: "Start NeuralNote on login",
    });
    expect(startup).not.toBeChecked();
    expect(
      await screen.findByText(/Startup registration could not be read/),
    ).toBeInTheDocument();
  });

  it("re-reads the OS state and surfaces the failure when a change is rejected", async () => {
    vi.mocked(getAutostartEnabled).mockResolvedValue(false);
    vi.mocked(setAutostartEnabled).mockRejectedValue({
      kind: "io",
      message: "permission denied",
    });
    const user = renderPage();

    const startup = await screen.findByRole("checkbox", {
      name: "Start NeuralNote on login",
    });
    await user.click(startup);

    expect(
      await screen.findByText(/Startup registration could not be changed/),
    ).toBeInTheDocument();
    // The failure path re-reads the persisted OS truth to keep the toggle honest.
    await waitFor(() => expect(getAutostartEnabled).toHaveBeenCalledTimes(2));
  });
});
