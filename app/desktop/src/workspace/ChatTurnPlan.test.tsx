import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { JournalPlanStep } from "./activityJournal";
import { ChatTurnPlan } from "./ChatTurnPlan";

const plan: JournalPlanStep[] = [
  { id: "pending", label: "Collect the source", status: "pending" },
  { id: "running", label: "Draft the note", status: "running" },
  { id: "done", label: "Check the citations", status: "done" },
  { id: "skipped", label: "Remove duplicates", status: "skipped" },
  { id: "failed", label: "Publish the result", status: "failed" },
];

describe("ChatTurnPlan", () => {
  it("shows the complete active plan in declaration order with explicit statuses", () => {
    render(<ChatTurnPlan steps={plan} active earlyEnd={null} />);

    const region = screen.getByRole("region", { name: "Task plan" });
    const items = within(region).getAllByRole("listitem");
    expect(items).toHaveLength(5);
    expect(items.map((item) => item.textContent)).toEqual([
      "PendingCollect the source",
      "In progressDraft the note",
      "DoneCheck the citations",
      "SkippedRemove duplicates",
      "FailedPublish the result",
    ]);
    expect(region).toHaveClass("sticky");
    expect(within(region).getByRole("list", { name: "Plan tasks" })).toHaveClass(
      "overflow-y-auto",
    );
  });

  it("renders nothing when no plan was declared", () => {
    const { container } = render(
      <ChatTurnPlan steps={[]} active earlyEnd={null} />,
    );

    expect(container).toBeEmptyDOMElement();
  });

  it("settles into one collapsed disclosure and lazy-mounts the full plan", async () => {
    const user = userEvent.setup();
    render(<ChatTurnPlan steps={plan} active={false} earlyEnd={null} />);

    const summary = screen.getByText("Plan · 1 of 5 done", {
      selector: "summary",
    });
    expect(screen.queryByText("Collect the source")).not.toBeInTheDocument();
    await user.click(summary);
    expect(screen.getByText("Collect the source")).toBeVisible();
    expect(screen.getByText("Publish the result")).toBeVisible();
  });

  it("keeps the last authoritative statuses and explains an early end", () => {
    render(
      <ChatTurnPlan
        steps={plan}
        active={false}
        earlyEnd="the remaining work could not run"
      />,
    );

    expect(screen.getByText("Run ended early: the remaining work could not run")).toBeVisible();
    expect(screen.getByText("Plan · 1 of 5 done", { selector: "summary" })).toBeVisible();
  });
});
