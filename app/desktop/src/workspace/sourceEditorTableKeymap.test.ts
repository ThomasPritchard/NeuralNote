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

import { completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { foldKeymap } from "@codemirror/language";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView, keymap, type KeyBinding } from "@codemirror/view";
import { describe, expect, it } from "vitest";

import { revealTableSource, tableKeymap } from "./sourceEditorTableCommands";
import { revealedTableSource } from "./sourceEditorTableReveal";
import { tableDelimiterGuard } from "./sourceEditorTableDelimiterGuard";

const REVEAL_KEY = "Shift-Alt-\\";

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
 * `key: "\\"` is the literal backslash. Note this is what a synthetic event
 * carries, NOT necessarily what macOS delivers for Option-Shift-backslash —
 * see the reachability note in the reveal command's report.
 */
function pressRevealKey(view: EditorView): void {
  view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", {
    key: "\\",
    altKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  }));
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

describe("the binding resolved by CodeMirror itself", () => {
  const TABLE = ["| A | B |", "| --- | --- |", "| 1 | 2 |"].join("\n");

  function mounted(anchor: number) {
    const view = new EditorView({
      state: EditorState.create({
        doc: TABLE,
        selection: EditorSelection.cursor(anchor),
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          revealedTableSource,
          tableDelimiterGuard,
          history(),
          keymap.of([...REGISTERED]),
        ],
      }),
      parent: document.body,
    });
    return view;
  }

  it("reaches the reveal command through the real keymap, unshadowed", () => {
    // This is the anti-shadowing proof: it goes through CodeMirror's own key
    // resolution against the full ordered keymap, so ANY earlier entry claiming
    // the key would leave the field null here.
    const view = mounted(TABLE.indexOf("| --- |") + 2);
    expect(view.state.field(revealedTableSource)).toBeNull();

    pressRevealKey(view);
    expect(view.state.field(revealedTableSource)).not.toBeNull();
    expect(view.state.doc.toString()).toBe(TABLE);
    view.destroy();
  });
});
