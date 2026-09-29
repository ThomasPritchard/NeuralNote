**NeuralNote main — codebase review**

Reviewed 28 September 2026 (BST), commit `b4fe8315d787bbe5226828557f7f4204d435731b`.

**Verdict: targeted fixes needed; the existing architecture is worth keeping.** The Rust core, thin native adapters, generated contracts and frontend API seam give the project useful boundaries. The most consequential problems are inconsistent enforcement within those boundaries: some writes lose metadata or report failure after committing, some reads bypass size limits, and asynchronous results can arrive without a freshness check. Two measured algorithms also scale quadratically. Comment bloat is supported by measured volume and examples of repetition, stale pointers and overstated guarantees; it is a separate maintainability finding.

This records the read-only review phase, before remediation. It is not release approval or proof that the application is free of other defects. No repository files were changed during that phase; subsequent work is tracked in [the remediation ledger](2026-09-28-remediation.md). Main's tracked files remained clean; the pre-existing untracked `.grilling/` and `.superpowers/` directories were preserved. Other worktree changes are outside this report.

The durable [comment measurement and per-file counts](2026-09-28-comment-audit/README.md) accompany this report. Scratch paths below identify additional local probe evidence; those artifacts are not part of the repository.

**Scope and evidence**

The review covered product/acceptance contracts, core note and entry operations, tree/search/backlinks, editor source preservation, frontend asynchronous state, AI transport/orchestration/citation boundaries, and CI/release/dependency controls. It traced representative end-to-end failure paths and used focused probes. It was not an exhaustive line-by-line audit of every module, a complete capture/helper/updater security assessment, or a cross-platform native walkthrough.

“Source trace” below means the triggering path and consequence follow from inspected production code. “Isolated probe” executes selected production logic with a small harness. “Platform analogue” exercises the relevant filesystem primitives, not NeuralNote's compiled command. These distinctions matter because the full frontend and Rust suites could not run with the dependencies currently available.

**Recommended order**

| Order | Work | Reason |
| --- | --- | --- |
| 1 | Update the vulnerable native-test dependency; fix write permission retention, rename staging and post-commit error handling | One actual gate failure, plus confidentiality and file-integrity concerns |
| 2 | Bound disk/provider reads; centralize provider-error redaction; reject stale tree responses | Enforce existing resource, secret and freshness boundaries consistently |
| 3 | Remove quadratic backlink/editor work; correct deleted-note recovery | Measured costs and a recovery action that cannot succeed |
| 4 | Reconcile release evaluation requirements; prune repetitive comments; profile remaining scan/render costs | Make quality claims measurable and reduce maintenance overhead before broader architectural work |

**1. Native-test dependencies currently fail the high-severity audit gate**

**Priority: address before the next release. Evidence: actual audit failure.** The native test lockfile contains `js-yaml` 4.3.1 at [package-lock.json:4491](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/e2e-native/package-lock.json#L4491). Running the repository's `scripts/audit-e2e-native.mjs` returned exit 1 for `GHSA-2883-xcg3-v3hh`. The upstream advisory describes CPU exhaustion through empty YAML merge sources and identifies 4.3.2 as the patched 4.x version. This is a development/test dependency; shipped-application exposure was not established. [Upstream advisory](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh).

The separate desktop lockfile audit passed the high-severity threshold but reported five moderate package entries arising from the same Vitest advisory. The locked 4.1.10 family should move together to a compatible patched version, 4.1.11 or later. This concerns development-server file access, not a demonstrated vulnerability in the packaged app. [Vitest advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9).

Update the affected lockfiles, retain the current audit thresholds, and run the relevant browser/native harnesses after the update. The release workflow invokes `audit:all`; a current hosted GitHub run was not inspected, so this finding is a local gate result rather than a claim about GitHub's latest status.

**Additional R01 evidence from remediation verification, 29 September 2026:** the complete Rust
gate also failed on locked `rustls` 0.23.43 with `RUSTSEC-2026-0285`. The TLS 1.3 implementation
accepted handshake messages at the wrong encryption level. The advisory states that the handshake
transcript remains authenticated; this is not evidence of arbitrary handshake forgery or an observed
attack on NeuralNote. The compatible fix is Rustls 0.23.45, requiring WebPKI 0.103.14. Cargo generated
that two-package lockfile update; no advisory policy was relaxed.
[Primary advisory](https://rustsec.org/advisories/RUSTSEC-2026-0285) and
[upstream release](https://github.com/rustls/rustls/releases/tag/v%2F0.23.45).

**2. Saving an existing private note can broaden its file permissions**

**Priority: medium; confidentiality. Evidence: source trace plus platform analogue.** [note.rs:351](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/note.rs#L351) creates a new sibling and replaces the original file. [temp_sibling.rs:46](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/temp_sibling.rs#L46) uses exclusive creation but does not retain the original permissions. Under a `022` umask, replacing a `0600` note this way produces a `0644` note. The platform probe reproduced that transition.

Other local users gain read access if the containing directories permit traversal. The temporary file can also expose the private contents while being written. This is conditional on filesystem permissions and process umask; it is not evidence of an observed disclosure.

Create the temporary file with restrictive permissions, retain the original file's intended mode before replacement, and explicitly decide how supported platforms handle ACLs and other metadata. Add a core filesystem regression that saves a `0600` note and checks the result, including failure cleanup. Exclusive temporary-file creation already protects against an occupied symlink; that does not solve mode preservation.

**3. Rename/move can succeed on disk and still return failure**

**Priority: medium; correctness and recovery. Evidence: source trace plus platform analogue.** [entries.rs:111](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/entries.rs#L111) and [entries.rs:199](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/entries.rs#L199) perform the rename and then call `node_for`. For directories, [tree.rs:180](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/tree.rs#L180) recursively scans descendants and propagates errors.

A folder with an unreadable descendant can therefore move successfully, then return an error when constructing the response. The platform analogue reproduced a missing old path, an existing new path, and a subsequent permission error. The frontend remaps open tabs only on success: [useFileTreeCrud.ts:151](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/useFileTreeCrud.ts#L151), [useFileTreeMove.ts:54](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/useFileTreeMove.ts#L54). Dirty tabs can retain the old path and then fail to save.

Make the committed mutation result independent of a recursive refresh. Return enough confirmed identity/path information to remap tabs immediately; surface subsequent refresh failures separately. A regression should move/rename a directory with an unreadable descendant and verify both the actual location and the caller's understanding of the operation.

**4. Case-only rename can overwrite an occupied staging file**

**Priority: medium; conditional data loss. Evidence: source trace plus platform analogue.** [entries.rs:142](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/entries.rs#L142) stages through `.{final_name}.{pid}.nn-caserename` without reserving that name or checking ownership. On the reviewed platform, the first rename replaces an existing file at that path. The analogue confirmed the pre-existing staging bytes were lost.

The trigger is unusual, but concrete: an occupied hidden staging path, such as a stranded artifact followed by PID reuse. The final-target collision check does not protect the staging path.

Use an exclusively owned staging location and a platform-appropriate no-clobber strategy, preserving the current case-insensitive-filesystem behavior. Test an already occupied staging name and both stages of failure/rollback. A random filename alone reduces collision probability without establishing ownership.

**5. Save-time conflict checking bypasses the note-size boundary**

**Priority: medium; availability. Evidence: source trace.** Ordinary note reads have an editable-size limit, but [note.rs:296](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/note.rs#L296) reads the entire current file with `std::fs::read` during conflict checking. The incoming draft is bounded at line 315; the existing disk file read at line 333 is not.

Open a small note, edit it, then have another tool replace it with a very large file. Saving the retained draft can allocate and decode the whole replacement before reporting the expected conflict. The frontend's size guard describes the earlier opened document, so it does not reliably prevent this path. No deliberate memory-exhaustion test was run.

Use the same bounded read/decoding policy for conflict checks and return an explicit conflict or size-related failure when the current disk content exceeds the limit. Preserve the separate, deliberate user-overwrite policy. Test an initially editable file that grows beyond the limit while a dirty draft remains open.

**6. Provider responses lack local size limits**

**Priority: medium; availability at an untrusted-input boundary. Evidence: source trace and isolated production-code probe.** [tool_turn_reader.rs:64](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/tool_turn_reader.rs#L64) keeps extending its buffer until a newline arrives. [ai.rs:1043](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src-tauri/src/ai.rs#L1043) has the same pattern for final answers. Tool content/argument accumulation and buffered `.json()`/error-body `.text()` reads also lack comparable local byte limits.

The production `ToolTurnReader` accepted 32 MiB delivered as 512 chunks without a newline or a size error. That isolated probe took about 2.0 seconds, including repeated scans of the growing buffer. It does not establish a real provider exploit or native UI timing. Idle timeouts do not stop a stream that keeps supplying bytes, and model output parameters do not constrain malformed responses.

Add explicit limits for incomplete frames, total response bytes, tool-call count, argument/content sizes and buffered error bodies. Check limits before extending allocations; fail visibly and settle live previews. Track the unscanned suffix rather than repeatedly searching the entire accumulated buffer. Test fragmented oversized frames, many small valid deltas, excessive tool calls and buffered-response overflow. Limits should accommodate legitimate note-writing tasks rather than imposing an arbitrary short duration on useful streams.

**7. API-key redaction does not cover in-band stream errors**

**Priority: medium; conditional secret-boundary gap. Evidence: complete source trace; no real credential used or leaked.** The non-success HTTP path sanitizes the provider body using the bearer token at [ai.rs:1092](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src-tauri/src/ai.rs#L1092). However, an HTTP 200 response containing an SSE `error.message` is formatted directly at [openai.rs:341](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/openai.rs#L341), propagated from the native client, and emitted to the frontend by [orchestrator/mod.rs:136](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/orchestrator/mod.rs#L136).

If an upstream provider or proxy echoes an authorization token inside that error frame, the streamed path bypasses the defense already present for HTTP errors. This is a missing defensive control, not evidence that normal responses contain credentials.

Sanitize provider-originated errors at the transport boundary while the secret is available, covering answer streams, tool streams and buffered completion errors. Use synthetic token fixtures and assert that neither returned errors nor emitted events contain the token. Preserve useful diagnostic information around the redacted value.

**8. Older tree requests can overwrite newer results**

**Priority: medium; stale UI state. Evidence: isolated execution of production hook logic.** [useVaultTree.ts:88](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/useVaultTree.ts#L88) checks whether the effect has been cancelled, but not whether a request is still the latest request for that vault. Initial load, watcher refresh and explicit refresh can overlap.

The deferred-IPC probe completed the newer request with `new.md`, then the older request with `old.md`. The hook replaced the fresh tree with the old one and retained `ready` status. The same guard omission allows an older rejection to replace a newer successful status. The harness uses minimal hook adapters; it is not a mounted React or native integration test.

Add a per-effect request generation and accept success/failure only from the current generation. Consider coalescing full scans, while ensuring a change arriving during a scan still schedules a fresh read. Test both out-of-order success and stale failure after success.

**9. Backlink snippet extraction is quadratic on link-dense lines**

**Priority: medium; measured performance problem. Evidence: optimized microbenchmark of extracted production functions.** Each occurrence at [links/mod.rs:258](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/links/mod.rs#L258) computes a character position and calls [search.rs:1040](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/search.rs#L1040), which builds a full character-offset vector for that line again. Link extraction constructs these snippets before resolving whether each link targets the note being viewed. The reader automatically requests backlinks when its panel mounts.

| Single-line fixture | Link occurrences | Extraction time |
| --- | ---: | ---: |
| 12 KB | 2,000 | 71.7 ms |
| 24 KB | 4,000 | 264.9 ms |
| 48 KB | 8,000 | 989.9 ms |
| 96 KB | 16,000 | 3,917.0 ms |

Doubling the input approaches four times the work. These are deliberately dense fixtures and algorithm timings, excluding filesystem scans, masking, link resolution, IPC and rendering. They are not measurements of a normal user's vault or a four-second UI freeze.

Build/reuse character offsets per line, avoid repeatedly counting prefixes, and defer expensive snippet construction until an occurrence is relevant. Apply the same scrutiny to unlinked-mention snippets. Preserve every-occurrence results and Unicode/source-line accuracy. Add a scaling test for dense lines, not just a large collection of short notes.

**10. Multiline editor replacements repeatedly scan every old newline**

**Priority: medium; measured performance problem on the UI thread. Evidence: production source-preservation function in an isolated harness.** [sourceText.ts:111](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/sourceText.ts#L111) searches all old newline positions for the separator to inherit. [sourceText.ts:159](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/sourceText.ts#L159) invokes it for each new/replaced newline. A select-all multiline paste therefore does approximately `old lines × new lines` work.

| Replacement fixture | Median function time, three runs |
| --- | ---: |
| 1,000 lines / 9 KB | 6.6 ms |
| 2,000 lines / 18 KB | 25.8 ms |
| 4,000 lines / 36 KB | 94.5 ms |
| 8,000 lines / 72 KB | 361.6 ms |

The harness supplied minimal text/change adapters and verified preserved CRLF output. It isolates this algorithm; it does not measure CodeMirror layout or native interaction latency. The function runs synchronously in the editor transaction path, so its cost contributes directly to input stalls. Existing single-character scaling tests do not exercise this replacement case.

Use sorted positions with binary search or a moving cursor over the replaced range. Preserve the nearest-separator/tie-breaking contract. Add mixed-ending paste, replacement and undo regressions plus a relative scaling check. Afterwards, profile the additional full-document serialization work before deciding whether to redesign the source representation.

**11. The deleted-note notice advertises a recovery action that fails**

**Priority: lower than the integrity fixes; user-visible correctness. Evidence: source trace.** [NotePane.tsx:114](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/NotePane.tsx#L114) says “save to restore it.” But [useNoteTabs.ts:188](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/useNoteTabs.ts#L188) calls the ordinary write operation, and [note.rs:323](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/note.rs#L323) rejects a missing file before considering overwrite behavior.

The in-memory draft remains available; this finding is not immediate content loss. The problem is a recovery promise the implementation cannot fulfill. Provide an explicit create-only restore/Save As action, with collision handling if the file reappears, or change the notice to describe an actually supported recovery route. Test external deletion followed by recovery and recreation by another process.

**12. Live citation-behavior evidence is not enforced by the release workflow**

**Priority: resolve before making release-quality claims. Evidence: workflow/spec/test inspection.** [conversational-chat-slice.md:241](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/specs/conversational-chat-slice.md#L241) describes a behavioral regression gate. Both provider evaluations are explicitly ignored by routine Cargo tests at [behavioural_eval.rs:350](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src-tauri/tests/behavioural_eval.rs#L350). The release workflow runs ordinary `cargo test --workspace --locked` at [release-alpha.yml:223](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/.github/workflows/release-alpha.yml#L223), without invoking the ignored evaluation or requiring evidence of a separate run.


Consequently, release checks can pass without a live model evaluation. Ignoring paid/nondeterministic tests in routine PR checks is reasonable; the missing link is a clear release evidence policy. The documented decision that local-model citations are best-effort remains an accepted product choice, not a newly discovered defect. Historical reliability figures in comments were not remeasured here.

The deterministic verifier checks source identity/hash, quote presence and range length. That establishes important provenance properties but does not prove that a cited source supports the answer's claim. The current behavioral fixtures likewise do not constitute a broad semantic-faithfulness benchmark.

Define an explicit release-time evaluation or reviewed artifact bound to the commit, provider and model. Separate cloud requirements from the accepted local limitations, and include a small curated set of answer-support/abstention cases. Reconcile the spec with that policy. No paid provider calls or Ollama startup were performed for this review.

**13. Comment bloat obscures production logic and creates a second, drifting account of behavior**

**Priority: medium maintainability improvement, below correctness/security fixes. Evidence: `cloc` measurement plus manual inspection.** There is a concrete cleanup opportunity. This conclusion combines comment volume with examples of redundant and inaccurate prose; there is no universal percentage that makes comments bad.

The measurement used the tracked main snapshot and installed `cloc` 2.10. It separated dedicated tests/fixtures, generated bindings and tooling, and extracted 61 inline Rust test modules into a separate measurement group. It counted comment-only lines, including API documentation, as a share of nonblank code-plus-comment lines. Individual test-only helpers/declarations inside production Rust modules can remain, so the production totals are a close estimate rather than a compiler-derived inventory.

| Application source group | Files | Code lines | Comment lines | Comments / nonblank lines |
| --- | ---: | ---: | ---: | ---: |
| Frontend TypeScript/TSX | 187 | 23,880 | 7,034 | 22.75% |
| Rust production-module sections | 145 | 31,105 | 7,611 | 19.66% |
| Combined | 332 | 54,985 | 14,645 | 21.03% |

Among production files with at least 50 nonblank lines, 14 contain more comment lines than code lines. Generated bindings were excluded from this conclusion; their high documentation ratio is expected and they must not be hand-edited.

| Representative file | Comment lines | Code lines | Comment share |
| --- | ---: | ---: | ---: |
| `sourceEditorTableMeasurement.ts` | 56 | 31 | 64.4% |
| `KeyChangeCaveat.tsx` | 40 | 23 | 63.5% |
| `ai/events.rs` | 329 | 194 | 62.9% |
| `sourceEditorTableScrollSync.ts` | 287 | 253 | 53.1% |
| `useVaultTree.ts` | 69 | 65 | 51.5% |

The maintainability problems are specific:

- **Bug history overwhelms the current contract.** [useVaultTree.ts:1](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/useVaultTree.ts#L1) repeats tree/status/error behavior across a long introduction, type documentation, function documentation and inline explanations. [events.rs:64](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/events.rs#L64) has a 42-line narrative before a small status enum, including previous behavior and descriptions of what tests would fail. Preserve the outcome distinctions; condense the history.
- **Review/experiment records live inside implementation files.** [KeyChangeCaveat.tsx:1](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/KeyChangeCaveat.tsx#L1) embeds dated caller checks and detailed contrast measurements around a small notice component. [sourceEditorTableScrollSync.ts:1](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/sourceEditorTableScrollSync.ts#L1) opens with 66 lines covering experiment coordinates, abandoned approaches and third-party bundle line numbers. Keep the browser/lifecycle constraints close to code; link a durable design/evidence record for the experimental narrative.
- **Some historical references have already drifted.** [events.rs:86](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/events.rs#L86) points to tests in `orchestrator.rs`; the named tests now live in `orchestrator/settlement.rs` and `orchestrator/tests.rs`. Third-party built-file line numbers are similarly fragile unless tied to a version.
- **Some comments promise more than the implementation establishes.** [temp_sibling.rs:57](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/temp_sibling.rs#L57) claims only this process could predict its temporary names, although the module itself documents the PID/counter naming as predictable. Exclusive creation supplies the protection. [verify.rs:24](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/verify.rs#L24) describes an exact line-location guarantee while the implementation checks quote presence and range length, as discussed above. These should describe the actual guarantee precisely.

Use a focused cleanup pass over the densest files. Keep API contracts, ownership/lifecycle rules, security invariants and non-obvious platform workarounds. Remove implementation narration and repeated justifications; compress necessary rationale; relocate substantial historical evidence to its authoritative document and link it once. Correct stale guarantees as part of the same review. Do not impose a comment quota or bulk-delete comments to lower a metric.

The benefit is easier review and less documentation drift. No runtime speedup is claimed from deleting source comments. Detailed counts and the reproducible measurement script are retained in the comment audit (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/comment-audit/README.md`).

**Further improvements — useful, but not yet measured defects**

- **Avoid re-rendering settled chat turns for each token.** [ChatMessages.tsx:261](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src/workspace/ChatMessages.tsx#L261) maps the transcript on each update. The stream reducer preserves unchanged message objects, so memoizing completed turns and stabilizing their props is a plausible low-complexity improvement. Profile a long transcript first; introduce virtualization only if DOM size warrants it.
- **Coordinate vault scans and blocking work.** Tree refresh, backlinks and search independently traverse data; several native async commands perform synchronous filesystem/CPU work. Fix the measured hotspots first, then measure larger vaults. Coalesce requests and use bounded blocking workers with cancellation. A revision-aware metadata snapshot may help; this review does not establish a need for a new database or indexing subsystem.
- **Expose degraded external-change watching.** [commands/vault.rs:119](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/app/desktop/src-tauri/src/commands/vault.rs#L119) intentionally permits vault opening when the watcher fails, logging the failure. Keep that availability decision, but expose a nonfatal degraded status and provide focus/manual reconciliation for both the tree and open notes. A successful frontend event subscription does not establish that the underlying native watch is working.
- **Budget the assembled model request.** [orchestrator/collect.rs:70](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/orchestrator/collect.rs#L70) builds tool schemas, fits messages to the context window, then adds the schemas to the request. Add a regression for the full serialized request, including tool definitions, before tuning the reserve. Provider truncation/overflow was not reproduced in this review.
- **Strengthen citation verification defensively.** [verify.rs:80](https://github.com/ThomasPritchard/NeuralNote/blob/b4fe8315d787bbe5226828557f7f4204d435731b/crates/neuralnote-core/src/ai/verify.rs#L80) checks that quote text exists somewhere in the note. Anchoring that check to the stated start line would catch future producer mistakes. Current trusted producers were not shown to generate a wrong start line, so this is hardening rather than a demonstrated user-facing miscitation.
- **Keep contracts synchronized with implementation decisions.** Resolve the evaluation-gate mismatch in one authoritative place. Avoid wholesale file splitting or comment churn: some large Rust modules include extensive tests, and line count alone does not establish a maintenance problem.

**Practices that are working well**

The reusable Rust core and single frontend IPC seam make important boundaries inspectable. Generated bindings reduce wire-contract drift. The reviewed code contains meaningful protections for vault containment, tool authorization, stale provider configuration, write conflicts, bounded ordinary note reads and explicit stream failure settlement. There are substantive unit/browser/native layers and release workflow contract tests. The findings call for extending those existing patterns consistently, rather than introducing a new architecture.

Accepted residuals were not relabeled as fresh defects: the documented cooperative-writer conflict-check/rename window, the deliberate note-save durability/performance choice, nonfatal watcher startup, and local-model citation limitations need to remain distinct from the problems above. Planned full-source/chunk/timestamp recall was not treated as an already implemented feature.

**Verification performed and limits**

Commands below ran during this review, with exit statuses checked. Dependency-sensitive probes used a disposable exact `git archive HEAD` snapshot. No packages were installed and no user vault, credentials, service or release was modified. Supported Node 24 was selected explicitly because the default shell Node was 26; Rust was 1.96.0.

| Command / check | Result and scope |
| --- | --- |
| `git status --short --branch`; `git rev-parse HEAD`; tracked/cached diff checks | Main at the recorded SHA; tracked files unchanged; existing untracked directories preserved |
| `cargo fmt --all -- --check` | **Passed**, exit 0 |
| `gitleaks git . --log-opts=main --redact --no-banner` | **Passed**, exit 0; 94 commits on main, no detected secrets; other branches outside this scan |
| `/opt/homebrew/opt/node@24/bin/node scripts/check-release-workflow.mjs` | **Passed**, exit 0; 28 release-contract tests; no real release publication |
| `bash scripts/rust-quality-gate.test.sh` | **Passed**, exit 0; 5 gate-script contract tests with controlled fixtures; not the actual Rust quality gate |
| `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm --prefix app/desktop audit --package-lock-only --audit-level=high --json` | **Passed threshold**, exit 0; zero high/critical, five moderate package entries from the Vitest advisory |
| `PATH=/opt/homebrew/opt/node@24/bin:$PATH node scripts/audit-e2e-native.mjs` | **Failed**, exit 1; high-severity `js-yaml` advisory |
| `PATH=/opt/homebrew/opt/node@24/bin:$PATH npm --prefix app/desktop run lint` | **Blocked**, exit 127; `oxlint` missing because frontend dependencies are not installed |
| `cargo test --workspace --locked --offline` | **Blocked**, exit 101 before tests; `adler2 v2.0.1` absent from the local cache and offline download refused |
| Local SonarQube prerequisites/status | **Unavailable**: Docker, scanner and credential-file existence checked, but localhost:9000 connection failed; credential contents never read; service not started |
| Editor replacement, tree ordering, stream growth, backlink extraction and filesystem primitive probes | Completed with the scoped results described above; harnesses/results retained |
| `python3 /private/tmp/neuralnote-main-review-a39x66_8/comment-audit/measure.py` | **Completed**, exit 0; `cloc` counts for 719 tracked source files, grouped production/test/generated/tooling; split totals checked against unsplit source totals |

Frontend typecheck/unit/coverage/build/browser checks, bindings generation checks, complete Rust tests/quality/coverage/advisory gates, SonarQube analysis, live provider evaluations and native manual journeys were not completed. Therefore this report does not assert current whole-project test success, runtime acceptance, Windows/Linux parity, or absence of production security issues. Unavailable checks are not passing checks.

**Evidence artifacts**

- Verification logs (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/logs`)
- Vault probe scope and reproduction instructions (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/vault-probes/README.md`)
- Vault probe original results (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/vault-probes/original-results.txt`)
- Editor performance probe (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/editor-perf-probe.mjs`)
- Tree ordering probe (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/tree-race-probe.mjs`)
- Stream buffering probe (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/stream-buffer-probe.rs`)
- [Comment audit methodology and counts](2026-09-28-comment-audit/README.md)
- Exact tracked-source snapshot (local artifact: `/private/tmp/neuralnote-main-review-a39x66_8/source`)

All report artifacts are under `/private/tmp`; copy them to a durable location if they need long-term retention.
