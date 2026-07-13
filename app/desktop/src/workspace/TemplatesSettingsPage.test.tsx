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
});
