# Neural Note — Product & v1 Technical Spec

> Status: design draft for review. No code yet. The terminal step after this spec is an
> implementation plan (plan mode), not implementation.

---

## 1. What it is

Neural Note is an AI-native "second brain" desktop app, positioned as a **zero-setup alternative
to Obsidian**.

The core insight: Obsidian hands you a powerful empty room and a hardware store. The filing system,
the plugins, the capture pipelines, the note-taking method are all yours to assemble — and that
assembly is exactly the hump most people never get over. Neural Note's thesis is that **the assembly
is the product**: the AI does the filing you currently do by hand.

### The moat — protect this above everything

Every Obsidian AI plugin embeds the *sparse note you typed*, because that's all that lives in the
vault. Neural Note **captures and stores the entire source** (full article, full PDF, full
transcript with timestamps) as part of ingestion, then runs retrieval over that. The result: chat
can answer questions **you never wrote down**, citing the exact chunk or timestamp.

Competitors can't easily follow, because the part they offload to the user — capturing the full
source — is the part Neural Note owns. This is the defensible wedge. Every v1 decision should
protect retrieval quality and citation fidelity first.

Positioning: hook on *"no setup"*, prove with *"the second brain that actually read your sources."*

### Competitive reality (do not pretend this lane is empty)

- **Obsidian is itself pre-baking.** Native **Bases** (GUI database) is eating Dataview's common
  case; the **official Web Clipper** now ships an LLM "Interpreter" that summarises on capture. The
  setup-pain gap is one Obsidian is actively narrowing.
- **Note Companion** is a live competitor already doing much of the foundation (AI auto-tag/
  organise/format, YouTube + audio transcription, @-mention chat, BYO-key or cloud).

Differentiation rests on two things only: (1) the full-source cited-RAG moat, and (2) one tight,
opinionated loop instead of a toolbox of features.

---

## 2. Product pillars

1. **Foundation — effortless capture & recall.** Throw anything in; AI distils, tags, links, and
   resurfaces. Zero macros, zero templates, zero config.
2. **Hero — chat-led synthesis, every answer cited.** Ask anything; get answers grounded in your
   knowledge, each claim linked to its exact source.
3. **Migration — "bring your brain with you."** Obsidian on day one (it's just opening your vault,
   since the format is compatible); Notion as the first fast-follow.
4. **Later (north star) — proactive thinking-partner.** Surfaces connections, prompts, and matured
   ideas without being asked.

---

## 3. Business model & tiers (north star, not v1)

Mirrors Obsidian's proven model: the local app is free and complete; the cloud is the paid layer.

| Layer | Who it's for | Free / Paid |
|---|---|---|
| Local files (source of truth, ownership) | Everyone; desktop-strong | Free |
| BYO-key / local AI | Privacy & power lane | Free |
| Cloud **Sync** (multi-device equaliser) | Multi-device users | **Paid** |
| Cloud **AI** managed (mid-flight processing, mobile parity) | "Just handle it" users | **Paid** |

**Parity is by tier, not platform.** A paying (cloud) user gets identical full-power features on
desktop and mobile; a free local-first user gets a powerful *desktop* brain and a deliberately
thinner *mobile* one — because the thing that lights up mobile (cloud sync + cloud AI) is the paid
layer. "Fully-local AI" is realistically a desktop strength; phones can't run the heavy models.

**Open-core for trust — timed deliberately.** The long-term shape is an open desktop client with a
closed server / managed-AI / sync layer. But *when* to open the client matters more than whether:

- **Not at v1.** In v1 the moat (full-source ingestion + RAG) lives entirely in the client, so
  open-sourcing it pre-traction would hand a competitor the one hard part. And at v1 there is nothing
  to distrust yet — local-first, BYO-key, nothing leaves the machine except to the user's own API
  key.
- **Open the client when the cloud tier launches**, as the trust counterweight to "we now offer
  cloud sync + managed AI." That is the moment "is my data safe?" becomes a live question, and an
  open, auditable client is what answers it — proving exactly what does and doesn't leave the device.
- **Middle path:** "source-available" (visible, not freely forkable) can deliver the transparency
  signal earlier without the fork-and-close risk, graduating to a true OSI licence later.
- **Licence (deferred).** Permissive (MIT/Apache — maximum goodwill, but forkable-and-closable) vs
  copyleft; **AGPL** on the client plus a proprietary server is the standard open-core stance that
  blocks a closed rival fork. Decide when the cloud ships, not now.

**Data/AI shape.** Hybrid local-first: files you own on disk + cloud LLM for the smart parts.
`local-first` vs `cloud-first` is just whether the local copy is the source of truth or a cache —
one engine, one cloud, a boundary flag. A future PWA is the cloud-first entry point, not a second
product.

---

## 4. v1 — the smallest lovable cut

v1 exists to answer one question: **does cited chat over auto-distilled captures actually feel like
magic?** Everything else is downstream of that yes. v1 target user is the **Obsidian refugee** — a
power user who finds the setup exhausting and can comfortably supply their own API key.

**In scope:**

- **Platform:** desktop only, **Tauri 2** (single framework, mobile-capable later — verified).
- **Data:** local-first **markdown + YAML frontmatter**, deliberately **Obsidian-vault-compatible**.
  Local **SQLite** index + **embedded vector store**. The **full source** is stored alongside the
  note.
- **AI:** **BYO-key.** Default to Claude (a fast model for distillation, a strong model for chat);
  OpenAI-compatible endpoints supported.
- **Capture paths:** links (YouTube transcript / web article), files (PDF), typed/pasted text.
  Voice (dictate → transcribe) is in v1 but **sequenced last** (it drags in a speech-to-text
  dependency).
- **The core loop:**
  `capture → AI distil (summary + key claims) + infer title/tags/links/frontmatter → write note +
  full source to vault → embed → cited chat (scoped to note / project / whole vault)`.
- **Cheap wins that earn their v1 place** (each near-free given the infra above):
  - AI-inferred title/tags/links/frontmatter on capture (collapses QuickAdd + Templater + Linter
    into nothing).
  - Semantic auto-linking on ingest (free from the vector store).
  - Semantic + keyword search (a better Omnisearch, free from the vector store).
  - **Open an existing Obsidian/markdown vault** — the headline onboarding feature. "Migrate from
    Obsidian" is just "open the folder."

**Explicitly NOT in v1** (on the roadmap, off the critical path):

sync · mobile · managed cloud AI · PWA · billing · proactive nudges/resurface feed · NL-query-over-
metadata (Dataview replacement; Bases is eating it anyway) · Notion import (first fast-follow) ·
tasks/kanban/canvas · spaced-repetition cards · open-source-release decision.

---

## 5. Architecture (v1)

A **shared Rust core engine** behind a thin Tauri webview shell. The core is deliberately
client-agnostic so future mobile/PWA clients reuse it rather than reimplement it.

```
            ┌─────────────────────────── Tauri shell (webview UI) ───────────────────────────┐
            │   Capture surface   │   Chat surface (cited)   │   Vault / search browser       │
            └───────────────┬──────────────────┬──────────────────────────┬──────────────────┘
                            │                  │                          │
        ┌───────────────────▼──────────────────▼──────────────────────────▼───────────────────┐
        │                                 Rust core engine                                     │
        │                                                                                       │
        │  Ingest ──▶ Distiller ──▶ Vault store ──▶ Indexer ──▶ Retrieval/RAG ──▶ Chat          │
        │  adapters    (LLM)        (md+frontmatter  (SQLite +   (scoped, full-     orchestrator │
        │  url/pdf/                  + full source)   vectors)    source chunks,    (LLM + cite  │
        │  text/[voice]                                           citations)         mapping)    │
        └───────────────────────────────────────────────────────────────────────────────────────┘
                            │
                            ▼
                     BYO-key LLM API (Claude default / OpenAI-compatible)
```

**Components:**

- **Ingest adapters** — one per source type. URL → YouTube transcript or readable article text;
  PDF → extracted text; text → passthrough; (voice → STT, later). Each yields raw source + metadata.
- **Distiller** — LLM calls that produce the summary, extract key claims, and infer title/tags/
  links/frontmatter.
- **Vault store** — writes one markdown file per note (Obsidian-compatible frontmatter) plus the
  retained full source. Atomic writes; tolerant of external edits.
- **Indexer** — SQLite for structure/metadata; embedded vector store for embeddings of the
  **full-source chunks** (not just the note).
- **Retrieval / RAG** — scoped retrieval (note / project / whole vault) over full-source chunks,
  returning chunks with exact provenance (file + offset, or video timestamp).
- **Chat orchestrator** — assembles retrieved context, calls the LLM, and maps every claim back to
  the chunk that supports it for jump-to citations.

---

## 6. Failure modes & error handling (v1)

Trust is the product, so failures are first-class, never silent.

- **Capture failures** (no transcript, paywalled/garbled article, unparseable PDF) — surface
  clearly, keep the raw capture, mark a visible "couldn't distil" state. Never drop user input
  silently.
- **LLM / API failures** (bad key, rate limit, timeout) — explicit user-facing errors; retry with
  backoff only for transient classes. A missing/invalid key is a guided setup prompt, not a stack
  trace.
- **Citation integrity** — **never fabricate a citation.** If retrieval returns nothing relevant,
  the answer says so rather than inventing one. *A wrong citation is worse than no answer* — it
  destroys the one thing that makes Neural Note trustworthy.
- **Vault integrity** — writes are atomic; user markdown is never corrupted. Because the vault is
  Obsidian-compatible, files can change underneath us; reconciliation of external edits is an
  acknowledged open question (Section 8).

---

## 7. Testing strategy (v1)

- **Unit** — ingest adapters, frontmatter generation, chunking.
- **Integration** — end-to-end capture → distil → store → chat against real fixtures (a real
  YouTube link, a real PDF, a text note). This is the honest signal that the wiring works; run it
  after each significant phase, not just unit tests.
- **Citation-faithfulness eval** — the moat needs a test. Sample chat answers and verify each
  citation's chunk actually supports its claim. Treat a faithfulness regression as a release
  blocker.
- **Dogfood** — Tom's own YouTube-distillation workflow, from day one.

---

## 8. Stack direction & open questions

Direction is set; exact libraries/versions are **finalised in the implementation plan against
current docs**, not asserted from memory here.

- **Desktop shell:** Tauri 2 (verified current; stable iOS/Android support → single-framework path
  to future mobile parity).
- **Storage:** official SQLite plugin (`tauri-plugin-sql`) + embedded vector search — **sqlite-vec**
  (rides the SQLite we already have) vs **LanceDB** (Rust-native): decide in plan.
- **AI:** BYO-key; Claude default (fast model for distil, strong model for chat); OpenAI-compatible.
- **Embeddings:** API (e.g. Voyage / OpenAI) vs a local embedding model — privacy vs quality vs
  cost trade-off: decide in plan.
- **Source extraction:** YouTube transcript fetch + PDF text extraction libraries: decide in plan.

**Open questions for plan / later:**

1. Embeddings local vs API.
2. Vector store: sqlite-vec vs LanceDB.
3. Chunking strategy for full-source RAG (timestamp-aware for video).
4. v1 desktop reach: macOS-first vs all three desktop OSes.
5. External-edit reconciliation for the Obsidian-compatible vault.
6. Open-client licence (deferred).

---

## 9. Risks

- **Competitors close the gap** (Obsidian Bases/Clipper; Note Companion). → Protect the full-source
  cited-RAG moat; don't compete on pre-baked breadth alone.
- **Scope creep.** The full vision is coherent and therefore tempting to build at once. → This
  spec's v1 / non-goals line is the defence; everything else is the roadmap.
- **Citation trust.** One confident wrong citation can sink the product. → Citation-faithfulness
  eval + "no answer beats a wrong answer."
- **BYO-key friction.** Getting an API key is power-user territory; the average user won't. → v1
  deliberately targets the Obsidian refugee who can; managed cloud AI (paid) solves it for the
  average user later, not now.
