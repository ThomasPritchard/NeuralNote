import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { NoteDoc } from "../lib/types";
import { Reader } from "./Reader";

function doc(overrides: Partial<NoteDoc> = {}): NoteDoc {
  return {
    path: "/v/n.md",
    relPath: "n.md",
    title: "My Note",
    frontmatter: null,
    frontmatterRaw: null,
    frontmatterError: null,
    body: "# Heading\n\nbody text",
    raw: "# Heading\n\nbody text",
    contentHash: "h",
    binary: false,
    lossyText: false,
    ...overrides,
  };
}

describe("Reader — body rendering", () => {
  it("renders markdown for a .md note with a type chip and title", () => {
    render(<Reader note={doc()} />);
    expect(screen.getByText("My Note")).toBeInTheDocument();
    expect(screen.getByText("Markdown")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Heading" }),
    ).toBeInTheDocument();
  });

  it("renders extensionless files (README) through markdown", () => {
    render(
      <Reader
        note={doc({ path: "/v/README", relPath: "README", body: "plain readme" })}
      />,
    );
    expect(screen.getByText("plain readme")).toBeInTheDocument();
    expect(screen.getByText("File")).toBeInTheDocument();
  });

  it("shows the binary notice with no raw dump even when raw is present", () => {
    const { container } = render(
      <Reader
        note={doc({
          path: "/v/scan.pdf",
          binary: true,
          body: "",
          raw: "%PDF-should-not-leak",
        })}
      />,
    );
    expect(screen.getByText(/Preview not available/i)).toBeInTheDocument();
    expect(screen.queryByText(/should-not-leak/)).not.toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("falls back to a raw text dump for text-like non-markdown files", () => {
    const { container } = render(
      <Reader
        note={doc({
          path: "/v/data.json",
          body: "",
          raw: '{"a":1}',
        })}
      />,
    );
    expect(screen.getByText(/Preview not available for \.json/i)).toBeInTheDocument();
    expect(container.querySelector("pre")?.textContent).toBe('{"a":1}');
    expect(screen.getByText(".JSON")).toBeInTheDocument();
  });

  it("shows no raw dump for non-text, non-markdown files", () => {
    const { container } = render(
      <Reader note={doc({ path: "/v/pic.png", body: "", raw: "binary-bytes" })} />,
    );
    expect(screen.getByText(/Preview not available for \.png/i)).toBeInTheDocument();
    expect(container.querySelector("pre")).toBeNull();
  });

  it("still renders content for a lossily-decoded (non-UTF-8) note", () => {
    // The lossy notice itself lives at pane level (NotePane) so it shows in edit
    // mode too; the reader's job is just to still show the content, never hide it.
    render(<Reader note={doc({ lossyText: true, body: "caf� content" })} />);
    expect(screen.getByText(/caf� content/)).toBeInTheDocument();
  });

  it("shows the offending raw block when frontmatter fails to parse", () => {
    render(
      <Reader
        note={doc({
          frontmatterError: "invalid YAML frontmatter: ...",
          frontmatterRaw: "title: [unclosed",
        })}
      />,
    );
    expect(screen.getByText(/couldn't be parsed/i)).toBeInTheDocument();
    // The user can see WHAT failed, so they can fix it.
    expect(screen.getByText("title: [unclosed")).toBeInTheDocument();
  });
});

describe("Reader — frontmatter", () => {
  it("renders a properties table covering arrays, objects, scalars and nulls", () => {
    render(
      <Reader
        note={doc({
          frontmatter: {
            tags: ["alpha", { nested: 1 }],
            meta: { k: "v" },
            empty: null,
            title: "From FM",
          },
        })}
      />,
    );
    expect(screen.getByText("tags")).toBeInTheDocument();
    expect(screen.getByText("alpha")).toBeInTheDocument();
    expect(screen.getByText('{"nested":1}')).toBeInTheDocument(); // object item in array
    expect(screen.getByText('{"k":"v"}')).toBeInTheDocument(); // object value
    expect(screen.getByText("—")).toBeInTheDocument(); // null scalar
    expect(screen.getByText("From FM")).toBeInTheDocument(); // string scalar
  });

  it("hides the properties table when frontmatter is empty", () => {
    render(<Reader note={doc({ frontmatter: {} })} />);
    expect(screen.queryByRole("term")).not.toBeInTheDocument();
  });

  it("shows the parse-error banner but still renders the body", () => {
    render(
      <Reader
        note={doc({ frontmatterError: "bad indentation", body: "still here" })}
      />,
    );
    expect(
      screen.getByText(/Frontmatter couldn't be parsed: bad indentation/i),
    ).toBeInTheDocument();
    expect(screen.getByText("still here")).toBeInTheDocument();
  });
});
