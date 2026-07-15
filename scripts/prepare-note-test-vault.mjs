import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(repoRoot, "fixtures", "note-test-vault");
const destination = path.resolve(
  process.argv[2] ?? path.join(repoRoot, "target", "manual-note-test-vault"),
);

try {
  await lstat(destination);
  throw new Error(`Destination already exists: ${destination}`);
} catch (error) {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    // Expected: a fresh destination prevents stale files from influencing QA.
  } else {
    throw error;
  }
}

await mkdir(path.dirname(destination), { recursive: true });
await cp(source, destination, { recursive: true, errorOnExist: true });

const exact = path.join(destination, "07 Exact-byte and size");
await mkdir(exact, { recursive: true });

await writeFile(
  path.join(exact, "CR only.md"),
  "---\rtags: [qa/preservation, qa/cr-only]\r---\r# CR only\r\rEvery separator is CR.\r",
);
await writeFile(
  path.join(exact, "Mixed endings.md"),
  Buffer.from("---\r\ntags: [qa/preservation, qa/mixed]\n---\r# Mixed endings\r\n\rBody\n"),
);
await writeFile(
  path.join(exact, "Trailing whitespace and tabs.md"),
  Buffer.from("# Trailing whitespace and tabs\n\nspaces follow   \n\ttab-indented\t\n"),
);
await writeFile(
  path.join(exact, "No final newline.md"),
  "# No final newline\n\nThe final byte is not a line separator.",
);
await writeFile(
  path.join(exact, "Invalid UTF-8.md"),
  Buffer.concat([
    Buffer.from("# Invalid UTF-8\n\nBefore invalid bytes: "),
    Buffer.from([0xff, 0xfe]),
    Buffer.from(" after invalid bytes.\n"),
  ]),
);
await writeFile(
  path.join(exact, "Binary attachment.bin"),
  Buffer.from([0x00, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
);

const paragraphs = Array.from(
  { length: 5_000 },
  (_, index) => `Paragraph ${index + 1}: **bold** _emphasis_ [[Performance Target]] #qa/performance ${"x".repeat(32)}.`,
);
await writeFile(
  path.join(exact, "Large 5000 paragraphs.md"),
  `---\ntags: [qa/performance]\n---\n# Large 5000 paragraph note\n\n${paragraphs.join("\n\n")}\n`,
);

const maxEditableNoteBytes = 8 * 1024 * 1024;
const oversizedHeader = Buffer.from(
  "---\ntags: [qa/oversized]\n---\n# Oversized editable note\n\n",
);
await writeFile(
  path.join(exact, "Oversized editable note.md"),
  Buffer.concat([
    oversizedHeader,
    Buffer.alloc(maxEditableNoteBytes + 1 - oversizedHeader.length, 0x78),
  ]),
);

const preservationPaths = [
  "01 Frontmatter/BOM frontmatter.md",
  "01 Frontmatter/CRLF frontmatter.md",
  "06 Edge cases/Empty note.md",
  "06 Edge cases/Single blank line.md",
  "07 Exact-byte and size/CR only.md",
  "07 Exact-byte and size/Mixed endings.md",
  "07 Exact-byte and size/Trailing whitespace and tabs.md",
  "07 Exact-byte and size/No final newline.md",
  "07 Exact-byte and size/Invalid UTF-8.md",
  "07 Exact-byte and size/Binary attachment.bin",
  "07 Exact-byte and size/Large 5000 paragraphs.md",
  "07 Exact-byte and size/Oversized editable note.md",
];
const controlledEdits = new Map([
  ["01 Frontmatter/BOM frontmatter.md", ["This", "this"]],
  ["01 Frontmatter/CRLF frontmatter.md", ["Edit", "edit"]],
  ["07 Exact-byte and size/CR only.md", ["Every", "every"]],
  ["07 Exact-byte and size/Mixed endings.md", ["Body", "body"]],
  ["07 Exact-byte and size/Trailing whitespace and tabs.md", ["spaces", "Spaces"]],
  ["07 Exact-byte and size/No final newline.md", ["separator.", "separator!"]],
]);
const preservationBaseline = {};
for (const relativePath of preservationPaths) {
  const bytes = await readFile(path.join(destination, relativePath));
  preservationBaseline[relativePath] = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const controlledEdit = controlledEdits.get(relativePath);
  if (controlledEdit) {
    const [from, to] = controlledEdit.map((value) => Buffer.from(value));
    const index = bytes.indexOf(from);
    if (index < 0 || bytes.indexOf(from, index + from.length) >= 0 || from.length !== to.length) {
      throw new Error(`Controlled edit must replace one equal-length occurrence: ${relativePath}`);
    }
    const edited = Buffer.from(bytes);
    to.copy(edited, index);
    preservationBaseline[relativePath].controlledEdit = {
      bytes: edited.length,
      sha256: createHash("sha256").update(edited).digest("hex"),
    };
  }
}
await writeFile(
  path.join(destination, ".neuralnote-preservation-baseline.json"),
  `${JSON.stringify(preservationBaseline, null, 2)}\n`,
);

console.log(destination);
