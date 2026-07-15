// SettingsModal: the presentational shell — open/close (Esc, backdrop, X),
// section switching, initial-section override, focus handling (a native
// <dialog> opened via showModal; the jsdom polyfill lives in test/setup.ts).
// AiSettingsPage and SkillsSettingsPage are stubbed out: their data loading
// has its own suites, and the shell's job is only to mount the right section.

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("./AiSettingsPage", () => ({
  AiSettingsPage: () => <div data-testid="ai-settings-page" />,
}));

vi.mock("./SkillsSettingsPage", () => ({
  SkillsSettingsPage: () => <div data-testid="skills-settings-page" />,
}));

vi.mock("./GeneralSettingsPage", () => ({
  GeneralSettingsPage: () => <div data-testid="general-settings-page" />,
}));

vi.mock("./AppearanceSettingsPage", () => ({
  AppearanceSettingsPage: () => <div data-testid="appearance-settings-page" />,
}));

vi.mock("./TemplatesSettingsPage", () => ({
  TemplatesSettingsPage: () => <div data-testid="templates-settings-page" />,
}));

vi.mock("../whats-new/ReleaseNotesArticle", () => ({
  ReleaseNotesArticle: () => <article data-testid="release-notes-page" />,
}));

import { SettingsModal } from "./SettingsModal";

function setup(props: Partial<Parameters<typeof SettingsModal>[0]> = {}) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  const view = render(<SettingsModal open onClose={onClose} {...props} />);
  return { onClose, user, view };
}

describe("SettingsModal — shell", () => {
  it("renders nothing while closed", () => {
    setup({ open: false });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("opens as a labelled modal dialog, defaulting to What's new", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByTestId("release-notes-page")).toBeInTheDocument();
    // The section nav lists every shipped section.
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    expect(nav).toContainElement(screen.getByRole("button", { name: "What's new" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "General" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "Appearance" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "Templates" }));
    expect(nav).toContainElement(
      screen.getByRole("button", { name: "AI" }),
    );
    expect(nav).toContainElement(screen.getByRole("button", { name: "Skills" }));
    expect(nav).toContainElement(screen.getByRole("button", { name: "About" }));
  });

  it("stacks its navigation and reduces content padding at narrow widths", () => {
    setup();
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const nav = screen.getByRole("navigation", { name: "Settings sections" });
    const releaseNotes = screen.getByTestId("release-notes-page");
    const content = releaseNotes.parentElement;

    expect(dialog).toHaveClass("flex-col", "sm:flex-row");
    expect(nav).toHaveClass("hidden", "sm:flex", "sm:w-48");
    const mobileSelector = screen.getByRole("combobox", { name: "Settings section" });
    expect(mobileSelector.parentElement).toHaveClass("sm:hidden");
    expect(content).toHaveClass("px-4", "sm:px-6");
  });

  it("switches sections from the compact mobile selector", async () => {
    const { user } = setup();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Settings section" }),
      "general",
    );

    expect(screen.getByTestId("general-settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("release-notes-page")).not.toBeInTheDocument();
  });

  it("switches sections from the left nav", async () => {
    const { user } = setup();

    await user.click(screen.getByRole("button", { name: "General" }));
    expect(screen.getByTestId("general-settings-page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.getByTestId("appearance-settings-page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Templates" }));
    expect(screen.getByTestId("templates-settings-page")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "About" }));
    expect(screen.getByText("NeuralNote")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-settings-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Skills" }));
    expect(screen.getByTestId("skills-settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-settings-page")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "AI" }));
    expect(screen.getByTestId("ai-settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("skills-settings-page")).not.toBeInTheDocument();
  });

  it("ships a real General section without placeholder copy", () => {
    setup({ initialSection: "general" });
    expect(screen.getByRole("button", { name: "General" })).toBeInTheDocument();
    expect(screen.getByTestId("general-settings-page")).toBeInTheDocument();
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it("honours an explicit initial section", () => {
    setup({ initialSection: "about" });
    expect(screen.getByText("NeuralNote")).toBeInTheDocument();
    expect(screen.queryByTestId("ai-settings-page")).not.toBeInTheDocument();
  });

  it("honours an explicit General route without showing release notes", () => {
    setup({ initialSection: "general" });
    expect(screen.getByTestId("general-settings-page")).toBeInTheDocument();
    expect(screen.queryByTestId("release-notes-page")).not.toBeInTheDocument();
  });

  it("describes only shipped capabilities in the About copy (PA-004)", () => {
    setup({ initialSection: "about" });
    // v1 ships cited recall; AI filing/linking/distillation does not. The
    // self-description must not claim unbuilt features.
    expect(
      screen.getByText(/the AI answers questions across them/i),
    ).toBeInTheDocument();
    expect(screen.queryByText(/files, links/i)).not.toBeInTheDocument();
  });

  it("closes on Escape", async () => {
    const { onClose, user } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes from the backdrop and from the X button", async () => {
    const { onClose, user } = setup();
    await user.click(screen.getByRole("button", { name: "Dismiss settings" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole("button", { name: "Close settings" }));
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe("SettingsModal — focus", () => {
  it("takes focus on open and returns it to the opener on close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(
      <>
        <button type="button">opener</button>
        <SettingsModal open={false} onClose={onClose} />
      </>,
    );
    const opener = screen.getByRole("button", { name: "opener" });
    await user.click(opener);
    await vi.waitFor(() => expect(opener).toHaveFocus());

    rerender(
      <>
        <button type="button">opener</button>
        <SettingsModal open onClose={onClose} />
      </>,
    );
    expect(screen.getByRole("dialog")).toHaveFocus();

    rerender(
      <>
        <button type="button">opener</button>
        <SettingsModal open={false} onClose={onClose} />
      </>,
    );
    await vi.waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps keyboard focus inside the modal", async () => {
    const { user } = setup();
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveFocus();
    await user.tab({ shift: true });
    expect(dialog).toContainElement(document.activeElement as HTMLElement);
  });
});
