// Remark plugin: turn Obsidian `[[wikilinks]]` in *text* nodes into mdast
// `link` nodes with a private `nn-wikilink:` scheme, so Markdown.tsx can
// resolve them against the vault's note index and make them clickable.
//
// Scanning only `text` nodes naturally skips code fences and inline code —
// their content lives in a node's `value`, not in text children — so `[[x]]`
// inside a fence stays literal, mirroring the Rust core's code-masking.
// The `[[` / `]]` pairing uses the same first-`]]`-after-`[[` scan as
// crates/neuralnote-core/src/links.rs (`extract_wikilinks`), so what the
// reader renders as a link is exactly what the backlinks/graph side counts.

import type { Parent, PhrasingContent, Root } from "mdast";

/** The private URL scheme carrying the raw wikilink target (heading included). */
export const WIKILINK_SCHEME = "nn-wikilink:";

/** Parents whose text children must not become links: a link inside a link is
 *  invalid HTML, and react-markdown would silently flatten it. */
const SKIP_CHILDREN = new Set(["link", "linkReference"]);

interface WikilinkToken {
  end: number;
  target: string;
  label: string;
}

function parseWikilinkInner(inner: string): Omit<WikilinkToken, "end"> {
  const pipe = inner.indexOf("|");
  // The raw target keeps its `#heading`; only the `|alias` is display-side.
  const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
  const alias = pipe === -1 ? "" : inner.slice(pipe + 1).trim();
  return { target, label: alias === "" ? target : alias };
}

function readWikilink(value: string, open: number): WikilinkToken | null {
  const close = value.indexOf("]]", open + 2);
  if (close === -1) return null;
  return {
    ...parseWikilinkInner(value.slice(open + 2, close)),
    end: close + 2,
  };
}

function wikilinkNode(target: string, label: string): PhrasingContent {
  return {
    type: "link",
    url: WIKILINK_SCHEME + target,
    children: [{ type: "text", value: label }],
  };
}

/** Split a text value around its wikilinks, or null when none are present.
 *  Handles `[[t]]`, `[[t|alias]]`, `[[t#heading]]`, `[[t#heading|alias]]`;
 *  an unclosed `[[` (no following `]]`) stays literal text. */
function splitWikilinks(value: string): PhrasingContent[] | null {
  const parts: PhrasingContent[] = [];
  let emitted = 0; // start of the text not yet pushed
  let scan = 0;
  let found = false;

  for (;;) {
    const open = value.indexOf("[[", scan);
    if (open === -1) break;
    const token = readWikilink(value, open);
    if (token === null) break; // unclosed — leave the rest literal

    scan = token.end;
    if (token.target === "") continue; // `[[]]` / `[[|x]]` — not a link, stays literal

    if (open > emitted) {
      parts.push({ type: "text", value: value.slice(emitted, open) });
    }
    parts.push(wikilinkNode(token.target, token.label));
    found = true;
    emitted = scan;
  }

  if (!found) return null;
  if (emitted < value.length) {
    parts.push({ type: "text", value: value.slice(emitted) });
  }
  return parts;
}

function transform(parent: Parent): void {
  const next: Parent["children"] = [];
  let changed = false;
  for (const child of parent.children) {
    if (child.type === "text") {
      const parts = splitWikilinks(child.value);
      if (parts !== null) {
        next.push(...parts);
        changed = true;
        continue;
      }
    } else if ("children" in child && !SKIP_CHILDREN.has(child.type)) {
      transform(child);
    }
    next.push(child);
  }
  if (changed) parent.children = next;
}

/** The remark plugin. Add to `remarkPlugins` alongside remark-gfm. */
export function remarkWikilink() {
  return (tree: Root): void => {
    transform(tree);
  };
}
