import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanupNativeE2eRoot,
  createNativeE2eRoot,
  nativeE2eEnvironment,
} from "./native-root.js";
import {
  MARKDOWN_COMPATIBILITY_SOURCE,
  seedNativeFixtures,
} from "./native-fixtures.js";

function withParent(run: (parent: string) => void): void {
  const parent = mkdtempSync(path.join(os.tmpdir(), "neuralnote-native-root-test-"));
  try {
    run(parent);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

function withOwnedLayout(run: (layout: ReturnType<typeof createNativeE2eRoot>) => void): void {
  const layout = createNativeE2eRoot();
  try {
    run(layout);
  } finally {
    if (existsSync(layout.root)) rmSync(layout.root, { recursive: true, force: true });
  }
}

test("creates a private marked root without replacing HOME", () => {
  withOwnedLayout((layout) => {
    const inherited = { HOME: "/Users/example", PATH: "/usr/bin" };

    assert.equal(existsSync(layout.marker), true);
    assert.equal(existsSync(layout.config), true);
    assert.equal(existsSync(layout.vaults), true);
    assert.equal(existsSync(layout.artifacts), true);
    assert.deepEqual(nativeE2eEnvironment(layout, inherited), {
      ...inherited,
      NEURALNOTE_E2E_ROOT: layout.root,
    });

    cleanupNativeE2eRoot(layout, { appExited: true });
    assert.equal(existsSync(layout.root), false);
  });
});

test("refuses cleanup until the app has exited", () => {
  withOwnedLayout((layout) => {

    assert.throws(
      () => cleanupNativeE2eRoot(layout, { appExited: false }),
      /application exit has not been observed/,
    );
    assert.equal(existsSync(layout.root), true);

    cleanupNativeE2eRoot(layout, { appExited: true });
  });
});

test("refuses cleanup when the ownership marker was replaced", () => {
  withOwnedLayout((layout) => {
    writeFileSync(layout.marker, JSON.stringify({ schemaVersion: 1, sessionId: "forged" }));

    assert.throws(
      () => cleanupNativeE2eRoot(layout, { appExited: true }),
      /ownership marker does not match/,
    );
    assert.equal(existsSync(layout.root), true);
  });
});

test("refuses cleanup for a marked lookalike outside the process temp directory", () => {
  withParent((outsideParent) => {
    const layout = createNativeE2eRoot(outsideParent);

    assert.throws(
      () => cleanupNativeE2eRoot(layout, { appExited: true }),
      /root is not a direct child of the process temp directory/,
    );
    assert.equal(existsSync(layout.root), true);
  });
});

test("seeds exact Markdown, line-ending and oversized native fixtures", () => {
  withOwnedLayout((layout) => {
    const fixtures = seedNativeFixtures(layout);

    assert.equal(
      readFileSync(fixtures.markdown, "utf8"),
      MARKDOWN_COMPATIBILITY_SOURCE,
    );
    assert.equal(readFileSync(fixtures.crlf, "utf8").includes("\r\n"), true);
    assert.equal(readFileSync(fixtures.mixed, "utf8").includes("\r\n"), true);
    assert.equal(readFileSync(fixtures.mixed, "utf8").includes("\n"), true);
    assert.equal(readFileSync(fixtures.oversized).byteLength, 8 * 1024 * 1024 + 1);

    const recents = JSON.parse(
      readFileSync(path.join(layout.config, "recent-vaults.json"), "utf8"),
    ) as Array<{ path: string; lastOpened: number; last_opened?: unknown }>;
    assert.deepEqual(recents.map((recent) => recent.path), [fixtures.vault]);
    assert.equal(Number.isFinite(recents[0]?.lastOpened), true);
    assert.equal(recents[0]?.last_opened, undefined);

    cleanupNativeE2eRoot(layout, { appExited: true });
  });
});
