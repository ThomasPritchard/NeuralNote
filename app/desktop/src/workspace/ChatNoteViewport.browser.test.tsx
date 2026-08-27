import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChatNoteViewport } from "./ChatNoteViewport";
import "../styles.css";

const BOTTOM_TOLERANCE = 8;
const POLL = { timeout: 5_000, interval: 25 } as const;
let host: HTMLElement | null = null;
let root: Root | null = null;

interface NoteProps {
  activityId: string;
  body: string;
  streaming: boolean;
}

const rows = (count: number, width = 50) =>
  Array.from(
    { length: count },
    (_, index) => `${index + 1}. ${"wrapped note content ".repeat(width)}`,
  ).join("\n");

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.documentElement.style.fontSize = "";
});

function noteViewport(): HTMLElement {
  const element = document.querySelector<HTMLElement>(
    '[aria-label="Note draft content"]',
  );
  if (element === null) throw new Error("note viewport did not render");
  return element;
}

function distanceFromBottom(element: HTMLElement): number {
  return element.scrollHeight - element.scrollTop - element.clientHeight;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

async function waitForScrollToRest(viewport: HTMLElement): Promise<void> {
  await expect
    .poll(async () => {
      const before = viewport.scrollTop;
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 75));
      });
      return viewport.scrollTop === before;
    }, POLL)
    .toBe(true);
}

function nativeScrollEnd(viewport: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      viewport.removeEventListener("scrollend", done);
      clearTimeout(timer);
      resolve();
    };
    viewport.addEventListener("scrollend", done);
    timer = window.setTimeout(done, 1_000);
  });
}

async function renderNote(props: NoteProps): Promise<void> {
  await act(async () => {
    root!.render(<ChatNoteViewport {...props} />);
  });
  await settle();
}

async function mountNote(props: NoteProps, width = 440): Promise<HTMLElement> {
  await document.fonts.ready;
  host = document.createElement("div");
  host.style.width = `${width}px`;
  host.style.minWidth = "0";
  document.body.append(host);
  root = createRoot(host);
  await renderNote(props);
  return noteViewport();
}

async function scrollUp(viewport: HTMLElement): Promise<void> {
  await act(async () => {
    viewport.focus();
  });
  expect(document.activeElement).toBe(viewport);
  await act(async () => {
    const ended = nativeScrollEnd(viewport);
    await userEvent.keyboard("{PageUp}");
    await ended;
  });
  await expect
    .poll(() => distanceFromBottom(viewport), POLL)
    .toBeGreaterThan(BOTTOM_TOLERANCE);
  await waitForScrollToRest(viewport);
}

describe("ChatNoteViewport in a real browser", () => {
  it("keeps a fixed block size while long wrapped text scrolls internally", async () => {
    const viewport = await mountNote({
      activityId: "write-1",
      body: "Short draft",
      streaming: true,
    });
    const height = viewport.getBoundingClientRect().height;

    await renderNote({ activityId: "write-1", body: rows(80), streaming: true });

    expect(viewport.getBoundingClientRect().height).toBeCloseTo(height, 1);
    expect(viewport.scrollHeight).toBeGreaterThan(viewport.clientHeight);
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
    expect(viewport.textContent).toContain("80.");
  });

  it("pauses immediately on an upward keyboard scroll and leaves new text parked", async () => {
    const body = rows(45, 5);
    const viewport = await mountNote({
      activityId: "write-1",
      body,
      streaming: true,
    });
    await expect
      .poll(() => distanceFromBottom(viewport), POLL)
      .toBeLessThanOrEqual(BOTTOM_TOLERANCE);

    await scrollUp(viewport);
    const parked = viewport.scrollTop;
    await expect
      .poll(() => page.getByRole("button", { name: "Jump to latest" }).query(), POLL)
      .not.toBeNull();

    await renderNote({
      activityId: "write-1",
      body: `${body}\n${rows(12, 5)}`,
      streaming: true,
    });

    expect(viewport.scrollTop).toBeCloseTo(parked, 0);
  });

  it("keyboard Jump to latest retains focus, and a manual return to bottom resumes follow", async () => {
    const body = rows(50, 5);
    const viewport = await mountNote({
      activityId: "write-1",
      body,
      streaming: true,
    });
    await scrollUp(viewport);
    const jump = page.getByRole("button", { name: "Jump to latest" });
    const jumpElement = jump.query();
    if (jumpElement === null) throw new Error("Jump to latest did not render");
    act(() => jumpElement.focus());
    expect(document.activeElement).toBe(jumpElement);
    await act(async () => {
      await userEvent.keyboard("{Enter}");
    });
    await expect
      .poll(() => distanceFromBottom(viewport), POLL)
      .toBeLessThanOrEqual(BOTTOM_TOLERANCE);
    expect(page.getByRole("button", { name: "Jump to latest" }).query()).toBeNull();
    expect(
      page.getByRole("button", { name: "Latest note content shown" }).query(),
    ).toBe(jumpElement);
    expect(document.activeElement).toBe(jumpElement);
    expect(jumpElement).toHaveAccessibleName("Latest note content shown");

    act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Jump to latest" }).query(), POLL)
      .not.toBeNull();
    act(() => {
      viewport.scrollTop = viewport.scrollHeight;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await expect
      .poll(() => page.getByRole("button", { name: "Jump to latest" }).query(), POLL)
      .toBeNull();
  });

  it("keeps scroll position and focus when a preview upgrades in place", async () => {
    const body = rows(45, 5);
    const viewport = await mountNote({
      activityId: "write-1",
      body,
      streaming: true,
    });
    await scrollUp(viewport);
    const parked = viewport.scrollTop;
    const textNode = viewport.querySelector("pre")?.firstChild;
    if (!(textNode instanceof Text)) throw new Error("note body text did not render");
    const selection = window.getSelection();
    if (selection === null) throw new Error("browser selection is unavailable");
    const range = document.createRange();
    range.setStart(textNode, 4);
    range.setEnd(textNode, 24);
    selection.removeAllRanges();
    selection.addRange(range);
    const selectedText = selection.toString();

    await renderNote({
      activityId: "write-1",
      body: `${body}\narguments complete`,
      streaming: false,
    });

    expect(noteViewport()).toBe(viewport);
    expect(document.activeElement).toBe(viewport);
    expect(viewport.scrollTop).toBeCloseTo(parked, 0);
    expect(selection.toString()).toBe(selectedText);
  });

  it("restores each selected activity's own paused position", async () => {
    const alpha = rows(45, 5);
    const beta = rows(60, 4);
    const viewport = await mountNote({
      activityId: "write-a",
      body: alpha,
      streaming: true,
    });
    await scrollUp(viewport);
    const alphaTop = viewport.scrollTop;

    await renderNote({ activityId: "write-b", body: beta, streaming: true });
    await scrollUp(viewport);
    act(() => {
      viewport.scrollTop = Math.max(1, viewport.scrollTop / 2);
      viewport.dispatchEvent(new Event("scroll"));
    });
    const betaTop = viewport.scrollTop;

    await renderNote({ activityId: "write-a", body: alpha, streaming: true });
    expect(viewport.scrollTop).toBeCloseTo(alphaTop, 0);

    await renderNote({ activityId: "write-b", body: beta, streaming: true });
    expect(viewport.scrollTop).toBeCloseTo(betaTop, 0);
  });

  it.each([
    ["narrow", 260, "", ""],
    ["default", 440, "", ""],
    ["expanded", 720, "", ""],
    ["zoomed", 440, "1.5", ""],
    ["increased text", 440, "", "20px"],
  ])(
    "does not overflow horizontally at %s size",
    async (_name, width, zoom, rootFontSize) => {
      document.documentElement.style.fontSize = rootFontSize;
      const viewport = await mountNote(
        {
          activityId: "write-1",
          body: `${"one-unbroken-token".repeat(100)}\n${rows(15, 8)}`,
          streaming: true,
        },
        width,
      );
      host!.style.zoom = zoom;
      await settle();

      expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.clientWidth + 1);
      expect(viewport.getBoundingClientRect().height).toBeGreaterThan(0);
    },
  );
});
