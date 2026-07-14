// Contract tests for the two search/graph mock-backend handlers, driven through
// the real Tauri IPC boundary (mockIPC) and the real api.ts wrappers. The e2e
// journeys (phases C/D) render the full <App/>; this suite pins the mirrored
// core semantics — code-point offsets, case folding, snippet windows, budget
// flow, walk order, masking, and wikilink/md-link resolution — mirrored 1:1
// from crates/neuralnote-core/src/{search,links,tree}.rs (the ground truth).

import { afterEach, describe, expect, it } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { clearMocks } from "@tauri-apps/api/mocks";
import {
  cancelChatRun,
  cancelRequirementDownload,
  chat,
  createNoteFromTemplate,
  downloadRequirement,
  listTemplates,
  loadWorkspaceState,
  readBacklinks,
  readLinkGraph,
  readNote,
  readRichNote,
  resetWorkspaceState,
  saveWorkspaceState,
  searchVault,
} from "../lib/api";
import type { PullEvent } from "../lib/types";
import { createMockVault, VAULT_ROOT, type SeedEntry } from "./mockVault";

afterEach(() => {
  clearMocks();
});

/** Install a mock backend rooted at VAULT_ROOT with the given entries. */
const seedVault = (seed: SeedEntry[]): void => {
  createMockVault({ seed }).install();
};

describe("mockVault rich-edit compatibility", () => {
  it("mirrors the native raw fallback for wikilinks", async () => {
    seedVault([{ kind: "file", relPath: "wiki.md", content: "Go to [[Target]]." }]);

    await expect(readRichNote(`${VAULT_ROOT}/wiki.md`)).resolves.toMatchObject({
      disposition: {
        kind: "raw",
        reason: { code: "unsupported_syntax" },
      },
      body: "Go to [[Target]].",
    });
  });
});

describe("mockVault exact-turn chat cancellation", () => {
  const turnId = "018f5f6c-8d5f-7c64-b8e7-8f9f238d9e31";

  it("acknowledges the matching stop before streaming provider wind-down", async () => {
    createMockVault({
      chatScript: [{ type: "processing" }],
      cancelChatAfterEvents: 1,
      cancelChatTail: [
        { type: "answer", delta: "late provider tail" },
        { type: "done" },
      ],
    }).install();
    const order: string[] = [];
    const run = chat(turnId, "hello", [], (event) => {
      order.push(event.type);
    });

    await Promise.resolve();
    expect(order).toEqual(["processing"]);
    const outcome = await cancelChatRun(turnId);
    order.push(`outcome:${outcome.status}`);

    expect(outcome).toEqual({ turnId, status: "cancelled" });
    expect(order).toEqual(["processing", "outcome:cancelled"]);

    await new Promise((resolve) => setTimeout(resolve, 0));
    await expect(run).resolves.toBe(turnId);
    expect(order).toEqual([
      "processing",
      "outcome:cancelled",
      "answer",
      "done",
    ]);
  });

  it("reports an already completed exact turn without replaying a stop tail", async () => {
    createMockVault({
      chatScript: [{ type: "done" }],
      cancelChatTail: [{ type: "answer", delta: "must not replay" }],
    }).install();
    const events: string[] = [];

    await expect(
      chat(turnId, "hello", [], (event) => events.push(event.type)),
    ).resolves.toBe(turnId);
    await expect(cancelChatRun(turnId)).resolves.toEqual({
      turnId,
      status: "alreadyCompleted",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(events).toEqual(["done"]);
  });
});

describe("mockVault search_vault", () => {
  it("returns an empty response for an empty or whitespace-only query", async () => {
    seedVault([{ kind: "file", relPath: "a.md", content: "hello" }]);
    expect(await searchVault("")).toEqual({
      hits: [],
      truncated: false,
      skippedFiles: 0,
    });
    expect(await searchVault("   ")).toEqual({
      hits: [],
      truncated: false,
      skippedFiles: 0,
    });
  });

  it("matches case-insensitively with 1-based lines and all ranges per line", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "a.md",
        content: "First line\nsays Hello twice: hello HELLO",
      },
    ]);
    const out = await searchVault("hello");
    expect(out.truncated).toBe(false);
    expect(out.skippedFiles).toBe(0);
    expect(out.hits).toEqual([
      {
        path: `${VAULT_ROOT}/a.md`,
        relPath: "a.md",
        title: "a",
        nameMatch: false,
        matches: [
          {
            line: 2,
            snippet: "says Hello twice: hello HELLO",
            ranges: [
              [5, 10],
              [18, 23],
              [24, 29],
            ],
          },
        ],
      },
    ]);
  });

  it("reports ranges in Unicode code points, not UTF-16 units", async () => {
    seedVault([{ kind: "file", relPath: "emoji.md", content: "🚀🚀 hello" }]);
    const out = await searchVault("hello");
    const match = out.hits[0].matches[0];
    // "🚀🚀 hello" is 4+"hello" UTF-16 units before the match — but only 3 code
    // points. The contract counts code points (Rust char offsets).
    expect(match.ranges).toEqual([[3, 8]]);
    const [start, end] = match.ranges[0];
    expect(Array.from(match.snippet).slice(start, end).join("")).toBe("hello");
  });

  it("searches the raw text including frontmatter, and only markdown files", async () => {
    seedVault([
      { kind: "file", relPath: "n.md", content: "---\ntopic: neural\n---\nbody" },
      { kind: "file", relPath: "skip.txt", content: "neural" },
      { kind: "file", relPath: "skip.png", content: "neural" },
    ]);
    const out = await searchVault("neural");
    expect(out.hits.map((h) => h.relPath)).toEqual(["n.md"]);
    expect(out.hits[0].matches[0].line).toBe(2);
  });

  it("flags stem matches as nameMatch with empty matches when content misses", async () => {
    seedVault([
      { kind: "file", relPath: "Neural Notes.md", content: "nothing relevant" },
    ]);
    const out = await searchVault("neural");
    expect(out.hits).toEqual([
      {
        path: `${VAULT_ROOT}/Neural Notes.md`,
        relPath: "Neural Notes.md",
        title: "Neural Notes",
        nameMatch: true,
        matches: [],
      },
    ]);
  });

  it("flags title matches as nameMatch (title from frontmatter)", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "x.md",
        content: "---\ntitle: Neural roadmap\n---\nbody text",
      },
    ]);
    const out = await searchVault("roadmap");
    expect(out.hits[0].nameMatch).toBe(true);
    expect(out.hits[0].title).toBe("Neural roadmap");
    // The frontmatter line itself also matches the raw-text scan.
    expect(out.hits[0].matches.map((m) => m.line)).toEqual([2]);
  });

  it("orders name-match hits before content-only hits", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "has alpha inside" },
      { kind: "file", relPath: "z-alpha.md", content: "nothing" },
    ]);
    const out = await searchVault("alpha");
    expect(out.hits.map((h) => [h.relPath, h.nameMatch])).toEqual([
      ["z-alpha.md", true],
      ["a.md", false],
    ]);
  });

  it("emits hits in tree-walk order: folders first, case-insensitive by name", async () => {
    seedVault([
      { kind: "file", relPath: "Banana.md", content: "alpha" },
      { kind: "file", relPath: "apple.md", content: "alpha" },
      { kind: "file", relPath: "b-dir/note1.md", content: "alpha" },
    ]);
    const out = await searchVault("alpha");
    // Core walks read_tree order (tree.rs): folders before files within each
    // dir, each group case-insensitive by name — NOT case-sensitive relPath
    // order (which would put Banana.md before apple.md).
    expect(out.hits.map((h) => h.relPath)).toEqual([
      "b-dir/note1.md",
      "apple.md",
      "Banana.md",
    ]);
  });

  it("silently truncates queries at 256 code points", async () => {
    seedVault([{ kind: "file", relPath: "big.md", content: `${"a".repeat(256)}XYZ` }]);
    const out = await searchVault("a".repeat(300));
    // The 300-char query is capped to 256 (MAX_QUERY_CHARS) and then matches.
    // The 256-wide match is wider than the 200-char window, so its range is
    // clipped to the full visible window — never dropped.
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].matches[0].snippet).toBe("a".repeat(200));
    expect(out.hits[0].matches[0].ranges).toEqual([[0, 200]]);
  });

  it("folds with full Unicode lowercasing (İ expands) keeping original offsets", async () => {
    seedVault([{ kind: "file", relPath: "notes.md", content: "xİ is" }]);
    const out = await searchVault("i");
    // "İ".toLowerCase() → "i" + combining dot (2 code points); the fold-origin
    // map keeps the match anchored to the ONE original İ char.
    expect(out.hits[0].nameMatch).toBe(false);
    expect(out.hits[0].matches[0].ranges).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("normalises Greek final sigma so ΣΕΙΣΜΌΣ matches σεισμός", async () => {
    seedVault([{ kind: "file", relPath: "quake.md", content: "σεισμός" }]);
    const out = await searchVault("ΣΕΙΣΜΌΣ");
    expect(out.hits).toHaveLength(1);
    expect(out.hits[0].matches[0].ranges).toEqual([[0, 7]]);
  });

  it("clips long lines to a 200-code-point window centered on the first match", async () => {
    const line = `${"x".repeat(300)}NEEDLE${"y".repeat(300)}NEEDLE`;
    seedVault([{ kind: "file", relPath: "long.md", content: line }]);
    const out = await searchVault("needle");
    const match = out.hits[0].matches[0];
    expect(Array.from(match.snippet).length).toBe(200);
    expect(match.snippet).toBe(`${"x".repeat(97)}NEEDLE${"y".repeat(97)}`);
    // First occurrence rebased into the window; the second falls fully outside
    // and is dropped rather than clipped to an empty/backwards range.
    expect(match.ranges).toEqual([[97, 103]]);
  });

  it("clips (not drops) a range straddling the window edge", async () => {
    // Window = chars [203, 403): the second NEEDLE starts at char 400, so only
    // its first 3 chars are visible → clipped to [197, 200], kept.
    const line = `${"x".repeat(300)}NEEDLE${"y".repeat(94)}NEEDLE${"z".repeat(100)}`;
    seedVault([{ kind: "file", relPath: "long.md", content: line }]);
    const out = await searchVault("needle");
    const match = out.hits[0].matches[0];
    expect(match.snippet).toBe(`${"x".repeat(97)}NEEDLE${"y".repeat(94)}NEE`);
    expect(match.ranges).toEqual([
      [97, 103],
      [197, 200],
    ]);
  });

  it("caps matches at 50 per file and flags truncation", async () => {
    seedVault([
      { kind: "file", relPath: "big.md", content: Array(55).fill("hit").join("\n") },
    ]);
    const out = await searchVault("hit");
    expect(out.hits[0].matches).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });

  it("caps total matches at 200 across files in walk order", async () => {
    const content = Array(45).fill("hit").join("\n");
    seedVault(
      [1, 2, 3, 4, 5].map((n) => ({
        kind: "file" as const,
        relPath: `f${n}.md`,
        content,
      })),
    );
    const out = await searchVault("hit");
    expect(out.truncated).toBe(true);
    expect(out.hits.map((h) => h.matches.length)).toEqual([45, 45, 45, 45, 20]);
  });

  it("spends the global budget in walk order — a late name-hit keeps its hit but loses its matches", async () => {
    const fifty = Array(50).fill("hit").join("\n");
    seedVault([
      { kind: "file", relPath: "a1.md", content: fifty },
      { kind: "file", relPath: "a2.md", content: fifty },
      { kind: "file", relPath: "a3.md", content: fifty },
      { kind: "file", relPath: "a4.md", content: fifty },
      { kind: "file", relPath: "zz-hit.md", content: "hit\nhit\nhit" },
    ]);
    const out = await searchVault("hit");
    // Core consumes the 200 budget DURING the walk (a1–a4 exhaust it), so
    // zz-hit.md — walked last — keeps its name hit but gets no content
    // matches; name-first ordering then puts it at the front of the response.
    expect(out.truncated).toBe(true);
    expect(out.hits.map((h) => [h.relPath, h.nameMatch, h.matches.length])).toEqual([
      ["zz-hit.md", true, 0],
      ["a1.md", false, 50],
      ["a2.md", false, 50],
      ["a3.md", false, 50],
      ["a4.md", false, 50],
    ]);
  });
});

describe("mockVault read_link_graph", () => {
  it("builds a node per markdown note with title and top-level cluster", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "# Alpha" },
      { kind: "file", relPath: "Projects/b.md", content: "---\ntitle: Beta\n---\n" },
      { kind: "file", relPath: "Projects/Sub/c.md", content: "" },
      { kind: "file", relPath: "image.png", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.skippedFiles).toBe(0);
    expect(out.nodes).toHaveLength(3);
    expect(out.nodes).toEqual(
      expect.arrayContaining([
        { id: "a.md", title: "Alpha", cluster: "" },
        { id: "Projects/b.md", title: "Beta", cluster: "Projects" },
        { id: "Projects/Sub/c.md", title: "c", cluster: "Projects" },
      ]),
    );
  });

  it("resolves wikilinks case-insensitively, with or without .md", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[[beta]] and [[GAMMA.md]]" },
      { kind: "file", relPath: "Beta.md", content: "" },
      { kind: "file", relPath: "Gamma.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "a.md", target: "Beta.md", bridge: false },
        { source: "a.md", target: "Gamma.md", bridge: false },
      ]),
    );
    expect(out.links).toHaveLength(2);
  });

  it("handles alias/heading/embed wikilink forms and dedupes the edge", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "a.md",
        content: "[[Beta|alias]] [[Beta#heading]] ![[Beta]] [[ Beta ]]",
      },
      { kind: "file", relPath: "Beta.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([{ source: "a.md", target: "Beta.md", bridge: false }]);
  });

  it("resolves path-qualified wikilinks by case-insensitive relPath suffix", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[[projects/beta]]" },
      { kind: "file", relPath: "Projects/Beta.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([
      { source: "a.md", target: "Projects/Beta.md", bridge: true },
    ]);
  });

  it("resolves markdown links relative to the note's folder with ../ and %20", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "n/one.md",
        content:
          "[up](../two.md) [spaced](sub/three%20note.md) " +
          "[ext](https://example.com/a.md) [mail](mailto:x@y.z) [abs](/two.md) " +
          "[frag](../two.md#section)",
      },
      { kind: "file", relPath: "two.md", content: "" },
      { kind: "file", relPath: "n/sub/three note.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "n/one.md", target: "two.md", bridge: true },
        { source: "n/one.md", target: "n/sub/three note.md", bridge: false },
      ]),
    );
    expect(out.links).toHaveLength(2);
  });

  it("skips markdown links that escape the vault root", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[out](../escape.md)" },
      { kind: "file", relPath: "escape.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([]);
  });

  it("ignores links inside fenced code blocks and inline code spans", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "a.md",
        content:
          "```\n[[Beta]]\n```\ninline `[[Beta]]` span\n[[Gamma]]\n```\n[[Beta]] unterminated fence",
      },
      { kind: "file", relPath: "Beta.md", content: "" },
      { kind: "file", relPath: "Gamma.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([{ source: "a.md", target: "Gamma.md", bridge: false }]);
  });

  it("treats a 3-backtick line inside a 4-backtick fence as content, not a closer", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "a.md",
        content: "````\n```\n[[Beta]]\n```\n````\n[[Gamma]]",
      },
      { kind: "file", relPath: "Beta.md", content: "" },
      { kind: "file", relPath: "Gamma.md", content: "" },
    ]);
    const out = await readLinkGraph();
    // CommonMark: only a run of the SAME char at least as long as the opener
    // closes a fence — [[Beta]] stays masked until the ```` closer.
    expect(out.links).toEqual([{ source: "a.md", target: "Gamma.md", bridge: false }]);
  });

  it("does not treat mid-line backticks as a fence opener", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "see ``` marker\n[[Beta]]" },
      { kind: "file", relPath: "Beta.md", content: "" },
    ]);
    const out = await readLinkGraph();
    // Fences are line-anchored; an unmatched mid-line ``` run is literal text,
    // so the wikilink on the next line is live.
    expect(out.links).toEqual([{ source: "a.md", target: "Beta.md", bridge: false }]);
  });

  it("masks inline code spans that cross newlines", async () => {
    seedVault([
      {
        kind: "file",
        relPath: "a.md",
        content: "a `x\n[[Beta]]\ny` b\n[[Gamma]]",
      },
      { kind: "file", relPath: "Beta.md", content: "" },
      { kind: "file", relPath: "Gamma.md", content: "" },
    ]);
    const out = await readLinkGraph();
    // CommonMark code spans may cross newlines: the single-backtick span
    // swallows [[Beta]]; [[Gamma]] after the closer stays live.
    expect(out.links).toEqual([{ source: "a.md", target: "Gamma.md", bridge: false }]);
  });

  it("takes md-link targets up to the first ')' (spaces included) with .md fallback", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[x](my note.md) [g](docs/guide)" },
      { kind: "file", relPath: "my note.md", content: "" },
      { kind: "file", relPath: "docs/guide.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "a.md", target: "my note.md", bridge: false },
        { source: "a.md", target: "docs/guide.md", bridge: true },
      ]),
    );
    expect(out.links).toHaveLength(2);
  });

  it("resolves case-colliding rel-paths with exact-case preference", async () => {
    seedVault([
      { kind: "file", relPath: "src.md", content: "[a](Target.md) [b](target.md)" },
      { kind: "file", relPath: "Target.md", content: "" },
      { kind: "file", relPath: "target.md", content: "" },
    ]);
    const out = await readLinkGraph();
    // A case-sensitive filesystem can hold both; each link resolves to its
    // exact-case file instead of collapsing onto one slot.
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "src.md", target: "Target.md", bridge: false },
        { source: "src.md", target: "target.md", bridge: false },
      ]),
    );
    expect(out.links).toHaveLength(2);
  });

  it("breaks resolution ties by shortest relPath, then lexicographic", async () => {
    seedVault([
      { kind: "file", relPath: "src.md", content: "[[note]] [[paper]]" },
      { kind: "file", relPath: "x/Note.md", content: "" },
      { kind: "file", relPath: "a/b/Note.md", content: "" },
      { kind: "file", relPath: "b/Paper.md", content: "" },
      { kind: "file", relPath: "a/Paper.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "src.md", target: "x/Note.md", bridge: true },
        { source: "src.md", target: "a/Paper.md", bridge: true },
      ]),
    );
    expect(out.links).toHaveLength(2);
  });

  it("drops self-links and dedupes reciprocal links as one unordered edge", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[[a]] [[b]]" },
      { kind: "file", relPath: "b.md", content: "[[a]]" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([{ source: "a.md", target: "b.md", bridge: false }]);
  });

  it("skips unresolved targets and links to non-markdown files", async () => {
    seedVault([
      { kind: "file", relPath: "a.md", content: "[[missing]] [[image.png]] [pic](image.png)" },
      { kind: "file", relPath: "image.png", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual([]);
  });

  it("marks cross-cluster links as bridges, same-cluster as not", async () => {
    seedVault([
      { kind: "file", relPath: "p/a.md", content: "[[b]] [[c]] [[root]]" },
      { kind: "file", relPath: "p/b.md", content: "" },
      { kind: "file", relPath: "q/c.md", content: "" },
      { kind: "file", relPath: "root.md", content: "" },
    ]);
    const out = await readLinkGraph();
    expect(out.links).toEqual(
      expect.arrayContaining([
        { source: "p/a.md", target: "p/b.md", bridge: false },
        { source: "p/a.md", target: "q/c.md", bridge: true },
        { source: "p/a.md", target: "root.md", bridge: true },
      ]),
    );
    expect(out.links).toHaveLength(3);
  });
});

describe("mockVault read_backlinks", () => {
  it("returns linked occurrences, every unlinked title mention, and skipped unreadable markdown count", async () => {
    seedVault([
      { kind: "file", relPath: "target.md", content: "# Rust\n" },
      {
        kind: "file",
        relPath: "alpha.md",
        content: "# Alpha\n\nSee [[target]].\nAgain [target](target.md).\n",
      },
      {
        kind: "file",
        relPath: "both.md",
        content: "# Both\nRust is mentioned, but this note links [[target]].\n",
      },
      {
        kind: "file",
        relPath: "plain.md",
        content:
          "# Plain\nRust starts here. Rust also here.\nTrust is not a match.\ninline `Rust` ignored\n```\nRust ignored\n```\nRust survives.\n",
      },
      { kind: "file", relPath: "locked.md", content: "[[target]]\n", unreadable: true },
    ]);

    const out = await readBacklinks(`${VAULT_ROOT}/target.md`);

    expect(out.skippedFiles).toBe(1);
    expect(out.linked).toEqual([
      {
        sourceRel: "alpha.md",
        sourceTitle: "Alpha",
        line: 3,
        snippet: "See [[target]].",
      },
      {
        sourceRel: "alpha.md",
        sourceTitle: "Alpha",
        line: 4,
        snippet: "Again [target](target.md).",
      },
      {
        sourceRel: "both.md",
        sourceTitle: "Both",
        line: 2,
        snippet: "Rust is mentioned, but this note links [[target]].",
      },
    ]);
    expect(out.unlinked).toEqual([
      {
        sourceRel: "plain.md",
        sourceTitle: "Plain",
        line: 2,
        snippet: "Rust starts here. Rust also here.",
      },
      {
        sourceRel: "plain.md",
        sourceTitle: "Plain",
        line: 2,
        snippet: "Rust starts here. Rust also here.",
      },
      {
        sourceRel: "plain.md",
        sourceTitle: "Plain",
        line: 8,
        snippet: "Rust survives.",
      },
    ]);
  });
});

describe("mockVault templates", () => {
  it("lists markdown templates from the inferred Obsidian folder", async () => {
    seedVault([
      {
        kind: "file",
        relPath: ".obsidian/templates.json",
        content: JSON.stringify({ folder: "Meta/Templates" }),
      },
      { kind: "file", relPath: "Templates/Default.md", content: "wrong folder" },
      { kind: "file", relPath: "Meta/Templates/Zed.md", content: "z" },
      { kind: "file", relPath: "Meta/Templates/alpha.markdown", content: "a" },
      { kind: "file", relPath: "Meta/Templates/not-template.txt", content: "x" },
    ]);

    await expect(listTemplates()).resolves.toEqual([
      { relPath: "Meta/Templates/alpha.markdown", name: "alpha" },
      { relPath: "Meta/Templates/Zed.md", name: "Zed" },
    ]);
  });

  it("renders title, date, templater dates, and unknown variables verbatim", async () => {
    createMockVault({
      now: new Date(2026, 0, 2, 15, 4, 5),
      seed: [
        {
          kind: "file",
          relPath: ".obsidian/templates.json",
          content: JSON.stringify({ dateFormat: "DD/MM/YYYY", timeFormat: "HH:mm:ss" }),
        },
        {
          kind: "file",
          relPath: "Templates/Daily.md",
          content:
            "# {{title}}\nCreated {{date}} at {{time}}\nTomorrow <% tp.date.tomorrow(\"YYYY-MM-DD\") %>\nUnknown {{evil}}\n",
        },
      ],
    }).install();

    const node = await createNoteFromTemplate(VAULT_ROOT, "Project Alpha", "Templates/Daily.md");
    expect(node).toMatchObject({
      kind: "file",
      name: "Project Alpha.md",
      relPath: "Project Alpha.md",
    });
    await expect(readNote(`${VAULT_ROOT}/Project Alpha.md`)).resolves.toMatchObject({
      raw:
        "# Project Alpha\nCreated 02/01/2026 at 15:04:05\nTomorrow 2026-01-03\nUnknown {{evil}}\n",
    });
  });

  it("creates a blank note when no template is requested and no template folder exists", async () => {
    seedVault([]);

    const node = await createNoteFromTemplate(VAULT_ROOT, "Blank", null);

    expect(node).toMatchObject({ kind: "file", name: "Blank.md", relPath: "Blank.md" });
    await expect(readNote(`${VAULT_ROOT}/Blank.md`)).resolves.toMatchObject({ raw: "" });
  });
});

describe("mockVault requirement downloads", () => {
  it("keeps the first download as cancel owner when a concurrent start is rejected", async () => {
    createMockVault({
      requirementDownloadScript: [
        {
          type: "progress",
          status: "downloading",
          digest: null,
          completed: null,
          total: null,
          percent: null,
        },
        { type: "success" },
      ],
    }).install();
    const firstEvents: PullEvent[] = [];
    const secondEvents: PullEvent[] = [];

    const first = downloadRequirement("yt-dlp", (event) => firstEvents.push(event));
    const second = downloadRequirement("yt-dlp", (event) => secondEvents.push(event));
    await cancelRequirementDownload();
    await Promise.all([first, second]);

    expect(secondEvents).toEqual([
      {
        type: "error",
        message: "a skill requirement download is already in progress",
      },
    ]);
    expect(firstEvents).toEqual([
      {
        type: "progress",
        status: "downloading",
        digest: null,
        completed: null,
        total: null,
        percent: null,
      },
      { type: "error", message: "Download cancelled." },
    ]);
  });
});

describe("mockVault unknown commands", () => {
  it("rejects loudly instead of resolving undefined (silent empty success)", async () => {
    seedVault([]);
    await expect(invoke("bogus_cmd")).rejects.toEqual({
      kind: "io",
      message: "unknown command: bogus_cmd",
    });
  });
});

describe("mockVault workspace state", () => {
  it("round-trips saved tab paths and resets them to the safe empty state", async () => {
    seedVault([]);

    expect(await loadWorkspaceState()).toEqual({
      state: { openPaths: [], activePath: null },
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    });

    await saveWorkspaceState({
      openPaths: ["A.md", "folder/B.md"],
      activePath: "folder/B.md",
    });
    expect(await loadWorkspaceState()).toEqual({
      state: {
        openPaths: ["A.md", "folder/B.md"],
        activePath: "folder/B.md",
      },
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    });

    expect(await resetWorkspaceState()).toEqual({
      state: { openPaths: [], activePath: null },
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    });
    expect(await loadWorkspaceState()).toEqual({
      state: { openPaths: [], activePath: null },
      recoveredFromCorrupt: false,
      recoveryMessage: null,
    });
  });
});
