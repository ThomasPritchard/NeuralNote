import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyFocus, registerNode, resetRegistry } from "./nodeRegistry";

function fakeHandle() {
  return {
    update: vi.fn<(time: number) => void>(),
    setHover: vi.fn<(on: boolean) => void>(),
    setDimmed: vi.fn<(on: boolean) => void>(),
  };
}

describe("applyFocus (hover-focus dim targeting)", () => {
  beforeEach(() => resetRegistry());

  it("dims exactly the nodes outside the lit set", () => {
    const a = fakeHandle();
    const b = fakeHandle();
    const c = fakeHandle();
    registerNode("a", a);
    registerNode("b", b);
    registerNode("c", c);

    applyFocus(new Set(["a", "b"]));

    expect(a.setDimmed).toHaveBeenCalledWith(false);
    expect(b.setDimmed).toHaveBeenCalledWith(false);
    expect(c.setDimmed).toHaveBeenCalledWith(true);
  });

  it("restores every node when focus clears", () => {
    const a = fakeHandle();
    const b = fakeHandle();
    registerNode("a", a);
    registerNode("b", b);
    applyFocus(new Set(["a"]));

    applyFocus(null);

    expect(a.setDimmed).toHaveBeenLastCalledWith(false);
    expect(b.setDimmed).toHaveBeenLastCalledWith(false);
  });
});
