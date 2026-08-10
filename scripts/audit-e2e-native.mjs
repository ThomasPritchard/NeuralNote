#!/usr/bin/env node
// Audit gate for app/desktop/e2e-native (CI-only WebdriverIO tooling, never shipped).
//
// `npm audit` has no allowlist mechanism, so this wrapper enforces one explicitly:
// it fails on ANY high-or-critical advisory except the entries in ACCEPTED below,
// which carry their justification inline. Fail-closed: if the audit cannot run, its
// output cannot be parsed, or the report schema deviates from what we understand
// (missing `vulnerabilities`, missing/empty `via`, advisory without a well-formed
// GitHub advisory URL, unrecognized severity), the gate exits 2 rather than passing
// blind.
//
// Used by the `audit:all` script in app/desktop/package.json (PR CI, Node 24 leg).

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const here = path.dirname(fileURLToPath(import.meta.url));
const e2eNativeDir = path.resolve(here, "../app/desktop/e2e-native");

// Advisories accepted as residual risk, keyed by GHSA id and BOUND TO ONE PACKAGE so
// an acceptance can never cover a different package. Each entry MUST carry: why no
// compatible fix can be locked, why the risk is not reachable here, and the trigger
// that should remove the acceptance.
// Empty on purpose: no advisory is currently accepted as residual risk. The
// brace-expansion acceptance (GHSA-mh99-v99m-4gvg) was removed once upstream pulled a
// patched version within compatible ranges, which was its documented removal trigger.
const ACCEPTED = new Map([]);

// npm's severity scale. Anything outside this table is schema drift → exit 2.
const SEVERITY_RANK = { low: 1, moderate: 2, high: 3, critical: 4 };
// Severity at or above the gate threshold (--audit-level=high equivalent).
const BLOCKING_RANK = SEVERITY_RANK.high;

const GHSA_URL_PATTERN = /^\/advisories\/(GHSA-[0-9a-z]{4}-[0-9a-z]{4}-[0-9a-z]{4})$/;

function fail(message, exitCode = 1) {
  console.error(`audit-e2e-native: FAIL: ${message}`);
  process.exit(exitCode);
}

function schemaViolation(message) {
  fail(`unexpected audit report schema (${message})`, 2);
}

// Extract the GHSA id from an advisory url, or die trying: the gate only knows how
// to reason about GitHub advisory URLs, so any other shape is fail-closed schema
// drift, never a silent skip.
function ghsaIdFromUrl(via) {
  if (typeof via.url !== "string") schemaViolation(`advisory without a string url: ${JSON.stringify(via).slice(0, 200)}`);
  let parsed;
  try {
    parsed = new URL(via.url);
  } catch {
    schemaViolation(`advisory url does not parse: ${via.url.slice(0, 200)}`);
  }
  if (parsed.host !== "github.com") {
    schemaViolation(`advisory url is not on github.com: ${via.url.slice(0, 200)}`);
  }
  const match = GHSA_URL_PATTERN.exec(parsed.pathname);
  if (!match) schemaViolation(`advisory url is not a GHSA advisory path: ${via.url.slice(0, 200)}`);
  return match[1];
}

// Test hook: read a precomputed audit report instead of invoking npm. Loud on
// purpose — a gate that silently skips the real audit is no gate.
let raw;
if (process.env.AUDIT_JSON_PATH) {
  console.warn(
    `audit-e2e-native: WARNING: reading audit report from AUDIT_JSON_PATH=` +
      `${process.env.AUDIT_JSON_PATH} — npm audit was NOT run (test hook)`,
  );
  try {
    raw = fs.readFileSync(process.env.AUDIT_JSON_PATH, "utf8");
  } catch (error) {
    fail(`cannot read AUDIT_JSON_PATH: ${error.message}`, 2);
  }
} else {
  try {
    raw = execFileSync("npm", ["audit", "--json"], {
      cwd: e2eNativeDir,
      encoding: "utf8",
      // npm audit exits 1 when vulnerabilities exist; the report is still on stdout.
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (error) {
    if (typeof error.stdout === "string" && error.stdout.length > 0) {
      raw = error.stdout;
    } else {
      fail(`npm audit could not run: ${error.message}`, 2);
    }
  }
}

let report;
try {
  report = JSON.parse(raw);
} catch {
  fail("npm audit output was not valid JSON", 2);
}
if (typeof report.vulnerabilities !== "object" || report.vulnerabilities === null) {
  fail("npm audit report has no vulnerabilities object — unexpected schema", 2);
}

// Collect every distinct advisory (via entries that are objects carry the advisory;
// string entries are just "depends on" propagation). A vulnerability with no usable
// via cannot be classified, so it is schema drift, not a free pass. Duplicate ids
// merge at their MAX severity.
const advisories = new Map(); // ghsa id -> { title, severity, rank, package }
for (const [vulnName, vuln] of Object.entries(report.vulnerabilities)) {
  if (!Array.isArray(vuln.via) || vuln.via.length === 0) {
    schemaViolation(`vulnerability "${vulnName}" has no via array`);
  }
  for (const via of vuln.via) {
    if (typeof via === "string") continue;
    if (typeof via !== "object" || via === null) schemaViolation(`non-object via entry in "${vulnName}"`);
    const id = ghsaIdFromUrl(via);
    const severity = typeof via.severity === "string" ? via.severity.toLowerCase() : "";
    const rank = SEVERITY_RANK[severity];
    if (rank === undefined) {
      schemaViolation(`advisory ${id} has unrecognized severity ${JSON.stringify(via.severity)}`);
    }
    const pkg = typeof via.name === "string" ? via.name : vulnName;
    const existing = advisories.get(id);
    if (!existing || rank > existing.rank) {
      advisories.set(id, { title: via.title ?? id, severity, rank, package: pkg });
    }
  }
}

const unaccepted = [];
const acceptedSeen = [];
for (const [id, info] of advisories) {
  if (info.rank < BLOCKING_RANK) {
    console.log(`audit-e2e-native: info: ${id} (${info.severity}) below gate: ${info.title}`);
    continue;
  }
  const accepted = ACCEPTED.get(id);
  if (accepted && accepted.package === info.package) {
    acceptedSeen.push(id);
    console.log(`audit-e2e-native: accepted: ${id} (${info.severity}) on ${info.package}: ${info.title}`);
    console.log(`  rationale: ${accepted.rationale}`);
  } else {
    unaccepted.push(`${id} (${info.severity}) on ${info.package}: ${info.title}`);
  }
}

if (unaccepted.length > 0) {
  fail(`unaccepted advisories at or above the high gate:\n  ${unaccepted.join("\n  ")}`);
}

// An acceptance that matched nothing is not harmless: it is a standing
// pre-authorisation for that advisory to return. If a later dependency change makes
// the same GHSA reachable in a context its rationale never covered, the gate accepts
// it silently and still prints PASS. Reporting only what blocked and what was
// accepted makes "0 accepted" and "no stale entries" indistinguishable, which is how
// the brace-expansion entry sat dormant here until it was found by hand.
//
// Warn rather than fail: a stale entry means upstream FIXED something, and turning
// someone else's good news into a red build teaches people to distrust the gate.
const stale = [...ACCEPTED.keys()].filter((id) => !acceptedSeen.includes(id));
for (const id of stale) {
  console.warn(
    `audit-e2e-native: WARNING: accepted advisory ${id} ` +
      `(${ACCEPTED.get(id).package}) matched nothing in this run — it is dormant and ` +
      `still armed. Confirm it is genuinely resolved upstream, then delete the entry.`,
  );
}

console.log(
  `audit-e2e-native: PASS (${advisories.size} advisories, ${acceptedSeen.length} accepted, ` +
    `${unaccepted.length} blocking, ${stale.length} stale acceptances)`,
);
