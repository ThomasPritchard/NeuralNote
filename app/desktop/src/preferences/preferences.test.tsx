import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, saveAppPreferences: vi.fn(), loadAppPreferences: vi.fn() };
});

import * as api from "../lib/api";
import { ToastProvider } from "../notifications";
import {
  DEFAULT_PREFERENCES,
  PreferencesProvider,
  WRITE_REFUSED_MESSAGE,
  applyPreferences,
  bootstrapPreferences,
  usePreferences,
  type PreferencesBootstrap,
} from "./preferences";

const LOADED: PreferencesBootstrap = {
  preferences: {
    automaticUpdateChecks: true,
    theme: "forestLight",
    fontScale: "large",
    fontFamily: "sourceSerif4",
    lastSeenWhatsNewVersion: "0.1.1",
  },
  recoveredFromCorrupt: false,
  readFailed: false,
  recoveryMessage: null,
};

/** The preferences file could not be READ, so the user's stored bytes are
 *  intact and unseen. Writing anything would destroy settings they still have. */
const READ_FAILED: PreferencesBootstrap = {
  preferences: { ...DEFAULT_PREFERENCES },
  recoveredFromCorrupt: false,
  readFailed: true,
  recoveryMessage: "Your saved settings could not be read.",
};

/** The file was read but its JSON was unusable, so the core already fell back to
 *  defaults. The stored bytes are junk — overwriting them is a repair, not a loss. */
const CORRUPT_RECOVERED: PreferencesBootstrap = {
  preferences: { ...DEFAULT_PREFERENCES },
  recoveredFromCorrupt: true,
  readFailed: false,
  recoveryMessage: "Preferences were corrupt; safe defaults are active.",
};

function Probe({ onResult }: Readonly<{ onResult?: (saved: boolean) => void }>) {
  const { preferences, update } = usePreferences();
  return (
    <>
      <output>{preferences.theme}</output>
      <button
        type="button"
        onClick={() =>
          void update({ theme: "oceanBlueDark" }).then((saved) => onResult?.(saved))
        }
      >
        change theme
      </button>
    </>
  );
}

describe("preferences", () => {
  // Reset, not clear: every test below installs the api behaviour it needs, so a
  // leaked implementation would let one test's rejection surface in another's toast.
  beforeEach(() => {
    vi.resetAllMocks();
  });

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

  it("bootstraps and applies persisted preferences before mount", async () => {
    vi.mocked(api.loadAppPreferences).mockResolvedValue(LOADED);

    const loaded = await bootstrapPreferences();

    expect(loaded).toEqual(LOADED);
    expect(document.documentElement).toHaveAttribute("data-theme", "forestLight");
  });

  it("recovers to safe defaults when preferences cannot be loaded", async () => {
    vi.mocked(api.loadAppPreferences).mockRejectedValue({
      kind: "io",
      message: "preferences.json is unreadable",
    });

    const loaded = await bootstrapPreferences();

    // The core only throws when the file could not be READ — unparseable JSON
    // resolves with `recoveredFromCorrupt: true`. So a throw is never a corrupt
    // recovery, and labelling it as one is what let defaults be written back.
    expect(loaded.readFailed).toBe(true);
    expect(loaded.recoveredFromCorrupt).toBe(false);
    expect(loaded.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(loaded.recoveryMessage).toContain("preferences.json is unreadable");
    expect(document.documentElement).toHaveAttribute(
      "data-theme",
      DEFAULT_PREFERENCES.theme,
    );
  });

  it("keeps the prior preferences and reports failure when a save is rejected", async () => {
    vi.mocked(api.saveAppPreferences).mockRejectedValue({
      kind: "io",
      message: "disk full",
    });
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <PreferencesProvider initial={LOADED}>
          <Probe />
        </PreferencesProvider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "change theme" }));

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Settings could not be saved. disk full",
    );
    expect(screen.getByText("forestLight")).toBeInTheDocument();
  });

  it("surfaces corrupt preference recovery as a persistent error", () => {
    render(
      <ToastProvider>
        <PreferencesProvider initial={CORRUPT_RECOVERED}>
          <Probe />
        </PreferencesProvider>
      </ToastProvider>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Preferences were corrupt; safe defaults are active.",
    );
  });

  it("refuses to write over settings it could not read, and says so", async () => {
    const saved = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <PreferencesProvider initial={READ_FAILED}>
          <Probe onResult={saved} />
        </PreferencesProvider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "change theme" }));

    expect(api.saveAppPreferences).not.toHaveBeenCalled();
    expect(saved).toHaveBeenCalledWith(false);
    expect(
      screen.getByRole("alert", {
        name: `${WRITE_REFUSED_MESSAGE} notification`,
      }),
    ).toBeInTheDocument();
    // The DOM assertion above only proves *which* message shows. Pin what it has
    // to SAY, so the copy cannot be quietly watered down into a vague failure.
    expect(WRITE_REFUSED_MESSAGE).toMatch(/could not be read/i);
    expect(WRITE_REFUSED_MESSAGE).toMatch(/not been overwritten/i);
  });

  it("raises one refusal, not one per attempt, while settings are unreadable", async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <PreferencesProvider initial={READ_FAILED}>
          <Probe />
        </PreferencesProvider>
      </ToastProvider>,
    );

    const change = screen.getByRole("button", { name: "change theme" });
    await user.click(change);
    await user.click(change);

    expect(
      screen.getAllByRole("alert", {
        name: `${WRITE_REFUSED_MESSAGE} notification`,
      }),
    ).toHaveLength(1);
  });

  it("still saves after a corrupt-parse recovery, whose stored bytes are junk", async () => {
    vi.mocked(api.saveAppPreferences).mockResolvedValue(undefined);
    const saved = vi.fn();
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <PreferencesProvider initial={CORRUPT_RECOVERED}>
          <Probe onResult={saved} />
        </PreferencesProvider>
      </ToastProvider>,
    );

    await user.click(screen.getByRole("button", { name: "change theme" }));

    expect(api.saveAppPreferences).toHaveBeenCalledWith({
      ...DEFAULT_PREFERENCES,
      theme: "oceanBlueDark",
    });
    expect(saved).toHaveBeenCalledWith(true);
  });
});
