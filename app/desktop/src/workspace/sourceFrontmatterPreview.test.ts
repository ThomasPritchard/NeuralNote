import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";

import { sourceFrontmatterRaw } from "./sourceFrontmatterPreview";

describe("sourceFrontmatterRaw", () => {
  it.each([
    ["---\ntags: [old]\n---\nBody", "tags: [old]"],
    [
      "---\ntags: [reference, '#ops/nested', 7]\naliases: [reference]\n---\nBody",
      "tags: [reference, '#ops/nested', 7]\naliases: [reference]",
    ],
    ["\uFEFF---\ntags: [bom]\n...\nBody", "tags: [bom]"],
    ["---\n---\nBody", ""],
  ])("extracts the backend-normalized YAML block", (source, expected) => {
    expect(sourceFrontmatterRaw(EditorState.create({ doc: source }))).toBe(expected);
  });
});
