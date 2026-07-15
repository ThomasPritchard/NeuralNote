import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return {
    ...actual,
    loadTemplateSettings: vi.fn(),
    saveTemplateSettings: vi.fn(),
    resetTemplateSettings: vi.fn(),
    pickTemplateFolder: vi.fn(),
  };
});

import * as api from "../lib/api";
import { ToastProvider } from "../notifications";
import { TemplatesSettingsPage } from "./TemplatesSettingsPage";

const STATUS = {
  settings: { folder: "Templates", dateFormat: "YYYY-MM-DD", timeFormat: "HH:mm" },
  source: "neuralNote" as const,
  folderExists: true,
};

function renderPage() {
  const user = userEvent.setup();
  render(
    <ToastProvider>
      <TemplatesSettingsPage />
    </ToastProvider>,
  );
  return user;
}

beforeEach(() => {
  vi.mocked(api.loadTemplateSettings).mockReset().mockResolvedValue(STATUS);
  vi.mocked(api.saveTemplateSettings).mockReset().mockResolvedValue(STATUS);
  vi.mocked(api.resetTemplateSettings).mockReset().mockResolvedValue(STATUS);
  vi.mocked(api.pickTemplateFolder).mockReset().mockResolvedValue(null);
});

describe("TemplatesSettingsPage", () => {
  it("loads the vault settings, previews formats, and flags a missing folder", async () => {
    vi.mocked(api.loadTemplateSettings).mockResolvedValue({
      ...STATUS,
      folderExists: false,
    });
    renderPage();

    expect(await screen.findByDisplayValue("Templates")).toBeInTheDocument();
    const folder = screen.getByLabelText("Template folder");
    const folderError = screen.getByText(/folder is missing/i);
    expect(folder).toHaveAttribute("aria-invalid", "true");
    expect(folder).toHaveAttribute("aria-describedby", folderError.id);
    expect(screen.getByRole("button", { name: "Choose template folder" })).toBeInTheDocument();
    expect(screen.getByLabelText("Date preview")).not.toHaveTextContent("YYYY");
    expect(screen.getByLabelText("Time preview")).toHaveTextContent(/\d{2}:\d{2}/);
  });

  it("rejects invalid custom formats before saving", async () => {
    const user = renderPage();
    const date = await screen.findByLabelText("Date format");
    fireEvent.change(date, { target: { value: "YYYY [at" } });
    const fieldError = screen.getByText(/unclosed literal/i);
    expect(date).toHaveAttribute("aria-describedby", fieldError.id);
    expect(fieldError).toHaveAttribute("aria-live", "polite");
    await user.click(screen.getByRole("button", { name: "Save template settings" }));

    expect(screen.getByRole("alert")).toHaveTextContent(/unclosed literal/i);
    expect(api.saveTemplateSettings).not.toHaveBeenCalled();
  });

  it("surfaces malformed settings with a reset action", async () => {
    vi.mocked(api.loadTemplateSettings).mockRejectedValue({
      kind: "io",
      message: "could not parse template settings",
    });
    const user = renderPage();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "could not parse template settings",
    );
    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));
    expect(api.resetTemplateSettings).toHaveBeenCalledOnce();
  });

  it("adopts a picked folder into the draft", async () => {
    vi.mocked(api.pickTemplateFolder).mockResolvedValue("Daily/Templates");
    const user = renderPage();
    await screen.findByDisplayValue("Templates");

    await user.click(screen.getByRole("button", { name: "Choose template folder" }));

    expect(await screen.findByDisplayValue("Daily/Templates")).toBeInTheDocument();
  });

  it("reports a folder-picker failure without changing the draft", async () => {
    vi.mocked(api.pickTemplateFolder).mockRejectedValue({
      kind: "io",
      message: "dialog unavailable",
    });
    const user = renderPage();
    await screen.findByDisplayValue("Templates");

    await user.click(screen.getByRole("button", { name: "Choose template folder" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template folder could not be selected. dialog unavailable",
    );
    expect(screen.getByLabelText("Template folder")).toHaveValue("Templates");
  });

  it("persists valid settings and confirms the save", async () => {
    const user = renderPage();
    await screen.findByLabelText("Date format");

    await user.click(screen.getByRole("button", { name: "Save template settings" }));

    expect(api.saveTemplateSettings).toHaveBeenCalledWith({
      folder: "Templates",
      dateFormat: "YYYY-MM-DD",
      timeFormat: "HH:mm",
    });
    expect(
      await screen.findByRole("listitem", { name: "Template settings saved notification" }),
    ).toBeInTheDocument();
  });

  it("surfaces a save failure as an error toast", async () => {
    vi.mocked(api.saveTemplateSettings).mockRejectedValue({
      kind: "io",
      message: "disk full",
    });
    const user = renderPage();
    await screen.findByLabelText("Date format");

    await user.click(screen.getByRole("button", { name: "Save template settings" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template settings could not be saved. disk full",
    );
  });

  it("resets to defaults from the main form action", async () => {
    const user = renderPage();
    await screen.findByLabelText("Date format");

    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(api.resetTemplateSettings).toHaveBeenCalledOnce();
    expect(
      await screen.findByRole("listitem", { name: "Template settings reset notification" }),
    ).toBeInTheDocument();
  });

  it("surfaces a reset failure as an error toast", async () => {
    vi.mocked(api.resetTemplateSettings).mockRejectedValue({
      kind: "io",
      message: "read-only vault",
    });
    const user = renderPage();
    await screen.findByLabelText("Date format");

    await user.click(screen.getByRole("button", { name: "Reset to defaults" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Template settings could not be reset. read-only vault",
    );
  });

  it("previews an edited time format live", async () => {
    renderPage();
    const time = await screen.findByLabelText("Time format");
    fireEvent.change(time, { target: { value: "HH:mm:ss" } });

    expect(time).toHaveValue("HH:mm:ss");
    expect(screen.getByLabelText("Time preview")).toHaveTextContent(
      /\d{2}:\d{2}:\d{2}/,
    );
  });
});
