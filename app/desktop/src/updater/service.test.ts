import { describe, expect, it, vi } from "vitest";

import {
  createUpdateService,
  type PlatformUpdate,
  type UpdatePlatform,
} from "./service";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function availableUpdate(): PlatformUpdate {
  return {
    version: "0.1.1",
    notes: "A safer alpha.",
    date: "2026-07-13T12:00:00Z",
    downloadAndInstall: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function platformWith(check: UpdatePlatform["check"]): UpdatePlatform {
  return {
    check,
    relaunch: vi.fn().mockResolvedValue(undefined),
  };
}

describe("update service", () => {
  it("reports checking then up-to-date for a manual check", async () => {
    const pending = deferred<PlatformUpdate | null>();
    const service = createUpdateService(platformWith(() => pending.promise));

    const check = service.check("manual");
    expect(service.getState()).toEqual({ status: "checking", source: "manual" });

    pending.resolve(null);
    await expect(check).resolves.toEqual({ status: "upToDate" });
    expect(service.getState()).toEqual({ status: "upToDate" });
  });

  it("keeps a background no-update result quiet", async () => {
    const service = createUpdateService(
      platformWith(vi.fn().mockResolvedValue(null)),
    );

    await expect(service.check("background")).resolves.toEqual({ status: "idle" });
    expect(service.getState()).toEqual({ status: "idle" });
  });

  it("exposes available metadata without downloading or relaunching", async () => {
    const update = availableUpdate();
    const platform = platformWith(vi.fn().mockResolvedValue(update));
    const service = createUpdateService(platform);

    await expect(service.check("background")).resolves.toEqual({
      status: "available",
      update: {
        version: "0.1.1",
        notes: "A safer alpha.",
        date: "2026-07-13T12:00:00Z",
      },
    });
    expect(update.downloadAndInstall).not.toHaveBeenCalled();
    expect(platform.relaunch).not.toHaveBeenCalled();
  });

  it("downloads, installs, and relaunches only after the explicit install call", async () => {
    const update = availableUpdate();
    const platform = platformWith(vi.fn().mockResolvedValue(update));
    const service = createUpdateService(platform);
    await service.check("manual");

    await service.installAndRelaunch();

    expect(update.downloadAndInstall).toHaveBeenCalledOnce();
    expect(platform.relaunch).toHaveBeenCalledOnce();
  });

  it("runs only one install when consent is activated twice before React can disable the button", async () => {
    const download = deferred<void>();
    const update = availableUpdate();
    vi.mocked(update.downloadAndInstall).mockReturnValueOnce(download.promise);
    const platform = platformWith(vi.fn().mockResolvedValue(update));
    const service = createUpdateService(platform);
    await service.check("manual");

    const first = service.installAndRelaunch();
    await expect(service.installAndRelaunch()).rejects.toThrow(
      "An update installation is already in progress.",
    );
    expect(update.downloadAndInstall).toHaveBeenCalledOnce();

    download.resolve();
    await first;
    expect(platform.relaunch).toHaveBeenCalledOnce();
  });

  it("publishes download progress to state subscribers", async () => {
    const update = availableUpdate();
    vi.mocked(update.downloadAndInstall).mockImplementationOnce(async (onProgress) => {
      onProgress?.({ downloadedBytes: 40, totalBytes: 100 });
    });
    const service = createUpdateService(
      platformWith(vi.fn().mockResolvedValue(update)),
    );
    const listener = vi.fn();
    const unsubscribe = service.subscribe(listener);
    await service.check("manual");

    await service.installAndRelaunch();
    unsubscribe();

    expect(listener).toHaveBeenCalledWith({
      status: "installing",
      update: {
        version: "0.1.1",
        notes: "A safer alpha.",
        date: "2026-07-13T12:00:00Z",
      },
      downloadedBytes: 40,
      totalBytes: 100,
    });
  });

  it("does not relaunch after an interrupted download and keeps the update retryable", async () => {
    const update = availableUpdate();
    vi.mocked(update.downloadAndInstall).mockRejectedValueOnce(
      new Error("connection lost"),
    );
    const platform = platformWith(vi.fn().mockResolvedValue(update));
    const service = createUpdateService(platform);
    await service.check("manual");

    await expect(service.installAndRelaunch()).rejects.toThrow("connection lost");
    expect(platform.relaunch).not.toHaveBeenCalled();
    expect(service.getState()).toEqual({
      status: "installFailed",
      update: {
        version: "0.1.1",
        notes: "A safer alpha.",
        date: "2026-07-13T12:00:00Z",
      },
      message: "connection lost",
    });
  });

  it("retains automatic-check failures and reports them once per session", async () => {
    const onAutomaticError = vi.fn();
    const platform = platformWith(
      vi.fn().mockRejectedValue(new Error("manifest unavailable")),
    );
    const service = createUpdateService(platform);
    service.subscribeAutomaticErrors(onAutomaticError);

    await expect(service.check("background")).rejects.toThrow("manifest unavailable");
    await expect(service.check("background")).rejects.toThrow("manifest unavailable");

    expect(onAutomaticError).toHaveBeenCalledOnce();
    expect(service.getLastAutomaticError()).toBe("manifest unavailable");
    expect(service.getState()).toEqual({ status: "idle" });
  });

  it("shows manual-check failures in state", async () => {
    const service = createUpdateService(
      platformWith(vi.fn().mockRejectedValue("offline")),
    );

    await expect(service.check("manual")).rejects.toBe("offline");
    expect(service.getState()).toEqual({
      status: "checkFailed",
      message: "offline",
    });
  });

  it("preserves the update error when an automatic-error observer fails", async () => {
    const service = createUpdateService(
      platformWith(vi.fn().mockRejectedValue(new Error("signature rejected"))),
    );
    service.subscribeAutomaticErrors(() => {
      throw new Error("toast unavailable");
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(service.check("background")).rejects.toThrow("signature rejected");
    expect(service.getLastAutomaticError()).toBe("signature rejected");
    expect(consoleError).toHaveBeenCalledWith(
      "Automatic update error observer failed:",
      expect.any(Error),
    );
  });

  it("closes a superseded update resource", async () => {
    const update = availableUpdate();
    const check = vi.fn()
      .mockResolvedValueOnce(update)
      .mockResolvedValueOnce(null);
    const service = createUpdateService(platformWith(check));

    await service.check("manual");
    await service.check("manual");

    expect(update.close).toHaveBeenCalledOnce();
  });

  it("disposes retained resources and subscriptions", async () => {
    const update = availableUpdate();
    const service = createUpdateService(
      platformWith(vi.fn().mockResolvedValue(update)),
    );
    const stateListener = vi.fn();
    const automaticErrorListener = vi.fn();
    service.subscribe(stateListener);
    const unsubscribeAutomaticError = service.subscribeAutomaticErrors(
      automaticErrorListener,
    );
    await service.check("manual");

    unsubscribeAutomaticError();
    await service.dispose();

    expect(update.close).toHaveBeenCalledOnce();
  });

  it("rejects install attempts when no update was accepted", async () => {
    const platform = platformWith(vi.fn().mockResolvedValue(null));
    const service = createUpdateService(platform);

    await expect(service.installAndRelaunch()).rejects.toThrow(
      "No update is available to install.",
    );
    expect(platform.relaunch).not.toHaveBeenCalled();
  });
});
