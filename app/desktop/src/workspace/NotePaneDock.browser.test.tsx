// Real-browser proof that the note editor still fits the pane once the
// notification dock has taken its share of the window (issue #166).
//
// jsdom cannot answer this. It has no layout engine, so every
// `getBoundingClientRect()` there is a rect of zeros and every `clientHeight` a
// zero — which makes "the editor fits the box that shows it" trivially true
// against the broken sizings AND against the fix. Here the real
// `ToastProvider`, the real `NotePane` and a real CodeMirror render in a real
// browser through the app's own Tailwind pipeline, at the window
// `tauri.conf.json` allows as its minimum, with the dock filled by errors that
// never expire.
//
// `ToastViewport.browser.test.tsx` is the only other browser test that mounts
// `ToastProvider`, and it mounts `ChatSlot` alone. The note pane had never met
// the dock in any tier, which is why these sizings survived the #117
// re-parenting unnoticed.

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../styles.css";
import { ToastProvider, useToast } from "../notifications/ToastProvider";
import { MAX_VISIBLE_TOASTS } from "../notifications/toast-store";
import { NotePane } from "./NotePane";
import { clearSourceEditorSessions } from "./sourceEditorSession";
import type { OpenNote } from "./useOpenNote";
import type { NoteDoc } from "../lib/types";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    // Never resolves. Backlinks are not the subject, and a pending request
    // keeps the panel's own height out of every measurement below.
    readBacklinks: vi.fn(() => new Promise(() => {})),
    onMenu: vi.fn(async () => () => {}),
  };
});

const POLL = { timeout: 5000, interval: 50 } as const;

/** The window `tauri.conf.json` allows as its minimum — the configuration this
 *  app is worst at, and the one the issue reports against. */
const MINIMUM_WINDOW = { width: 920, height: 600 } as const;

/** The viewport `vitest.browser.config.ts` pins, restored after every test so a
 *  case that resizes cannot hand the next one a window it never asked for. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

/** A save failure the way the app actually raises one: `useWorkspaceLifecycle`
 *  hands `api.errorMessage(writeError)` straight to `toast.error`, so the whole
 *  backend error chain arrives with its absolute paths intact. Around 500
 *  characters — six or seven wrapped lines per card. */
const longWriteFailure = (note: string) =>
  `Could not save “${note}”: failed to write ` +
  `/Users/tom/Documents/SecondBrain/10 Areas/Weekly reviews/${note}: ` +
  `while creating its parent directory ` +
  `/Users/tom/Documents/SecondBrain/10 Areas/Weekly reviews: ` +
  `Operation not permitted (os error 1). The vault directory may live on a ` +
  `removable volume, or in a location this app has not been granted access to; ` +
  `check that the volume is mounted and grant access under System Settings → ` +
  `Privacy & Security → Files and Folders, then try saving again.`;

/** A full dock. Every one of these is an error and `getToastDuration` returns
 *  null for an error, so none of them expires — the dock the user is left
 *  looking at is this one, for the life of the session. Sized from the store's
 *  own cap so raising the cap moves this with it. */
const A_FULL_DOCK = Array.from({ length: MAX_VISIBLE_TOASTS }, (_, i) =>
  longWriteFailure(`Weekly review 2026-08-${12 + i}.md`),
);

const NOTE_BODY = [
  "# Weekly review",
  "",
  "Retrieval quality is the moat, so the questions worth asking each week are",
  "about citations rather than throughput.",
  "",
  "- What did the chat cite that turned out to be the wrong chunk?",
  "- Which captures never got a full source stored?",
  "- Where did a timestamp drift from the transcript?",
  "",
  "The distilled note is the index, not the record. Keep the record.",
].join("\n");

function noteDoc(): NoteDoc {
  return {
    path: "/v/Weekly review.md",
    relPath: "10 Areas/Weekly review.md",
    title: "Weekly review",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: NOTE_BODY,
    raw: NOTE_BODY,
    contentHash: "hash-1",
    binary: false,
    lossyText: false,
    exceedsEditableSize: false,
    sizeBytes: NOTE_BODY.length,
  };
}

function openNote(): OpenNote {
  return {
    sessionKey: "note-tab-1",
    sessionHash: "hash-1",
    path: "/v/Weekly review.md",
    note: noteDoc(),
    loading: false,
    error: null,
    draft: NOTE_BODY,
    dirty: false,
    saving: false,
    externalDeleted: false,
    // The in-pane save notice is up for the same reason the dock is full: the
    // write failed. Both surfaces appear together in the real failure, and the
    // notice is part of what competes with the editor for the pane.
    saveError: "Operation not permitted (os error 1)",
    preservationError: null,
    conflict: false,
    open: vi.fn(),
    reload: vi.fn(),
    overwrite: vi.fn(),
    repath: vi.fn(),
    setDraft: vi.fn(),
    setPreservationError: vi.fn(),
    save: vi.fn(),
    clear: vi.fn(),
  };
}

function Notifier({ messages }: Readonly<{ messages: string[] }>) {
  const toast = useToast();
  useEffect(() => {
    for (const message of messages) toast.error(message);
  }, [messages, toast]);
  return null;
}

/** The app shell as `Workspace.tsx` builds it, cut to the column the editor
 *  lives in: everything inside one `ToastProvider`, a title bar and status bar
 *  at the real token heights, and the REAL note pane inside the real panes row.
 *
 *  The two bars are stand-ins but their heights are not decorative — the
 *  editor's height was written as the window less exactly those two, so a
 *  harness without them would be measuring a window this app never shows. */
function Harness({ messages }: Readonly<{ messages: string[] }>) {
  return (
    <ToastProvider>
      <Notifier messages={messages} />
      <div className="nn-app-shell flex h-full w-full flex-col bg-background text-foreground">
        <div
          data-testid="titlebar"
          className="h-(--titlebar-height) shrink-0 border-b border-border bg-titlebar"
        />
        <div className="nn-workspace-panes flex min-h-0 flex-1 overflow-hidden">
          <div className="flex min-w-0 flex-1">
            <NotePane open={openNote()} />
          </div>
        </div>
        <div
          data-testid="statusbar"
          className="h-(--statusbar-height) shrink-0 border-t border-border bg-titlebar"
        />
      </div>
    </ToastProvider>
  );
}

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(clearSourceEditorSessions);

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  clearSourceEditorSessions();
  await resizeWindow(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

/** Resize, and wait for the resize to COMMIT by polling the window itself. A
 *  "has the layout settled?" wait is satisfied by the pre-resize geometry and
 *  hands back the previous, taller window's measurements. */
async function resizeWindow(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await expect
    .poll(() => `${window.innerWidth}x${window.innerHeight}`, POLL)
    .toBe(`${width}x${height}`);
}

async function mount(messages: string[]): Promise<void> {
  host = document.createElement("div");
  host.style.position = "fixed";
  host.style.inset = "0";
  host.style.display = "flex";
  host.style.flexDirection = "column";
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness messages={messages} />);
  });
  // The editor is lazy and CodeMirror lays out on mount; measuring before the
  // textbox exists would measure the Suspense fallback.
  await expect
    .poll(() => host!.querySelector('[role="textbox"][aria-label="Note content"]'), POLL)
    .not.toBeNull();
  await expect.poll(toastCount, POLL).toBe(messages.length);
}

function toastCount(): number {
  return host!.querySelectorAll('[data-testid="toast"]').length;
}

/** A rect with the vacuity guard attached: an element that rendered with no
 *  area fits inside anything, so every measurement downstream of one would pass
 *  for the wrong reason. */
function rectOf(element: Element | null, what: string): DOMRect {
  if (element === null) throw new Error(`${what} did not render`);
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`${what} rendered with no area (${rect.width}x${rect.height})`);
  }
  return rect;
}

function find(selector: string, what: string): HTMLElement {
  const element = host!.querySelector<HTMLElement>(selector);
  if (element === null) throw new Error(`${what} did not render`);
  return element;
}

const dock = () => find('[aria-label="Notifications"]', "the notification dock");
const appShell = () => find(".nn-app-shell", "the app shell");
/** The `<article>` of `NoteDocumentFrame` — the box the note document is read
 *  through, and the nearest ancestor of the editor that scrolls. */
const noteScrollport = () => find("article", "the note document scrollport");
/** CodeMirror's own scrollport. `.cm-editor` is the sized box; `.cm-scroller`
 *  is the window the document is read through, and it carries `overflow: auto`
 *  (`styles.css`), so the editor scrolls itself rather than asking an ancestor. */
const editorScrollport = () => find(".cm-scroller", "the editor's scrollport");

function scrollsVertically(element: HTMLElement): boolean {
  const overflowY = globalThis.getComputedStyle(element).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

function clipsVertically(element: HTMLElement): boolean {
  const overflowY = globalThis.getComputedStyle(element).overflowY;
  return overflowY === "hidden" || overflowY === "clip";
}

function overflowsVertically(element: HTMLElement): boolean {
  return element.scrollHeight > element.clientHeight + 1;
}

function describeBox(element: HTMLElement): string {
  return `${element.tagName.toLowerCase()}.${element.className || "(unclassed)"} (client ${element.clientHeight}, scroll ${element.scrollHeight})`;
}

/** The premise the whole file rests on. Every assertion below is about what the
 *  dock leaves the editor, so a harness where the dock took nothing — or where
 *  it floated over the app instead of standing beside it — would make all of
 *  them true for the wrong reason. */
function expectAFullDockStandingBesideTheApp(): void {
  expect(window.innerHeight).toBe(MINIMUM_WINDOW.height);
  expect(toastCount()).toBe(MAX_VISIBLE_TOASTS);

  const dockBox = rectOf(dock(), "the notification dock");
  const shell = rectOf(appShell(), "the app shell");

  // Siblings in one column: the dock begins exactly where the app ends, and
  // ends at the window's own bottom edge.
  expect(Math.round(dockBox.top)).toBe(Math.round(shell.bottom));
  expect(Math.round(dockBox.bottom)).toBe(window.innerHeight);
  // And it really took space — a dock of no consequence would prove nothing.
  expect(
    dockBox.height / window.innerHeight,
    `the dock is only ${Math.round(dockBox.height)}px of the ${window.innerHeight}px window`,
  ).toBeGreaterThan(0.25);
}

/** THE defect (#166).
 *
 *  `.cm-scroller` carries `overflow: auto`, so CodeMirror scrolls the document
 *  itself: it decides a caret is "in view" when the caret lies inside THIS box,
 *  and only then does it leave an ancestor alone. That reasoning is sound only
 *  while the box is one the user can actually see. Sized against the window
 *  rather than the pane, it is not — the dock takes its share from the app
 *  column, the pane shrinks, and the editor's scrollport keeps the height it had
 *  before, hanging past the bottom of the pane that shows it. The user then
 *  types into a viewport CodeMirror believes is on screen and the caret is
 *  behind the dock.
 *
 *  Stated as a relation between two measured boxes, never a pixel count: the
 *  window the editor reads through must fit inside the window the pane reads
 *  through. */
function expectTheEditorFitsTheBoxThatShowsIt(): void {
  const editor = editorScrollport();
  const pane = noteScrollport();

  // The pane scrollport is the reachability mechanism the assertion below
  // leans on; if it stopped scrolling, "fits or scrolls" would be a claim about
  // a box that can do neither.
  expect(
    scrollsVertically(pane),
    `${describeBox(pane)} does not scroll, so nothing below the fold is reachable`,
  ).toBe(true);

  rectOf(editor, "the editor's scrollport");
  // The message stays one template literal on purpose: oxlint's
  // `vitest/valid-expect` accepts a second argument only when it is literally a
  // string or template, and reds on a variable or a `+` concatenation.
  expect(
    editor.clientHeight,
    `the editor reads through a ${editor.clientHeight}px window inside a ${pane.clientHeight}px pane, so ${editor.clientHeight - pane.clientHeight}px of it hangs off the pane`,
  ).toBeLessThanOrEqual(pane.clientHeight);
}

/** …and not starved to nothing by the fix. The floor is read off the rendered
 *  document — one line of the user's own text — rather than invented, so it
 *  cannot drift from the type scale it is meant to track. */
function expectTheEditorStillShowsTheUsersText(): void {
  const line = rectOf(find(".cm-line", "a line of the note"), "a line of the note");
  const editor = editorScrollport();
  expect(
    editor.clientHeight,
    `the editor's ${editor.clientHeight}px window cannot show one ${Math.round(line.height)}px line`,
  ).toBeGreaterThanOrEqual(line.height);
}

/** The acceptance criterion in its general form: on the way from the editor up
 *  to the app column, no box may clip what it cannot scroll. A box with
 *  `overflow: visible` neither clips nor scrolls, so it is not a hiding place;
 *  a box with `auto`/`scroll` hands the content back on a gesture; a box with
 *  `hidden` swallows it silently, and is the one thing that must never be
 *  holding overflow. */
function expectNothingIsSilentlyClipped(): void {
  const clippers: HTMLElement[] = [];
  const scrollers: HTMLElement[] = [];

  let node: HTMLElement | null = editorScrollport();
  while (node !== null && node !== host) {
    if (clipsVertically(node)) clippers.push(node);
    if (scrollsVertically(node)) scrollers.push(node);
    node = node.parentElement;
  }

  // Vacuity guards: this walk is only meaningful if it actually crossed the
  // app's clipping wells (`nn-workspace-panes`, the ToastProvider's content
  // row) and found the scroller the note document is read through.
  expect(clippers.length, "the walk crossed no clipping box at all").toBeGreaterThan(0);
  expect(scrollers.length, "the walk found no scroll container at all").toBeGreaterThan(0);

  for (const clipper of clippers) {
    expect(
      overflowsVertically(clipper),
      `${describeBox(clipper)} clips ${clipper.scrollHeight - clipper.clientHeight}px it cannot scroll`,
    ).toBe(false);
  }
}

/** And the criterion in the form the user experiences it: scroll the pane to
 *  the end and the bottom of the editor arrives. */
async function expectTheEditorIsReachableByScrolling(): Promise<void> {
  const pane = noteScrollport();
  pane.scrollTop = pane.scrollHeight;
  await expect.poll(() => pane.scrollTop, POLL).toBeGreaterThan(0);

  const paneBox = pane.getBoundingClientRect();
  const editorBox = rectOf(find(".cm-editor", "the editor"), "the editor");
  expect(
    editorBox.bottom,
    `the editor still ends ${Math.round(editorBox.bottom - paneBox.bottom)}px below the scrolled pane`,
  ).toBeLessThanOrEqual(paneBox.bottom + 1);
}

describe("the note editor beside the notification dock", () => {
  it("keeps the editor inside the pane at the minimum window with the dock full", async () => {
    await resizeWindow(MINIMUM_WINDOW.width, MINIMUM_WINDOW.height);
    await mount(A_FULL_DOCK);

    expect(toastCount()).toBe(MAX_VISIBLE_TOASTS);
    expectAFullDockStandingBesideTheApp();
    expectTheEditorFitsTheBoxThatShowsIt();
    expectTheEditorStillShowsTheUsersText();
    expectNothingIsSilentlyClipped();
    await expectTheEditorIsReachableByScrolling();
  });

  it("keeps the same guarantee at the ordinary window, dock or no dock", async () => {
    // The everyday case, so a fix for the pathological one cannot be bought by
    // changing what the app looks like the rest of the time: the editor has to
    // hold this invariant at the pinned viewport with nothing raised at all.
    await mount([]);

    expect(toastCount()).toBe(0);
    // Not `rectOf`: an idle dock is SUPPOSED to have no area, which is the one
    // case the vacuity guard would reject.
    expect(dock().getBoundingClientRect().height).toBe(0);
    expectTheEditorFitsTheBoxThatShowsIt();
    expectTheEditorStillShowsTheUsersText();
    expectNothingIsSilentlyClipped();
  });
});
