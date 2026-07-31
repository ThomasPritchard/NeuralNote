import { EditorView } from "@codemirror/view";
import { emit } from "@tauri-apps/api/event";

import { MENU_ACTION } from "./lib/bindings/events";

interface NativeE2eEditorBridge {
  replaceFirst(expected: string, replacement: string): boolean;
  matchesDocument(expected: string): boolean;
  append(text: string): void;
  closeVaultViaNativeMenuAction(): Promise<void>;
}

declare global {
  interface Window {
    NEURALNOTE_NATIVE_E2E_BRIDGE_V1?: NativeE2eEditorBridge;
  }
}

function currentEditor(): EditorView {
  const content = document.querySelector<HTMLElement>(
    "[role='textbox'][aria-label='Note content']",
  );
  const view = content ? EditorView.findFromDOM(content) : null;
  if (!view) throw new Error("native E2E editor bridge could not find CodeMirror");
  return view;
}

export function installNativeE2eBridge(): void {
  window.NEURALNOTE_NATIVE_E2E_BRIDGE_V1 = {
    replaceFirst(expected, replacement) {
      const view = currentEditor();
      const from = view.state.doc.toString().indexOf(expected);
      if (from < 0) return false;
      view.dispatch({
        changes: { from, to: from + expected.length, insert: replacement },
        selection: { anchor: from + replacement.length },
      });
      view.focus();
      return true;
    },
    matchesDocument(expected) {
      return currentEditor().state.doc.toString() === expected;
    },
    append(text) {
      const view = currentEditor();
      const from = view.state.doc.length;
      view.dispatch({
        changes: { from, insert: `\n${text}` },
        selection: { anchor: from + text.length + 1 },
      });
      view.focus();
    },
    async closeVaultViaNativeMenuAction() {
      await emit(MENU_ACTION, { action: "close-vault" });
    },
  };
}
