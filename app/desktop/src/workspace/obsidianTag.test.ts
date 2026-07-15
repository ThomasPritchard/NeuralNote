import { describe, expect, it } from "vitest";

import { normalizeObsidianTag } from "./obsidianTag";

describe("normalizeObsidianTag", () => {
  it.each([
    ["reference", "#reference"],
    ["#ops/nested", "#ops/nested"],
    ["café", "#café"],
    ["测试", "#测试"],
    ["🧠", "#🧠"],
    [" project ", "#project"],
  ])("normalizes %s to one source-compatible hash", (source, expected) => {
    expect(normalizeObsidianTag(source)).toBe(expected);
  });

  it.each([1984, "1984", "", "#", "two words", "##double", "tag!"])(
    "rejects a non-searchable property value: %s",
    (value) => {
      expect(normalizeObsidianTag(value)).toBeNull();
    },
  );
});
