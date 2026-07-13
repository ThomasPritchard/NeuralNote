import { relaunch } from "@tauri-apps/plugin-process";
import {
  check,
  type DownloadEvent,
  type Update,
} from "@tauri-apps/plugin-updater";

import type {
  DownloadProgress,
  PlatformUpdate,
  UpdatePlatform,
} from "./service";

function wrapUpdate(update: Update): PlatformUpdate {
  return {
    version: update.version,
    ...(update.body === undefined ? {} : { notes: update.body }),
    ...(update.date === undefined ? {} : { date: update.date }),
    async downloadAndInstall(onProgress) {
      let downloadedBytes = 0;
      let totalBytes: number | undefined;
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          totalBytes = event.data.contentLength;
          onProgress?.({ downloadedBytes, totalBytes });
        } else if (event.event === "Progress") {
          downloadedBytes += event.data.chunkLength;
          const progress: DownloadProgress = {
            downloadedBytes,
            ...(totalBytes === undefined ? {} : { totalBytes }),
          };
          onProgress?.(progress);
        }
      });
    },
    close: () => update.close(),
  };
}

export const tauriUpdatePlatform: UpdatePlatform = {
  async check() {
    const update = await check();
    return update ? wrapUpdate(update) : null;
  },
  relaunch,
};
