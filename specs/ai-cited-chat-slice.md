# NeuralNote — AI Slice 1: Cited Chat over Your Notes

> Status: design, approved in principle (2026-07-07). The first vertical AI slice. It wires an
> LLM into the app end-to-end for the first time. Read `specs/neural-note.md` (the product spec)
> and `docs/definition-of-done.md` before implementing.

---

## 1. What this slice is — and what it deliberately is not

This slice is **cited chat over your markdown notes**, powered by an **agentic keyword-search
loop**. The user opens a vault, (optionally) connects an API key, asks a question in the chat
pane, and watches the AI search and read their notes live before answering — every claim cited
back to the exact note and line, and every citation verified before it is shown.

It is **not** the full-source cited-recall moat (spec §1). That needs embeddings, chunking, a
vector store, and full-source capture — all of which stay deferred here. Naming this honestly
matters: this slice proves the **chat UX**, the **live-search "harness" feel**, and the
**citation-verification discipline**, on the *real current backend*, without committing the two
near-irreversible decisions (embedding model, vector store — spec §8).

*(Advisor note, frontier GPT via codex: agentic-search-first is the right first slice precisely
because it uses the real backend and keeps the React/Tauri boundary small — but only if we call it
what it is. The `ChatStub` copy "Once your vault is embedded…" becomes false and is replaced.)*

## 2. Scope

**In:**
- Skippable API-key setup (OpenRouter) after a vault is opened; key stored in the OS keychain.
- A chat pane replacing `ChatStub`, driven by an agentic tool-search loop over the existing vault
  search, with **live streamed search/read/verify steps**.
- **Citation fidelity**: the model may only cite evidence IDs; each citation is re-verified against
  the source before the answer is shown.
- A **coverage footer** (searched terms, notes read, truncated/skipped flags) so partial coverage
  is visible, never hidden.

**Out (deferred to later slices):**
- Embeddings, chunking, vector store, semantic recall.
- Full-source capture, the `.neuralnote/sources/` sidecar, the distiller, ingest adapters.
- Non-markdown sources (PDF/YouTube/etc.).

## 3. Architecture — the seam to get right now

```
PromptInput ─▶ chat command ─▶ ChatOrchestrator ─▶ RetrievalProvider ─▶ EvidenceSpan[]
   (React)      (Tauri shell)     (Rust core)          (trait)            (durable evidence)
                                       │                                        │
                                       ▼                                        ▼
                                 LlmClient (OpenRouter)                  CitationVerifier
                                       │                                        │
                                       └──────────────▶ ChatEvent stream ◀──────┘
                                            (tauri::ipc::Channel<ChatEvent>)
                                                         │
                                                         ▼
                                              AI Elements chat UI (React)
```

**Where things live (advisor's seam warning — do not make React the agent runtime):**
- **Orchestration + retrieval + verification**: Rust (`neuralnote-core`), client-agnostic and
  unit-testable without a network.
- **LLM transport + keychain + streaming channel**: the Tauri shell (`src-tauri`), the OS-integration
  layer.
- **Presentation only**: React. The webview never sees the API key and never runs the agent loop.

The point of the abstraction: a later `VectorRetriever` returns the **same `EvidenceSpan` shape**, so
embedding-RAG slots in as just another `RetrievalProvider` with no reshaping of the chat layer.

## 4. Rust core additions — `neuralnote-core::ai`

- **`EvidenceSpan`** — the durable evidence contract:
  `{ rel_path, content_hash, start_line, end_line, char_start?, char_end?, text }`.
  Every citation references a span **ID**; the model is never allowed to cite a freeform path.
- **`RetrievalProvider`** trait; first impl **`KeywordRetriever`**, backed by `search::search_vault`
  plus bounded span reads (`note::read_note`, sliced to a line range).
- **`CitationVerifier`** — before the final answer, re-read each cited span and confirm it still
  matches the recorded `content_hash` **and** contains the quoted text. Drop or flag any that fail.
  This is the moat's discipline (*a wrong citation is worse than no answer*, spec §6) held even in
  the keyword slice.
- **`ChatOrchestrator`** — the tool loop: build the request → on tool calls, dispatch to the
  provider and emit a `ChatEvent` per step → repeat until the model answers or a guard trips →
  verify citations → emit the answer + coverage footer. Generic over an **`LlmClient`** trait so the
  loop is fully testable against a mock (no network in unit tests).
- **Tools exposed to the model** (`scope` = whole vault by default in this slice; folder/note
  scoping is optional polish, deferred unless cheap):
  - `list_notes(scope)` — metadata only (title, rel_path, tags). Never full content.
  - `search_notes(query, scope, max_results)` — returns `EvidenceSpan`s.
  - `read_note_span(rel_path, line_range, max_bytes)` — bounded; not whole-note dumps by default.
- **Query-expansion prompt** — the loop is instructed to issue **3–8 visible searches** (synonyms,
  tags, titles, the user's wording), mitigating keyword search's semantic blindness *and* making a
  miss inspectable in the UI (advisor mitigation).
- **Guards:** max tool iterations (~8), max spans read, and a per-turn context/token cap
  (cost-awareness, spec §4). A hard "answer only from retrieved evidence" system prompt.

## 5. Tauri shell additions — `src-tauri`

- **Keychain** (via the `keyring` crate — `Entry::new("neuralnote", "openrouter")` →
  `set_password` / `get_password` / `delete_credential`; macOS Keychain / Windows Credential Manager
  / libsecret). The key is read in Rust at call time and **never returned to the webview**.
  - `api_key_status() -> { has_key, model }`
  - `save_api_key(key, model)`
  - `clear_api_key()`
- **`chat(prompt, history, on_event: Channel<ChatEvent>)`** — reads the key from the keychain, runs
  the orchestrator with an OpenRouter `LlmClient`, and streams `ChatEvent`s. Async, on the worker
  pool (matching the existing `read_tree`/`search_vault` recipe), so the loop never freezes the UI.
- **OpenRouter client** — `reqwest` to `https://openrouter.ai/api/v1/chat/completions`,
  `Authorization: Bearer <key>`, OpenAI-compatible body with `tools` + `stream: true` (SSE). Exact
  request/response shape and the default model id are verified against current OpenRouter docs in the
  implementation plan, not asserted here.

## 6. The `ChatEvent` protocol (Rust → UI contract)

A serde-tagged enum streamed over the channel (camelCased, matching the repo's event convention):

`Searching { query }` · `Retrieved { query, hit_count }` · `Reading { rel_path, line_range }` ·
`Thinking { delta }` (optional reasoning tokens) · `Verifying` · `CitationDropped { reason }` ·
`Answer { delta }` (streamed answer text) · `Citation { id, rel_path, line_range, text }` ·
`Coverage { searched_terms, notes_read, truncated, skipped_files }` · `Error { message }` · `Done`.

`truncated` / `skipped_files` are carried through from the existing `SearchResponse` so search
limits surface honestly.

## 7. Frontend — chat pane on AI Elements

- **Library:** Vercel **AI Elements** (shadcn registry; Tailwind v4 + React 19 native). Adopted as
  **presentational components driven by our `ChatEvent` stream** — *not* the AI SDK `useChat`
  transport (the components are props-driven; `useChat` is only their example data source). Mapping:
  - `Tool` / `ToolHeader` / `ToolContent` ← `Searching` / `Retrieved` / `Reading` steps.
  - `Sources` / `Source` ← `Citation` events; clicking a source opens the note at the cited line
    (reuse `useOpenNote`).
  - `Message` / `MessageResponse` ← streamed `Answer` deltas (rendered with the existing
    `react-markdown` + `remark-gfm`).
  - `Reasoning` ← optional `Thinking` deltas. `PromptInput` ← the composer. `Conversation` ← scroll.
- **Setup cost:** add a shadcn `components.json` and the Radix primitives AI Elements depends on
  (none present today). One-time.
- **Key-setup panel** — shown *inside* the chat pane (not a blocking screen) when `has_key` is
  false: OpenRouter key + model fields, plus **"Skip for now"** (leaves the pane in a clearly
  disabled "Connect a key" state). Guided setup, never a stack trace (spec §6).
- **`api.ts` additions** — `apiKeyStatus`, `saveApiKey`, `clearApiKey`, and `chat(prompt, history,
  onEvent)` using `new Channel<ChatEvent>()`. The single TS↔Rust seam stays intact.

## 8. Error handling (spec §6 — failures are never silent)

- Missing/invalid key → the guided setup panel, not an error trace.
- Rate limit / timeout → explicit user-facing `Error` event; retry-with-backoff only for transient
  classes.
- No relevant evidence → the answer says "I couldn't find this in your vault"; it never fabricates a
  citation.
- Coverage footer counters overclaim: thin support is reported as partial, not synthesised as if the
  whole vault was read (advisor mitigation).

## 9. Testing (Definition of Done)

- **Rust unit** — `EvidenceSpan` construction; `CitationVerifier` (hash match, hash mismatch,
  quote-not-found); `KeywordRetriever`; tool dispatch; loop guards (max-iter, caps) — all against a
  **mock `LlmClient`** (no network).
- **TS unit/component** — key-setup form (save / skip / status); rendering of each `ChatEvent`
  variant; citation click → open note at line.
- **e2e (jsdom + mockIPC, `src/e2e/`)** — skip-onboarding path; key-set path; ask → streamed steps →
  cited answer; no-evidence path. The `chat` channel is mocked.
- **Integration (real)** — one real OpenRouter call over a tiny fixture vault → cited answer, gated
  on a key env var (CI without a key skips **loudly**).
- **Citation-faithfulness** — a minimal golden set (`question → expected note/lines`) exists from day
  one, so the harness (spec §7) is in place before RAG lands.

Security-adjacent bar applies (spec touches secrets, the IPC boundary, and untrusted note content):
independent adversarial review of the key handling and the citation verifier is required, not just a
green suite.

## 10. Deferred / next slices (the seam is built to take them)

- `VectorRetriever` returning the same `EvidenceSpan` shape (embeddings + vector store).
- Full-source capture + `.neuralnote/sources/` sidecar; the distiller; ingest adapters.
- Semantic recall; non-markdown sources.

## 11. Open questions for the implementation plan

1. Exact OpenRouter **default model id** (verify current) and request/response shape.
2. Where the OpenRouter `LlmClient` impl lives — core behind a `reqwest` feature, or the shell.
3. SSE parsing approach (`reqwest` + an eventsource stream vs manual line parsing).
4. `keyring` Linux backend feature selection (macOS-first for v1; confirm §8.4 desktop reach).
5. AI Elements install specifics — `components.json`, and the exact component subset to pull.
