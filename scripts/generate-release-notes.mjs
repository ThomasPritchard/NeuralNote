// Generates app/desktop/src/whats-new/releaseNotes.ts from docs/releases/vX.Y.Z.md.
//
// Why this exists. Two artifacts describe the same release: the immutable GitHub
// release body (the .md, copied verbatim by release-alpha.yml) and the in-app
// "What's new" modal (the .ts). scripts/check-release-workflow.mjs asserts their
// ordered bullet lists are deepEqual, so a hand-maintained pair can drift right up
// until the gate catches it. Deriving one from the other removes the drift instead
// of detecting it: there is only ever one place to edit, the .md.
//
// The version is read from app/desktop/package.json, so this runs after the version
// bump, not before. See docs/releases/RUNBOOK.md §2.
//
//   node scripts/generate-release-notes.mjs           # write
//   node scripts/generate-release-notes.mjs --check   # verify, write nothing (exit 1 on drift)

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const repoFile = (relativePath) => fileURLToPath(new URL(`../${relativePath}`, import.meta.url));

const OUTPUT_PATH = "app/desktop/src/whats-new/releaseNotes.ts";

const { version } = JSON.parse(await readFile(repoFile("app/desktop/package.json"), "utf8"));
const changelogPath = `docs/releases/v${version}.md`;
const markdown = await readFile(repoFile(changelogPath), "utf8");

/**
 * The .md is the single source. Its H1 is the release title, the first prose
 * paragraph is the introduction, each `## ` opens a group, and each `- ` is an item.
 * Backticks are stripped because the contract strips them before comparing.
 */
function parse(source) {
  const groups = [];
  let introduction = "";

  for (const line of source.split("\n")) {
    if (line.startsWith("## ")) {
      groups.push({ title: line.slice(3).trim(), items: [] });
    } else if (line.startsWith("- ")) {
      const group = groups.at(-1);
      if (!group) throw new Error(`${changelogPath}: a bullet appears before the first "## " heading.`);
      group.items.push(line.slice(2).replaceAll("`", ""));
    } else if (!line.startsWith("#") && line.trim() && groups.length === 0 && !introduction) {
      introduction = line.trim();
    }
  }

  if (!introduction) throw new Error(`${changelogPath}: no introduction paragraph found.`);
  if (groups.length === 0) throw new Error(`${changelogPath}: no "## " sections found.`);
  const empty = groups.find((group) => group.items.length === 0);
  if (empty) throw new Error(`${changelogPath}: section "${empty.title}" has no bullets.`);

  return { introduction, groups };
}

function render({ introduction, groups }) {
  const indent = (depth) => " ".repeat(depth);
  const body = groups
    .map(
      (group) => `${indent(6)}{
${indent(8)}title: ${JSON.stringify(group.title)},
${indent(8)}items: [
${group.items.map((item) => `${indent(10)}${JSON.stringify(item)},`).join("\n")}
${indent(8)}],
${indent(6)}},`,
    )
    .join("\n");

  // A named import, never a default one: Rolldown does not tree-shake the unused
  // properties off a whole-manifest default import, so `import packageJson` ships
  // every dependency and version range in package.json to users.
  return `import { version } from "../../package.json";

export interface ReleaseNotesGroup {
  readonly title: string;
  readonly items: readonly string[];
}

export interface ReleaseNotes {
  readonly version: string;
  readonly title: string;
  readonly introduction: string;
  readonly groups: readonly ReleaseNotesGroup[];
}

// GENERATED FILE — do not edit by hand.
// Source: ${changelogPath}. Regenerate with \`npm run gen:release-notes\`.
//
// One release only. The workflow contract greps this WHOLE file for \`items:\` and
// compares the result with the single-version \`.md\`, so a superseded entry left
// behind here fails the release, not just this file's own test. Generating the file
// is what guarantees that: the .md holds one release, so this can only hold one.
//
// Exported so a test can assert the key set directly. Asserting that a superseded
// release's PROSE is absent from the DOM cannot work — the component renders only
// CURRENT_RELEASE_NOTES, so a stale entry is never rendered and the query passes
// whether or not the entry is there.
export const RELEASE_NOTES: Readonly<Record<string, ReleaseNotes>> = {
  ${JSON.stringify(version)}: {
    version: ${JSON.stringify(version)},
    title: ${JSON.stringify(`What's new in NeuralNote ${version}`)},
    introduction:
      ${JSON.stringify(introduction)},
    groups: [
${body}
    ],
  },
};

function releaseNotesFor(releaseVersion: string): ReleaseNotes {
  const notes = RELEASE_NOTES[releaseVersion];
  if (!notes) {
    throw new Error(\`No bundled release notes exist for NeuralNote \${releaseVersion}.\`);
  }
  return notes;
}

export const CURRENT_RELEASE_NOTES = releaseNotesFor(version);
`;
}

const parsed = parse(markdown);
const generated = render(parsed);
const bulletCount = parsed.groups.reduce((total, group) => total + group.items.length, 0);

if (process.argv.includes("--check")) {
  const committed = await readFile(repoFile(OUTPUT_PATH), "utf8");
  if (committed !== generated) {
    console.error(
      `${OUTPUT_PATH} is stale against ${changelogPath}. Run \`npm run gen:release-notes\` and commit the result.`,
    );
    process.exit(1);
  }
  console.log(`${OUTPUT_PATH} is current with ${changelogPath} (${bulletCount} bullets).`);
} else {
  await writeFile(repoFile(OUTPUT_PATH), generated);
  console.log(
    `Wrote ${OUTPUT_PATH} from ${changelogPath}: ${parsed.groups.length} sections, ${bulletCount} bullets.`,
  );
}
