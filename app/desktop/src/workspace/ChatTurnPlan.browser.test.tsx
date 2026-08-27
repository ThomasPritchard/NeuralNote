import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { ChatTurnPlan } from "./ChatTurnPlan";
import type { JournalPlanStep } from "./activityJournal";
import "../styles.css";

let host: HTMLElement | null = null;
let root: Root | null = null;

const steps: JournalPlanStep[] = Array.from({ length: 24 }, (_, index) => ({
  id: `step-${index + 1}`,
  label: `Complete accountable task ${index + 1}`,
  status: index === 0 ? "running" : "pending",
}));

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
  host = null;
});

async function mountPlan(active = true): Promise<HTMLElement> {
  host = document.createElement("div");
  host.style.width = "360px";
  document.body.append(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(<ChatTurnPlan steps={steps} active={active} earlyEnd={null} />);
  });
  if (!active) {
    await act(async () => {
      await userEvent.click(page.getByText("Plan · 0 of 24 done"));
    });
  }
  const plan = page.getByRole("list", { name: "Plan tasks" }).query();
  if (!(plan instanceof HTMLElement)) {
    throw new Error("plan scrollport did not render");
  }
  return plan;
}

function nativeScrollEnd(element: HTMLElement): Promise<void> {
  return new Promise((resolve) => {
    let timer = 0;
    const done = () => {
      element.removeEventListener("scrollend", done);
      clearTimeout(timer);
      resolve();
    };
    element.addEventListener("scrollend", done);
    timer = window.setTimeout(done, 1_000);
  });
}

describe("ChatTurnPlan in a real browser", () => {
  it("keeps every task in a bounded keyboard-scrollable plan", async () => {
    const plan = await mountPlan();

    expect(plan.scrollHeight).toBeGreaterThan(plan.clientHeight);
    expect(page.getByText("Complete accountable task 24").query()).not.toBeNull();

    plan.focus();
    expect(document.activeElement).toBe(plan);
    await act(async () => {
      const ended = nativeScrollEnd(plan);
      await userEvent.keyboard("{PageDown}{PageDown}");
      await ended;
    });
    expect(plan.scrollTop).toBeGreaterThan(0);
  });

  it("keeps the expanded settled plan keyboard-scrollable", async () => {
    const plan = await mountPlan(false);

    expect(plan.scrollHeight).toBeGreaterThan(plan.clientHeight);
    plan.focus();
    expect(document.activeElement).toBe(plan);
    await act(async () => {
      const ended = nativeScrollEnd(plan);
      await userEvent.keyboard("{PageDown}{PageDown}");
      await ended;
    });
    expect(plan.scrollTop).toBeGreaterThan(0);
  });
});
