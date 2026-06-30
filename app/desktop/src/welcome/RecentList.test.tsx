import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { RecentVault } from "../lib/types";
import { RecentList } from "./RecentList";

const recents: RecentVault[] = [
  { name: "Brain", path: "/home/Brain", lastOpened: 2 },
  { name: "Work", path: "/home/Work", lastOpened: 1 },
];

describe("RecentList", () => {
  it("shows an empty state with no recents", () => {
    render(<RecentList recents={[]} onOpen={vi.fn()} />);
    expect(screen.getByText(/No recent vaults yet/i)).toBeInTheDocument();
  });

  it("lists recents and opens one by path", async () => {
    const onOpen = vi.fn();
    render(<RecentList recents={recents} onOpen={onOpen} />);
    expect(screen.getByText("Brain")).toBeInTheDocument();
    expect(screen.getByText("/home/Work")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Open Brain" }));
    expect(onOpen).toHaveBeenCalledWith("/home/Brain");
  });
});
