import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_RECORD_BYTES = 16 * 1024;

function fail(message) { throw new Error(`Citation evaluation: ${message}`); }
function object(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
  if (Object.keys(value).some((key) => !keys.includes(key))) fail(`${label} has unsupported fields`);
}
function text(value, label, max = 200) {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
    fail(`${label} must be nonempty bounded text`);
  }
}
function run(value, provider, model, label) {
  object(value, ["provider", "model", "outcome", "logUrl", "logSha256", "claimSupportReviewed", "abstentionReviewed", "acceptedLimitation", "observations"], label);
  if (value.provider !== provider || value.model !== model) fail(`${label} provider/model must match the release defaults`);
  text(value.logUrl, `${label}.logUrl`, 2048);
  let url;
  try { url = new URL(value.logUrl); } catch { fail(`${label}.logUrl must be an HTTPS evidence URL`); }
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password) fail(`${label}.logUrl must be an HTTPS evidence URL without credentials`);
  if (typeof value.logSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.logSha256)) fail(`${label}.logSha256 must identify the retained log`);
  if (value.claimSupportReviewed !== true || value.abstentionReviewed !== true) fail(`${label} requires human claim-support and abstention review`);
}

/** Validate a maintainer's review record, not the truth of the remote log it cites. */
export function validateCitationEvaluation(raw, { sha, cloudModel, localModel, now = Date.now() }) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > MAX_RECORD_BYTES) fail("record is missing or oversized");
  let record;
  try { record = JSON.parse(raw); } catch { fail("record must be valid JSON"); }
  object(record, ["schemaVersion", "commit", "reviewedAt", "reviewer", "cloud", "local"], "record");
  if (record.schemaVersion !== 1) fail("unsupported schema version");
  if (!/^[a-f0-9]{40}$/.test(sha ?? "") || record.commit !== sha) fail("record must identify the exact release commit");
  text(record.reviewer, "reviewer");
  text(record.reviewedAt, "reviewedAt");
  const reviewed = Date.parse(record.reviewedAt);
  if (!Number.isFinite(reviewed) || new Date(reviewed).toISOString() !== record.reviewedAt || reviewed > now + 300_000) {
    fail("reviewedAt must be an ISO UTC timestamp and cannot be in the future");
  }
  run(record.cloud, "openrouter", cloudModel, "cloud");
  run(record.local, "ollama", localModel, "local");
  if (record.cloud.outcome !== "pass" || record.cloud.acceptedLimitation !== "none") fail("cloud evaluation must pass without an accepted limitation");
  if (record.local.outcome === "pass") {
    if (record.local.acceptedLimitation !== "none") fail("a passing local evaluation cannot claim a limitation");
  } else if (record.local.outcome === "best-effort") {
    if (record.local.acceptedLimitation !== "missing-citations") fail("only the accepted local missing-citation limitation may be acknowledged");
    text(record.local.observations, "local.observations", 4000);
  } else {
    fail("local evaluation must have run; unavailable/skipped is not accepted evidence");
  }
  if (record.cloud.observations !== undefined) text(record.cloud.observations, "cloud.observations", 4000);
  if (record.local.observations !== undefined) text(record.local.observations, "local.observations", 4000);
  return record;
}

function releaseConstant(relativePath, name) {
  const source = readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
  const match = source.match(new RegExp(`pub const ${name}: &str = "([^"\\n]+)";`));
  if (!match) fail(`could not read release constant ${name}`);
  return match[1];
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const record = validateCitationEvaluation(process.env.CITATION_EVALUATION_JSON, {
      sha: process.env.RELEASE_SHA,
      cloudModel: releaseConstant("crates/neuralnote-core/src/ai/orchestrator/mod.rs", "DEFAULT_MODEL"),
      localModel: releaseConstant("crates/neuralnote-core/src/ai/local/mod.rs", "DEFAULT_LOCAL_MODEL"),
    });
    if (!process.argv[2]) fail("an output path for the reviewed record is required");
    writeFileSync(process.argv[2], `${JSON.stringify(record, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    console.log(`Reviewed citation evaluation record accepted for ${record.commit}; live models were not run by this validator.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
