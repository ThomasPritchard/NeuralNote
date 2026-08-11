// Real-browser proof of expand-to-wide.
//
// This phase is geometric by definition, and jsdom has no layout engine:
// `getBoundingClientRect()` returns zeros there, so a jsdom suite can be
// completely green while the pane never gains a pixel. The one link only this
// tier can prove is the whole feature — that flipping `chatExpanded` produces a
// MEASURABLY wider pane — and it runs through the real chain: the real header
// button, the real `useWorkspaceLayout` controller, the real `.nn-chat-slot`
// attribute, the real `--chat-width-expanded` token, resolved by the app's own
// Tailwind pipeline.
//
// What is deliberately NOT asserted anywhere: that the token is defined, or that
// the toggle sets an attribute. Both pass while the pane stays exactly as wide
// as it was.
//
// `lib/api` and `lib/store` are mocked because ChatPane asks the backend which
// provider is configured and there is no Tauri here. Neither is on the path
// under test: the pane's header — and its toggle — render in every provider
// state, including the first-run picker this lands in.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";

const { reportError } = vi.hoisted(() => ({ reportError: vi.fn() }));

vi.mock("../lib/store", () => ({
  useVault: () => ({ vault: { name: "V", path: "/vault" }, reportError }),
}));

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    aiStatus: vi.fn().mockResolvedValue({
      activeProvider: null,
      reasoningSupported: "unknown",
      openrouter: { hasKey: false, model: "anthropic/claude-sonnet-4.5", reasoning: false },
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

import { ChatSlot } from "./ChatSlot";
import { ChatTranscript } from "./ChatTranscript";
import { useWorkspaceLayout } from "./useWorkspaceLayout";
import { WORKSPACE_LAYOUT_STORAGE_KEY } from "./workspaceLayout";
import { emptyAssistant, type ChatMessage, type ToolCallView } from "./chatMessage";
import "../styles.css";

/** The editor's floor (`EDITOR_MIN_WIDTH`), mirrored rather than tightened. */
const EDITOR_MIN_WIDTH = 240;

/** The container-query threshold the two-column disclosure opens at. */
const TWO_COLUMN_PX = 480;

const POLL = { timeout: 5000, interval: 50 } as const;

let root: Root | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  globalThis.localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
});

afterEach(async () => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  globalThis.localStorage.removeItem(WORKSPACE_LAYOUT_STORAGE_KEY);
  await page.viewport(1280, 800);
});

/** The navigation ribbon's compacted width and the sidebar's floor, mirrored
 *  from `workspaceLayout.ts`. The harness reserves them because the editor's
 *  share is what is left AFTER them: a row of just editor-plus-chat would leave
 *  the editor 250px of slack it does not have in the app, and the narrowest-
 *  window assertion below would then pass no matter how wide the pane grew. */
const NAVIGATION_COMPACT_WIDTH = 56;
const SIDEBAR_MIN_WIDTH = 192;
const SPLITTER_WIDTH = 8;

/** The workspace row the chat slot actually lives in: the navigation ribbon and
 *  sidebar at the sizes a squeezed window forces them to, a `flex-1` editor, and
 *  a `flex: 0 0 auto` slot. The widths are the real cascade's arithmetic, not a
 *  model of it — only the two fixed panels are stood in for. */
function Harness() {
  const layout = useWorkspaceLayout(true, "/vault");
  return (
    <div
      ref={layout.workspacePanesRef}
      className="nn-workspace-panes flex min-h-0 flex-1 overflow-hidden"
    >
      <div className="nn-ribbon shrink-0" style={{ width: NAVIGATION_COMPACT_WIDTH }} />
      <div className="shrink-0" style={{ width: SIDEBAR_MIN_WIDTH }} />
      <div className="shrink-0" style={{ width: SPLITTER_WIDTH }} />
      <div data-testid="editor" className="flex min-w-0 flex-1" />
      <ChatSlot
        showChat
        expanded={layout.effectiveLayout.chatExpanded}
        onToggleExpanded={layout.toggleChatExpanded}
        openNoteAt={() => {}}
        onOpenSettings={() => {}}
        refreshSignal={0}
      />
    </div>
  );
}

function makeHost(): HTMLElement {
  const el = document.createElement("div");
  el.style.position = "fixed";
  el.style.inset = "0";
  el.style.display = "flex";
  el.style.flexDirection = "column";
  document.body.append(el);
  return el;
}

async function mountHarness(): Promise<void> {
  host = makeHost();
  root = createRoot(host);
  await act(async () => {
    root!.render(<Harness />);
  });
}

function slot(): HTMLElement {
  const el = host!.querySelector<HTMLElement>(".nn-chat-slot");
  if (el === null) throw new Error("the chat slot did not render");
  return el;
}

function editorWidth(): number {
  const el = host!.querySelector<HTMLElement>('[data-testid="editor"]');
  if (el === null) throw new Error("the editor stand-in did not render");
  return el.getBoundingClientRect().width;
}

const toggle = () => page.getByRole("button", { name: "Toggle wide chat pane" });

const slotWidth = () => slot().getBoundingClientRect().width;

/** Wait for the width transition to stop moving: two equal samples an interval
 *  apart. Polling "is it wider yet?" returns on the first animation frame, at a
 *  width the pane is still travelling away from. */
async function settledSlotWidth(): Promise<number> {
  let last = -1;
  await expect
    .poll(async () => {
      const before = slotWidth();
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 120));
      });
      last = slotWidth();
      return last === before;
    }, POLL)
    .toBe(true);
  return last;
}

/** Press the toggle and wait until the pane has genuinely reached its wider
 *  size, returning the width it came to rest at.
 *
 *  The waiting is in two parts and both are load-bearing. "Two equal samples"
 *  alone is trivially satisfied BEFORE the transition starts, and when the whole
 *  browser suite runs, several test iframes compete and the click's commit can
 *  land after both of them — which handed the caller the pre-click width and
 *  failed as though the pane had never widened. So poll the target width first,
 *  which cannot be satisfied early, and only then wait for it to settle. A pane
 *  that never widens times this out, which is still a red.
 *
 *  The 40px here is only "it has visibly started moving", deliberately well
 *  under the smallest real gain (96px, at the narrowest breakpoint). How much
 *  the pane actually gained is each caller's assertion to make, not this
 *  helper's — a wait that doubled as the check would let one number quietly
 *  govern both. */
async function widenFrom(collapsed: number): Promise<number> {
  await userEvent.click(toggle());
  await expect.poll(slotWidth, POLL).toBeGreaterThan(collapsed + 40);
  return settledSlotWidth();
}

describe("expand-to-wide", () => {
  it("widens the pane by a measurable amount when the header toggle is pressed", async () => {
    await mountHarness();
    const collapsed = await settledSlotWidth();
    // Vacuity guard: a slot that never had a width cannot prove it gained one.
    expect(collapsed).toBeGreaterThan(300);

    // At the 1280px viewport the tokens are 25.5rem and 34rem — a 136px gain.
    // Asserted as a real inequality with room to spare, not as an exact number:
    // the point is that the pane got wider, not that a constant was copied.
    const expanded = await widenFrom(collapsed);

    expect(expanded).toBeGreaterThan(collapsed + 100);
    // And it settles rather than oscillating: expanding compacts the navigation,
    // which re-measures, and a width that fed back into that measurement would
    // never come to rest. `settledSlotWidth` only returns once it has.
    expect(await settledSlotWidth()).toBe(expanded);
  });

  it("comes back expanded after a remount", async () => {
    await mountHarness();
    const collapsed = await settledSlotWidth();
    const expanded = await widenFrom(collapsed);
    expect(expanded).toBeGreaterThan(collapsed);

    // A remount is what a restart looks like to this component: the controller
    // re-reads the persisted layout on mount. Nothing in the test carries the
    // state across — it goes through localStorage, the way the app's does.
    act(() => root!.unmount());
    host!.remove();
    await mountHarness();

    expect(await settledSlotWidth()).toBe(expanded);
    await expect.element(toggle()).toHaveAttribute("aria-pressed", "true");
  });

  it("still leaves the editor usable at the narrowest window the app allows", async () => {
    // 920px is the Tauri window's `minWidth`, and it sits inside the last
    // breakpoint tier. If the expanded token there were sized by eye rather than
    // derived, this is where the chat pane would push the editor under its floor.
    await page.viewport(920, 700);
    await mountHarness();
    const collapsed = await settledSlotWidth();

    const expanded = await widenFrom(collapsed);

    // The app's own floor, mirrored rather than tightened into a number this
    // test invented.
    expect(editorWidth()).toBeGreaterThanOrEqual(EDITOR_MIN_WIDTH);
    // And the failure the width token exists to prevent, stated directly: a
    // chat pane wider than the editor beside it. Skip the responsive overrides
    // and the base `clamp(36rem, …)` reaches here as 576px of a 920px window,
    // which trips this before the floor above notices.
    expect(expanded).toBeLessThan(window.innerWidth / 2);
  });
});

/** A settled call whose disclosure carries both an argument payload and a
 *  result, which is what the widened fold lays out side by side. */
function detailedCall(): ToolCallView {
  return {
    id: "call-search",
    name: "search_notes",
    title: "Search notes",
    arguments: '{"query":"spaced repetition","max_results":8}',
    status: "error",
    summary: null,
    detail: "the provider timed out after 30s",
    stepId: null,
  };
}

function detailedTranscript(): ChatMessage[] {
  return [
    { role: "user", content: "What did I write about spaced repetition?" },
    {
      ...emptyAssistant(false, "turn-1"),
      toolCalls: [detailedCall()],
      answer: "Here is what I found.",
      done: true,
    },
  ];
}

/** Mount a transcript inside the REAL slot markup at one of the two widths, so
 *  the container query is evaluated against the width the token actually
 *  resolves to rather than a number this test picked. */
async function mountTranscript(expanded: boolean): Promise<void> {
  host = makeHost();
  const slotEl = document.createElement("div");
  slotEl.className = "nn-chat-slot";
  slotEl.dataset.visible = "true";
  slotEl.dataset.expanded = String(expanded);
  host.append(slotEl);
  const pane = document.createElement("div");
  pane.className = "nn-chat-pane flex flex-col";
  slotEl.append(pane);
  root = createRoot(pane);
  await act(async () => {
    root!.render(
      <ChatTranscript
        messages={detailedTranscript()}
        onOpenCitation={() => {}}
        onOpenNote={() => {}}
        onSendFollowUp={() => {}}
        busy={false}
        runIds={{}}
      />,
    );
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 120));
  });
}

/** The two column blocks of the open disclosure, by their headings. Both are
 *  always in the DOM; below the threshold they are `display: none`, which is a
 *  rect of zeros — so these are measured, never merely found. */
function columnRects(): { args: DOMRect; result: DOMRect } {
  const found = (text: string): DOMRect => {
    const el = [...host!.querySelectorAll<HTMLElement>("p")].find(
      (candidate) => candidate.textContent === text,
    );
    if (el === undefined) throw new Error(`the ${text} column did not render`);
    return el.getBoundingClientRect();
  };
  return { args: found("Arguments"), result: found("Result") };
}

/** The turn card, which is the container the disclosure queries against. */
function turnContainer(): HTMLElement {
  const el = host!.querySelector<HTMLElement>(".\\@container");
  if (el === null) throw new Error("the turn container did not render");
  return el;
}

/** The pane may grow downward for ever and must never scroll sideways. A second
 *  column that did not fit is the obvious way to break that, and a JSON payload
 *  with a long unbreakable URL in it is the obvious way to break the column. */
function expectNoHorizontalOverflow(): void {
  const port = host!.querySelector<HTMLElement>('[aria-label="Conversation"]');
  if (port === null) throw new Error("the conversation region did not render");
  expect(port.scrollWidth).toBeLessThanOrEqual(port.clientWidth);
}

describe("the tool disclosure at the widened width", () => {
  it("lays the arguments beside the result once the turn is wide enough", async () => {
    await mountTranscript(true);

    const turn = turnContainer();
    // Guard the premise twice over. A container query can only be what opened
    // the columns if the element really is a query container and really did
    // cross the threshold — otherwise this test passes for the wrong reason.
    expect(getComputedStyle(turn).containerType).toBe("inline-size");
    expect(turn.getBoundingClientRect().width).toBeGreaterThanOrEqual(TWO_COLUMN_PX);

    const { args, result } = columnRects();
    // Side by side, not stacked — measured, because a grid that failed to emit
    // would still render both blocks, one under the other.
    expect(args.width).toBeGreaterThan(0);
    expect(result.left).toBeGreaterThan(args.right - 1);
    expect(Math.abs(result.top - args.top)).toBeLessThan(2);
    expectNoHorizontalOverflow();
  });

  it("stays exactly as it was at the shipped width", async () => {
    await mountTranscript(false);

    expect(turnContainer().getBoundingClientRect().width).toBeLessThan(TWO_COLUMN_PX);

    // Neither heading occupies any space, so what is on screen is the single
    // detail block this disclosure has always been.
    const { args, result } = columnRects();
    expect(args.width).toBe(0);
    expect(result.width).toBe(0);
    expectNoHorizontalOverflow();
  });
});
