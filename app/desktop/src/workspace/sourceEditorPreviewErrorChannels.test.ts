// The two preview passes report on their own channel, through the composed
// `sourceEditorDecorations` extension.
//
// They have different triggers: the table `StateField` recomputes on a document,
// selection, viewport, remeasure or reparse; the inline plugin also on a focus
// change and on the refresh effect a vault-index rebuild dispatches. Sent
// through one callback, the inline pass's routine success cleared a banner the
// table pass had raised — while every table on screen was still raw pipes.
//
// `sourceEditorPreviewErrorReporter.test.ts` covers the multiplexer's own rules.
// This file covers the wiring: that each pass reaches the channel it belongs to.

import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { forceParsing } from "@codemirror/language";
import { EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import {
  refreshSourceEditorDecorations,
  sourceEditorDecorations,
  tableCellMetrics,
} from "./sourceEditorDecorations";

const FIRST_TABLE = ["| aa | bb |", "| --- | --- |", "| cc | dd |"].join("\n");

const mounted: EditorView[] = [];

afterEach(() => {
  for (const view of mounted.splice(0)) {
    view.dom.parentElement?.remove();
    view.destroy();
  }
});

const TABLE_ERROR = "Table preview is temporarily unavailable. Your source is unchanged.";

/**
 * The shipped extension with a table-decoration failure injected at the one
 * seam a caller controls: the measurement probe, which `tableRenderPlan` calls
 * once per cell from inside the `StateField`.
 */
const failingMetricsExtensions = (
  onError: (message: string | null) => void,
  failing: { current: boolean },
) => [
  markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
  sourceEditorDecorations(onError),
  tableCellMetrics.of(() => {
    if (failing.current) throw new Error("synthetic table decoration failure");
    return null;
  }),
];

/**
 * Mount the editor with that failure armed, and with the parse finished.
 *
 * The parse is not incidental: the table `StateField` reaches the injected
 * probe only for a table it can find in `syntaxTree(state)`, and
 * `LanguageState.init` publishes only what it parsed inside `Work.Apply` — 20 ms
 * of WALL CLOCK (`@codemirror/language/dist/index.js:539-545`). Lose that race
 * and there is no table, the probe never throws, and every assertion here reads
 * a channel that was never asked to report. `forceParsing` finishes the parse
 * AND dispatches the transaction that publishes it (`ibid.:225-230`); see
 * `src/test/publishedParse.ts` for the same argument in full.
 */
function mountWithFailingTableMetrics(
  doc: string,
  caretAt: number,
  failing: { current: boolean },
): { view: EditorView; messages: Array<string | null> } {
  const messages: Array<string | null> = [];
  const host = document.createElement("div");
  document.body.append(host);
  const view = new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: caretAt },
      extensions: failingMetricsExtensions((message) => { messages.push(message); }, failing),
    }),
    parent: host,
  });
  mounted.push(view);
  if (!forceParsing(view, view.state.doc.length, 30_000)) {
    throw new Error("the note did not parse in full; the table channel would never be reached");
  }
  return { view, messages };
}

const flushMicrotasks = (): Promise<void> =>
  new Promise((resolve) => { setTimeout(resolve, 0); });

describe("the preview error channels", () => {
  it("keeps a table failure reported when the inline pass succeeds", async () => {
    const failing = { current: true };
    const { view, messages } = mountWithFailingTableMetrics(
      FIRST_TABLE,
      FIRST_TABLE.indexOf("cc"),
      failing,
    );
    await flushMicrotasks();
    expect(messages).toContain(TABLE_ERROR);

    // A vault-index rebuild dispatches exactly this, and it recomputes the
    // inline plugin without recomputing the table field.
    view.dispatch({ effects: refreshSourceEditorDecorations.of(null) });
    await flushMicrotasks();

    expect(messages.at(-1)).toBe(TABLE_ERROR);
  });

  it("clears the banner once the table path stops failing", async () => {
    // The other half of the contract. A reporter that never clears would pass
    // the test above and leave a stale banner up for the rest of the session.
    const failing = { current: true };
    const { view, messages } = mountWithFailingTableMetrics(
      FIRST_TABLE,
      FIRST_TABLE.indexOf("cc"),
      failing,
    );
    await flushMicrotasks();
    expect(messages).toContain(TABLE_ERROR);

    failing.current = false;
    view.dispatch({ selection: { anchor: FIRST_TABLE.indexOf("dd") } });
    await flushMicrotasks();

    expect(messages.at(-1)).toBeNull();
  });

  it("re-reports a live table failure to a reconfigured callback", async () => {
    // Reopening a note tab reconfigures the SAME state
    // (`sourceEditorSession.ts:41`) and builds a fresh reporter, which has never
    // heard of the failure the field is still holding — so the banner would
    // disappear with every table on screen still raw pipes.
    //
    // It does not, because the field recomputes on `transaction.reconfigured`
    // and the freshly built `tableErrorPlugin` reports what it finds. That is a
    // deliberate mechanism rather than an incidental one: the rebuilt extension
    // array also carries a fresh `markdown()` Language, so `reparsed` would
    // cover this case today too — but memoise the language extension and only
    // the `reconfigured` check is left holding it up.
    const failing = { current: true };
    const { view } = mountWithFailingTableMetrics(
      FIRST_TABLE,
      FIRST_TABLE.indexOf("cc"),
      failing,
    );
    await flushMicrotasks();

    const reconfigured: Array<string | null> = [];
    view.dispatch({
      effects: StateEffect.reconfigure.of(
        failingMetricsExtensions((message) => { reconfigured.push(message); }, failing),
      ),
    });
    await flushMicrotasks();

    expect(reconfigured.at(-1)).toBe(TABLE_ERROR);
  });

  it("reports nothing but null while both channels are healthy", async () => {
    // The premise the two tests above rest on: without it they would pass
    // against a callback that had simply stopped being called.
    const { messages } = mountWithFailingTableMetrics(
      FIRST_TABLE,
      FIRST_TABLE.indexOf("cc"),
      { current: false },
    );
    await flushMicrotasks();

    expect(messages.filter((message) => message !== null)).toEqual([]);
    expect(messages).toContain(null);
  });
});
