import { describe, expect, it, vi } from "vitest";

vi.mock("./platform", () => ({
  tauriUpdatePlatform: {
    check: vi.fn().mockResolvedValue(null),
    relaunch: vi.fn().mockResolvedValue(undefined),
  },
}));

import { updateService } from "./index";

describe("app updater boundary", () => {
  it("exports a ready, app-owned update service", () => {
    expect(updateService.getState()).toEqual({ status: "idle" });
  });
});
