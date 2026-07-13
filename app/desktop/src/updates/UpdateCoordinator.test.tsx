import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../updater";

const mocks = vi.hoisted(() => {
  let stateListener: ((state: UpdateState) => void) | undefined;
  let automaticErrorListener: ((message: string) => void) | undefined;
  return {
    preferences: {
      automaticUpdateChecks: true,
      suppressAutomaticChecksThisLaunch: false,
    },
    toast: {
      error: vi.fn(),
      info: vi.fn(),
    },
    service: {
      getState: vi.fn<() => UpdateState>(() => ({ status: "idle" })),
      getLastAutomaticError: vi.fn<() => string | null>(() => null),
      check: vi.fn().mockResolvedValue({ status: "idle" }),
      installAndRelaunch: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn((listener: (state: UpdateState) => void) => {
        stateListener = listener;
        return vi.fn();
      }),
      subscribeAutomaticErrors: vi.fn((listener: (message: string) => void) => {
        automaticErrorListener = listener;
        return vi.fn();
      }),
    },
    publishState(state: UpdateState) {
      stateListener?.(state);
    },
    publishAutomaticError(message: string) {
      automaticErrorListener?.(message);
    },
    resetListeners() {
      stateListener = undefined;
      automaticErrorListener = undefined;
    },
  };
});

vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({
    preferences: {
      automaticUpdateChecks: mocks.preferences.automaticUpdateChecks,
    },
    suppressAutomaticChecksThisLaunch:
      mocks.preferences.suppressAutomaticChecksThisLaunch,
  }),
}));

vi.mock("../notifications", () => ({
  useToast: () => mocks.toast,
}));

vi.mock("../updater", async (importOriginal) => {
  const original = await importOriginal<typeof import("../updater")>();
  return { ...original, updateService: mocks.service };
});

import { UpdateCoordinator, useUpdateCoordinator } from "./UpdateCoordinator";

function AutomaticErrorStatus() {
  const { lastAutomaticError } = useUpdateCoordinator();
  return <p>{lastAutomaticError ?? "No automatic error"}</p>;
}

const available: UpdateState = {
  status: "available",
  update: {
    version: "0.1.1",
    notes: "A safer alpha with better updates.",
  },
};

describe("UpdateCoordinator", () => {
  beforeEach(() => {
    mocks.preferences.automaticUpdateChecks = true;
    mocks.preferences.suppressAutomaticChecksThisLaunch = false;
    mocks.resetListeners();
    mocks.service.getState.mockReturnValue({ status: "idle" });
    mocks.service.getLastAutomaticError.mockReturnValue(null);
    mocks.service.check.mockReset().mockResolvedValue({ status: "idle" });
    mocks.service.installAndRelaunch.mockReset().mockResolvedValue(undefined);
    mocks.service.subscribe.mockClear();
    mocks.service.subscribeAutomaticErrors.mockClear();
    mocks.toast.error.mockReset();
    mocks.toast.info.mockReset();
  });

  it("checks quietly after startup only when automatic checks are enabled", async () => {
    const view = render(<UpdateCoordinator>App</UpdateCoordinator>);

    await waitFor(() => {
      expect(mocks.service.check).toHaveBeenCalledExactlyOnceWith("background");
    });

    view.unmount();
    mocks.preferences.automaticUpdateChecks = false;
    render(<UpdateCoordinator>App</UpdateCoordinator>);

    expect(mocks.service.check).toHaveBeenCalledOnce();
  });

  it("suppresses the background check for a recovered-preferences launch", () => {
    mocks.preferences.suppressAutomaticChecksThisLaunch = true;

    render(<UpdateCoordinator>App</UpdateCoordinator>);

    expect(mocks.service.check).not.toHaveBeenCalled();
  });

  it("does not install until the available-update toast action is accepted", async () => {
    const user = userEvent.setup();
    render(<UpdateCoordinator>App</UpdateCoordinator>);

    act(() => mocks.publishState(available));
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());
    expect(mocks.service.installAndRelaunch).not.toHaveBeenCalled();

    const options = mocks.toast.info.mock.calls[0]?.[1];
    act(() => options?.action?.onClick());

    expect(
      screen.getByRole("heading", { name: "NeuralNote 0.1.1 is available" }),
    ).toBeInTheDocument();
    expect(screen.getByText("A safer alpha with better updates.")).toBeInTheDocument();
    expect(mocks.service.installAndRelaunch).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Later" }));
    expect(mocks.service.installAndRelaunch).not.toHaveBeenCalled();
  });

  it("installs and relaunches only from the explicit consent button", async () => {
    const user = userEvent.setup();
    render(<UpdateCoordinator>App</UpdateCoordinator>);
    act(() => mocks.publishState(available));
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());

    act(() => mocks.toast.info.mock.calls[0]?.[1]?.action?.onClick());
    await user.click(
      screen.getByRole("button", { name: "Install and relaunch" }),
    );

    expect(mocks.service.installAndRelaunch).toHaveBeenCalledOnce();
  });

  it("announces installation progress and removes the inert close affordance", async () => {
    render(<UpdateCoordinator>App</UpdateCoordinator>);
    act(() => mocks.publishState(available));
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());
    act(() => mocks.toast.info.mock.calls[0]?.[1]?.action?.onClick());

    act(() =>
      mocks.publishState({
        status: "installing",
        update: available.update,
        downloadedBytes: 0,
      }),
    );

    expect(screen.getByRole("status")).toHaveTextContent("Installing update");
    expect(screen.queryByRole("button", { name: "Close dialog" })).not.toBeInTheDocument();
  });

  it("keeps the dialog open and renders an interrupted-install failure", async () => {
    const user = userEvent.setup();
    mocks.service.installAndRelaunch.mockImplementation(async () => {
      mocks.publishState({
        status: "installFailed",
        update: available.update,
        message: "The signature could not be verified.",
      });
      throw new Error("The signature could not be verified.");
    });
    render(<UpdateCoordinator>App</UpdateCoordinator>);
    act(() => mocks.publishState(available));
    await waitFor(() => expect(mocks.toast.info).toHaveBeenCalledOnce());

    act(() => mocks.toast.info.mock.calls[0]?.[1]?.action?.onClick());
    await user.click(
      screen.getByRole("button", { name: "Install and relaunch" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The signature could not be verified.",
    );
    expect(
      screen.getByRole("heading", { name: "NeuralNote 0.1.1 is available" }),
    ).toBeInTheDocument();
  });

  it("surfaces automatic check errors once and retains the message in context", () => {
    render(
      <UpdateCoordinator>
        <AutomaticErrorStatus />
      </UpdateCoordinator>,
    );

    act(() => mocks.publishAutomaticError("Manifest unavailable."));

    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Automatic update check failed. Manifest unavailable.",
      { dedupKey: "automatic-update-error" },
    );
    expect(screen.getByText("Manifest unavailable.")).toBeInTheDocument();
  });
});
