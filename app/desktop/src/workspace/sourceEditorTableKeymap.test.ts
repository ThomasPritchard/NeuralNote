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

import { formatTable, revealTableSource, tableKeymap } from "./sourceEditorTableCommands";
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
 * A real `Shift-Alt-\` keydown, as the DOM would deliver it.
 *
 * `key: "\\"` is the literal backslash — the base key, which is what a WebDriver
 * or synthetic press carries. It is NOT what macOS delivers for that chord from
 * a real keyboard; that is » and is covered separately below (#97).
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

    expect(owners(MAC_FORMAT_KEY)).toEqual([formatTable]);
    expect(owners(MAC_REVEAL_KEY)).toEqual([revealTableSource]);
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
