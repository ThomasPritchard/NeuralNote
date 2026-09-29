# Reviewed citation evidence for releases

The release workflow requires `citation_evaluation`: a JSON review record for the exact tagged
commit and the cloud/local defaults in that commit. This closes the gap between routine tests
(which intentionally ignore live providers) and release citation evaluation. It does not make
unit tests a measure of model quality or automatically verify a reviewer's statements.

1. Check out the candidate release commit with a clean tree. Record `git rev-parse HEAD` and the
   `DEFAULT_MODEL` / `DEFAULT_LOCAL_MODEL` constants. Use an isolated fixture vault, not personal
   notes. Arrange the provider credentials and a running local model through the normal approved
   setup; never put credentials into the record, command line, or retained evidence.
2. Explicitly run each live probe with its default model and retain the complete exit status/log:

   ```bash
   NEURALNOTE_REQUIRE_EVAL=1 cargo test -p desktop --locked --test behavioural_eval openrouter_behavioural_eval -- --ignored --nocapture
   NEURALNOTE_REQUIRE_EVAL=1 cargo test -p desktop --locked --test behavioural_eval local_ollama_behavioural_eval -- --ignored --nocapture
   ```

   The OpenRouter probe reads `OPENROUTER_API_KEY` from the environment. The local probe uses
   `NEURALNOTE_OLLAMA_PORT` if necessary; unset `NEURALNOTE_EVAL_MODEL` to exercise the shipped
   default. Missing providers fail. Do not treat an ignored, skipped, or unavailable probe as a pass.
3. Review actual answers and citation destinations for all five cases in
   `specs/conversational-chat-slice.md` §7. The current harness checks counts and aborts on its
   first assertion failure; it does not retain all answer text or prove semantic support.
   Exercise the cases in the native app with the same fixture/model and retain a manual record
   of prompts, answers, cited lines, and observed outcomes alongside the test log. The factual
   fixture is `Projects/meridian.md`: Meridian uses a **47-second handshake window** and nodes
   authenticate with a **rotating quorum key**. The missing-topic question concerns the Fibonacci
   trading strategy. Confirm claims are supported and missing evidence produces honest abstention.
4. Cloud must pass. For local, only the documented missing-citation limitation may be accepted as
   `best-effort`; record the failing assertion and manually finish every remaining case. Incorrect
   citations, unsupported factual answers, failed abstention, transport errors, or an unavailable
   runner cannot be accepted under that limitation. Keep this distinction in release QA notes.
5. Retain a redacted evidence file for each provider in a maintainer-accessible HTTPS location.
   Include both automated and manual observations. Record each exact file's SHA-256 digest
   (`shasum -a 256 <file>`). Review links and digests before dispatch; the workflow does not fetch
   them. Retain the underlying evidence for the supported lifetime of the release.
6. Supply the record below with actual values. The workflow rejects unknown fields, a different
   commit/model, incomplete review, or unsupported outcomes, and archives the accepted record as
   `citation-evaluation-record` for 90 days. Archive a copy with the durable release QA evidence.

Template (placeholders must be replaced; this is not passing evidence):

```json
{
  "schemaVersion": 1,
  "commit": "EXACT_40_CHARACTER_RELEASE_SHA",
  "reviewedAt": "YYYY-MM-DDTHH:mm:ss.sssZ",
  "reviewer": "Maintainer name",
  "cloud": {
    "provider": "openrouter",
    "model": "DEFAULT_MODEL_FROM_RELEASE_SOURCE",
    "outcome": "pass",
    "logUrl": "https://YOUR_EVIDENCE_HOST/cloud-review.txt",
    "logSha256": "SHA256_OF_RETAINED_EVIDENCE_FILE",
    "claimSupportReviewed": true,
    "abstentionReviewed": true,
    "acceptedLimitation": "none"
  },
  "local": {
    "provider": "ollama",
    "model": "DEFAULT_LOCAL_MODEL_FROM_RELEASE_SOURCE",
    "outcome": "pass",
    "logUrl": "https://YOUR_EVIDENCE_HOST/local-review.txt",
    "logSha256": "SHA256_OF_RETAINED_EVIDENCE_FILE",
    "claimSupportReviewed": true,
    "abstentionReviewed": true,
    "acceptedLimitation": "none"
  }
}
```

For a reviewed local missing-citation result, set `local.outcome` to `best-effort`,
`local.acceptedLimitation` to `missing-citations`, and add nonempty `local.observations` describing
the measured limitation and remaining-case review. Do not include keys, private note contents, or
credential-bearing/signed download URLs. The gate is a maintainer attestation; it cannot establish
that a cited log is authentic or that its conclusions are correct.
