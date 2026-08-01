import assert from "node:assert/strict";
import test from "node:test";

import { assertNativeFrontendReady } from "./tauri-bootstrap.js";

test("accepts a frontend with both Tauri and the WebdriverIO bootstrap", async () => {
  const calls: string[] = [];
  const driver = {
    execute: async (script: () => unknown): Promise<unknown> => {
      calls.push(script.toString());
      return script();
    },
  };
  const previousTauri = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    __TAURI__: { core: { invoke: () => undefined } },
    __wdio_original_core__: { invoke: () => undefined },
    wdioTauri: { waitForInit: async () => undefined },
    NEURALNOTE_NATIVE_E2E_BRIDGE_V1: {
      replaceFirst: () => true,
      matchesDocument: () => true,
      scrollTextIntoView: () => true,
      append: () => undefined,
      closeVaultViaNativeMenuAction: async () => undefined,
    },
  });

  try {
    await assertNativeFrontendReady(driver);
  } finally {
    Reflect.set(globalThis, "window", previousTauri);
  }

  assert.equal(calls.length, 2, "the readiness check must not poll or sleep");
});

test("diagnoses a missing test-only editor bridge before the first journey", async () => {
  const driver = {
    execute: async (script: () => unknown): Promise<unknown> => script(),
  };
  const previousTauri = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    __TAURI__: { core: { invoke: () => undefined } },
    __wdio_original_core__: { invoke: () => undefined },
    wdioTauri: { waitForInit: async () => undefined },
  });

  try {
    await assert.rejects(
      assertNativeFrontendReady(driver),
      /native E2E editor bridge is absent/,
    );
  } finally {
    Reflect.set(globalThis, "window", previousTauri);
  }
});

test("diagnoses a missing test-only frontend import before using browser.tauri", async () => {
  const driver = {
    execute: async (script: () => unknown): Promise<unknown> => script(),
  };
  const previousTauri = Reflect.get(globalThis, "window");
  Reflect.set(globalThis, "window", {
    __TAURI__: { core: { invoke: () => undefined } },
  });

  try {
    await assert.rejects(
      assertNativeFrontendReady(driver),
      /Tauri core is present, but the WebdriverIO frontend bootstrap is absent/,
    );
  } finally {
    Reflect.set(globalThis, "window", previousTauri);
  }
});
