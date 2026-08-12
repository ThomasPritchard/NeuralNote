// The binding, and the collision check the spec demands for it.
//
// `specs/in-place-table-cell-editing.md:1133-1138`: the reveal command is bound
// to `Shift-Alt-\` "so it sits beside the existing `Shift-Alt-f` table binding;
// a test must assert it collides with nothing already in
// `SourceNoteEditor.tsx:161-196` (three `Mod-Enter` bindings, `completionKeymap`,
// `Tab`, `Shift-Tab`, `Enter`, `Shift-Alt-f`, `foldKeymap`, `defaultKeymap`,
// `historyKeymap`)".
//
// The failure mode being guarded is a binding SILENTLY SHADOWED by an earlier
// keymap entry: CodeMirror runs bindings in registration order and stops at the
// first that returns true, so a duplicate key higher up means the reveal
// command simply never runs and nothing reports it.
//
// THIS WHOLE FILE RUNS AS macOS. `@codemirror/view` samples the platform once,
// while the module is being evaluated (`dist/index.js:6,18`), so the flavour is
// a property of the module graph and cannot be switched per test — one platform
// per file is the only arrangement that cannot end up half mac and half not.
// macOS is the one worth having here because that is where the chords break
// (#97). The Windows/Linux side of that fix is proved live in
// `sourceEditorTableCommands.test.ts`, which runs on jsdom's own platform.

import { completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldKeymap } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";

import {
  formatTable,
  formatTableChord,
  revealTableSource,
  revealTableSourceChord,
  tableKeymap,
} from "./sourceEditorTableCommands";
import { revealedTableSource } from "./sourceEditorTableReveal";
import { tableDelimiterGuard } from "./sourceEditorTableDelimiterGuard";

// Vitest lifts this above the imports, which is the whole point: by the time
// `@codemirror/view` reads `navigator.platform`, it has to already say Mac.
// "really did load the macOS flavour of CodeMirror" below fails loudly if the
// lifting ever stops happening, rather than letting the suite pass as Linux.
vi.hoisted(() => {
  Object.defineProperty(globalThis.navigator, "platform", {
    value: "MacIntel",
    configurable: true,
  });
});

const REVEAL_KEY = "Shift-Alt-\\";

/**
 * The names macOS forces the two chords to be bound under (#97).
 *
 * On macOS `KeyboardEvent.key` carries the character the Option chord PRODUCES,
 * and CodeMirror deliberately skips its base-layout fallback for Option
 * combinations there (`@codemirror/view/dist/index.js:9188-9189`), so these are
 * the only names its resolver ever looks up for those keystrokes. On a US
 * layout Option-Shift-F produces Ï and Option-Shift-\ produces », the two
 * characters issue #97 reported being typed into the cell; each is annotated
 * with its codepoint below so a look-alike substitution is visible in review.
 */
const MAC_FORMAT_CHAR = "Ï"; // U+00CF LATIN CAPITAL LETTER I WITH DIAERESIS
const MAC_REVEAL_CHAR = "»"; // U+00BB RIGHT-POINTING DOUBLE ANGLE QUOTATION MARK
const MAC_FORMAT_KEY = `Shift-Alt-${MAC_FORMAT_CHAR}`;
const MAC_REVEAL_KEY = `Shift-Alt-${MAC_REVEAL_CHAR}`;

const TABLE = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

/** A table that needs reformatting, so `formatTable` has work to accept. */
const RAGGED = ["| a | b |", "| --- | --- |", "| xxxx | yyyy |"].join("\n");
const RAGGED_CARET = RAGGED.indexOf("xxxx");

/**
 * A table `formatTable` has nothing left to do to, so the command DECLINES
 * inside it — and it is the state the user is in immediately after every
 * successful format, which is what makes it the interesting case rather than a
 * corner one. Each test that uses it proves the decline rather than assuming
 * it, so a change to the width rules turns this fixture red instead of quietly
 * turning the case into the one above.
 */
const ALIGNED = ["| A   | B   |", "| --- | --- |", "| 1   | 2   |"].join("\n");
const ALIGNED_CARET = ALIGNED.indexOf("1");

/** No table anywhere, so both commands decline for want of one. */
const PROSE = "a paragraph with no table in it";

/** Dispatch a keydown and hand back the event, so callers can read the verdict. */
function press(view: EditorView, init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  view.contentDOM.dispatchEvent(event);
  return event;
}

/**
 * Every binding `SourceNoteEditor` registers, in registration order.
 *
 * The three `Mod-Enter` entries close over component refs and so cannot be
 * imported; their KEYS are static and are restated here, which is the only part
 * a collision check needs. Everything else is the real module.
 */
const REGISTERED: readonly KeyBinding[] = [
  { key: "Mod-Enter", run: () => false },
  { key: "Mod-Enter", run: () => false },
  { key: "Mod-Enter", run: () => false },
  ...completionKeymap,
  ...tableKeymap,
  ...foldKeymap,
  ...defaultKeymap,
  ...historyKeymap,
];

/** Every key a binding claims, across all platform variants. */
function claimedKeys(binding: KeyBinding): string[] {
  return [binding.key, binding.mac, binding.win, binding.linux]
    .filter((key): key is string => typeof key === "string");
}

/**
 * A hand-built `Shift-Alt-\` keydown carrying the UNSHIFTED base character.
 *
 * Nothing real delivers that shape, and the point of it is what it proves. A
 * macOS keyboard sends » for this chord, and a driver sends `|`: a Playwright
 * press of `Shift+Alt+Backslash` on macOS reports `key: "|"`, `keyCode: 220` on
 * both WebKit and Chromium, which is the shape
 * `sourceEditorTableCommands.test.ts` presses for the Windows/Linux half.
 *
 * `"\\"` is the ONE shape that still resolves the base binding on macOS. The
 * base-layout fallback is switched off there
 * (`@codemirror/view/dist/index.js:9189`), so the only remaining route is the
 * retry at `:9199-9200`, which prefixes `Shift-` to the event's own `key` — and
 * that matches only when the `key` is the base character. So this press is the
 * live proof that the base name is still REGISTERED on macOS, which is exactly
 * what keeping the `mac:` entries separate buys. The » chord a real keyboard
 * sends is covered separately below (#97).
 */
function pressRevealKey(view: EditorView): void {
  press(view, { key: "\\", altKey: true, shiftKey: true });
}

describe("the Shift-Alt-\\ binding", () => {
  it("is claimed exactly once across the whole registered keymap", () => {
    const claims = REGISTERED.flatMap(claimedKeys).filter((key) => key === REVEAL_KEY);
    expect(claims).toHaveLength(1);
  });

  it("is claimed by the reveal command and nothing else", () => {
    const owners = REGISTERED.filter((binding) => claimedKeys(binding).includes(REVEAL_KEY));
    expect(owners.map((binding) => binding.run)).toEqual([revealTableSource]);
  });

  it("sits beside Shift-Alt-f in the table keymap", () => {
    // Spec :1134 — "so it sits beside the existing `Shift-Alt-f` table binding".
    const keys = tableKeymap.flatMap(claimedKeys);
    expect(keys).toContain("Shift-Alt-f");
    expect(keys.indexOf(REVEAL_KEY)).toBe(keys.indexOf("Shift-Alt-f") + 1);
  });

  it("claims each macOS alternate exactly once, for the command it belongs to", () => {
    const owners = (key: string) =>
      REGISTERED.filter((binding) => claimedKeys(binding).includes(key)).map((binding) => binding.run);

    // The chord wrappers, not the bare commands: on macOS these keys run the
    // command AND claim the keystroke when it declines inside a table, which is
    // the whole of the contract below.
    expect(owners(MAC_FORMAT_KEY)).toEqual([formatTableChord]);
    expect(owners(MAC_REVEAL_KEY)).toEqual([revealTableSourceChord]);
    // The base names keep the bare commands — reveal's is pinned above.
    expect(owners("Shift-Alt-f")).toEqual([formatTable]);
  });

  it("gives the macOS alternates no cross-platform key", () => {
    // How they stay inert off macOS: `buildKeymap` reads `binding[platform] ||
    // binding.key` and skips a binding that yields neither
    // (`@codemirror/view/dist/index.js:9136-9138`). A `key` here would bind the
    // Option-produced character on Windows and Linux, where it means nothing.
    const alternates = tableKeymap.filter((binding) => binding.mac !== undefined);

    expect(alternates.map((binding) => binding.mac)).toEqual([MAC_FORMAT_KEY, MAC_REVEAL_KEY]);
    expect(alternates.flatMap((binding) => [binding.key, binding.win, binding.linux])
      .filter((key) => key !== undefined)).toEqual([]);
  });

  it("keeps the table keymap after completionKeymap and before defaultKeymap", () => {
    // The documented ordering constraint in `SourceNoteEditor.tsx`: an open
    // completion popup keeps Enter, and table commands still beat the defaults.
    const order = REGISTERED.map(claimedKeys);
    const first = (source: readonly KeyBinding[]) =>
      order.findIndex((keys) => keys.includes(claimedKeys(source[0]!)[0]!));
    expect(first(completionKeymap)).toBeLessThan(order.findIndex((k) => k.includes(REVEAL_KEY)));
    expect(order.findIndex((k) => k.includes(REVEAL_KEY)))
      .toBeLessThan(REGISTERED.length - defaultKeymap.length - historyKeymap.length);
  });
});

/** The editor as `SourceNoteEditor` configures it, with the full ordered keymap. */
function mounted(doc: string, anchor: number, extra: readonly KeyBinding[] = []) {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(anchor),
      extensions: [
        markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
        revealedTableSource,
        tableDelimiterGuard,
        history(),
        keymap.of([...extra, ...REGISTERED]),
      ],
    }),
    parent: document.body,
  });
}

describe("the binding resolved by CodeMirror itself", () => {
  it("reaches the reveal command through the real keymap, unshadowed", () => {
    // This is the anti-shadowing proof: it goes through CodeMirror's own key
    // resolution against the full ordered keymap, so ANY earlier entry claiming
    // the key would leave the field null here.
    const view = mounted(TABLE, TABLE.indexOf("| --- |") + 2);
    expect(view.state.field(revealedTableSource)).toBeNull();

    pressRevealKey(view);
    expect(view.state.field(revealedTableSource)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(TABLE);
    view.destroy();
  });
});

describe("the macOS Option chords (#97)", () => {
  it("really did load the macOS flavour of CodeMirror", () => {
    // Without this the block below is worthless. On a non-mac graph the chords
    // resolve through the base-layout fallback instead, so every test here would
    // pass for a reason that does not exist on the platform the bug is on — and
    // that is not hypothetical: it is what this file did before the platform
    // override was hoisted above the imports.
    // `Mod-` is CodeMirror's own platform tell: Meta on mac, Ctrl elsewhere.
    const ran: string[] = [];
    const view = mounted("x", 0, [
      { key: "Mod-b", run: () => { ran.push("Mod-b"); return true; } },
    ]);

    press(view, { key: "b", ctrlKey: true });
    expect(ran).toEqual([]);

    press(view, { key: "b", metaKey: true });
    expect(ran).toEqual(["Mod-b"]);
    view.destroy();
  });

  it("invokes formatTable for the Shift-Option-F chord macOS actually delivers", () => {
    const byCommand = mounted(RAGGED, RAGGED_CARET);
    expect(formatTable(byCommand)).toBe(true);
    const formatted = byCommand.state.doc.toString();
    byCommand.destroy();

    const view = mounted(RAGGED, RAGGED_CARET);
    const event = press(view, {
      key: MAC_FORMAT_CHAR,
      altKey: true,
      shiftKey: true,
      keyCode: 70,
    });

    // Pinned to what the command itself produces rather than to a literal
    // layout: the column widths belong to another module's contract, and what
    // is on trial here is the keystroke reaching the command at all.
    expect(view.state.doc.toString()).toBe(formatted);
    expect(formatted).not.toBe(RAGGED);
    // Documentation, not coverage: jsdom performs no default text insertion for
    // a synthetic keydown, so this line cannot fail here whatever the keymap
    // does. `defaultPrevented` below is the assertion carrying the weight — it
    // is the mechanism by which the character is suppressed in a real engine.
    expect(view.state.doc.toString()).not.toContain(MAC_FORMAT_CHAR);
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  it("invokes revealTableSource for the Shift-Option-backslash chord macOS delivers", () => {
    const view = mounted(TABLE, TABLE.indexOf("| --- |") + 2);
    expect(view.state.field(revealedTableSource)).toBeNull();

    const event = press(view, {
      key: MAC_REVEAL_CHAR,
      altKey: true,
      shiftKey: true,
      keyCode: 220,
    });

    expect(view.state.field(revealedTableSource)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(TABLE); // revealing changes no bytes
    // Same as above: unfalsifiable at this tier, kept only as the statement of
    // intent. `defaultPrevented` on the next line is what proves it.
    expect(view.state.doc.toString()).not.toContain(MAC_REVEAL_CHAR);
    expect(event.defaultPrevented).toBe(true);
    view.destroy();
  });

  // The regression a too-broad fix causes, and so the most important case here:
  // claiming Option chords wholesale would take the editor's dead keys and every
  // accented character with them. jsdom cannot type, so `defaultPrevented` is
  // the load-bearing assertion — false means the keymap declined and the event
  // goes on to the input method, which is exactly what composition needs.
  it.each<{ chord: string; init: KeyboardEventInit }>([
    { chord: "a dead key opening a composition (Option-E)", init: { key: "Dead", altKey: true, keyCode: 69 } },
    { chord: "the accented character that composition then commits", init: { key: "é", keyCode: 69 } },
    { chord: "an ordinary Option character (Option-8)", init: { key: "•", altKey: true, keyCode: 56 } },
    { chord: "a shifted Option character that is not a table chord (Shift-Option-8)", init: { key: "°", altKey: true, shiftKey: true, keyCode: 56 } },
    { chord: "the unshifted half of the format chord (Option-F)", init: { key: "ƒ", altKey: true, keyCode: 70 } },
    { chord: "the unshifted half of the reveal chord (Option-backslash)", init: { key: "«", altKey: true, keyCode: 220 } },
  ])("leaves $chord to the input method inside a table cell", ({ init }) => {
    const view = mounted(TABLE, TABLE.indexOf("| 1 |") + 2);
    const event = press(view, init);

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE);
    view.destroy();
  });
});

/**
 * The contract the two macOS entries implement, one case per row (#97).
 *
 * > Inside a table the chord is a COMMAND; outside a table it is a CHARACTER.
 *
 * The middle case is the defect this block was written for. A CodeMirror
 * binding only claims a keystroke when its `run` returns true, so a command
 * that DECLINED inside a table — an already-aligned table, which is where every
 * successful format leaves the user — left the chord unclaimed and `Ï` landed
 * in the cell. Pressing Shift-Option-F twice was enough to reproduce it.
 *
 * `defaultPrevented` carries every assertion here, because it is the actual
 * suppression mechanism and the only observable at this tier: jsdom implements
 * no default text insertion for a synthetic keydown, so `doc` cannot gain a `Ï`
 * however broken the binding is, and a `not.toContain` written against it would
 * pass on a keymap that did nothing at all.
 */
describe("the macOS chord contract (#97)", () => {
  const FORMAT_CHORD: KeyboardEventInit = {
    key: MAC_FORMAT_CHAR,
    altKey: true,
    shiftKey: true,
    keyCode: 70,
  };
  const REVEAL_CHORD: KeyboardEventInit = {
    key: MAC_REVEAL_CHAR,
    altKey: true,
    shiftKey: true,
    keyCode: 220,
  };

  it("claims the format chord inside a table it has nothing to reformat", () => {
    // The precondition, not an aside: without a genuinely declining command
    // this is the row above wearing a different fixture.
    const probe = mounted(ALIGNED, ALIGNED_CARET);
    expect(formatTable(probe)).toBe(false);
    probe.destroy();

    const view = mounted(ALIGNED, ALIGNED_CARET);
    const event = press(view, FORMAT_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.doc.toString()).toBe(ALIGNED);
    view.destroy();
  });

  it("claims the reveal chord inside a table already showing its source", () => {
    // Reveal toggles, so it cannot decline inside a table the way format does.
    // Pressing it twice is the nearest thing: the second press is a command
    // with a table under it either way, and the chord must stay claimed.
    const view = mounted(TABLE, TABLE.indexOf("| 1 |") + 2);
    expect(press(view, REVEAL_CHORD).defaultPrevented).toBe(true);
    expect(view.state.field(revealedTableSource)).not.toBeNull();

    const event = press(view, REVEAL_CHORD);

    expect(event.defaultPrevented).toBe(true);
    expect(view.state.field(revealedTableSource)).toBeNull();
    view.destroy();
  });

  it.each<{ chord: string; init: KeyboardEventInit }>([
    { chord: "format", init: FORMAT_CHORD },
    { chord: "reveal", init: REVEAL_CHORD },
  ])("leaves the $chord chord to the input method outside any table", ({ init }) => {
    const view = mounted(PROSE, PROSE.indexOf("with"));
    const event = press(view, init);

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(PROSE);
    view.destroy();
  });

  it.each<{ chord: string; init: KeyboardEventInit }>([
    { chord: "format", init: FORMAT_CHORD },
    { chord: "reveal", init: REVEAL_CHORD },
  ])("leaves the $chord chord alone where the table stops being active", ({ init }) => {
    // `activeTableAt` is exclusive of `table.to`, because the preview layer
    // still draws the read-only widget there and every other table command
    // refuses at that position. The chords agree rather than deriving the
    // boundary again: at exactly `to` the caret is outside the table, so the
    // character is what the user asked for.
    const view = mounted(TABLE, TABLE.length);
    const event = press(view, init);

    expect(event.defaultPrevented).toBe(false);
    expect(view.state.doc.toString()).toBe(TABLE);
    expect(view.state.field(revealedTableSource)).toBeNull();
    view.destroy();
  });
});
