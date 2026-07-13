import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToastProvider, useToast } from "./ToastProvider";

function BasicHarness() {
  const toast = useToast();

  return (
    <>
      <button onClick={() => toast.success("Vault saved")}>Success</button>
      <button onClick={() => toast.info("Update available")}>Info</button>
      <button onClick={() => toast.warning("Template missing")}>Warning</button>
      <button onClick={() => toast.error("Write failed")}>Error</button>
      <button
        onClick={() =>
          toast.info("Already checking", { dedupKey: "update-check" })
        }
      >
        Deduplicated info
      </button>
    </>
  );
}

function renderHarness() {
  return render(
    <ToastProvider>
      <BasicHarness />
    </ToastProvider>,
  );
}

describe("ToastProvider", () => {
  it("exposes success, info, warning, and error notifications", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Success" }));
    await user.click(screen.getByRole("button", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Warning" }));

    expect(
      within(screen.getByLabelText("Vault saved notification")).getByText("Vault saved"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Update available notification")).getByText("Update available"),
    ).toBeInTheDocument();
    expect(
      within(screen.getByLabelText("Template missing notification")).getByText("Template missing"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Vault saved notification")).toHaveClass(
      "border-primary/40",
    );
    expect(screen.getByLabelText("Template missing notification")).toHaveClass(
      "border-warning/40",
    );

    await user.click(
      within(screen.getByLabelText("Vault saved notification")).getByRole(
        "button",
        { name: "Dismiss notification" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Error" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Write failed");
    expect(screen.getByRole("alert")).toHaveClass("border-destructive/40");
  });

  it("keeps only three notifications visible and promotes queued work", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Success" }));
    await user.click(screen.getByRole("button", { name: "Info" }));
    await user.click(screen.getByRole("button", { name: "Warning" }));
    await user.click(screen.getByRole("button", { name: "Error" }));

    expect(screen.getAllByTestId("toast")).toHaveLength(3);
    expect(screen.queryByText("Write failed")).not.toBeInTheDocument();

    await user.click(
      within(screen.getByLabelText("Vault saved notification")).getByRole(
        "button",
        { name: "Dismiss notification" },
      ),
    );

    expect(screen.getAllByTestId("toast")).toHaveLength(3);
    expect(screen.getByRole("alert")).toHaveTextContent("Write failed");
  });

  it("deduplicates repeated keys across the provider", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(
      screen.getByRole("button", { name: "Deduplicated info" }),
    );
    await user.click(
      screen.getByRole("button", { name: "Deduplicated info" }),
    );

    expect(
      screen.getAllByLabelText("Already checking notification"),
    ).toHaveLength(1);
  });

  it("announces non-errors politely without moving focus", async () => {
    const user = userEvent.setup();
    renderHarness();
    const trigger = screen.getByRole("button", { name: "Success" });

    await user.click(trigger);

    expect(screen.getByRole("status")).toHaveAttribute("aria-live", "polite");
    expect(screen.getByRole("status")).toHaveTextContent("Vault saved");
    expect(trigger).toHaveFocus();
  });

  it("announces only newly visible notifications instead of repeating the stack", async () => {
    const user = userEvent.setup();
    renderHarness();

    await user.click(screen.getByRole("button", { name: "Success" }));
    expect(screen.getByRole("status")).toHaveTextContent("Vault saved");

    await user.click(screen.getByRole("button", { name: "Info" }));
    expect(screen.getByRole("status")).toHaveTextContent("Update available");
    expect(screen.getByRole("status")).not.toHaveTextContent("Vault saved");
  });

  it("runs an optional action from a native keyboard-operable button", async () => {
    const action = vi.fn();

    function ActionHarness() {
      const toast = useToast();
      return (
        <button
          onClick={() =>
            toast.warning("Preferences recovered", {
              action: { label: "Review", onClick: action },
            })
          }
        >
          Notify
        </button>
      );
    }

    const user = userEvent.setup();
    render(
      <ToastProvider>
        <ActionHarness />
      </ToastProvider>,
    );
    await user.click(screen.getByRole("button", { name: "Notify" }));

    const actionButton = screen.getByRole("button", { name: "Review" });
    actionButton.focus();
    await user.keyboard(" ");

    expect(action).toHaveBeenCalledOnce();
    expect(
      screen.getByLabelText("Preferences recovered notification"),
    ).toBeInTheDocument();
  });

  it("supports dismissal with the keyboard", async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole("button", { name: "Success" }));

    const dismissButton = within(
      screen.getByLabelText("Vault saved notification"),
    ).getByRole("button", { name: "Dismiss notification" });
    dismissButton.focus();
    await user.keyboard("{Enter}");

    expect(screen.queryByLabelText("Vault saved notification")).not.toBeInTheDocument();
  });
});
