import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NoteDoc } from "../lib/types";

// The reader now mounts the backlinks panel for markdown notes; keep its
// fetch pending by default so these rendering tests stay focused (the panel's
// own behaviour is covered in BacklinksPanel.test.tsx).
vi.mock("../lib/api", async (importActual) => {
  const actual = await importActual<typeof import("../lib/api")>();
  return { ...actual, readBacklinks: vi.fn() };
});

import * as api from "../lib/api";
import { Reader, withoutRepeatedLeadingTitle } from "./Reader";

const mockApi = vi.mocked(api);

beforeEach(() => {
  mockApi.readBacklinks.mockReset();
  mockApi.readBacklinks.mockReturnValue(new Promise(() => {}));
});

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
  it("scans a long non-heading prefix without regex backtracking", () => {
    const body = `${" ".repeat(100_000)}not a heading`;

    expect(withoutRepeatedLeadingTitle(body, "My Note")).toBe(body);
  });

  it("does not consume a title-matching paragraph after an empty H1", () => {
    const body = "#\nMy Note\nsecret";

    expect(withoutRepeatedLeadingTitle(body, "My Note")).toBe(body);
  });

  it("renders markdown for a .md note with a title and no file-type pill", () => {
    render(<Reader note={doc()} />);
    expect(screen.getByText("My Note")).toBeInTheDocument();
    expect(screen.queryByText("Markdown")).not.toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 1, name: "Heading" }),
    ).toBeInTheDocument();
  });

  it("does not repeat a leading body H1 that supplies the document title", () => {
    render(
      <Reader
        note={doc({
          title: "My Note",
          body: "#   My Note   \n\nFirst paragraph.",
        })}
      />,
    );

    expect(screen.getAllByRole("heading", { level: 1, name: "My Note" })).toHaveLength(1);
    expect(screen.getByText("First paragraph.")).toBeInTheDocument();
  });

  it("keeps a leading body H1 when frontmatter provides a different title", () => {
    render(
      <Reader
        note={doc({
          title: "Frontmatter title",
          body: "# Body heading\n\nFirst paragraph.",
        })}
      />,
    );

    expect(
      screen.getByRole("heading", { level: 1, name: "Frontmatter title" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Body heading" })).toBeInTheDocument();
  });

  it("renders extensionless files (README) through markdown", () => {
    render(
      <Reader
        note={doc({ path: "/v/README", relPath: "README", body: "plain readme" })}
      />,
    );
    expect(screen.getByText("plain readme")).toBeInTheDocument();
    expect(screen.queryByText("File")).not.toBeInTheDocument();
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
    expect(screen.queryByText(".JSON")).not.toBeInTheDocument();
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
    render(<Reader note={doc({ lossyText: true, body: "caf\uFFFD content" })} />);
    expect(screen.getByText(/caf\uFFFD content/)).toBeInTheDocument();
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

  it("shows an explicit fallback when an object has no JSON representation", () => {
    render(
      <Reader
        note={doc({
          frontmatter: {
            opaque: { toJSON: () => undefined },
          },
        })}
      />,
    );

    expect(screen.getByText("opaque")).toBeInTheDocument();
    expect(screen.getByText("—")).toBeInTheDocument();
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

describe("Reader — backlinks panel", () => {
  it("mounts the backlinks panel for markdown notes, fetching by note path", async () => {
    mockApi.readBacklinks.mockResolvedValue({
      linked: [],
      unlinked: [],
      skippedFiles: 0,
    });
    render(<Reader note={doc()} />);
    expect(screen.getByRole("region", { name: "Backlinks" })).toBeInTheDocument();
    expect(await screen.findByText(/No backlinks yet/)).toBeInTheDocument();
    expect(mockApi.readBacklinks).toHaveBeenCalledExactlyOnceWith("/v/n.md");
  });

  it("skips the panel for non-markdown and binary files", () => {
    const { rerender } = render(
      <Reader note={doc({ path: "/v/data.json", body: "", raw: "{}" })} />,
    );
    expect(screen.queryByRole("region", { name: "Backlinks" })).not.toBeInTheDocument();

    rerender(<Reader note={doc({ path: "/v/scan.pdf", binary: true, body: "" })} />);
    expect(screen.queryByRole("region", { name: "Backlinks" })).not.toBeInTheDocument();
    expect(mockApi.readBacklinks).not.toHaveBeenCalled();
  });

  it("threads wikilink clicks in the body through onOpenLink", async () => {
    mockApi.readBacklinks.mockResolvedValue({
      linked: [],
      unlinked: [],
      skippedFiles: 0,
    });
    const onOpenLink = vi.fn();
    render(
      <Reader
        note={doc({ body: "go to [[Target]]" })}
        noteIndex={[{ relPath: "Notes/Target.md", stem: "target" }]}
        onOpenLink={onOpenLink}
      />,
    );
    await userEvent.click(screen.getByRole("link", { name: "Target" }));
    expect(onOpenLink).toHaveBeenCalledExactlyOnceWith("Notes/Target.md");
  });
});
