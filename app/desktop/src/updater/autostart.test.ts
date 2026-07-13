import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-autostart", () => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}));

import { disable, enable, isEnabled } from "@tauri-apps/plugin-autostart";

import { getAutostartEnabled, setAutostartEnabled } from "./autostart";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("autostart boundary", () => {
  it("reads registration state from the operating system", async () => {
    vi.mocked(isEnabled).mockResolvedValue(true);

    await expect(getAutostartEnabled()).resolves.toBe(true);
    expect(isEnabled).toHaveBeenCalledOnce();
  });

  it("enables registration and returns the confirmed operating-system state", async () => {
    vi.mocked(enable).mockResolvedValue(undefined);
    vi.mocked(isEnabled).mockResolvedValue(true);

    await expect(setAutostartEnabled(true)).resolves.toBe(true);
    expect(enable).toHaveBeenCalledOnce();
    expect(disable).not.toHaveBeenCalled();
    expect(isEnabled).toHaveBeenCalledOnce();
  });

  it("disables registration and returns the confirmed operating-system state", async () => {
    vi.mocked(disable).mockResolvedValue(undefined);
    vi.mocked(isEnabled).mockResolvedValue(false);

    await expect(setAutostartEnabled(false)).resolves.toBe(false);
    expect(disable).toHaveBeenCalledOnce();
    expect(enable).not.toHaveBeenCalled();
    expect(isEnabled).toHaveBeenCalledOnce();
  });

  it("surfaces registration failures without returning cached state", async () => {
    vi.mocked(enable).mockRejectedValue(new Error("launch agent rejected"));

    await expect(setAutostartEnabled(true)).rejects.toThrow(
      "launch agent rejected",
    );
    expect(isEnabled).not.toHaveBeenCalled();
  });
});
