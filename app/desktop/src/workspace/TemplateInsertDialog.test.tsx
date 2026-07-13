import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { TreeNode } from "../lib/types";
import { TemplateInsertDialog } from "./TemplateInsertDialog";

const templates = [
  { relPath: "Templates/Daily.md", name: "Daily" },
  { relPath: "Templates/Meeting.md", name: "Meeting" },
];

const tree: TreeNode[] = [
  {
    kind: "folder",
    name: "Projects",
    path: "/v/Projects",
    relPath: "Projects",
    ext: null,
    children: [],
  },
];

function setup(availableTemplates = templates) {
  const onCreate = vi.fn();
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <TemplateInsertDialog
      open
      templates={availableTemplates}
      vaultPath="/v"
      tree={tree}
      onCreate={onCreate}
      onClose={onClose}
    />,
  );
  return { onCreate, onClose, user };
}

describe("TemplateInsertDialog", () => {
  it("filters templates and selects the first result from the keyboard", async () => {
    const { user } = setup();
    const search = screen.getByRole("searchbox", { name: "Search templates" });
    expect(search).toHaveFocus();

    await user.type(search, "daily");
    expect(screen.getByRole("button", { name: /Daily, Templates\/Daily\.md/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Meeting/ })).not.toBeInTheDocument();

    await user.keyboard("{ArrowDown}{Enter}");
    expect(screen.getByRole("textbox", { name: "Note name" })).toBeInTheDocument();
  });

  it("creates in the vault root by default or a selected destination folder", async () => {
    const { user, onCreate } = setup();
    await user.click(screen.getByRole("button", { name: /Meeting, Templates\/Meeting\.md/ }));

    const folder = screen.getByRole("combobox", { name: "Destination folder" });
    expect(folder).toHaveValue("/v");
    await user.selectOptions(folder, "/v/Projects");
    await user.type(screen.getByRole("textbox", { name: "Note name" }), "Kickoff");
    await user.click(screen.getByRole("button", { name: "Create note" }));

    expect(onCreate).toHaveBeenCalledExactlyOnceWith(
      "Templates/Meeting.md",
      "Kickoff",
      "/v/Projects",
    );
  });

  it("closes on Escape without creating a note", async () => {
    const { user, onClose, onCreate } = setup();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledOnce();
    expect(onCreate).not.toHaveBeenCalled();
  });

  it("distinguishes duplicate template names by their vault-relative path", () => {
    setup([
      { relPath: "Templates/Daily.md", name: "Daily" },
      { relPath: "Work/Daily.md", name: "Daily" },
    ]);

    expect(
      screen.getByRole("button", { name: "Daily, Templates/Daily.md" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Daily, Work/Daily.md" }),
    ).toBeInTheDocument();
  });

  it("surfaces an empty search result and returns focus to search after Back", async () => {
    const { user } = setup();
    const search = screen.getByRole("searchbox", { name: "Search templates" });

    await user.type(search, "does not exist");
    expect(screen.getByRole("status")).toHaveTextContent(
      'No templates match "does not exist".',
    );

    await user.clear(search);
    await user.click(
      screen.getByRole("button", { name: /Daily, Templates\/Daily\.md/ }),
    );
    await user.click(screen.getByRole("button", { name: "Back" }));

    expect(
      screen.getByRole("searchbox", { name: "Search templates" }),
    ).toHaveFocus();
  });
});
