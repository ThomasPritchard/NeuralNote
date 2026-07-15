import { EditorState, StateEffect, type Extension } from "@codemirror/state";

import { loadSourceText, type SourceText } from "./sourceText";

export interface SourceEditorSession {
  readonly token: number;
  readonly loadedHash: string;
  readonly state: EditorState;
  readonly source: SourceText;
  readonly scrollTop: number;
  readonly preservationError: string | null;
}

const MAX_RETAINED_SESSIONS = 32;
const sessions = new Map<string, SourceEditorSession>();
const activeTokens = new Map<string, number>();
let nextToken = 1;

function retain(sessionKey: string, session: SourceEditorSession): SourceEditorSession {
  sessions.delete(sessionKey);
  sessions.set(sessionKey, session);
  while (sessions.size > MAX_RETAINED_SESSIONS) {
    const oldest = sessions.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    sessions.delete(oldest);
    activeTokens.delete(oldest);
  }
  return session;
}

export function acquireSourceEditorSession(
  sessionKey: string,
  loadedHash: string,
  rawSource: string,
  extensions: Extension,
): SourceEditorSession {
  const current = sessions.get(sessionKey);
  if (current?.loadedHash === loadedHash) {
    return retain(sessionKey, {
      ...current,
      state: current.state.update({ effects: StateEffect.reconfigure.of(extensions) }).state,
    });
  }

  const source = loadSourceText(rawSource);
  const token = nextToken++;
  activeTokens.set(sessionKey, token);
  return retain(sessionKey, {
    token,
    loadedHash,
    state: EditorState.create({ doc: source.text, extensions }),
    source,
    scrollTop: 0,
    preservationError: null,
  });
}

export function updateSourceEditorSession(
  sessionKey: string,
  session: SourceEditorSession,
): void {
  if (activeTokens.get(sessionKey) !== session.token) return;
  retain(sessionKey, session);
}

export function destroySourceEditorSession(sessionKey: string): void {
  sessions.delete(sessionKey);
  activeTokens.delete(sessionKey);
}

export function clearSourceEditorSessions(): void {
  sessions.clear();
  activeTokens.clear();
}

export function sourceEditorSessionCount(): number {
  return sessions.size;
}
