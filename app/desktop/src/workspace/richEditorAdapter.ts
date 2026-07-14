/**
 * The source-preserving boundary around MDXEditor.
 *
 * The editor package is allowed to own interaction, never persistence. Core
 * block IDs remain opaque and byte offsets never enter the webview. Before a
 * body becomes editable, the actual mounted package must return every block
 * unchanged. Saves then describe only the smallest contiguous original block
 * range that covers the edit.
 */

export interface RichSourceBlock {
  id: string;
  leadingSeparator: string;
  markdown: string;
  trailingSeparator: string;
}

export interface RichSourceDocument {
  revision: string;
  body: string;
  blocks: RichSourceBlock[];
}

export interface MarkdownEditorBridge {
  setMarkdown: (markdown: string) => void;
  getMarkdown: () => string;
}

export interface RichEditPatchInput {
  expectedRevision: string;
  changedBlockIds: string[];
  replacementMarkdown: string;
}

export type RichPreflightResult =
  | { ok: true; editorMarkdown: string; terminalLf: boolean }
  | { ok: false; message: string };

const NORMALIZATION_FALLBACK =
  "This note uses Markdown that the rich editor would rewrite. It is open as raw Markdown instead.";
const RANGE_FALLBACK =
  "This note could not be mapped to stable source ranges. It is open as raw Markdown instead.";

function withoutOneTerminalLf(markdown: string): {
  editorMarkdown: string;
  terminalLf: boolean;
} {
  const terminalLf = markdown.endsWith("\n") && !markdown.endsWith("\n\n");
  return {
    editorMarkdown: terminalLf ? markdown.slice(0, -1) : markdown,
    terminalLf,
  };
}

function restoreOneTerminalLf(
  exported: string,
  terminalLf: boolean,
): string {
  const withoutTerminalLfs = exported.replace(/\n+$/, "");
  return terminalLf ? `${withoutTerminalLfs}\n` : exported;
}

function sourceSpan(block: RichSourceBlock): string {
  return `${block.leadingSeparator}${block.markdown}${block.trailingSeparator}`;
}

export function preflightRichDocument(
  editor: MarkdownEditorBridge,
  source: RichSourceDocument,
): RichPreflightResult {
  const reconstructed = source.blocks.map(sourceSpan).join("");
  if (reconstructed !== source.body) {
    return { ok: false, message: RANGE_FALLBACK };
  }

  // A byte-identical whole-body round trip necessarily preserves every
  // reconstructed source block and separator. Keeping this to one package pass
  // avoids a paint-frame wait per block for large notes.
  const whole = withoutOneTerminalLf(source.body);
  editor.setMarkdown(whole.editorMarkdown);
  const wholeExport = restoreOneTerminalLf(
    editor.getMarkdown(),
    whole.terminalLf,
  );
  if (wholeExport !== source.body) {
    return { ok: false, message: NORMALIZATION_FALLBACK };
  }

  return {
    ok: true,
    editorMarkdown: whole.editorMarkdown,
    terminalLf: whole.terminalLf,
  };
}

function afterEditorUpdate(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * MDXEditor publishes setMarkdown through its Realm/Lexical update pipeline.
 * The imperative setter is therefore not guaranteed to be observable through
 * getMarkdown in the same JavaScript turn. Production preflight waits for one
 * mounted whole-body commit before comparing the exact reconstructed source.
 */
export async function preflightMountedRichDocument(
  editor: MarkdownEditorBridge,
  source: RichSourceDocument,
): Promise<RichPreflightResult> {
  const reconstructed = source.blocks.map(sourceSpan).join("");
  if (reconstructed !== source.body) {
    return { ok: false, message: RANGE_FALLBACK };
  }

  // The exact body comparison below covers every core-provided block while
  // requiring only one asynchronous Realm/Lexical commit.
  const whole = withoutOneTerminalLf(source.body);
  editor.setMarkdown(whole.editorMarkdown);
  await afterEditorUpdate();
  const wholeExport = restoreOneTerminalLf(
    editor.getMarkdown(),
    whole.terminalLf,
  );
  if (wholeExport !== source.body) {
    return { ok: false, message: NORMALIZATION_FALLBACK };
  }

  return {
    ok: true,
    editorMarkdown: whole.editorMarkdown,
    terminalLf: whole.terminalLf,
  };
}

function decodeCharacterReferences(value: string): string | null {
  const named: Readonly<Record<string, string>> = {
    colon: ":",
    sol: "/",
    bsol: "\\",
    period: ".",
    percnt: "%",
  };
  let invalid = false;
  const decoded = value.replace(
    /&(?:#(\d+)|#x([\da-f]+)|([a-z]+));/gi,
    (_reference, decimal: string | undefined, hexadecimal: string | undefined, name: string | undefined) => {
      if (name) {
        const replacement = named[name.toLowerCase()];
        if (replacement !== undefined) return replacement;
        invalid = true;
        return "";
      }
      const codePoint = Number.parseInt(decimal ?? hexadecimal ?? "", decimal ? 10 : 16);
      if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
        invalid = true;
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
  // Unknown references are rejected rather than interpreted differently by
  // the editor, browser and native validation layers.
  if (invalid || /&(?:#\d+|#x[\da-f]+|[a-z]+);/i.test(decoded)) return null;
  return decoded;
}

function decodeUrlForValidation(value: string): string | null {
  const withCharacters = decodeCharacterReferences(value.trim());
  if (withCharacters === null) return null;
  let decoded = withCharacters;
  for (let pass = 0; pass < 3; pass += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return null;
    }
  }
  return decoded;
}

/** The exact URL policy shared by live links and the save preflight. */
export function richLinkIsSafe(value: string): boolean {
  if (/%(?:2f|5c)/i.test(value)) return false;
  const decoded = decodeUrlForValidation(value);
  if (!decoded) return false;
  for (const character of decoded) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return false;
  }
  if (decoded.startsWith("/") || decoded.startsWith("\\")) return false;

  // TODO(rich-link-backslash-parity): reject every raw backslash here to match
  // native validate_link_destination; cover `Areas\\Note.md` in the adapter tests.

  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(decoded)?.[1];
  if (scheme) {
    const lowerScheme = scheme.toLowerCase();
    if (lowerScheme === "mailto") {
      const original = value.trim();
      return /^mailto:/i.test(original) && original.slice(7).includes("@");
    }
    return lowerScheme === "http" || lowerScheme === "https";
  }

  const path = decoded.split(/[?#]/, 1)[0];
  for (const segment of path.replaceAll("\\", "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") return false;
  }
  return true;
}

function markdownDestinations(markdown: string): string[] {
  const destinations: string[] = [];
  for (let index = 0; index < markdown.length - 1; index += 1) {
    if (markdown[index] !== "]" || markdown[index + 1] !== "(") continue;
    let cursor = index + 2;
    let escaped = false;
    let depth = 0;
    let destination = "";
    const angled = markdown[cursor] === "<";
    if (angled) cursor += 1;
    for (; cursor < markdown.length; cursor += 1) {
      const character = markdown[cursor];
      if (escaped) {
        destination += character;
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (angled && character === ">") break;
      if (!angled && character === "(" ) depth += 1;
      if (!angled && character === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      if (!angled && depth === 0 && /\s/.test(character)) break;
      destination += character;
    }
    destinations.push(destination);
  }
  return destinations;
}

function assertSafeExport(markdown: string): void {
  if (markdownDestinations(markdown).some((url) => !richLinkIsSafe(url))) {
    throw new Error(
      "The rich editor produced an unsafe link. Continue in raw Markdown to correct it.",
    );
  }
}

export function buildRichEditPatch(
  source: RichSourceDocument,
  editedBody: string,
): RichEditPatchInput | null {
  if (editedBody === source.body) return null;
  assertSafeExport(editedBody);

  const spans = source.blocks.map(sourceSpan);
  if (spans.join("") !== source.body) {
    throw new Error(RANGE_FALLBACK);
  }
  if (spans.length === 0) {
    return {
      expectedRevision: source.revision,
      changedBlockIds: [],
      replacementMarkdown: editedBody,
    };
  }

  let prefixCount = 0;
  let prefixLength = 0;
  while (
    prefixCount < spans.length &&
    editedBody.startsWith(spans[prefixCount], prefixLength)
  ) {
    prefixLength += spans[prefixCount].length;
    prefixCount += 1;
  }

  let suffixCount = 0;
  let suffixLength = 0;
  while (suffixCount < spans.length - prefixCount) {
    const span = spans[spans.length - 1 - suffixCount];
    const start = editedBody.length - suffixLength - span.length;
    if (start < prefixLength || editedBody.slice(start, start + span.length) !== span) {
      break;
    }
    suffixLength += span.length;
    suffixCount += 1;
  }

  let firstChanged = prefixCount;
  let lastChangedExclusive = spans.length - suffixCount;
  let replacementStart = prefixLength;
  let replacementEnd = editedBody.length - suffixLength;

  // A pure insertion has no original range. Bind it to the closest unchanged
  // neighbour so the native boundary still receives an opaque source capability.
  if (firstChanged === lastChangedExclusive) {
    if (firstChanged > 0) {
      firstChanged -= 1;
      replacementStart -= spans[firstChanged].length;
    } else {
      lastChangedExclusive = 1;
      replacementEnd += spans[0].length;
    }
  }

  return {
    expectedRevision: source.revision,
    changedBlockIds: source.blocks
      .slice(firstChanged, lastChangedExclusive)
      .map((block) => block.id),
    replacementMarkdown: editedBody.slice(replacementStart, replacementEnd),
  };
}
