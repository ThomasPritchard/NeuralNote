import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { moveCompletionSelection, startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";

import "../styles.css";
import {
  MARKDOWN_COMPATIBILITY_V1,
  type MarkdownAllowedInteractionV1,
  type MarkdownBrowserExecutionV1,
  type MarkdownCompatibilityCaseV1,
} from "../test-contracts/markdownCompatibilityV1";
import { selectBrowserCompatibilityScenarios } from "../test-contracts/markdownCompatibilityBrowserScenarios";
import type { NoteIndexEntry } from "./linkResolve";
import { SourceNoteEditor, type SourceNoteEditorProps } from "./SourceNoteEditor";
import { clearSourceEditorSessions } from "./sourceEditorSession";

vi.mock("../lib/api", () => ({
  onMenu: vi.fn(async () => () => {}),
}));

interface MountedEditor {
  readonly host: HTMLElement;
  readonly changes: string[];
  source(): string;
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let session = 0;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
  clearSourceEditorSessions();
  vi.restoreAllMocks();
});

async function mountEditor(
  value: string,
  overrides: Partial<SourceNoteEditorProps> = {},
  dimensions = { width: 840, height: 680 },
): Promise<MountedEditor> {
  await document.fonts.ready;
  host = document.createElement("main");
  host.setAttribute("aria-label", "Browser editor fixture");
  host.style.width = `${dimensions.width}px`;
  host.style.height = `${dimensions.height}px`;
  host.style.overflow = "hidden";
  document.body.appendChild(host);

  const changes: string[] = [];
  const sessionKey = `browser-${session++}`;
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <SourceNoteEditor
        sessionKey={sessionKey}
        loadedHash={sessionKey}
        value={value}
        onChange={(next) => changes.push(next)}
        onPreservationError={() => {}}
        {...overrides}
      />,
    );
  });

  await expect
    .poll(() => host?.querySelector<HTMLElement>('[role="textbox"][aria-label="Note content"]'))
    .not.toBeNull();

  return {
    host,
    changes,
    source: () => changes.at(-1) ?? value,
  };
}

function editorTextbox(): HTMLElement {
  return document.querySelector<HTMLElement>('[role="textbox"][aria-label="Note content"]')!;
}

function modifier(key: string): string {
  return server.platform === "darwin"
    ? `{Meta>}{${key}}{/Meta}`
    : `{Control>}{${key}}{/Control}`;
}

function shiftedModifier(key: string): string {
  return server.platform === "darwin"
    ? `{Meta>}{Shift>}{${key}}{/Shift}{/Meta}`
    : `{Control>}{Shift>}{${key}}{/Shift}{/Control}`;
}

const IMPLEMENTED_BROWSER_EXECUTIONS = new Set<MarkdownBrowserExecutionV1>([
  "browser:chromium-webkit:source-edit-copy",
  "browser:chromium-webkit:clipboard-history",
  "browser:chromium-webkit:task-toggle",
  "browser:chromium-webkit:table-source-activation",
  "browser:chromium-webkit:internal-link-pointer",
  "browser:chromium-webkit:internal-link-enter",
  "browser:chromium-webkit:internal-link-mod-enter",
  "browser:chromium-webkit:tag-pointer",
  "browser:chromium-webkit:tag-enter",
  "browser:chromium-webkit:tag-mod-enter",
  "browser:chromium-webkit:properties-source-and-tag",
  "browser:chromium-webkit:wikilink-completion",
  "browser:chromium-webkit:wikilink-alias-edit",
  "browser:chromium-webkit:wikilink-fragment-edit",
]);

const COMPATIBILITY_INDEX: readonly NoteIndexEntry[] = [
  { relPath: "Daily.md", stem: "daily" },
  { relPath: "Areas/Deep Work.md", stem: "deep work" },
];

const BROWSER_SCENARIOS = selectBrowserCompatibilityScenarios(
  MARKDOWN_COMPATIBILITY_V1.cases,
);

function editorView(): EditorView {
  return EditorView.findFromDOM(editorTextbox())!;
}

function select(view: EditorView, anchor: number, head = anchor): void {
  view.dispatch({ selection: { anchor, head } });
  view.focus();
}

function tagAnchor(source: string): number {
  const bodyTag = source.lastIndexOf("#");
  return Math.min(source.length, Math.max(0, bodyTag + 2));
}

// The interaction is the table-driven test dimension. Every exhaustive branch
// performs its own assertions; this is not runtime-conditional test logic.
// oxlint-disable vitest/no-conditional-expect
async function runDeclaredInteraction(
  item: MarkdownCompatibilityCaseV1,
  interaction: MarkdownAllowedInteractionV1,
): Promise<void> {
  const onOpenLink = vi.fn();
  const onSearchTag = vi.fn();
  const properties = item.id === "yaml-frontmatter-properties"
    ? {
        frontmatter: { title: "Exact source", tags: ["compatibility", "#nested/tag"] },
        frontmatterRaw: "title: Exact source\ntags: [compatibility, '#nested/tag']",
      }
    : {};
  const mounted = await mountEditor(item.source, {
    noteIndex: COMPATIBILITY_INDEX,
    onOpenLink,
    onSearchTag,
    ...properties,
  });
  const view = editorView();
  const logicalSource = view.state.doc.toString();

  switch (interaction) {
    case "editSource": {
      select(view, view.state.doc.length);
      await userEvent.keyboard("x");
      await expect.poll(() => mounted.source()).toBe(`${item.source}x`);
      await userEvent.keyboard(modifier("z"));
      await expect.poll(() => mounted.source()).toBe(item.source);
      return;
    }
    case "copySource": {
      let copiedSource: string | null = null;
      const captureCopy = (event: ClipboardEvent) => {
        copiedSource = event.clipboardData?.getData("text/plain") ?? null;
      };
      document.addEventListener("copy", captureCopy);
      select(view, 0, view.state.doc.length);
      try {
        await userEvent.copy();
      } finally {
        document.removeEventListener("copy", captureCopy);
      }
      expect(copiedSource).toBe(item.source);
      expect(mounted.source()).toBe(item.source);
      return;
    }
    case "cutSource": {
      let cutSource: string | null = null;
      const captureCut = (event: ClipboardEvent) => {
        cutSource = event.clipboardData?.getData("text/plain") ?? null;
      };
      document.addEventListener("cut", captureCut);
      select(view, 0, view.state.doc.length);
      try {
        await userEvent.cut();
      } finally {
        document.removeEventListener("cut", captureCut);
      }
      expect(cutSource).toBe(item.source);
      await expect.poll(() => mounted.source()).toBe("");
      await userEvent.keyboard(modifier("z"));
      await expect.poll(() => mounted.source()).toBe(item.source);
      await userEvent.keyboard(shiftedModifier("z"));
      await expect.poll(() => mounted.source()).toBe("");
      await userEvent.keyboard(modifier("z"));
      await expect.poll(() => mounted.source()).toBe(item.source);
      return;
    }
    case "pasteSource": {
      const from = logicalSource.startsWith("\uFEFF") ? 1 : 0;
      const copied = logicalSource.slice(from, from + 1);
      select(view, from, from + 1);
      await userEvent.copy();
      select(view, view.state.doc.length);
      await userEvent.paste();
      await expect.poll(() => mounted.source()).toBe(`${item.source}${copied}`);
      return;
    }
    case "undo": {
      select(view, view.state.doc.length);
      await userEvent.keyboard("x");
      await expect.poll(() => mounted.source()).toBe(`${item.source}x`);
      await userEvent.keyboard(modifier("z"));
      await expect.poll(() => mounted.source()).toBe(item.source);
      return;
    }
    case "redo": {
      select(view, view.state.doc.length);
      await userEvent.keyboard("x");
      await userEvent.keyboard(modifier("z"));
      await userEvent.keyboard(shiftedModifier("z"));
      await expect.poll(() => mounted.source()).toBe(`${item.source}x`);
      return;
    }
    case "toggleTask": {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.contentDOM.blur();
      await expect.poll(() => mounted.host.querySelector<HTMLInputElement>("[role='checkbox']"))
        .not.toBeNull();
      await userEvent.click(mounted.host.querySelector<HTMLInputElement>("[role='checkbox']")!);
      const toggled = item.source.replace(/\[([ xX])\]/u, (_match, marker: string) =>
        marker === " " ? "[x]" : "[ ]");
      await expect.poll(() => mounted.source()).toBe(toggled);
      return;
    }
    case "activateTableSource": {
      view.dispatch({ selection: { anchor: view.state.doc.length } });
      view.contentDOM.blur();
      await expect.poll(() => mounted.host.querySelector<HTMLElement>("table.nn-lp-table"))
        .not.toBeNull();
      const table = mounted.host.querySelector<HTMLElement>("table.nn-lp-table")!;
      table.focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => mounted.host.querySelector("table.nn-lp-table")).toBeNull();
      expect(mounted.source()).toBe(item.source);
      return;
    }
    case "activateInternalLink": {
      const execution = item.interactionExecutions.activateInternalLink;
      if (execution === "browser:chromium-webkit:internal-link-mod-enter") {
        const marker = item.source.includes("[[") ? item.source.indexOf("[[") + 2 : 1;
        select(view, marker);
        await userEvent.keyboard(modifier("Enter"));
      } else {
        view.dispatch({ selection: { anchor: view.state.doc.length } });
        view.contentDOM.blur();
        await expect.poll(() => mounted.host.querySelector<HTMLElement>(
          "[data-nn-wikilink-target], [data-nn-markdown-target]",
        )).not.toBeNull();
        const link = mounted.host.querySelector<HTMLElement>(
          "[data-nn-wikilink-target], [data-nn-markdown-target]",
        )!;
        if (execution === "browser:chromium-webkit:internal-link-enter") {
          link.focus();
          await userEvent.keyboard("{Enter}");
        } else {
          await userEvent.click(link);
        }
      }
      await expect.poll(() => onOpenLink.mock.calls.length).toBe(1);
      expect(mounted.source()).toBe(item.source);
      return;
    }
    case "searchTag": {
      const execution = item.interactionExecutions.searchTag;
      if (execution === "browser:chromium-webkit:properties-source-and-tag") {
        await userEvent.click(page.getByRole("button", { name: "Search for #compatibility" }));
      } else if (execution === "browser:chromium-webkit:tag-enter") {
        select(view, tagAnchor(item.source));
        await userEvent.keyboard("{Enter}");
      } else if (execution === "browser:chromium-webkit:tag-mod-enter") {
        select(view, tagAnchor(item.source));
        await userEvent.keyboard(modifier("Enter"));
      } else {
        await expect.poll(() => mounted.host.querySelector<HTMLElement>("[data-nn-tag]"))
          .not.toBeNull();
        await userEvent.click(mounted.host.querySelector<HTMLElement>("[data-nn-tag]")!);
      }
      await expect.poll(() => onSearchTag.mock.calls.length).toBe(1);
      expect(mounted.source()).toBe(item.source);
      return;
    }
    case "completeWikilink": {
      select(view, view.state.doc.length);
      const execution = item.interactionExecutions.completeWikilink;
      if (execution === "browser:chromium-webkit:wikilink-alias-edit") {
        await userEvent.keyboard("us]]");
        await expect.poll(() => mounted.source()).toBe(`${item.source}us]]`);
      } else if (execution === "browser:chromium-webkit:wikilink-fragment-edit") {
        await userEvent.keyboard("iew]]");
        await expect.poll(() => mounted.source()).toBe(`${item.source}iew]]`);
      } else {
        expect(startCompletion(view)).toBe(true);
        await expect.element(page.getByRole("listbox")).toBeVisible();
        await expect
          .poll(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent)
          .toContain("Deep Work");
        await expect.poll(() => moveCompletionSelection(true)(view)).toBe(true);
        await userEvent.keyboard("{ArrowUp}");
        await userEvent.keyboard("{Enter}");
        await expect.poll(() => mounted.source()).toBe("[[Deep Work]]");
      }
      return;
    }
    case "togglePropertiesSource": {
      await userEvent.click(page.getByRole("button", { name: "Edit note properties" }));
      await expect.poll(() => mounted.host.querySelector(".nn-source-properties")).toBeNull();
      await userEvent.click(page.getByRole("button", { name: "Done editing note properties" }));
      await expect.poll(() => mounted.host.querySelector(".nn-source-properties")).not.toBeNull();
      expect(mounted.source()).toBe(item.source);
      return;
    }
  }
}
// oxlint-enable vitest/no-conditional-expect

describe("MarkdownCompatibilityV1 — browser execution map", () => {
  it("implements every mapped Chromium and WebKit execution family", () => {
    const mapped = new Set(
      MARKDOWN_COMPATIBILITY_V1.cases.flatMap((item) =>
        Object.values(item.interactionExecutions)),
    );

    expect([...mapped].sort()).toEqual([...IMPLEMENTED_BROWSER_EXECUTIONS].sort());
  });

  // Assertions live in the exhaustive interaction driver above.
  // oxlint-disable-next-line vitest/expect-expect
  it.each(BROWSER_SCENARIOS)(
    "$item.id executes $interaction on its exact source",
    async ({ item, interaction }) => runDeclaredInteraction(item, interaction),
  );
});

describe("SourceNoteEditor — real-browser geometry", () => {
  it("keeps computed line height, focus indication, and scrolling inside the editor", async () => {
    const mounted = await mountEditor("alpha\nbeta");

    const editor = mounted.host.querySelector<HTMLElement>(".cm-editor")!;
    const scroller = mounted.host.querySelector<HTMLElement>(".cm-scroller")!;
    const line = mounted.host.querySelector<HTMLElement>(".cm-line")!;
    const fontSize = Number.parseFloat(getComputedStyle(editor).fontSize);
    const lineHeight = Number.parseFloat(getComputedStyle(line).lineHeight);

    expect(lineHeight).toBeCloseTo(fontSize * 1.8, 2);
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    expect(scroller.getBoundingClientRect().right).toBeLessThanOrEqual(
      editor.getBoundingClientRect().right,
    );

    await userEvent.click(page.getByRole("textbox", { name: "Note content" }));

    expect(document.activeElement).toBe(editorTextbox());
    expect(getComputedStyle(editor).boxShadow).not.toBe("none");
  });

  it("virtualises a narrow large document and scrolls decorations with the caret", async () => {
    const source = Array.from({ length: 2_000 }, (_, index) =>
      index === 1_999 ? "tail-marker #tail" : `line ${index} #tag`,
    ).join("\n");
    const mounted = await mountEditor(source, {}, { width: 360, height: 520 });
    const scroller = mounted.host.querySelector<HTMLElement>(".cm-scroller")!;

    expect(mounted.host.querySelectorAll(".cm-line").length).toBeLessThan(300);
    expect(mounted.host.querySelectorAll(".nn-lp-tag").length).toBeLessThan(300);

    await userEvent.click(page.getByRole("textbox", { name: "Note content" }));
    await userEvent.keyboard(modifier("End"));

    await expect.poll(() => scroller.scrollTop).toBeGreaterThan(0);
    await expect
      .poll(() => [...mounted.host.querySelectorAll(".cm-line")]
        .some((line) => line.textContent?.includes("tail-marker")))
      .toBe(true);
    expect(mounted.host.querySelectorAll(".cm-line").length).toBeLessThan(300);
    expect(mounted.source()).toBe(source);
  });
});

describe("SourceNoteEditor — real-browser inline preview", () => {
  it("renders ATX heading typography and reveals its marker when entered", async () => {
    const mounted = await mountEditor("plain\n# ATX heading");
    const heading = mounted.host.querySelector<HTMLElement>(".nn-lp-heading-1")!;
    const plain = mounted.host.querySelector<HTMLElement>(".cm-line")!;

    expect(heading).toHaveAttribute("role", "heading");
    expect(heading).toHaveAttribute("aria-level", "1");
    expect(Number.parseFloat(getComputedStyle(heading).fontSize)).toBeGreaterThan(
      Number.parseFloat(getComputedStyle(plain).fontSize),
    );
    expect(heading.textContent?.trim()).toBe("ATX heading");

    await userEvent.click(page.getByRole("heading", { name: "ATX heading" }));

    await expect
      .poll(() => mounted.host.querySelector(".nn-lp-marker-active")?.textContent)
      .toContain("#");
    expect(mounted.source()).toBe("plain\n# ATX heading");
  });

  it("renders Setext heading typography without losing its underline source", async () => {
    const mounted = await mountEditor("plain\n\nSetext heading\n===");
    const heading = mounted.host.querySelector<HTMLElement>(".nn-lp-heading-1")!;

    expect(heading).toHaveAttribute("role", "heading");
    expect(heading.textContent).toBe("Setext heading");

    await userEvent.click(page.getByRole("heading", { name: "Setext heading" }));

    await expect
      .poll(() => [...mounted.host.querySelectorAll(".nn-lp-marker-active")]
        .some((marker) => marker.textContent === "==="))
      .toBe(true);
    expect(mounted.source()).toBe("plain\n\nSetext heading\n===");
  });

  it("styles emphasis, strong, strikethrough, and code while retaining delimiters", async () => {
    const source = "plain\n*italic* **bold** ~~gone~~ `code`";
    const mounted = await mountEditor(source);
    const emphasis = mounted.host.querySelector<HTMLElement>(".nn-lp-emphasis")!;
    const strong = mounted.host.querySelector<HTMLElement>(".nn-lp-strong")!;
    const strike = mounted.host.querySelector<HTMLElement>(".nn-lp-strikethrough")!;
    const code = mounted.host.querySelector<HTMLElement>(".nn-lp-inline-code")!;

    expect(getComputedStyle(emphasis).fontStyle).toBe("italic");
    expect(Number.parseInt(getComputedStyle(strong).fontWeight, 10)).toBeGreaterThanOrEqual(700);
    expect(getComputedStyle(strike).textDecorationLine).toContain("line-through");
    expect(getComputedStyle(code).fontFamily).toContain("monospace");

    await userEvent.click(strong);

    await expect
      .poll(() => [...mounted.host.querySelectorAll(".nn-lp-marker-active")]
        .filter((marker) => marker.textContent === "**").length)
      .toBe(2);
    expect(mounted.source()).toBe(source);
  });

  it("opens internal Markdown links but leaves external and unsafe targets inert", async () => {
    const onOpenLink = vi.fn();
    const source = "plain\n[Daily](Daily.md) [web](https://example.test) [unsafe](javascript:alert(1))";
    const mounted = await mountEditor(source, {
      noteIndex: [{ relPath: "Daily.md", stem: "daily" }],
      onOpenLink,
    });
    const internal = mounted.host.querySelector<HTMLElement>(
      ".nn-lp-link[data-nn-markdown-target='Daily.md']",
    )!;

    await userEvent.click(internal);

    internal.focus();
    await userEvent.keyboard("{Enter}");

    expect(onOpenLink).toHaveBeenCalledTimes(2);
    expect(onOpenLink).toHaveBeenLastCalledWith("Daily.md");
    expect(mounted.host.querySelector("[data-nn-markdown-target^='http']")).toBeNull();
    expect(mounted.host.querySelector("[data-nn-markdown-target^='javascript']")).toBeNull();
    expect(mounted.host.querySelector("a[href]")).toBeNull();
    expect(mounted.source()).toBe(source);
  });
});

describe("SourceNoteEditor — real-browser block and widget preview", () => {
  it("lays out ordered, unordered, nested, and mixed list markers", async () => {
    const source = [
      "plain",
      "1. ordered",
      "   - nested unordered",
      "2) alternate ordered",
      "* star",
      "+ plus",
    ].join("\n");
    const mounted = await mountEditor(source);
    const markers = [...mounted.host.querySelectorAll<HTMLElement>(".nn-lp-list-marker")];

    expect(markers.map((marker) => marker.textContent)).toEqual(["1.", "-", "2)", "*", "+"]);
    expect(markers[1]!.getBoundingClientRect().left)
      .toBeGreaterThan(markers[0]!.getBoundingClientRect().left);
    expect(mounted.source()).toBe(source);
  });

  it("toggles only the task marker, restores editor focus, and supports undo", async () => {
    const source = "plain\n- [ ] ship browser coverage";
    const mounted = await mountEditor(source);
    const task = page.getByRole("checkbox", { name: "Mark task complete" });

    await userEvent.click(task);

    await expect.poll(() => mounted.source()).toBe("plain\n- [x] ship browser coverage");
    expect(document.activeElement).toBe(editorTextbox());

    await userEvent.keyboard(modifier("z"));

    await expect.poll(() => mounted.source()).toBe(source);
  });

  it("styles blockquotes without replacing their source", async () => {
    const source = "plain\n\n> quoted";
    const mounted = await mountEditor(source);

    expect(mounted.host.querySelector(".nn-lp-blockquote")).not.toBeNull();
    expect(mounted.source()).toBe(source);
  });

  it("styles thematic breaks without replacing their source", async () => {
    const source = "---\nplain";
    const mounted = await mountEditor(source);

    await userEvent.click(mounted.host.querySelectorAll<HTMLElement>(".cm-line").item(1));
    await expect.poll(() => mounted.host.querySelector(".nn-lp-thematic-break")).not.toBeNull();
    expect(mounted.source()).toBe(source);
  });

  it("styles fenced code without replacing its source", async () => {
    const source = "plain\n\n```ts\nconst answer = 42;\n```";
    const mounted = await mountEditor(source);

    expect(getComputedStyle(mounted.host.querySelector<HTMLElement>(".nn-lp-fenced-code")!).fontFamily)
      .toContain("monospace");
    expect(mounted.source()).toBe(source);
  });

  // Activating a table used to swap the read-only widget for raw pipe source,
  // and this asserted the pipes came back as literal text. #99 replaced that
  // swap with a grid drawn OVER the editable source, so the pipes are hidden and
  // painted as chrome instead. The overflow and keyboard-activation coverage
  // this test exists for is unchanged; only the post-activation contract moved.
  it("renders a semantic overflowing table and keeps it drawn once activated", async () => {
    const source = [
      "plain",
      "",
      "| Alpha heading | Beta heading | Gamma heading | Delta heading | Epsilon heading |",
      "| --- | --- | --- | --- | --- |",
      "| one | two | three | four | five |",
    ].join("\n");
    const mounted = await mountEditor(source, {}, { width: 420, height: 600 });
    const table = mounted.host.querySelector<HTMLTableElement>("table.nn-lp-table")!;
    const tableScroller = table.parentElement!;

    expect(table).toHaveAttribute("aria-label", "Markdown table");
    expect(table.querySelectorAll("th")).toHaveLength(5);
    expect(tableScroller.scrollWidth).toBeGreaterThan(tableScroller.clientWidth);

    await userEvent.tab();
    await userEvent.tab();
    await expect.poll(() => document.activeElement?.getAttribute("aria-label"))
      .toBe("Markdown table");
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => mounted.host.querySelector("table.nn-lp-table")).toBeNull();
    await expect.poll(
      () => mounted.host.querySelectorAll(".cm-content .cm-line.nn-lp-table-row").length,
    ).toBe(3);

    const drawnText = mounted.host.querySelector(".cm-content")?.textContent ?? "";
    expect(drawnText).toContain("Alpha heading");
    expect(drawnText).toContain("three");
    // The delimiters are chrome now, not characters. Asserting their absence is
    // what would go red if the widget ever fell back to painting raw source.
    expect(drawnText).not.toContain("one | two | three");
    expect(mounted.source()).toBe(source);
  });

  it("returns the compatibility table to exact source with pointer activation", async () => {
    const item = MARKDOWN_COMPATIBILITY_V1.cases.find(
      ({ id }) => id === "table-preview-source-switch",
    )!;
    const mounted = await mountEditor(item.source);
    const view = editorView();
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.contentDOM.blur();

    await expect.poll(() => mounted.host.querySelector<HTMLTableElement>("table.nn-lp-table"))
      .not.toBeNull();
    const table = mounted.host.querySelector<HTMLTableElement>("table.nn-lp-table")!;
    await userEvent.click(table);

    await expect.poll(() => mounted.host.querySelector("table.nn-lp-table")).toBeNull();
    expect(document.activeElement).toBe(editorTextbox());
    expect(view.state.doc.toString()).toBe(item.source);
    expect(mounted.source()).toBe(item.source);
  });

  it("keeps remote Markdown images labelled, inert, and non-fetching", async () => {
    const remote = "https://example.invalid/tracker.png";
    const source = `![diagram](${remote})\nplain`;
    const mounted = await mountEditor(source);

    await userEvent.click(mounted.host.querySelectorAll<HTMLElement>(".cm-line").item(1));
    await expect
      .poll(() => mounted.host.querySelector(".nn-lp-image")?.textContent)
      .toBe("Image: diagram");
    expect(mounted.host.querySelector(
      "img:not(.cm-widgetBuffer), iframe, object, embed, [src], [href]",
    )).toBeNull();
    expect(performance.getEntriesByName(remote)).toHaveLength(0);
    expect(mounted.source()).toBe(source);
  });

  it("keeps wikilink-shaped image alt text inert and reveals the complete image source", async () => {
    const source = "![prefix [[Daily]] suffix](local.png)\nplain";
    const onOpenLink = vi.fn();
    const mounted = await mountEditor(source, {
      noteIndex: [{ relPath: "Daily.md", stem: "daily" }],
      onOpenLink,
    });

    await userEvent.click(mounted.host.querySelectorAll<HTMLElement>(".cm-line").item(1));

    const image = page.getByText("Image: prefix [[Daily]] suffix", { exact: true });
    await expect.element(image).toBeVisible();
    expect(mounted.host.querySelector("[data-nn-wikilink-target]")).toBeNull();

    await userEvent.click(image);

    await expect.poll(() => mounted.host.querySelector(".nn-lp-image")).toBeNull();
    expect(mounted.host.querySelector(".cm-content")?.textContent).toContain(
      "![prefix [[Daily]] suffix](local.png)",
    );
    expect(mounted.host.querySelector("[data-nn-wikilink-target]")).toBeNull();
    expect(onOpenLink).not.toHaveBeenCalled();
    expect(mounted.source()).toBe(source);
  });

  it("keeps Obsidian embeds labelled and inert", async () => {
    const source = "![[Secret note]]\nplain";
    const mounted = await mountEditor(source);

    await userEvent.click(mounted.host.querySelectorAll<HTMLElement>(".cm-line").item(1));

    await expect
      .poll(() => mounted.host.querySelector(".nn-lp-embed")?.textContent)
      .toBe("Embed: Secret note");
    expect(mounted.host.querySelector(
      "img:not(.cm-widgetBuffer), iframe, object, embed, [src], [href]",
    )).toBeNull();
    expect(mounted.source()).toBe(source);
  });

  it("gives a missing-alt Markdown image a stable accessible fallback", async () => {
    const source = "![](/missing.png)\nplain";
    const mounted = await mountEditor(source);

    await userEvent.click(mounted.host.querySelectorAll<HTMLElement>(".cm-line").item(1));

    await expect
      .poll(() => mounted.host.querySelector(".nn-lp-image")?.textContent)
      .toBe("Image: image");
    expect(mounted.host.querySelector(
      "img:not(.cm-widgetBuffer), iframe, object, embed, [src], [href]",
    )).toBeNull();
    expect(mounted.source()).toBe(source);
  });
});

describe("SourceNoteEditor — real-browser Obsidian interactions", () => {
  const INDEX: readonly NoteIndexEntry[] = [
    { relPath: "Daily.md", stem: "daily" },
    { relPath: "Alfa/Topic.md", stem: "topic" },
    { relPath: "Beta/Topic.md", stem: "topic" },
  ];

  it("opens a resolved wikilink with pointer and keyboard activation", async () => {
    const onOpenLink = vi.fn();
    const mounted = await mountEditor("plain\n[[Daily]]", { noteIndex: INDEX, onOpenLink });
    const link = page.getByRole("link", { name: "Daily" });

    await userEvent.click(link);
    expect(onOpenLink).toHaveBeenCalledTimes(1);

    mounted.host.querySelector<HTMLElement>("[data-nn-wikilink-target]")!.focus();
    await userEvent.keyboard("{Enter}");

    expect(onOpenLink).toHaveBeenCalledTimes(2);
    expect(mounted.source()).toBe("plain\n[[Daily]]");
  });

  it("opens a resolved wikilink with Mod+Enter at the source caret", async () => {
    const onOpenLink = vi.fn();
    const source = "plain\n[[Daily]]";
    await mountEditor(source, { noteIndex: INDEX, onOpenLink });
    const view = EditorView.findFromDOM(editorTextbox())!;
    view.dispatch({ selection: { anchor: source.indexOf("Daily") + 2 } });
    view.focus();

    await userEvent.keyboard(modifier("Enter"));

    await expect.poll(() => onOpenLink.mock.calls.length).toBe(1);
    expect(onOpenLink).toHaveBeenCalledWith("Daily.md");
  });

  it("routes inline tags by pointer without decorating code or link destinations", async () => {
    const onSearchTag = vi.fn();
    const source = "#topic\nplain `#code` [label](#heading)";
    const mounted = await mountEditor(source, { onSearchTag });

    await userEvent.click(page.getByRole("link", { name: "Search for #topic" }));

    await expect.poll(() => onSearchTag.mock.calls.length).toBe(1);
    expect(onSearchTag).toHaveBeenCalledWith("#topic");
    expect(mounted.host.querySelectorAll(".nn-lp-tag")).toHaveLength(1);

    editorTextbox().focus();
    await userEvent.keyboard(modifier("Enter"));

    await expect.poll(() => onSearchTag.mock.calls.length).toBe(2);
    expect(onSearchTag).toHaveBeenLastCalledWith("#topic");
    expect(mounted.source()).toBe(source);
  });

  it("routes a focused inline tag with Enter", async () => {
    const onSearchTag = vi.fn();
    const source = "plain\n#review";
    await mountEditor(source, { onSearchTag });
    const view = EditorView.findFromDOM(editorTextbox())!;
    view.dispatch({ selection: { anchor: source.indexOf("review") + 2 } });
    view.focus();

    await userEvent.keyboard("{Enter}");

    await expect.poll(() => onSearchTag.mock.calls.length).toBe(1);
    expect(onSearchTag).toHaveBeenCalledWith("#review");
  });

  it("styles callout and block-ID markers without replacing their source", async () => {
    const source = "plain\n> [!NOTE]+ Browser contract\nParagraph ^browser-block";
    const mounted = await mountEditor(source);

    expect(mounted.host.querySelector(".nn-lp-callout")?.textContent).toContain("!NOTE");
    expect(mounted.host.querySelector(".nn-lp-block-id")?.textContent).toBe("^browser-block");
    expect(mounted.source()).toBe(source);
  });

  it("expands Properties to YAML and folds back without changing source", async () => {
    const source = "---\ntitle: Browser fixture\ntags: [e2e]\n---\n# Heading";
    const onSearchTag = vi.fn();
    const mounted = await mountEditor(source, {
      frontmatter: { title: "Browser fixture", tags: ["e2e"] },
      frontmatterRaw: "title: Browser fixture\ntags: [e2e]",
      onSearchTag,
    });

    expect(mounted.host.querySelector(".nn-source-properties")).not.toBeNull();
    expect(mounted.host.querySelector(".cm-content")?.textContent).not.toContain("title: Browser fixture");

    await userEvent.click(page.getByRole("button", { name: "Search for #e2e" }));
    await expect.poll(() => onSearchTag.mock.calls.length).toBe(1);
    expect(onSearchTag).toHaveBeenCalledWith("#e2e");

    await userEvent.click(page.getByRole("button", { name: "Edit note properties" }));

    await expect
      .poll(() => mounted.host.querySelector(".cm-content")?.textContent)
      .toContain("title: Browser fixture");
    await userEvent.click(page.getByRole("button", { name: "Done editing note properties" }));

    await expect.poll(() => mounted.host.querySelector(".nn-source-properties")).not.toBeNull();
    expect(mounted.source()).toBe(source);
    expect(mounted.changes).toHaveLength(0);
  });

  it("positions a keyboard-selectable completion popup inside the viewport", async () => {
    const mounted = await mountEditor("", { noteIndex: INDEX }, { width: 560, height: 480 });

    await userEvent.click(page.getByRole("textbox", { name: "Note content" }));
    await userEvent.keyboard("[[[[Top");

    const listbox = page.getByRole("listbox");
    await expect.element(listbox).toBeVisible();
    const popup = document.querySelector<HTMLElement>(".cm-tooltip-autocomplete")!;
    const rect = popup.getBoundingClientRect();
    expect(rect.left).toBeGreaterThanOrEqual(0);
    expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
    expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(2);

    await expect
      .poll(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent)
      .toContain("Alfa/Topic.md");
    // Prove the completion keymap is accepting input before using Enter. The
    // selected option is the observable readiness state; no wall-clock delay is
    // needed and an early key cannot accidentally submit a newline.
    const view = EditorView.findFromDOM(editorTextbox())!;
    await expect.poll(() => moveCompletionSelection(true)(view)).toBe(true);
    await expect
      .poll(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent)
      .toContain("Beta/Topic.md");
    await userEvent.keyboard("{ArrowUp}");
    await expect
      .poll(() => document.querySelector('[role="option"][aria-selected="true"]')?.textContent)
      .toContain("Alfa/Topic.md");
    await userEvent.keyboard("{Enter}");

    await expect.poll(() => mounted.source()).toBe("[[Alfa/Topic]]");
    expect(document.activeElement).toBe(editorTextbox());
  });

  it("continues editing a wikilink alias as exact source", async () => {
    const source = "plain\n[[Daily|foc";
    const mounted = await mountEditor(source, { noteIndex: INDEX });
    const view = EditorView.findFromDOM(editorTextbox())!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();

    await userEvent.keyboard("us]]");

    await expect.poll(() => mounted.source()).toBe("plain\n[[Daily|focus]]");
  });

  it("continues editing a wikilink fragment as exact source", async () => {
    const source = "plain\n[[Daily#Rev";
    const mounted = await mountEditor(source, { noteIndex: INDEX });
    const view = EditorView.findFromDOM(editorTextbox())!;
    view.dispatch({ selection: { anchor: view.state.doc.length } });
    view.focus();

    await userEvent.keyboard("iew]]");

    await expect.poll(() => mounted.source()).toBe("plain\n[[Daily#Review]]");
  });
});

describe("SourceNoteEditor — real-browser editing safety", () => {
  it("keeps malformed and unsupported syntax visible and non-executable", async () => {
    const source = [
      "<script>window.nnBrowserExecuted = true</script>",
      "<Component onClick={() => attack()} />",
      "$not-math$",
      "```dataviewjs",
      "dv.pages().file.delete()",
      "```",
      "[[broken",
      "| malformed | table",
    ].join("\n");
    const mounted = await mountEditor(source);

    expect((window as typeof window & { nnBrowserExecuted?: boolean }).nnBrowserExecuted)
      .not.toBe(true);
    expect(mounted.host.querySelector("script, component, iframe, [onclick]")).toBeNull();
    expect(mounted.host.querySelector(".cm-content")?.textContent).toContain("window.nnBrowserExecuted");
    expect(mounted.host.querySelector(".cm-content")?.textContent).toContain("dv.pages().file.delete()");
    expect(mounted.source()).toBe(source);
  });

  // Chromium only, and not because WebKit disagrees. `userEvent.copy/cut/paste`
  // drive the real system clipboard, which the WebKit runner in CI has no access
  // to: the call never settles and the test dies on its own timeout, taking 67s
  // to say nothing. It passes on WebKit locally, against a real macOS pasteboard,
  // which is exactly why the gap is the runner's rather than the engine's.
  // Nothing here is engine-specific anyway — it asserts the editor keeps bytes
  // exact across a clipboard round trip, and Chromium proves that in CI. WebKit's
  // job in this suite is the geometry, fonts and selection painting jsdom cannot
  // see. Tracked in #100.
  it.skipIf(server.browser !== "chromium")(
    "copies, cuts, pastes, undoes, and redoes exact multiline Markdown", async () => {
    const source = "# Alpha\n\n- beta\n- gamma";
    const mounted = await mountEditor(source);

    await userEvent.click(page.getByRole("textbox", { name: "Note content" }));
    await userEvent.keyboard(modifier("a"));
    await userEvent.copy();
    await userEvent.cut();
    await expect.poll(() => mounted.source()).toBe("");

    await userEvent.paste();
    await expect.poll(() => mounted.source()).toBe(source);

    await userEvent.keyboard(modifier("z"));
    await expect.poll(() => mounted.source()).toBe("");
    await userEvent.keyboard(modifier("z"));
    await expect.poll(() => mounted.source()).toBe(source);

    await userEvent.keyboard(shiftedModifier("z"));
    await expect.poll(() => mounted.source()).toBe("");
    await userEvent.keyboard(shiftedModifier("z"));
    await expect.poll(() => mounted.source()).toBe(source);
    },
  );
});
