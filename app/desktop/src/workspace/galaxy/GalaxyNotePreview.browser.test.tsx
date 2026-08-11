import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource/atkinson-hyperlegible/400.css";
import "@fontsource/atkinson-hyperlegible/700.css";
import "../../styles.css";
import type { NoteDoc } from "../../lib/types";
import { GalaxyNotePreview } from "./GalaxyNotePreview";
import type { GalaxyNode } from "./graph";
import {
  notePreviewFocusScreenX,
  notePreviewMetrics,
  notePreviewPlacement,
} from "./notePreviewModel";

const mocks = vi.hoisted(() => ({
  readNote: vi.fn(),
  useVault: vi.fn(),
}));

vi.mock("../../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/api")>()),
  readNote: mocks.readNote,
}));
vi.mock("../../lib/store", () => ({ useVault: mocks.useVault }));

const baseTitle = "A deliberately descriptive constellation note";
const baseBody =
  "This deliberately detailed opening sentence demonstrates that the complete bounded local digest remains readable even in the tightest supported graph pane.\n\n## Detail\n\nMore context follows.";

let root: Root | null = null;
let host: HTMLElement | null = null;

function makeNote(title: string, overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/vault/notes/constellation.md",
    relPath: "notes/constellation.md",
    title,
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: baseBody,
    raw: baseBody,
    contentHash: "hash",
    binary: false,
    lossyText: false,
    exceedsEditableSize: false,
    sizeBytes: 0,
    ...overrides,
  };
}

beforeEach(() => {
  mocks.useVault.mockReturnValue({ vault: { name: "My Vault", path: "/vault" } });
  mocks.readNote.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  document.documentElement.style.removeProperty("font-size");
  delete document.documentElement.dataset.fontFamily;
});

interface FixtureOptions {
  width: number;
  height: number;
  title?: string;
  note?: Partial<NoteDoc>;
  largeAtkinson?: boolean;
  smallAtkinson?: boolean;
  neighbourCount?: number;
}

async function renderAt({
  width,
  height,
  title = baseTitle,
  note,
  largeAtkinson = false,
  smallAtkinson = false,
  neighbourCount = 1,
}: FixtureOptions) {
  if (root) {
    act(() => root?.unmount());
    root = null;
    host?.remove();
  }
  document.documentElement.style.fontSize = largeAtkinson
    ? "112.5%"
    : smallAtkinson
      ? "90%"
      : "100%";
  document.documentElement.dataset.fontFamily = largeAtkinson || smallAtkinson
    ? "atkinsonHyperlegible"
    : "inter";
  await document.fonts.ready;

  host = document.createElement("main");
  host.setAttribute("aria-label", "Graph preview browser fixture");
  host.style.position = "relative";
  host.style.overflow = "hidden";
  host.style.width = `${width}px`;
  host.style.height = `${height}px`;
  document.body.appendChild(host);
  root = createRoot(host);

  const selected: GalaxyNode = {
    id: "notes/constellation.md",
    title,
    cluster: "notes",
    val: 4,
    color: "#7d6fe0",
  };
  const neighbours = Array.from({ length: neighbourCount }, (_, index) => ({
    node: {
      id: `notes/connected-${index}.md`,
      title: `Connected note ${index + 1}`,
      cluster: "notes",
      val: 2,
      color: "#2f9d93",
    } satisfies GalaxyNode,
    bridge: index % 2 === 1,
  }));
  const metrics = notePreviewMetrics(width, height);
  const focusX = notePreviewFocusScreenX(width, metrics) ?? width / 2;
  const placement = notePreviewPlacement(
    { x: focusX, y: height / 2 },
    metrics,
    width,
    height,
  );
  for (const [property, value] of [
    ["--nn-graph-preview-anchor-x", `${placement.anchorX}px`],
    ["--nn-graph-preview-anchor-y", `${placement.anchorY}px`],
    ["--nn-graph-preview-bubble-x", `${placement.bubbleX}px`],
    ["--nn-graph-preview-bubble-y", `${placement.bubbleY}px`],
    ["--nn-graph-preview-tether-length", `${placement.tetherLength}px`],
    ["--nn-graph-preview-tether-angle", `${placement.tetherAngle}rad`],
  ]) {
    host.style.setProperty(property, value);
  }

  mocks.readNote.mockResolvedValueOnce(makeNote(title, note));
  await act(async () => {
    root!.render(
      <GalaxyNotePreview
        selected={selected}
        clusters={{ notes: { label: "Notes", color: selected.color, drillable: false } }}
        neighbours={neighbours}
        onNodeClick={vi.fn()}
        onClose={vi.fn()}
        onOpenNote={vi.fn()}
        metrics={metrics}
      />,
    );
  });
  await expect.element(page.getByText("No model called")).toBeVisible();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320));
  });

  return { focusX, metrics, placement };
}

function expectPreviewFits(width: number, height: number) {
  const card = host!.querySelector<HTMLElement>(".nn-graph-preview")!;
  const body = host!.querySelector<HTMLElement>(".nn-graph-preview-body")!;
  const title = host!.querySelector<HTMLElement>(".nn-graph-preview-title")!;
  const hostRect = host!.getBoundingClientRect();
  const cardRect = card.getBoundingClientRect();

  expect(cardRect.left).toBeGreaterThanOrEqual(hostRect.left);
  expect(cardRect.top).toBeGreaterThanOrEqual(hostRect.top);
  expect(cardRect.right).toBeLessThanOrEqual(hostRect.right);
  expect(cardRect.bottom).toBeLessThanOrEqual(hostRect.bottom);
  expect(cardRect.width).toBeLessThanOrEqual(width);
  expect(cardRect.height).toBeLessThanOrEqual(height);
  expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth + 1);
  expect(card.scrollHeight).toBeLessThanOrEqual(card.clientHeight + 1);
  expect(body.scrollWidth).toBeLessThanOrEqual(body.clientWidth + 1);
  expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
  expect(title.scrollWidth).toBeLessThanOrEqual(title.clientWidth + 1);
}

describe("GalaxyNotePreview responsive geometry", () => {
  it("keeps the complete digest visible from wide through stacked and tight panes", async () => {
    for (const [width, height] of [
      [960, 640],
      [700, 525],
      [429, 525],
      [240, 525],
    ] as const) {
      const { focusX, placement } = await renderAt({ width, height });
      expectPreviewFits(width, height);
      expect(placement.tetherLength).toBeGreaterThan(0);
      expect(focusX).toBeLessThan(placement.bubbleX);
      await expect.element(page.getByText("Derived on this device")).toBeVisible();
      await expect.element(page.getByText("Words", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Read", { exact: true })).toBeVisible();
      await expect.element(page.getByText("Sections", { exact: true })).toBeVisible();
      await expect.element(page.getByText("1 connected note")).toBeVisible();
      await expect.element(page.getByRole("button", { name: "Open in reader" })).toBeVisible();
    }
  });

  it("fits hostile title geometry, dual warnings, neighbours, and Large Atkinson text", async () => {
    const title = `Unbroken-${"constellation".repeat(30)}`;
    await renderAt({
      width: 240,
      height: 525,
      title,
      largeAtkinson: true,
      neighbourCount: 8,
      note: {
        body: `This ${"dense local context ".repeat(16)}ends here.`,
        raw: `This ${"dense local context ".repeat(16)}ends here.`,
        lossyText: true,
        frontmatterError: "invalid yaml",
      },
    });

    expectPreviewFits(240, 525);
    await expect.element(page.getByRole("heading", { name: title })).toBeVisible();
    await expect.element(page.getByText("Lossy text")).toBeVisible();
    await expect.element(page.getByText("Frontmatter issue")).toBeVisible();
    await expect.element(page.getByText("8 connected notes")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Open in reader" })).toBeVisible();

    const targets = host!.querySelectorAll<HTMLElement>(".nn-graph-preview-neighbour-target");
    expect(targets).toHaveLength(6);
    await expect.element(page.getByText("+2", { exact: true })).toBeVisible();
    for (const target of targets) {
      const rect = target.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(24);
      expect(rect.height).toBeGreaterThanOrEqual(24);
    }

    await renderAt({
      width: 240,
      height: 525,
      smallAtkinson: true,
      neighbourCount: 8,
    });
    expectPreviewFits(240, 525);
    const smallTargets = host!.querySelectorAll<HTMLElement>(
      ".nn-graph-preview-neighbour-target",
    );
    expect(smallTargets).toHaveLength(6);
    for (const target of smallTargets) {
      const rect = target.getBoundingClientRect();
      expect(rect.width).toBeGreaterThanOrEqual(24);
      expect(rect.height).toBeGreaterThanOrEqual(24);
    }
  });
});
