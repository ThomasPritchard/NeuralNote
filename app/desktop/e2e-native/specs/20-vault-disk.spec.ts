import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  fixturePaths,
  invoke,
  invokeOutcome,
  type NativeNoteDoc,
  openFixtureVault,
  restoreStartSource,
} from "./native-helpers.js";

interface TreeNode {
  path: string;
  relPath: string;
}

describe("NeuralNote native disk and persistence boundary", () => {
  beforeEach(async () => {
    restoreStartSource();
    await openFixtureVault();
  });

  it("creates, edits, renames, and moves with exact disk assertions", async () => {
    const paths = fixturePaths();
    const folder = await invoke<TreeNode>("create_folder", {
      parentPath: paths.vault,
      name: "Created",
    });
    const note = await invoke<TreeNode>("create_note", {
      parentPath: folder.path,
      name: "Journey",
    });
    const created = await invoke<NativeNoteDoc>("read_note", { path: note.path });
    const exact = "# Created by native E2E\r\n\r\nExact body.  \r\n";
    await invoke("write_note", {
      path: note.path,
      content: exact,
      expectedHash: created.contentHash,
    });
    assert.deepEqual(readFileSync(note.path), Buffer.from(exact));

    const renamed = await invoke<TreeNode>("rename_entry", {
      path: note.path,
      newName: "Renamed",
    });
    assert.equal(existsSync(note.path), false);
    assert.equal(existsSync(renamed.path), true);

    const moved = await invoke<TreeNode>("move_entry", {
      path: renamed.path,
      newParentPath: paths.archive,
    });
    assert.equal(moved.path, path.join(paths.archive, "Renamed.md"));
    assert.deepEqual(readFileSync(moved.path), Buffer.from(exact));
  });

  it("persists a save across close and reopen", async () => {
    const source = restoreStartSource();
    const opened = await invoke<NativeNoteDoc>("read_note", {
      path: fixturePaths().start,
    });
    const saved = `${source}\nPersisted after reopen.\n`;
    await invoke("write_note", {
      path: fixturePaths().start,
      content: saved,
      expectedHash: opened.contentHash,
    });

    await invoke("close_vault");
    await openFixtureVault();
    const reopened = await invoke<NativeNoteDoc>("read_note", {
      path: fixturePaths().start,
    });

    assert.equal(reopened.raw, saved);
    assert.deepEqual(readFileSync(fixturePaths().start), Buffer.from(saved));
  });

  it("rejects stale saves without losing the caller draft and recovers explicitly", async () => {
    const pathName = fixturePaths().start;
    const opened = await invoke<NativeNoteDoc>("read_note", { path: pathName });
    const draft = `${opened.raw}\nlocal draft\n`;
    writeFileSync(pathName, `${opened.raw}\nexternal edit\n`, "utf8");

    const stale = await invokeOutcome("write_note", {
      path: pathName,
      content: draft,
      expectedHash: opened.contentHash,
    });

    assert.equal(stale.ok, false);
    assert.match(JSON.stringify(stale.error), /conflict|changed/i);
    assert.equal(draft.endsWith("local draft\n"), true);
    assert.equal(readFileSync(pathName, "utf8").endsWith("external edit\n"), true);

    await invoke("write_note", {
      path: pathName,
      content: draft,
      expectedHash: null,
    });
    assert.equal(readFileSync(pathName, "utf8"), draft);
  });

  it("surfaces external deletion and an actual oversized file", async () => {
    const deleted = path.join(fixturePaths().vault, "Deleted Externally.md");
    writeFileSync(deleted, "delete me\n", "utf8");
    await invoke<NativeNoteDoc>("read_note", { path: deleted });
    const { unlinkSync } = await import("node:fs");
    unlinkSync(deleted);
    const missing = await invokeOutcome("read_note", { path: deleted });
    assert.equal(missing.ok, false);
    assert.match(JSON.stringify(missing.error), /notFound|not found/i);

    const oversized = await invoke<NativeNoteDoc>("read_note", {
      path: fixturePaths().oversized,
    });
    assert.equal(oversized.exceedsEditableSize, true);
    assert.equal(oversized.sizeBytes, 8 * 1024 * 1024 + 1);
    assert.equal(oversized.raw, "");
  });

  it("round-trips workspace state through the vault-owned persistence file", async () => {
    const state = {
      openPaths: ["Start.md", "Markdown Compatibility.md"],
      activePath: "Markdown Compatibility.md",
    };
    await invoke("save_workspace_state", { state });
    await invoke("close_vault");
    await openFixtureVault();

    const loaded = await invoke<{
      state: typeof state;
      recoveredFromCorrupt: boolean;
    }>("load_workspace_state");
    assert.deepEqual(loaded.state, state);
    assert.equal(loaded.recoveredFromCorrupt, false);
  });
});
