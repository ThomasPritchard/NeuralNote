import { describe, it, expect } from "vitest";
import { MARKDOWN_EXTENSIONS } from "../lib/bindings/markdownExtensions";
import type { TreeNode } from "../lib/types";
import {
  countTree,
  extFromPath,
  extLabel,
  isMarkdownExt,
  isMarkdownRenderable,
  isPathInside,
  isTextLikeExt,
  normSep,
  parentRelPath,
  remapPath,
  vaultRelPath,
  wordCount,
} from "./fileMeta";

describe("extFromPath", () => {
  it("returns the lowercased extension", () => {
    expect(extFromPath("a/b/Note.MD")).toBe("md");
    expect(extFromPath("img.PNG")).toBe("png");
  });
  it("is null for dotfiles and extensionless names", () => {
    expect(extFromPath("a/.gitignore")).toBeNull();
    expect(extFromPath("a/README")).toBeNull();
  });
  it("is separator-agnostic (Windows paths)", () => {
    expect(extFromPath("a\\b\\note.md")).toBe("md");
  });
});

describe("markdown predicates", () => {
  it("isMarkdownExt covers md/markdown/mdx only", () => {
    expect(isMarkdownExt("md")).toBe(true);
    expect(isMarkdownExt("markdown")).toBe(true);
    expect(isMarkdownExt("mdx")).toBe(true);
    expect(isMarkdownExt("txt")).toBe(false);
    expect(isMarkdownExt(null)).toBe(false);
  });
  it("isMarkdownExt accepts exactly the shared generated set, and nothing else", () => {
    // Parity guard: the accepted extensions must equal the Rust-generated mirror,
    // so a divergence between fileMeta and the core's `is_markdown_ext` fails here.
    for (const ext of MARKDOWN_EXTENSIONS) {
      expect(isMarkdownExt(ext)).toBe(true);
    }
    for (const other of ["txt", "png", "pdf", "MD", "markdownx", ""]) {
      expect(isMarkdownExt(other)).toBe(false);
    }
    expect(isMarkdownExt(null)).toBe(false);
  });
  it("isMarkdownRenderable also accepts extensionless text (README/LICENSE)", () => {
    expect(isMarkdownRenderable(null)).toBe(true);
    expect(isMarkdownRenderable("md")).toBe(true);
    expect(isMarkdownRenderable("png")).toBe(false);
  });
  it("isTextLikeExt accepts known text extensions, rejects binaries", () => {
    expect(isTextLikeExt("json")).toBe(true);
    expect(isTextLikeExt("rs")).toBe(true);
    expect(isTextLikeExt("png")).toBe(false);
    expect(isTextLikeExt(null)).toBe(false);
  });
});

describe("extLabel", () => {
  it("labels markdown, generic, and other extensions", () => {
    expect(extLabel("md")).toBe("Markdown");
    expect(extLabel(null)).toBe("File");
    expect(extLabel("pdf")).toBe(".PDF");
  });
});

describe("countTree", () => {
  it("counts notes and folders recursively", () => {
    const tree: TreeNode[] = [
      {
        kind: "folder",
        name: "A",
        path: "/v/A",
        relPath: "A",
        ext: null,
        children: [
          { kind: "file", name: "n.md", path: "/v/A/n.md", relPath: "A/n.md", ext: "md", children: null },
          {
            kind: "folder",
            name: "B",
            path: "/v/A/B",
            relPath: "A/B",
            ext: null,
            children: [
              { kind: "file", name: "m.md", path: "/v/A/B/m.md", relPath: "A/B/m.md", ext: "md", children: null },
            ],
          },
        ],
      },
      { kind: "file", name: "top.md", path: "/v/top.md", relPath: "top.md", ext: "md", children: null },
    ];
    expect(countTree(tree)).toEqual({ notes: 3, folders: 2 });
  });
  it("handles an empty tree", () => {
    expect(countTree([])).toEqual({ notes: 0, folders: 0 });
  });
  it("counts only markdown files as notes, not attachments", () => {
    const tree: TreeNode[] = [
      { kind: "file", name: "note.md", path: "/v/note.md", relPath: "note.md", ext: "md", children: null },
      { kind: "file", name: "pic.png", path: "/v/pic.png", relPath: "pic.png", ext: "png", children: null },
      { kind: "file", name: "doc.pdf", path: "/v/doc.pdf", relPath: "doc.pdf", ext: "pdf", children: null },
    ];
    expect(countTree(tree)).toEqual({ notes: 1, folders: 0 });
  });
});

describe("wordCount", () => {
  it("counts whitespace-delimited words and handles empties", () => {
    expect(wordCount("  hello   world \n foo ")).toBe(3);
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
    expect(wordCount("one")).toBe(1);
  });
});

describe("isPathInside", () => {
  it("is true for self and descendants, false for siblings", () => {
    expect(isPathInside("/v/a", "/v/a")).toBe(true);
    expect(isPathInside("/v/a/b.md", "/v/a")).toBe(true);
    expect(isPathInside("/v/ab", "/v/a")).toBe(false);
    expect(isPathInside("/v/other", "/v/a")).toBe(false);
  });
  it("is separator-agnostic", () => {
    expect(isPathInside("C:\\v\\a\\b.md", "C:\\v\\a")).toBe(true);
  });
});

describe("remapPath", () => {
  it("remaps the renamed entry itself", () => {
    expect(remapPath("/v/old.md", "/v/old.md", "/v/new.md")).toBe("/v/new.md");
  });
  it("remaps descendants of a renamed folder", () => {
    expect(remapPath("/v/A/n.md", "/v/A", "/v/B")).toBe("/v/B/n.md");
  });
  it("returns null when unaffected", () => {
    expect(remapPath("/v/other.md", "/v/A", "/v/B")).toBeNull();
  });
});

describe("normSep", () => {
  it("normalises backslashes to forward slashes", () => {
    expect(normSep("a\\b\\c")).toBe("a/b/c");
    expect(normSep("a/b")).toBe("a/b");
  });
});

describe("vaultRelPath", () => {
  it("maps the root itself to the empty string", () => {
    expect(vaultRelPath("/v", "/v")).toBe("");
    expect(vaultRelPath("/v/", "/v")).toBe("");
  });
  it("strips the vault-root prefix", () => {
    expect(vaultRelPath("/v/Notes", "/v")).toBe("Notes");
    expect(vaultRelPath("/v/Notes/a.md", "/v")).toBe("Notes/a.md");
  });
  it("is separator-agnostic and tolerates a trailing-slash root", () => {
    expect(vaultRelPath("C:\\v\\Notes\\a.md", "C:\\v")).toBe("Notes/a.md");
    expect(vaultRelPath("/v/Notes", "/v/")).toBe("Notes");
  });
});

describe("parentRelPath", () => {
  it("returns the parent folder relPath, or '' at the root", () => {
    expect(parentRelPath("Notes/a.md")).toBe("Notes");
    expect(parentRelPath("Notes/Sub/a.md")).toBe("Notes/Sub");
    expect(parentRelPath("a.md")).toBe("");
    expect(parentRelPath("")).toBe("");
  });
});
