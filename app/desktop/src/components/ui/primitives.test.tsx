import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "lucide-react";
import { describe, expect, it, vi } from "vitest";
import { Button } from "./button";
import { IconButton } from "./icon-button";
import { Separator } from "./separator";
import { Skeleton } from "./skeleton";
import { Switch } from "./switch";
import { Textarea } from "./textarea";

describe("NeuralNote UI primitives", () => {
  it("exposes a labelled loading button as busy and disabled", () => {
    render(<Button loading>Save note</Button>);
    const button = screen.getByRole("button", { name: "Save note" });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
  });

  it("uses the high-contrast foreground token for destructive actions", () => {
    render(<Button tone="danger">Delete note</Button>);
    expect(screen.getByRole("button", { name: "Delete note" })).toHaveClass(
      "text-destructive-foreground",
    );
  });

  it("gives icon-only controls an accessible name and visible tooltip", async () => {
    const user = userEvent.setup();
    render(
      <IconButton label="Settings" tooltip="Open settings">
        <Settings aria-hidden />
      </IconButton>,
    );
    const button = screen.getByRole("button", { name: "Settings" });
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Open settings");
  });

  it("toggles a labelled switch with the keyboard", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        aria-label="Local AI"
        checked={false}
        onCheckedChange={onCheckedChange}
      />,
    );
    const control = screen.getByRole("switch", { name: "Local AI" });
    control.focus();
    await userEvent.keyboard(" ");
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it("hides the skeleton placeholder from assistive tech while keeping test overrides", () => {
    render(<Skeleton data-testid="chip" className="h-4 w-24" />);
    const placeholder = screen.getByTestId("chip");
    expect(placeholder).toHaveAttribute("aria-hidden");
    expect(placeholder).toHaveClass("animate-pulse", "h-4", "w-24");
  });

  it("renders a decorative separator whose orientation drives its axis", () => {
    const { rerender } = render(<Separator />);
    const separator = screen.getByRole("none");
    expect(separator).toHaveClass("h-px", "w-full");

    rerender(<Separator orientation="vertical" decorative={false} aria-label="Section divider" />);
    const divider = screen.getByRole("separator", { name: "Section divider" });
    expect(divider).toHaveClass("h-full", "w-px");
  });

  it("forwards a ref and native props to the underlying textarea", () => {
    const ref = vi.fn();
    render(<Textarea ref={ref} aria-label="Distilled summary" placeholder="Summary" rows={4} />);
    const textarea = screen.getByRole("textbox", { name: "Distilled summary" });
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea).toHaveAttribute("placeholder", "Summary");
    expect(ref).toHaveBeenCalledWith(textarea);
  });
});
