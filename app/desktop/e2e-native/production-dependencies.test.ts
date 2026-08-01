import assert from "node:assert/strict";
import test from "node:test";

import { assertProductionDependencyTree } from "./production-dependencies.js";

test("accepts a production graph without native automation plugins", () => {
  assert.doesNotThrow(() =>
    assertProductionDependencyTree("desktop v0.2.1\n tauri v2.8.5\n tauri-plugin-log v2.8.0\n"),
  );
});

test("rejects either native automation plugin in the production graph", () => {
  for (const dependency of ["tauri-plugin-wdio", "tauri-plugin-wdio-webdriver"]) {
    assert.throws(
      () => assertProductionDependencyTree(`desktop v0.2.1\n ${dependency} v1.2.0\n`),
      /production dependency graph contains native automation/,
    );
  }
});
