// Contract tests for the two search/graph mock-backend handlers, driven through
// the real Tauri IPC boundary (mockIPC) and the real api.ts wrappers. The e2e
// journeys (phases C/D) render the full <App/>; this suite pins the mirrored
// core semantics — code-point offsets, snippet windows, caps, wikilink/md-link
// resolution — that those journeys will build on, exactly as frozen in
// specs/search-and-graph-view.md §Contract.

import { afterEach, describe, expect, it } from "vitest";
import { clearMocks } from "@tauri-apps/api/mocks";
import { readLinkGraph, searchVault } from "../lib/api";
import { createMockVault, VAULT_ROOT, type SeedEntry } from "./mockVault";

afterEach(() => {
  clearMocks();
});

/** Install a mock backend rooted at VAULT_ROOT with the given entries. */
const seedVault = (seed: SeedEntry[]): void => {
  createMockVault({ seed }).install();
};

describe("mockVault search_vault", () => {
  it("returns an empty response for an empty or whitespace-only query", async () => {
    seedVault([{ kind: "file", relPath: "a.md", content: "hello" }]);
    expect(await searchVault("")).toEqual({ hits: [], truncated: false });
    expect(await searchVault("   ")).toEqual({ hits: [], truncated: false });
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

  it("clips long lines to a 200-code-point window centered on the first match", async () => {
    const line = `${"x".repeat(300)}NEEDLE${"y".repeat(300)}NEEDLE`;
    seedVault([{ kind: "file", relPath: "long.md", content: line }]);
    const out = await searchVault("needle");
    const match = out.hits[0].matches[0];
    expect(Array.from(match.snippet).length).toBe(200);
    expect(match.snippet).toBe(`${"x".repeat(97)}NEEDLE${"y".repeat(97)}`);
    // First occurrence rebased into the window; the second falls outside and
    // is dropped rather than clipped to an empty/backwards range.
    expect(match.ranges).toEqual([[97, 103]]);
  });

  it("caps matches at 50 per file and flags truncation", async () => {
    seedVault([
      { kind: "file", relPath: "big.md", content: Array(55).fill("hit").join("\n") },
    ]);
    const out = await searchVault("hit");
    expect(out.hits[0].matches).toHaveLength(50);
    expect(out.truncated).toBe(true);
  });

  it("caps total matches at 200 across files in display order", async () => {
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
