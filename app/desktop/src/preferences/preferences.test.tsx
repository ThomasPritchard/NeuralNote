import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { AppPreferencesLoad } from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, saveAppPreferences: vi.fn() };
});

import * as api from "../lib/api";
import { ToastProvider } from "../notifications";
import {
  PreferencesProvider,
  applyPreferences,
  usePreferences,
} from "./preferences";

const LOADED: AppPreferencesLoad = {
  preferences: {
    automaticUpdateChecks: true,
    theme: "forestLight",
    fontScale: "large",
    fontFamily: "sourceSerif4",
  },
  recoveredFromCorrupt: false,
  recoveryMessage: null,
};

function Probe() {
  const { preferences, update } = usePreferences();
  return (
    <>
      <output>{preferences.theme}</output>
      <button type="button" onClick={() => void update({ theme: "oceanBlueDark" })}>
        change theme
      </button>
    </>
  );
}

describe("preferences", () => {
  it("applies theme, family, and scale before React mounts", () => {
    applyPreferences(LOADED.preferences, document.documentElement);
    expect(document.documentElement).toHaveAttribute("data-theme", "forestLight");
    expect(document.documentElement).toHaveAttribute(
      "data-font-family",
      "sourceSerif4",
    );
    expect(document.documentElement.style.fontSize).toBe("112.5%");
  });

  it("persists an update and reapplies it to the application root", async () => {
    vi.mocked(api.saveAppPreferences).mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <PreferencesProvider initial={LOADED}>
          <Probe />
        </PreferencesProvider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "change theme" }));
    expect(api.saveAppPreferences).toHaveBeenCalledWith({
      ...LOADED.preferences,
      theme: "oceanBlueDark",
    });
    expect(document.documentElement).toHaveAttribute("data-theme", "oceanBlueDark");
    expect(
      screen.getByRole("listitem", { name: "Settings saved notification" }),
    ).toBeInTheDocument();
  });

  it("surfaces corrupt preference recovery as a persistent error", () => {
    render(
      <ToastProvider>
        <PreferencesProvider
          initial={{
            ...LOADED,
            recoveredFromCorrupt: true,
            recoveryMessage: "Preferences were corrupt; safe defaults are active.",
          }}
        >
          <Probe />
        </PreferencesProvider>
      </ToastProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Preferences were corrupt; safe defaults are active.",
    );
  });
});
