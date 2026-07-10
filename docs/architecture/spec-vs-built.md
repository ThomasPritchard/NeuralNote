# Spec vs Built — the Drift Ledger

> Every substantive claim in `specs/`, checked against the code as of 2026-07-10.
> Verdicts: **BUILT** (the code does what the spec says), **PARTIAL** (some of it,
> or a materially different shape), **NOT BUILT** (zero implementation). Evidence is
> `file:line` where the code exists, and a grep-verified absence where it doesn't.
> The point of this file is honesty — specs here are *design intent* and several
> status lines are stale.

## Stale status lines (read these corrections first)

| Spec | Says | Reality |
|---|---|---|
| `specs/ai-cited-chat-slice.md:3` | "Status: design, approved in principle" | **Fully built** — the orchestrator, verifier, tools, SSE client, chat pane, and keychain all ship (`crates/neuralnote-core/src/ai/`, `src-tauri/src/ai.rs`). |
| `specs/neural-note.md:3-5` | "AI loop … not yet implemented" | Partially stale: cited **chat** is implemented (keyword-agentic, not RAG); capture/distil/embed remain unbuilt. |
| `crates/neuralnote-core/src/ai/tools.rs:3` | "Three tools … scoping deferred" | Four tools — `list_folders` was added. |

---

## 1. `specs/neural-note.md` (master product spec)

### The core loop and its infrastructure

| Spec claim | Where | Verdict | Evidence |
|---|---|---|---|
| Vault-Slate foundation (open/create, browse, read/edit, CRUD) | §status, `app-vault-slate-plan.md` | **BUILT** | 21 vault commands (`src-tauri/src/lib.rs:141-161`); domain in `crates/neuralnote-core/src/{vault,paths,entries,note,tree}.rs`. |
| `capture → distil → embed → cited chat` loop | :204-208 | **NOT BUILT** (except chat) | Zero implementation hits for ingest adapters, distiller, embedder. Chat exists but retrieves over existing markdown only (`ai/retrieval.rs`, keyword). |
| Local SQLite index + embedded vector store | :180, :364-369 | **NOT BUILT** | No `tauri-plugin-sql`, no sqlite-vec, no LanceDB anywhere in `Cargo.toml`/code (grep-verified). |
| API embeddings, committed at v1 (Voyage/OpenAI) | :186-187, :372-376 | **NOT BUILT** | No embedding client exists. The "near-irreversible decision" has in fact been deferred, not committed. |
| Full source retained in `.neuralnote/sources/` sidecar | :180-183, :285-288 | **NOT BUILT** | No sidecar read/write path exists (grep-verified). |
| Capture paths: YouTube transcript, article, PDF, typed text | :191-203 | **NOT BUILT** | No ingest adapters, no pdfium, no OCR, no transcript fetch. |
| Idempotent capture (dedup on normalised URL / content hash) | :201-203 | **NOT BUILT** | No capture exists to be idempotent. |
| Semantic auto-linking on ingest | :212 | **NOT BUILT** | — |
| Semantic + keyword search | :213 | **PARTIAL** | Keyword only: lexical substring, case-folded per-scalar, no index (`search.rs:20-27` caps). No semantic layer. |
| Open an existing Obsidian vault (headline onboarding) | :214-215 | **BUILT** | `open_vault` + recents (`recents.rs:11-22`); the format is compatible by construction. |
| AI: BYO-key, **Claude default**, OpenAI-compatible endpoints | :185-186, :371 | **PARTIAL (drifted)** | Built as **OpenRouter + bundled local Ollama** (`ai-providers-slice.md`), one OpenAI-compatible client (`ai/openai.rs`). No direct Anthropic client; "Claude default" never happened. |
| API key in the OS keychain | :188-189 | **BUILT** | `keyring`, service `com.neuralnote.desktop`, account `openrouter-api-key` (`src-tauri/src/ai.rs:30-31`). |
| Cost pre-flight: estimate before embedding; cap retrieval context per turn; lean prompts | :217-222 | **PARTIAL** | Context caps exist (`Guards.max_context_chars` 60k, `orchestrator.rs:43`; history 12k, `orchestrator.rs:449`; answer 4096 tokens, `openai.rs:88`). **No token/cost estimation is shown to the user anywhere.** |
| **Post-hoc verification: each cited chunk entails its claim; no unverified citation reaches the user** | :294-300 | **PARTIAL — the biggest gap** | `verify.rs:29-46` checks provenance only: re-read → `content_hash` equality → `raw.contains(text)`. **It never checks that the quote supports the claim**, and an answer with zero `[eN]` markers streams to the user unchecked. The spec's own crux ("Generated citation markers are never trusted unverified — that is exactly how a confident wrong citation slips through") is not met in the sense it was written. |
| Never fabricate a citation; "couldn't find it" over inventing | :318-321 | **PARTIAL** | Fabricated *ids* are dropped (unknown `eN` fails verification → `CitationDropped`). But an unsupported claim wearing a *real* quote passes, and uncited assertions are prompt-constrained only. |
| Citation confidence tiers (OCR = page-level, low confidence) | :322-325 | **NOT BUILT** | No OCR, no offsets, no tiers. Citations are note + line range only. |
| Retry with backoff for transient LLM failures | :315-317 | **NOT BUILT** | Explicitly absent — `TODO(llm-retry)`, `orchestrator.rs:179`. One 429 ends the run. |
| Atomic writes; user markdown never corrupted | :326-327 | **BUILT** (with a caveat) | Temp + rename (`note.rs:167-168`); optimistic concurrency (`note.rs:22`, `error.rs:24`). No fsync — crash-consistent, not power-loss-durable. |
| Re-index externally-changed files on launch/focus | :328-332 | **NOT BUILT / N-A** | There is no index to refresh. What exists instead is a live `notify` watcher emitting `vault://tree-changed` (`event_names.rs:14`) — *more* live than the spec's launch/focus model, but only for the tree, and the spec's index it was meant to reconcile doesn't exist. |
| Citation-faithfulness eval harness + golden set, ≥95% gate | :224-233, §7 | **NOT BUILT** | No harness, no golden set, no LLM-judge (grep-verified). The v1 ship gate as written cannot currently be measured. |
| `nn:` frontmatter namespace (Appendix A) | :421-465 | **NOT BUILT** | No code writes `nn:` keys; nothing generates frontmatter at all (no capture). |
| Native application menu, `menu://action` bridge | :271-275 | **BUILT** | `src-tauri/src/menu.rs`; `event_names.rs:17`. |
| Live file-watching "is a fast-follow, not v1" | :240, :391 | **DRIFTED (in the good direction)** | A `notify` watcher already ships for the tree. |

### Verdict on §5's architecture diagram

The spec's component list — Ingest adapters, Distiller, Vault store, Indexer,
Retrieval/RAG, Chat orchestrator (`neural-note.md:250-300`) — is built **2 of 6**:
the Vault store (minus the sources sidecar) and the Chat orchestrator (keyword
retrieval, provenance verification). Ingest, Distiller, and Indexer have zero code;
Retrieval exists but is keyword-over-rescan, not RAG over chunks.

---

## 2. `specs/ai-cited-chat-slice.md` (slice 1 — cited chat)

| Spec claim | Where | Verdict | Evidence |
|---|---|---|---|
| Agentic keyword-search loop with live streamed steps | §1, §4 | **BUILT** | `run_chat` (`orchestrator.rs`), event order Searching → Retrieved/Reading → Verifying → deltas → Citation/CitationDropped → Coverage → Done. |
| `EvidenceSpan { rel_path, content_hash, start_line, end_line, char_start?, char_end?, text }` | :70-72 | **PARTIAL** | Built without char offsets — spans are line-granular only. |
| `RetrievalProvider` trait, `KeywordRetriever` first impl | :73-75 | **BUILT** | `ai/retrieval.rs`; `ai/mod.rs:13` documents the future `VectorRetriever` seam. |
| `CitationVerifier`: hash match + quoted text present, drop/flag on failure | :75-78 | **BUILT** (as specified) | `verify.rs:29-46`. Note the slice spec itself only ever asked for provenance — the *entailment* promise lives in the master spec (§1 above). The slice met its own bar; the product bar is the open gap. |
| Tools: `list_notes`, `search_notes`, `read_note_span` (3) | :83-88 | **BUILT+** | Four tools — `list_folders` added. Stale module doc at `tools.rs:3`. |
| Guards: ~8 iterations, max spans, context cap | :91-93 | **BUILT** | `Guards { 8, 60, 60_000 }` (`orchestrator.rs:26-43`). |
| Keychain: `Entry::new("neuralnote", "openrouter")` | :95-97 | **BUILT (names drifted)** | Actual: `("com.neuralnote.desktop", "openrouter-api-key")` (`ai.rs:30-31`). Cosmetic drift. |
| Key never returned to the webview | :98 | **BUILT** | `has_key: bool` only; call-time keychain read (`ai.rs:85-95`). |
| `chat(prompt, history, Channel<ChatEvent>)`, async worker pool | :102-104 | **BUILT** | `commands/ai.rs`; `lib.rs:165`. |
| `ChatEvent` protocol (11 variants) | :110-117 | **BUILT** | `ai/events.rs:21+`; frontend `reduceAssistant` is a total switch over all 11. |
| **Frontend: Vercel AI Elements + shadcn/Radix** | :122-134 | **NOT BUILT (deliberate drift)** | The shipped chat UI is hand-rolled — no AI Elements, no `components.json`, no Radix primitives were added. The spec's mapping table describes a UI that never existed. |
| Key-setup panel inside the chat pane, skippable | :135-137 | **BUILT** | Superseded/extended by the slice-2 provider picker. |
| Retry-with-backoff for transient classes | :144-145 | **NOT BUILT** | `TODO(llm-retry)`, `orchestrator.rs:179`. |
| Coverage footer counters overclaim | :146-149 | **BUILT** | `Coverage { searched_terms, notes_read, truncated, skipped_files }` carried from `SearchResponse`. |
| Minimal citation-faithfulness golden set "from day one" | :162-163 | **NOT BUILT** | No golden set or harness exists. |
| Real-OpenRouter integration test gated on a key env var | :160-161 | **NOT VERIFIED** | Not found in exploration; treat as absent until shown otherwise (inference, not a citation). |

## 3. `specs/ai-providers-slice.md` (slice 2 — providers + settings)

Status line says "built (2026-07-08)" and this one is accurate.

| Spec claim | Where | Verdict | Evidence |
|---|---|---|---|
| Bundled Ollama sidecar, private loopback port, private models dir | §1-2 | **BUILT** | `local.rs:225-229` (spawn + env), `local.rs:435-438` (ephemeral `127.0.0.1:0` bind). |
| Curated allowlist as source of truth, enforced in Rust at pull/selection/chat | §2, §4 | **BUILT** | `local/mod.rs:95-140` (list), `commands/ai.rs:108,205,415` (three enforcement sites). |
| Newest-generation-then-largest recommendation; RAM hard gate; 70% usable; detection-failure distinct from weak specs | §2 | **BUILT** | `local/mod.rs:54-59` (generation rank); recommender is macOS-only, RAM-based; GPU never detected (`TODO(local-gpu-detection)`, `local.rs:179`). |
| `shell:allow-execute` deliberately omitted | §4 | **BUILT** | `capabilities/default.json:4-10` — the rationale is inlined in the capability file itself. |
| Pull: exactly one terminal `PullEvent`; stalled download read-times-out | §5 | **BUILT** (with caveats) | Cancel token per pull (`local.rs:117-119`); cancel is checked per NDJSON line, an idle socket waits for the 60s read timeout; partial downloads not cleaned up (`TODO(pull-disk-precheck)` adjacent, `local.rs:376`). |
| Sidecar shutdown on exit; startup-orphan window documented | §5-6 | **BUILT** | `shutdown_ollama` on `ExitRequested\|Exit` (`local.rs:301`, `lib.rs:180-185`); SIGKILL still orphans. |
| HF metadata line is non-fatal when unreachable | §5 | **BUILT** | Per spec review record; fetch has no cache/UA/rate limit (hardening gap noted in the HLD §3). |
| Old `{model, keyConfigured}` configs still load | §3 | **BUILT** | `#[serde(default)]` migration (`provider_config.rs:28-40`). |
| Pre-existing cargo-audit RED (plist → quick-xml) | §6 | **CONFIRMED STILL TRUE** | Fails on `main` too; a SKIP (offline) is also not green. |

## 4. `specs/app-vault-slate-plan.md` (phase 1)

Status "built + verified (2026-06-29)" — accurate. All safety invariants hold in
code: path containment (`paths.rs:16`), trash-not-unlink (`entries.rs:175`), atomic
writes (`note.rs:167-168`), frontmatter failures surfaced not swallowed
(`note.rs:281-285`), Obsidian compatibility by construction. The optimistic-
concurrency fix from its review record is exactly what ships (`note.rs:22,132`;
`error.rs:22-24`). Deferred items it lists (restrictive CSP revisit, a11y move-to,
lazy tree scan) remain deferred — except CSP, which has since been tightened
(`tauri.conf.json:26`).

## 5. `specs/search-and-graph-view.md` (phase 2a)

Status "implemented + verified (2026-07-03)" — accurate, with two post-spec drifts:

| Spec claim | Verdict | Evidence |
|---|---|---|
| On-demand async scan per query, no index; caps 200/50/~200-char snippets, 256-char query | **BUILT** | `search.rs:20-27`. |
| Unicode-safe snippets; per-scalar case-fold + final sigma; lossy non-UTF-8 search | **BUILT** | Documented limitation carried honestly (`search-and-graph-view.md:179-184`). |
| Wikilinks + md links, code masking, shortest-path-then-lexicographic ambiguity | **BUILT** | `links/`, `mask.rs:9`. Unmasked residue (HTML comments, `$…$`, escaped brackets) is a known false-positive source. |
| Backend supplies `cluster` + `bridge` per node/link | **BUILT but UNUSED** | The frontend `graphTransform.ts` re-derives clusters/bridges per focus level and ignores the backend fields — the drill-down addendum (spec :155-170) made the backend fields dead weight. |
| "No node cap in v1" (:176) | **DRIFTED** | `GALAXY_NODE_CAP = 500` with an honest truncation notice was added. The right call; the spec line is stale. |
| Backlinks panel | **BUILT (post-spec)** | `backlinks.rs:25` — linked mentions + word-boundary unlinked title mentions; not in this spec at all (it arrived with templates work). |

---

## What this means for the product thesis

The thesis (`neural-note.md` §1) rests on three legs: **local-vault ownership**, a
**zero-setup loop that swallows any input**, and **citation fidelity as a release
gate**. Where each actually stands:

1. **Local-vault ownership is real and well-executed.** The vault layer is the most
   finished thing in the codebase: Obsidian-compatible by construction, path-safe,
   atomic, trash-recoverable, honest about unparseable content. This leg is earned.

2. **The zero-setup loop does not exist.** No capture, no distiller, no index, no
   embeddings, no sidecar sources, no `nn:` metadata. Everything that distinguishes
   the product *pitch* from "Obsidian with a chat pane" is still design. The seams
   for it are genuinely good — `RetrievalProvider`, `EvidenceSpan`, one
   OpenAI-compatible client — but seams are not the loop.

3. **Citation fidelity is currently a weaker promise than the spec makes.** The spec
   is unusually explicit that provenance is not enough: the crux mechanism is a
   "post-hoc verification pass [that] checks that each cited chunk actually
   **entails** its claim" (`neural-note.md:296-298`), and §7 demands a measurable
   faithfulness harness with a release-blocking number. What ships is provenance
   verification only (`verify.rs:29-46`): the quote is real, current, and present in
   the cited note — but nothing checks that it supports the sentence it's attached
   to, and a fully uncited answer is never checked at all. The eval harness and
   golden set do not exist, so the ≥95% gate is unmeasurable. Until entailment
   checking (or at minimum an uncited-claim detector plus the harness) lands, "every
   answer is verified" should not be claimed in any user-facing copy — by the spec's
   own logic, a confident wrong-but-well-quoted citation is exactly the failure mode
   that sinks trust in the product.

The honest one-line summary: **what exists today is a high-quality local vault
editor with keyword-agentic cited chat whose citations are provenance-verified** —
a strong slice 1+2, with the moat itself (full-source capture + entailment-grade
citation fidelity) still entirely ahead. `CLAUDE.md`'s "built vs vision" note
already says this; this ledger is the evidence behind it.
