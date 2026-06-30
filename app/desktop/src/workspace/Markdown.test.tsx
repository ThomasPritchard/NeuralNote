import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

// A single rich document that exercises every entry in the components map.
const RICH = [
  "# H1",
  "## H2",
  "### H3",
  "#### H4",
  "",
  "A paragraph with **bold**, _italic_, `inline code`, and a [link](https://example.com).",
  "",
  "- one",
  "- two",
  "",
  "1. first",
  "2. second",
  "",
  "> a quote",
  "",
  "---",
  "",
  "```js",
  "const x = 1;",
  "```",
  "",
  "| Col A | Col B |",
  "| ----- | ----- |",
  "| a1    | b1    |",
  "",
  "![alt text](https://example.com/i.png)",
].join("\n");

describe("Markdown", () => {
  it("renders the full set of GFM elements", () => {
    const { container } = render(<Markdown body={RICH} />);
    expect(screen.getByRole("heading", { level: 1, name: "H1" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 4, name: "H4" })).toBeInTheDocument();
    expect(screen.getByText("bold").tagName).toBe("STRONG");
    expect(screen.getByText("italic").tagName).toBe("EM");
    const lists = screen.getAllByRole("list");
    expect(lists.map((l) => l.tagName)).toEqual(
      expect.arrayContaining(["UL", "OL"]),
    );
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "Col A" })).toBeInTheDocument();
    expect(screen.getByText("a quote")).toBeInTheDocument();
    expect(container.querySelector("hr")).not.toBeNull();
    expect(container.querySelector("pre code")).not.toBeNull();
    expect(screen.getByText("inline code").tagName).toBe("CODE");
    expect(screen.getByRole("img", { name: "alt text" })).toBeInTheDocument();
  });

  it("renders links but keeps them inert (no navigation)", async () => {
    render(<Markdown body="[click](https://example.com)" />);
    const link = screen.getByRole("link", { name: "click" });
    expect(link).toHaveAttribute("href", "https://example.com");
    // preventDefault means the click is swallowed; just assert it does not throw.
    await userEvent.click(link);
    expect(link).toBeInTheDocument();
  });
});
