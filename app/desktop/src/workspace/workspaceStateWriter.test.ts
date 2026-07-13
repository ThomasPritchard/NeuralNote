import { describe, expect, it, vi } from "vitest";
import type { WorkspaceState } from "../lib/types";
import { createWorkspaceStateWriter } from "./workspaceStateWriter";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const state = (activePath: string): WorkspaceState => ({
  openPaths: ["A.md", "B.md"],
  activePath,
});

describe("workspace-state serialized writer", () => {
  it("coalesces queued state and never overlaps or reorders writes", async () => {
    const first = deferred();
    const save = vi
      .fn<(value: WorkspaceState) => Promise<void>>()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    const writer = createWorkspaceStateWriter(save, vi.fn());

    writer.schedule(state("A.md"));
    await Promise.resolve();
    expect(save).toHaveBeenCalledTimes(1);

    writer.schedule(state("B.md"));
    writer.schedule(state("A.md"));
    expect(save).toHaveBeenCalledTimes(1);

    const flushed = writer.flush();
    first.resolve();
    await flushed;

    expect(save.mock.calls.map(([value]) => value.activePath)).toEqual(["A.md"]);
  });

  it("reports a failed write and remains usable for the next state", async () => {
    const onError = vi.fn();
    const save = vi
      .fn<(value: WorkspaceState) => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValue(undefined);
    const writer = createWorkspaceStateWriter(save, onError);

    writer.schedule(state("A.md"));
    await writer.flush();
    writer.schedule(state("B.md"));
    await writer.flush();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
  });

  it("does not rewrite unchanged paths when tab-local state changes", async () => {
    const save = vi.fn<(value: WorkspaceState) => Promise<void>>().mockResolvedValue(undefined);
    const writer = createWorkspaceStateWriter(save, vi.fn());

    writer.schedule(state("A.md"));
    await writer.flush();
    writer.schedule(state("A.md"));
    writer.schedule({ openPaths: ["A.md", "B.md"], activePath: "A.md" });
    await writer.flush();

    expect(save).toHaveBeenCalledTimes(1);
  });
});
