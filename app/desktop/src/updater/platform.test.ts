import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/plugin-updater", () => ({ check: vi.fn() }));
vi.mock("@tauri-apps/plugin-process", () => ({ relaunch: vi.fn() }));

import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

import { tauriUpdatePlatform } from "./platform";

const downloadAndInstall = vi.fn();
const close = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  downloadAndInstall.mockResolvedValue(undefined);
  close.mockResolvedValue(undefined);
  vi.mocked(check).mockResolvedValue({
    version: "0.1.1",
    body: "Release notes",
    date: "2026-07-13T12:00:00Z",
    downloadAndInstall,
    close,
  } as never);
});

describe("Tauri updater boundary", () => {
  it("maps vendor metadata without downloading during a check", async () => {
    const update = await tauriUpdatePlatform.check();

    expect(update).toMatchObject({
      version: "0.1.1",
      notes: "Release notes",
      date: "2026-07-13T12:00:00Z",
    });
    expect(downloadAndInstall).not.toHaveBeenCalled();
  });

  it("translates Tauri download events into cumulative app progress", async () => {
    downloadAndInstall.mockImplementationOnce(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: 100 } });
      onEvent({ event: "Progress", data: { chunkLength: 25 } });
      onEvent({ event: "Progress", data: { chunkLength: 30 } });
    });
    const update = await tauriUpdatePlatform.check();
    const onProgress = vi.fn();

    await update?.downloadAndInstall(onProgress);

    expect(onProgress).toHaveBeenNthCalledWith(1, {
      downloadedBytes: 0,
      totalBytes: 100,
    });
    expect(onProgress).toHaveBeenNthCalledWith(2, {
      downloadedBytes: 25,
      totalBytes: 100,
    });
    expect(onProgress).toHaveBeenNthCalledWith(3, {
      downloadedBytes: 55,
      totalBytes: 100,
    });
  });

  it("handles unknown totals, finished events, and resource cleanup", async () => {
    downloadAndInstall.mockImplementationOnce(async (onEvent) => {
      onEvent({ event: "Started", data: { contentLength: undefined } });
      onEvent({ event: "Progress", data: { chunkLength: 12 } });
      onEvent({ event: "Finished" });
    });
    const update = await tauriUpdatePlatform.check();
    const onProgress = vi.fn();

    await update?.downloadAndInstall(onProgress);
    await update?.close();

    expect(onProgress).toHaveBeenLastCalledWith({ downloadedBytes: 12 });
    expect(close).toHaveBeenCalledOnce();
  });

  it("returns null when Tauri reports no update", async () => {
    vi.mocked(check).mockResolvedValueOnce(null);

    await expect(tauriUpdatePlatform.check()).resolves.toBeNull();
  });

  it("delegates relaunch to the process plugin", async () => {
    vi.mocked(relaunch).mockResolvedValue(undefined);

    await tauriUpdatePlatform.relaunch();

    expect(relaunch).toHaveBeenCalledOnce();
  });
});
