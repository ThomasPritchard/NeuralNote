import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { update } = vi.hoisted(() => ({ update: vi.fn() }));
vi.mock("../preferences/preferences", () => ({
  usePreferences: () => ({
    preferences: {
      automaticUpdateChecks: true,
      theme: "neuralVioletDark",
      fontScale: "default",
      fontFamily: "inter",
    },
    saving: false,
    update,
  }),
}));

import { AppearanceSettingsPage } from "./AppearanceSettingsPage";

beforeEach(() => {
  update.mockReset().mockResolvedValue(true);
});

describe("AppearanceSettingsPage", () => {
  it("offers all six explicit complete themes", () => {
    render(<AppearanceSettingsPage />);
    for (const name of [
      "Neural Violet Light",
      "Neural Violet Dark",
      "Ocean Blue Light",
      "Ocean Blue Dark",
      "Forest Light",
      "Forest Dark",
    ]) {
      expect(screen.getByRole("radio", { name })).toBeInTheDocument();
    }
    expect(screen.getByRole("radio", { name: "Neural Violet Dark" })).toBeChecked();
  });

  it("persists theme, font family, and scale changes", async () => {
    const user = userEvent.setup();
    render(<AppearanceSettingsPage />);

    await user.click(screen.getByRole("radio", { name: "Forest Light" }));
    await user.selectOptions(screen.getByLabelText("Font family"), "sourceSerif4");
    await user.click(screen.getByRole("radio", { name: "Large 112.5%" }));

    expect(update).toHaveBeenNthCalledWith(
      1,
      { theme: "forestLight" },
      "Appearance saved",
    );
    expect(update).toHaveBeenNthCalledWith(
      2,
      { fontFamily: "sourceSerif4" },
      "Appearance saved",
    );
    expect(update).toHaveBeenNthCalledWith(
      3,
      { fontScale: "large" },
      "Appearance saved",
    );
  });
});
