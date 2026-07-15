const TAG_WORD_CHARACTER = /^[\p{L}\p{M}\p{N}_/-]$/u;
const UNICODE_SYMBOL = /^\p{S}$/u;
const NUMERIC_CHARACTER = /^\p{N}$/u;

function isTagCharacter(character: string): boolean {
  return TAG_WORD_CHARACTER.test(character)
    || character === "\u200d"
    || ((character.codePointAt(0) ?? 0) > 0x7f && UNICODE_SYMBOL.test(character));
}

export function inlineTagAt(source: string, hashIndex: number): string | null {
  let end = hashIndex + 1;
  let hasNonNumericCharacter = false;
  for (const character of source.slice(end)) {
    if (!isTagCharacter(character)) break;
    if (!NUMERIC_CHARACTER.test(character)) hasNonNumericCharacter = true;
    end += character.length;
  }
  if (end === hashIndex + 1 || !hasNonNumericCharacter) return null;
  return source.slice(hashIndex, end);
}

export function normalizeObsidianTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const candidate = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return inlineTagAt(candidate, 0) === candidate ? candidate : null;
}
