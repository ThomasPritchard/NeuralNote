// Real-browser proof that the notification stack cannot cover the chat pane
// (issue #117).
//
// This has to be measured, and jsdom cannot measure. Every
// `getBoundingClientRect()` there is a rect of zeros, and zero-area rects never
// intersect anything — so a jsdom spec for this defect is green against the
// broken styling AND green against the fix, which is to say it asserts nothing.
// Here the real `ToastProvider` and the real `ChatPane` render in headless
// Chromium through the app's own Tailwind pipeline, the same long-lived error
// notification the issue reports is raised, and the only question that settles
// it is asked directly: do the two rectangles overlap?
//
// What is deliberately NOT asserted anywhere: an offset, an inset, or a `top`.
// The reported bug is that two boxes share pixels; a test pinned to
// `top === 96` would rot the first time the title bar changed height and would
// still pass for a stack that had merely moved its overlap somewhere else.
//
// `lib/api` and `lib/store` are mocked because ChatPane asks the backend which
// provider is configured and there is no Tauri here. The status is a CONFIGURED
// OpenRouter one on purpose: it is the only view that renders the composer, and
// the composer is the surface a fix that merely re-docked the stack downward
// would break instead.

import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act, useEffect } from "react";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn().mockResolvedValue({
      activeProvider: "openRouter",
      reasoningSupported: "unknown",
      openrouter: { hasKey: true, model: "anthropic/claude-sonnet-4.5", reasoning: false },
      local: { activeModelTag: null },
      approval: {
        mode: "alwaysAsk",
        overrides: {},
        classifierAvailable: true,
        yoloIrreversibleTools: [],
      },
    }),
    listSkills: vi.fn().mockResolvedValue([]),
    refreshReasoningSupport: vi.fn().mockImplementation(() => new Promise(() => {})),
  };
});

import { ToastProvider, useToast } from "./ToastProvider";
import { MAX_VISIBLE_TOASTS } from "./toast-store";
import { ChatSlot } from "../workspace/ChatSlot";
import "../styles.css";

const POLL = { timeout: 5000, interval: 50 } as const;

/** The notification from the issue, verbatim. Its KIND is what makes this worth
 *  fixing rather than waiting out: `getToastDuration` returns null for an error
 *  AND for any toast carrying an action, so an unacknowledged one of either
 *  stays up for the life of the session. */
const UPDATE_FAILURE = "Automatic update check failed. plugin updater not found";

/** A save failure the way the app actually raises one. `useWorkspaceLifecycle`
 *  passes `api.errorMessage(writeError)` straight to `toast.error`, so what
 *  arrives is the backend's whole error chain — every `with_context` layer, and
 *  an absolute vault path in most of them. Nothing truncates it on either side
 *  of the boundary, so this is the ordinary shape of a write failure, not a
 *  contrived one: around 500 characters, six or seven wrapped lines per card. */
const longWriteFailure = (note: string) =>
  `Could not save “${note}”: failed to write ` +
  `/Users/tom/Documents/SecondBrain/10 Areas/Weekly reviews/${note}: ` +
  `while creating its parent directory ` +
  `/Users/tom/Documents/SecondBrain/10 Areas/Weekly reviews: ` +
  `Operation not permitted (os error 1). The vault directory may live on a ` +
  `removable volume, or in a location this app has not been granted access to; ` +
  `check that the volume is mounted and grant access under System Settings → ` +
  `Privacy & Security → Files and Folders, then try saving again.`;

/** Module-level so the effect below has a stable dependency and fires once. */
const ONE_ERROR = [UPDATE_FAILURE];
const NO_ERRORS: string[] = [];
const A_FULL_STACK = Array.from(
  { length: MAX_VISIBLE_TOASTS },
  (_, i) => `${UPDATE_FAILURE} (${i + 1})`,
);

/** A full stack of them, each a DIFFERENT note — which is the case nothing
 *  collapses, because the store dedupes on `dedupKey` alone and separate save
 *  failures are never given one. Sized from the store's cap rather than a
 *  literal, so raising the cap raises this with it. None of them ever expires. */
const A_STACK_OF_LONG_ERRORS = Array.from({ length: MAX_VISIBLE_TOASTS }, (_, i) =>
  longWriteFailure(`Weekly review 2026-08-${12 + i}.md`),
);

function Notifier({ messages }: Readonly<{ messages: string[] }>) {
  const toast = useToast();
  useEffect(() => {
    for (const message of messages) toast.error(message);
  }, [messages, toast]);
  return null;
}

/** The app shell as `App.tsx` and `Workspace.tsx` build it: everything inside
 *  one `ToastProvider`, a title bar and status bar at the real token heights,
 *  and the REAL chat slot last in the workspace row.
 *
 *  The two bars are stand-ins but their heights are not decorative — the stack
 *  used to be offset by `--titlebar-height`, and a harness that left the chrome
 *  out would be measuring a window this app never shows. The editor is a bare
 *  flex child for the same reason the expand spec's is: what it contains cannot
 *  change where the chat pane's own header lands. */
function Harness({ messages }: Readonly<{ messages: string[] }>) {
  return (
    <ToastProvider>
      <Notifier messages={messages} />
      <div className="nn-app-shell flex h-full w-full flex-col bg-background text-foreground">
        <div
          data-testid="titlebar"
          className="h-(--titlebar-height) shrink-0 border-b border-border bg-titlebar"
        />
        <div className="flex min-h-0 flex-1 overflow-hidden">
          <div data-testid="editor" className="min-w-0 flex-1" />
          <ChatSlot
            showChat
            expanded={false}
            onToggleExpanded={() => {}}
            openNoteAt={() => {}}
            onOpenSettings={() => {}}
            refreshSignal={0}
          />
        </div>
        <div
          data-testid="statusbar"
          className="h-(--statusbar-height) shrink-0 border-t border-border bg-titlebar"
        />
      </div>
    </ToastProvider>
  );
}

/** The viewport `vitest.browser.config.ts` pins. Restored after every test, so a
 *  case that resizes cannot hand the next one a window it never asked for. */
const DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  await resizeWindow(DEFAULT_VIEWPORT.width, DEFAULT_VIEWPORT.height);
});

/** Resize, and wait for the resize to COMMIT by polling the window itself.
 *  A "has the layout settled?" wait is satisfied by the pre-resize geometry and
 *  would hand back the previous, taller window's measurements. */
async function resizeWindow(width: number, height: number): Promise<void> {
  await page.viewport(width, height);
  await expect
    .poll(() => `${window.innerWidth}x${window.innerHeight}`, POLL)
    .toBe(`${width}x${height}`);
}

const composer = () => page.getByRole("textbox", { name: "Ask across your vault" });
const sendButton = () => page.getByRole("button", { name: "Send" });

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
  // The pane resolves its provider asynchronously and only then lays out the
  // composer; measuring before that would measure the loading state.
  await expect.poll(() => composer().query(), POLL).not.toBeNull();
  await expect.poll(toastCount, POLL).toBe(messages.length);
}

function toastCount(): number {
  return host!.querySelectorAll('[data-testid="toast"]').length;
}

/** A rect, with the vacuity guard attached: an element that rendered with no
 *  area cannot overlap anything, so every assertion downstream of it would pass
 *  for the wrong reason. */
function rectOf(element: Element | null, what: string): DOMRect {
  if (element === null) throw new Error(`${what} did not render`);
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) {
    throw new Error(`${what} rendered with no area (${rect.width}x${rect.height})`);
  }
  return rect;
}

/** Shared pixels. Touching edges are not an overlap — a stack docked flush
 *  against a pane is exactly what "laid out around it" looks like. */
function overlaps(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function describeRect(rect: DOMRect): string {
  return `[${Math.round(rect.left)},${Math.round(rect.top)} → ${Math.round(rect.right)},${Math.round(rect.bottom)}]`;
}

function chatPaneRect(): DOMRect {
  return rectOf(host!.querySelector(".nn-chat-pane"), "the chat pane");
}

/** The pane header, found through its title rather than through a structural
 *  selector — the reported symptom is that the pane's "Neural Assistant" title
 *  is obscured. The string matched is the full title `ChatPane` renders. */
function chatHeaderRect(): DOMRect {
  const title = [...host!.querySelectorAll("span")].find(
    (element) => element.textContent === "Neural Assistant AI",
  );
  return rectOf(title?.closest("header") ?? null, "the chat pane header");
}

/** The labelled notification region — `Notifications` in the accessibility tree,
 *  which is how the issue identifies it. */
function notificationRegionRect(): DOMRect {
  return rectOf(host!.querySelector('[aria-label="Notifications"]'), "the notification region");
}

function toastRects(): DOMRect[] {
  return [...host!.querySelectorAll('[data-testid="toast"]')].map((toast, i) =>
    rectOf(toast, `notification ${i + 1}`),
  );
}

function appShellRect(): DOMRect {
  return rectOf(host!.querySelector(".nn-app-shell"), "the app shell");
}

/** How much of a notification is actually drawn. Once the stack outgrows the
 *  dock's ceiling the well scrolls, and `getBoundingClientRect()` does not know
 *  that — it reports where a scrolled-away card WOULD be, not where the user
 *  sees it. The geometry that means anything is the part inside the dock. */
function visiblePartOf(rect: DOMRect, dock: DOMRect): DOMRect | null {
  const top = Math.max(rect.top, dock.top);
  const bottom = Math.min(rect.bottom, dock.bottom);
  const left = Math.max(rect.left, dock.left);
  const right = Math.min(rect.right, dock.right);
  if (bottom <= top || right <= left) return null;
  return new DOMRect(left, top, right - left, bottom - top);
}

/** The premise the whole file rests on: the chat pane really is the top-right
 *  occupant of the window. If it were not, "no overlap" would be geometry this
 *  test arranged rather than a property of the fix. */
function expectChatPaneOccupiesTheTopRight(): void {
  const pane = chatPaneRect();
  const header = chatHeaderRect();
  expect(Math.round(pane.right)).toBe(Math.round(window.innerWidth));
  expect(header.top).toBeLessThan(window.innerHeight / 2);
  expect(overlaps(header, pane)).toBe(true);
}

/** Every notification on screen, and none of them sharing a pixel with the pane.
 *
 *  The header and the composer are called out separately because they are the
 *  two named requirements — the surface the bug covers, and the surface a fix
 *  that simply re-docked the stack downward would cover instead. The whole-pane
 *  assertion subsumes both and states the general property: the stack is laid
 *  out around the panes, never over them. */
function expectStackClearOfTheChatPane(): void {
  const pane = chatPaneRect();
  const header = chatHeaderRect();
  const composerBox = rectOf(composer().element(), "the chat composer");
  const sendBox = rectOf(sendButton().element(), "the composer's send button");

  const dock = notificationRegionRect();
  const drawn = toastRects()
    .map((rect) => visiblePartOf(rect, dock))
    .filter((rect): rect is DOMRect => rect !== null);
  // Vacuity guard for the clipping above: a dock that drew none of its own
  // notifications would hand this loop nothing but the dock itself and satisfy
  // every assertion in it.
  expect(drawn.length, "no notification is drawn inside the dock").toBeGreaterThan(0);

  for (const rect of [dock, ...drawn]) {
    // On screen. A stack pushed out of the window would satisfy every
    // non-overlap assertion below and show the user nothing.
    expect(rect.top, `notification ${describeRect(rect)} above the window`).toBeGreaterThanOrEqual(0);
    expect(rect.left, `notification ${describeRect(rect)} left of the window`).toBeGreaterThanOrEqual(0);
    expect(rect.bottom, `notification ${describeRect(rect)} below the window`).toBeLessThanOrEqual(
      window.innerHeight + 1,
    );
    expect(rect.right, `notification ${describeRect(rect)} right of the window`).toBeLessThanOrEqual(
      window.innerWidth + 1,
    );

    expect(
      overlaps(rect, header),
      `notification ${describeRect(rect)} overlaps the pane header ${describeRect(header)}`,
    ).toBe(false);
    expect(
      overlaps(rect, composerBox),
      `notification ${describeRect(rect)} overlaps the composer ${describeRect(composerBox)}`,
    ).toBe(false);
    expect(
      overlaps(rect, sendBox),
      `notification ${describeRect(rect)} overlaps the send button ${describeRect(sendBox)}`,
    ).toBe(false);
    expect(
      overlaps(rect, pane),
      `notification ${describeRect(rect)} overlaps the chat pane ${describeRect(pane)}`,
    ).toBe(false);
  }
}

/** The dock's ceiling, as a SHARE of the window rather than a pixel count.
 *
 *  Deliberately looser than the `max-h` the well carries: what is under test is
 *  that the dock cannot starve the workspace, not that the cap is one particular
 *  value, and pinning the number here would turn every future adjustment of it
 *  into a test edit. The numbers this rejects are nowhere near the boundary —
 *  uncapped, a full stack of real save failures measures taller than the whole
 *  window and leaves the app shell nothing at all. */
const DOCK_MAX_SHARE_OF_WINDOW = 0.45;
const WORKSPACE_MIN_SHARE_OF_WINDOW = 0.5;

/** Non-overlap is only half the guarantee. The dock and the app are siblings in
 *  one column, so every pixel the dock takes is a pixel the workspace loses —
 *  and `shrink-0` against a `flex-1` with no floor means an unbounded well takes
 *  them all. */
function expectTheDockLeavesTheWorkspaceStanding(): void {
  const dockHeight = notificationRegionRect().height;
  const dockShare = dockHeight / window.innerHeight;
  expect(
    dockShare,
    `the dock is ${Math.round(dockHeight)}px, ${(dockShare * 100).toFixed(1)}% of the ${window.innerHeight}px window`,
  ).toBeLessThanOrEqual(DOCK_MAX_SHARE_OF_WINDOW);

  // The same statement from the side the user experiences: whatever the dock
  // borrows, this much of the window is still the app.
  const shellShare = appShellRect().height / window.innerHeight;
  expect(
    shellShare,
    `the workspace is left ${(shellShare * 100).toFixed(1)}% of the window`,
  ).toBeGreaterThanOrEqual(WORKSPACE_MIN_SHARE_OF_WINDOW);
}

/** The well, found by the property under test rather than by a class: with a
 *  stack this tall SOMETHING in the region has to be scrolling, or the ceiling
 *  is a crop. */
function scrollingWell(): HTMLElement {
  const region = host!.querySelector('[aria-label="Notifications"]');
  const well = [...(region?.querySelectorAll("*") ?? [])].find(
    (element) =>
      element.scrollHeight > element.clientHeight &&
      globalThis.getComputedStyle(element).overflowY === "auto",
  );
  if (!well) {
    throw new Error(
      "nothing in the notification region scrolls, so a stack past the dock's ceiling is cropped rather than reachable",
    );
  }
  return well as HTMLElement;
}

/** A ceiling that merely CLIPPED would satisfy every bound above while silently
 *  swallowing the errors below the fold — and an error the user never sees is
 *  the failure this whole surface exists to prevent. */
async function expectEveryNotificationStillReachable(): Promise<void> {
  const well = scrollingWell();

  // Both ends of the stack, because "nothing is lost" is a claim about both. At
  // rest the well is at the top, where the first notification starts — a stack
  // that opened already scrolled past its own head would hide the newest
  // failure behind a gesture.
  const atRest = well.getBoundingClientRect();
  const first = toastRects()[0];
  expect(
    first.top,
    `the first notification ${describeRect(first)} starts above the well ${describeRect(atRest)}`,
  ).toBeGreaterThanOrEqual(atRest.top - 1);

  well.scrollTop = well.scrollHeight;
  await expect.poll(() => well.scrollTop, POLL).toBeGreaterThan(0);

  // And scrolling to the end brings the last one's final line into view. Its
  // BOTTOM EDGE is what has to arrive, not the whole card: one of these errors
  // is several hundred characters and is taller than the dock's ceiling on its
  // own, so it is read by scrolling through it either way.
  const scrolled = well.getBoundingClientRect();
  const last = toastRects().at(-1)!;
  expect(
    last.bottom,
    `the last notification ${describeRect(last)} ends below the scrolled well ${describeRect(scrolled)}`,
  ).toBeLessThanOrEqual(scrolled.bottom + 1);
  expect(
    visiblePartOf(last, scrolled),
    `the last notification ${describeRect(last)} is drawn nowhere inside the scrolled well ${describeRect(scrolled)}`,
  ).not.toBeNull();
}

describe("the notification stack beside the chat pane", () => {
  it("leaves the pane header and the composer untouched while an error stands", async () => {
    await mount(ONE_ERROR);

    expect(toastCount()).toBe(1);
    expectChatPaneOccupiesTheTopRight();
    expectStackClearOfTheChatPane();
  });

  it("stays clear with the stack at its full depth", async () => {
    // `MAX_VISIBLE_TOASTS` notifications: the tallest the stack can ever be, read
    // from the store rather than spelled out, so raising it moves this test with
    // it instead of leaving a comment behind that a green run vouches for. A fix
    // that clears the header for one notification and not for a full stack has
    // only moved the boundary.
    await mount(A_FULL_STACK);

    expect(toastCount()).toBe(MAX_VISIBLE_TOASTS);
    expectChatPaneOccupiesTheTopRight();
    expectStackClearOfTheChatPane();
  });

  it("leaves the workspace standing when a full stack of long errors fills a small window", async () => {
    // The depth case above cannot see this. It runs at the one viewport the
    // config pins and raises the issue's own 62-character message, and a dock
    // sized by its content is a problem of PROPORTION: the well grows with what
    // it holds, the window does not. So this asks the same question in the
    // configuration the app is worst at — 920x600 is `tauri.conf.json`'s
    // minimum window, and the messages are the length the backend actually
    // hands the toast rather than the length the issue happened to quote.
    await resizeWindow(920, 600);
    await mount(A_STACK_OF_LONG_ERRORS);

    expect(toastCount()).toBe(MAX_VISIBLE_TOASTS);
    // First, because it is the assertion that names the defect. Without a
    // ceiling the workspace is squeezed to nothing at this size, and every
    // measurement after this line is then taken of a pane with no area — a red
    // that reports "the chat pane rendered with no area" rather than why.
    expectTheDockLeavesTheWorkspaceStanding();
    expectChatPaneOccupiesTheTopRight();
    expectStackClearOfTheChatPane();

    // Scrolls the well, so it goes last: the assertions above measure the dock
    // at rest.
    await expectEveryNotificationStillReachable();
  });

  it("costs the workspace nothing while there is nothing to show", async () => {
    await mount(NO_ERRORS);

    // No dead band: an empty stack occupies no height at all, so the window
    // looks exactly as it does today until something is actually raised.
    const region = host!.querySelector('[aria-label="Notifications"]');
    expect(region).not.toBeNull();
    expect(region!.getBoundingClientRect().height).toBe(0);
    // And the live region inside it is MOUNTED while the stack is empty, which
    // is the whole reason it is separate from the well. Move it inside the
    // `toasts.length > 0` branch and every other test here still passes — each
    // one raises a notification before it looks — while a screen-reader user
    // silently stops being told about successful captures and warnings.
    // Scoped to the region, not the document: `ChatModelMenu` also renders a
    // `role="status"`, and although Radix only mounts it with the menu open, a
    // document-wide query would go vacuous the day any sibling status line
    // renders by default in this tree.
    expect(region!.querySelector('[role="status"]')).not.toBeNull();
    const statusbar = rectOf(host!.querySelector('[data-testid="statusbar"]'), "the status bar");
    expect(Math.round(statusbar.bottom)).toBe(Math.round(window.innerHeight));
  });

  it("hands the space back when the notification is dismissed", async () => {
    await mount(ONE_ERROR);
    const shortenedPane = chatPaneRect().height;

    await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    await expect.poll(toastCount, POLL).toBe(0);

    // The space a notification takes is BORROWED. This is the mechanism behind
    // the assertions above — the stack keeps clear of the panes by being laid
    // out beside them rather than floated over them — and it is what stops that
    // from turning into a strip of window the workspace never gets back.
    await expect.poll(() => chatPaneRect().height, POLL).toBeGreaterThan(shortenedPane);
    const statusbar = rectOf(host!.querySelector('[data-testid="statusbar"]'), "the status bar");
    expect(Math.round(statusbar.bottom)).toBe(Math.round(window.innerHeight));
  });
});
