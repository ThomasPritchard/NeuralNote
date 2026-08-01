import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { browser } from "@wdio/globals";

import {
  fixturePaths,
  invoke,
  invokeOutcome,
  nativeWait,
  openFixtureVault,
} from "./native-helpers.js";

describe("NeuralNote native authority and watcher lifecycle", () => {
  it("rejects an unauthorised direct IPC vault open", async () => {
    const paths = fixturePaths();
    const outside = path.join(paths.root, "vaults", "Never Authorised");
    mkdirSync(outside);

    const result = await invokeOutcome("open_vault", { path: outside });

    assert.equal(result.ok, false);
    assert.match(JSON.stringify(result.error), /not chosen via the folder picker|outsideVault/i);
  });

  it("emits a clean external edit and stops watching after close", async () => {
    await openFixtureVault();
    await browser.execute(async () => {
      const state = globalThis as typeof globalThis & {
        nativeE2eTreeEvents?: number;
        nativeE2eUnlisten?: () => void;
      };
      const tauri = Reflect.get(globalThis, "__TAURI__") as
        | {
            event?: {
              listen: (name: string, callback: () => void) => Promise<() => void>;
            };
          }
        | undefined;
      state.nativeE2eTreeEvents = 0;
      state.nativeE2eUnlisten = await tauri?.event?.listen(
        "vault://tree-changed",
        () => {
          state.nativeE2eTreeEvents = (state.nativeE2eTreeEvents ?? 0) + 1;
        },
      );
    });

    const external = path.join(fixturePaths().vault, "External.md");
    writeFileSync(external, "external one\n", "utf8");
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            (globalThis as typeof globalThis & { nativeE2eTreeEvents?: number })
              .nativeE2eTreeEvents ?? 0,
        )) > 0,
      { timeout: nativeWait(10_000), interval: 50 },
    );

    await invoke("close_vault");
    const countAfterClose = await browser.execute(
      () =>
        (globalThis as typeof globalThis & { nativeE2eTreeEvents?: number })
          .nativeE2eTreeEvents ?? 0,
    );
    writeFileSync(external, "external two\n", "utf8");

    let eventAfterClose = false;
    try {
      await browser.waitUntil(
        async () =>
          (await browser.execute(
            () =>
              (globalThis as typeof globalThis & { nativeE2eTreeEvents?: number })
                .nativeE2eTreeEvents ?? 0,
          )) > countAfterClose,
        { timeout: nativeWait(750), interval: 50 },
      );
      eventAfterClose = true;
    } catch {
      eventAfterClose = false;
    }
    assert.equal(eventAfterClose, false);
  });
});
