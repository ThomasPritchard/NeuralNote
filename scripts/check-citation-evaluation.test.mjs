import assert from "node:assert/strict";
import test from "node:test";
import { validateCitationEvaluation } from "./check-citation-evaluation.mjs";
const expected = { sha: "a".repeat(40), cloudModel: "cloud-default", localModel: "local-default", now: Date.parse("2026-09-28T12:00:00.000Z") };
function fixture() {
  const run = { outcome: "pass", logUrl: "https://example.test/evidence/run.log", logSha256: "b".repeat(64), claimSupportReviewed: true, abstentionReviewed: true, acceptedLimitation: "none" };
  return { schemaVersion: 1, commit: expected.sha, reviewedAt: "2026-09-28T12:00:00.000Z", reviewer: "Maintainer", cloud: { ...run, provider: "openrouter", model: expected.cloudModel }, local: { ...run, provider: "ollama", model: expected.localModel } };
}
const validate = (record) => validateCitationEvaluation(JSON.stringify(record), expected);
test("accepts a reviewed cloud and local pass for this release", () => assert.deepEqual(validate(fixture()), fixture()));
test("accepts only the documented missing-citation local limitation", () => {
  const record = fixture(); record.local.outcome = "best-effort"; record.local.acceptedLimitation = "missing-citations"; record.local.observations = "The factual case omitted its evidence marker; source correctness and abstention were reviewed.";
  assert.deepEqual(validate(record), record);
});
for (const [name, change] of [
  ["different commit", r => r.commit = "c".repeat(40)],
  ["missing commit", r => delete r.commit],
  ["future review", r => r.reviewedAt = "2026-09-29T12:00:00.000Z"],
  ["invalid timestamp", r => r.reviewedAt = "yesterday"],
  ["unsupported version", r => r.schemaVersion = 2],
  ["unreviewed claim support", r => r.cloud.claimSupportReviewed = false],
  ["unreviewed abstention", r => r.local.abstentionReviewed = false],
  ["cloud failure", r => r.cloud.outcome = "fail"],
  ["cloud waiver", r => r.cloud.acceptedLimitation = "missing-citations"],
  ["local skip", r => r.local.outcome = "skipped"],
  ["local unavailable", r => r.local.outcome = "unavailable"],
  ["wrong cloud model", r => r.cloud.model = "other"],
  ["wrong local model", r => r.local.model = "other"],
  ["wrong provider", r => r.cloud.provider = "ollama"],
  ["missing digest", r => delete r.cloud.logSha256],
  ["non-HTTPS evidence", r => r.local.logUrl = "file:///private/notes"],
  ["credentials in evidence URL", r => r.cloud.logUrl = "https://token@example.test/log"],
  ["unknown fields", r => r.secret = "must not be archived"],
  ["unknown nested fields", r => r.local.key = "must not be archived"],
  ["missing reviewer", r => delete r.reviewer],
  ["reviewer control characters", r => r.reviewer = "name\nforged log line"],
  ["local waiver without observations", r => { r.local.outcome = "best-effort"; r.local.acceptedLimitation = "missing-citations"; }],
  ["unapproved local limitation", r => { r.local.outcome = "best-effort"; r.local.acceptedLimitation = "wrong-citations"; r.local.observations = "Wrong source"; }],
]) test(`rejects ${name}`, () => { const record = fixture(); change(record); assert.throws(() => validate(record), /Citation evaluation:/); });
for (const value of [undefined, "{", "null", "[]", " ".repeat(16 * 1024 + 1)]) test(`rejects malformed/missing input ${String(value).slice(0, 12)}`, () => assert.throws(() => validateCitationEvaluation(value, expected), /Citation evaluation:/));
test("treats shell syntax as data", () => {
  const record = fixture(); record.reviewer = "$(touch never-executed)";
  assert.equal(validate(record).reviewer, record.reviewer);
});
