import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, server, userEvent } from "vitest/browser";

import "../../styles.css";
import { NeuralGalaxy } from "./NeuralGalaxy";

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

describe.skipIf(server.browser !== "chromium")("NeuralGalaxy — Chromium WebGL smoke", () => {
  it("keeps the renderer healthy through dimension, search, and note-opening interactions", async () => {
    await document.fonts.ready;
    host = document.createElement("main");
    host.setAttribute("aria-label", "Galaxy browser fixture");
    host.style.width = "960px";
    host.style.height = "640px";
    document.body.appendChild(host);
    const onOpenNote = vi.fn();
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <NeuralGalaxy
          data={{
            nodes: [
              { id: "Alpha.md", title: "Alpha", cluster: "notes", val: 3, color: "#7d6fe0" },
              { id: "Beta.md", title: "Beta", cluster: "notes", val: 2, color: "#7d6fe0" },
            ],
            links: [{ source: "Alpha.md", target: "Beta.md" }],
          }}
          clusters={{ notes: { label: "Notes", color: "#7d6fe0", drillable: false } }}
          stats={{ notes: 2, links: 1, crossFolderLinks: 0, outsideLinks: 0 }}
          width={960}
          height={640}
          onOpenNote={onOpenNote}
        />,
      );
    });

    await expect.poll(() => host?.querySelector<HTMLCanvasElement>("canvas")).not.toBeNull();
    const canvas = host.querySelector<HTMLCanvasElement>("canvas")!;
    const context = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    expect(context).not.toBeNull();
    expect(context!.isContextLost()).toBe(false);

    const view3d = page.getByRole("button", { name: "3d" });
    const view2d = page.getByRole("button", { name: "2d" });
    await expect.element(view3d).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(view2d);
    await expect.element(view2d).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(view3d);
    await expect.element(view3d).toHaveAttribute("aria-pressed", "true");

    const search = page.getByRole("searchbox", { name: "Search the galaxy" });
    await userEvent.fill(search, "Beta");
    await userEvent.click(page.getByRole("button", { name: "Beta" }));
    await expect.element(page.getByRole("heading", { name: "Beta" })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Open in reader" }));

    expect(onOpenNote).toHaveBeenCalledWith("Beta.md");
    expect(context!.isContextLost()).toBe(false);
  }, 30_000);
});
