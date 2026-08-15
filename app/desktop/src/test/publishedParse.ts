/**
 * A markdown `EditorState` whose finished parse the syntax tree actually holds.
 *
 * `LanguageState.init` parses at most `Work.InitViewport` (3,000) characters and
 * abandons even that slice once `Work.Apply` — 20ms of WALL CLOCK — is spent
 * (`@codemirror/language/dist/index.js:527-546`). On a loaded machine that race
 * is lost for a 1KB fixture, so two states built from the same text can hold
 * different trees. Anything reading the tree then sees a document with no table
 * in it: `tableStarts` finds nothing, the command declines, and a test asserting
 * on the command's spec fails with `expected null not to be null`.
 *
 * `ensureSyntaxTree` ALONE does not close it, which is why #118 stayed flaky
 * with that call already in place. It advances the parse CONTEXT and returns the
 * finished tree, but `syntaxTree()` — what the guards and commands read — returns
 * `LanguageState.tree`, a snapshot taken in that class's constructor. The
 * snapshot stays truncated, and `syntaxTreeAvailable()` answers `true` either
 * way, so it cannot detect this. Publishing the advanced parse takes a
 * transaction, which is precisely what `forceParsing` dispatches for a view
 * (`ibid.:225-230`). This is that, for a bare state.
 *
 * **This lives here rather than beside one test on purpose.** The original fix
 * (#118, #142) patched the two helpers named in the two issues and left every
 * other builder reading the unpublished snapshot — so the diagnosis was general
 * and the remedy was not, and the same failure resurfaced from a sibling helper
 * in the very same file at 20 CPU burners. One shared entry point is what stops
 * that recurring.
 *
 * Production cannot hit this: a filter and the paint path read the SAME state,
 * so they agree by construction whatever the parse has reached, and `reparsed`
 * (`sourceEditorDecorations.ts:73`) recomputes every decoration once the
 * finished tree lands. This is a property of reading a state from OUTSIDE the
 * editor, which only a test does.
 */

import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";

/** How long to let the parse run. Generous: it is bounded by work, not by wall clock. */
const PARSE_BUDGET_MS = 30_000;

/**
 * Finish `editor`'s parse and return a state whose `syntaxTree` IS that parse.
 *
 * Throws rather than returning a half-parsed state: a test that silently
 * proceeds on a truncated tree is the flake this exists to remove.
 */
export function withPublishedParse(editor: EditorState, doc: string): EditorState {
  const parsed = ensureSyntaxTree(editor, doc.length, PARSE_BUDGET_MS);
  if (!parsed) {
    throw new Error("the fixture did not parse in full; every assertion below would be unsound");
  }
  if (parsed === syntaxTree(editor)) return editor;

  const published = editor.update({}).state;
  // Identity, not truthiness: `ensureSyntaxTree` answering with a tree proves
  // only that the context reached the end, never that the field hands that tree
  // to its reader. If an upgrade stops republishing here, this throws rather
  // than quietly restoring the flake.
  if (syntaxTree(published) !== parsed) {
    throw new Error("the finished parse was not published; the reader would see a truncated tree");
  }
  return published;
}
