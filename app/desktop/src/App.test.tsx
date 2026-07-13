import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const { mockUseVault } = vi.hoisted(() => ({ mockUseVault: vi.fn() }));

vi.mock("./lib/store", () => ({
  VaultProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
  useVault: mockUseVault,
}));
vi.mock("./welcome/Welcome", () => ({
  Welcome: () => <div>welcome-screen</div>,
}));
vi.mock("./workspace/Workspace", () => ({
  Workspace: () => <div>workspace-screen</div>,
}));
vi.mock("./updates/UpdateCoordinator", () => ({
  UpdateCoordinator: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import App from "./App";

afterEach(() => {
  mockUseVault.mockReset();
});

describe("App router", () => {
  it("renders the welcome screen when no vault is open", () => {
    mockUseVault.mockReturnValue({ status: "welcome" });
    render(<App />);
    expect(screen.getByText("welcome-screen")).toBeInTheDocument();
    expect(screen.queryByText("workspace-screen")).not.toBeInTheDocument();
  });

  it("renders the welcome screen during the loading state", () => {
    mockUseVault.mockReturnValue({ status: "loading" });
    render(<App />);
    expect(screen.getByText("welcome-screen")).toBeInTheDocument();
  });

  it("renders the workspace once a vault is open", () => {
    mockUseVault.mockReturnValue({ status: "open" });
    render(<App />);
    expect(screen.getByText("workspace-screen")).toBeInTheDocument();
  });
});
