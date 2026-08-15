// The engine's Unicode tables, checked in the engine that ships.
//
// `monospaceWidth` decides an emoji's column count by asking the RUNTIME —
// `/^\p{Emoji_Presentation}$/u` (`sourceEditorTableModel.ts:90`) — rather than
// reading a transcribed range table. That is the right call for correctness:
// the property is scattered a character at a time through the symbol blocks, so
// a hand-copied list is both long and stale the next time Unicode adds an emoji.
//
// It has a cost, and this file is the guard against it. `Shift-Alt-f` pads table
// cells to that width and WRITES THE RESULT TO DISK, so the byte content of a
// formatted note becomes a property of whichever ICU the host engine was built
// with. Two machines formatting the same note would then disagree — a spurious
// diff in a git- or iCloud-synced vault, and a column that stays ragged on one
// of them. CLAUDE.md calls the data format sacred; this is the one command that
// rewrites it.
//
// **This cannot live in the jsdom tier, and a green suite there means nothing
// for it.** Vitest runs on Node's ICU. The app renders in macOS WKWebView, whose
// Unicode tables move on Apple's schedule, not Node's. Only the browser tier
// runs a real engine, and only `NEURALNOTE_BROWSER=webkit` runs the engine
// family the product actually ships in. Measured at the time of writing: WebKit
// 26.5 and Chromium 151 both resolve every code point below; Node 24.18 carries
// ICU 78 / Unicode 17.
//
// So this is deliberately a PLATFORM assertion, not a code assertion. If it goes
// red, the code is fine and the host is behind — and that is precisely the thing
// worth learning before a user's note gets reformatted differently on two of
// their machines.

import { describe, expect, it } from "vitest";

import { monospaceWidth } from "./sourceEditorTableModel";

/**
 * Emoji from Symbols and Pictographs Extended-A (`U+1FA70`-`U+1FAFF`).
 *
 * Chosen because that block sits OUTSIDE every static range the module keeps
 * (`DOUBLE_WIDTH_RANGES` stops at `U+1F9FF`), so each of these can only be
 * measured as two columns by the runtime property lookup. If someone later
 * transcribes the block into the static table, these keep passing — which is
 * why the first test asks the engine directly rather than inferring the tables
 * from the width.
 */
const EXTENDED_A_EMOJI = [
  { code: 0x1fa7b, name: "x-ray" },
  { code: 0x1fa88, name: "flute" },
  { code: 0x1fa89, name: "harp" },
  { code: 0x1fabf, name: "goose" },
  { code: 0x1fac6, name: "fingerprint" },
  { code: 0x1fadf, name: "splatter" },
] as const;

const label = ({ code, name }: { code: number; name: string }) =>
  `U+${code.toString(16).toUpperCase().padStart(5, "0")} ${name}`;

describe("emoji width depends on this engine's Unicode tables", () => {
  it("resolves Emoji_Presentation for code points added after the static ranges", () => {
    // The ICU check itself, stated against the engine rather than against our
    // code, so it stays true however `monospaceWidth` is implemented later.
    //
    // A non-empty list here does not mean the code broke. It means THIS ENGINE'S
    // Unicode tables predate the code points named in it, so Format table would
    // pad them to one column on this host and two on a current one — the same
    // note, formatted on two machines, differing on disk. The listed characters
    // are the ones to check against the engine's release notes.
    const narrow = EXTENDED_A_EMOJI
      .filter((emoji) => !/^\p{Emoji_Presentation}$/u.test(String.fromCodePoint(emoji.code)))
      .map(label);

    expect(narrow).toEqual([]);
  });

  it("measures those code points as two columns", () => {
    // The wiring: the property lookup above actually reaches the width used for
    // padding. Asserted per code point so a failure names the character.
    const mismeasured = EXTENDED_A_EMOJI
      .map((emoji) => ({ emoji, width: monospaceWidth(String.fromCodePoint(emoji.code)) }))
      .filter(({ width }) => width !== 2);

    expect(mismeasured.map(({ emoji, width }) => `${label(emoji)} = ${width}`)).toEqual([]);
  });

  it("still separates a text-presentation symbol from an emoji one", () => {
    // The discrimination the property exists for, and the reason a blanket
    // "symbol blocks are wide" range would be wrong. `U+2600` and `U+2714` are
    // narrow dingbats; `U+2614` and `U+2705` are two-column emoji. All four sit
    // in the same neighbourhood, which is why the module reads the property
    // instead of a range.
    expect(monospaceWidth("☀")).toBe(1); // ☀ text presentation
    expect(monospaceWidth("✔")).toBe(1); // ✔ text presentation
    expect(monospaceWidth("☔")).toBe(2); // ☔ emoji presentation
    expect(monospaceWidth("✅")).toBe(2); // ✅ emoji presentation
  });

  it("treats a variation selector as the request to widen that it is", () => {
    // `U+FE0F` is the whole difference between a narrow dingbat and an emoji, so
    // a note that carries it must pad for two columns on every engine.
    expect(monospaceWidth("☀️")).toBe(2);
    expect(monospaceWidth("✔️")).toBe(2);
  });
});
