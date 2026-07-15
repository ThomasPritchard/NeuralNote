import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arguments_ = process.argv.slice(2);
const controlledEdits = arguments_.includes("--controlled-edits");
const vaultArgument = arguments_.find((argument) => !argument.startsWith("--"));
const vault = path.resolve(
  vaultArgument ?? path.join(repoRoot, "target", "manual-note-test-vault"),
);
const baselinePath = path.join(vault, ".neuralnote-preservation-baseline.json");
const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
let failed = false;

for (const [relativePath, expected] of Object.entries(baseline)) {
  const bytes = await readFile(path.join(vault, relativePath));
  const target = controlledEdits && expected.controlledEdit
    ? expected.controlledEdit
    : expected;
  const actual = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  if (actual.bytes === target.bytes && actual.sha256 === target.sha256) {
    console.log(`PASS ${relativePath}`);
  } else {
    failed = true;
    console.error(
      `FAIL ${relativePath}: expected ${target.bytes} bytes / ${target.sha256}, `
      + `received ${actual.bytes} bytes / ${actual.sha256}`,
    );
  }
}

if (failed) {
  process.exitCode = 1;
}
