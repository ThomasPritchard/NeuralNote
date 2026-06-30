# NeuralNote — Product & v1 Technical Spec

> Status: design draft. The **Vault-Slate foundation is built and verified** (open/create a
> vault, browse, read/edit markdown, file/folder CRUD — see `specs/app-vault-slate-plan.md`).
> The AI loop in this spec (capture → distil → embed → cited chat) is **not yet implemented**.

---

## 1. What it is

NeuralNote is an AI-native "second brain" desktop app, positioned as a **zero-setup alternative
to Obsidian**.

The core insight: Obsidian hands you a powerful empty room and a hardware store. The filing system,
the plugins, the capture pipelines, the note-taking method are all yours to assemble — and that
assembly is exactly the hump most people never get over. NeuralNote's thesis is that **the assembly
is the product**: the AI does the filing you currently do by hand. You throw in anything — a video, an
article, a PDF, a rambled voice memo, a photo of your handwritten notes — and what comes back is one
clean, **queryable, cited** knowledge base you can interrogate like a person who actually read all of
it.

### Why someone switches — the value, not the mechanism

The job to be done: **one place you throw anything into, in any form, and get back a clear, queryable,
cited knowledge base** — a second brain that can actually answer from everything you've fed it. The
value lives in the gap between messy input and structured, retrievable output, and NeuralNote closes
that gap for you instead of handing you the parts.

For the person it's built for — studying, researching, or just consuming a lot and wanting it to
*stick* — the day-to-day wins are concrete:

- **Capture in whatever form the thought arrives.** A YouTube lecture, an article, a PDF paper, a
  typed note, a rambled voice memo, a photo of handwritten notes (roadmap). All land in the same
  brain; all become searchable and citable. No "which app does this go in?"
- **Ramble in, structure out.** Brain-dump a half-formed idea and get back a clean, titled, tagged,
  linked note. The organising you'd never do by hand is done for you.
- **Ask your whole library, not one note.** "What have I read about X?" returns a synthesised answer
  drawn across *every* source you've captured, each claim citable back to the exact chunk or
  timestamp. Obsidian's keyword search can't do this, and a per-notebook tool can't either.
- **Trust what it tells you.** Every answer is grounded and verifiable: jump to the source, read it
  in context, quote it with the citation attached. For studying or writing, that's the difference
  between "the AI said so" and something you can stand behind.

**Why this beats staying in Obsidian.** Obsidian gives you the room and the tools; you build the
system, and it only ever knows the sparse notes you typed. NeuralNote *is* the built system, and it
knows the **full sources** behind your notes — so it answers questions you never wrote down. You move
into it not for more features, but because the assembly and the recall are already done.

### The moat — protect this above everything

Full-source cited recall is still the thing to protect. But it is **not** protected by *capturing*
the source, and this spec must stop claiming it is. Capture is table stakes: the official Obsidian
Web Clipper already grabs full article text, YouTube transcripts are a fetch, PDFs are already files.
And full-source cited RAG itself already ships — **Recall** does it at 500k+ users, **NotebookLM**
does it free, **AnythingLLM / Khoj / Reor** do it open-source and local. "We capture the source and
nobody can follow" does not survive contact with a reviewer who knows those products exist.

The real, defensible moat is the **combination** none of them hit at once:

1. **Local-vault ownership.** Recall and NotebookLM keep your library in *their* cloud. NeuralNote's
   source of truth is your own Obsidian-compatible files on disk. The Obsidian RAG plugins are local
   but see only the *sparse note you typed*, not the full source.
2. **Zero-setup opinionated loop that swallows any input.** AnythingLLM and Khoj are generic toolkits;
   Recall is read-later-shaped; a per-notebook tool wants manual uploads. NeuralNote ships one tight
   capture → distil → cite loop that takes *any* form — links, PDFs, typed brain-dumps, voice, scanned
   pages — with no macros, templates, or config.
3. **Citation fidelity as a release gate.** Timestamp-accurate, never fabricated, regression-blocking
   (Section 7). This is execution quality rather than a structural secret, so it must be *earned and
   defended*, not declared.

Defensibility lives in execution quality + local-ownership + the opinionated loop. Every v1 decision
protects retrieval quality and citation fidelity first.

Positioning: hook on *"the second brain that actually read your sources,"* support with *"no filing,
no setup — just open your vault."* (v1 is zero-*filing*-setup, not literally zero-setup; the BYO-key
caveat is in Section 4.)

### Competitive reality (do not pretend this lane is empty)

- **Recall** (recall.it, 500k+ users) — the closest competitor and this spec's former blind spot.
  Saves articles, YouTube, podcasts, PDFs with the **full text kept in the library**, auto-summarises,
  and offers **chat with citations that link back to the source**, on your choice of GPT/Claude/Gemini.
  The daylight: its library lives in **its cloud**, not your local Obsidian-compatible files.
- **NotebookLM** (Google, free, Gemini 3, ~1M-token context) — the gold-standard cited-RAG demo
  everyone benchmarks against. Cloud-only, manual upload, no auto-capture pipeline, not a local vault —
  but it sets the "magic" bar, and it is free.
- **AnythingLLM / Khoj / Reor** — open-source, local, cited RAG over your documents *today*. Proof
  that the local full-source-RAG code is commodity. They are generic (no auto-distil/tag, no capture
  loop, not Obsidian-native), which is exactly the gap NeuralNote fills.
- **Obsidian is itself pre-baking.** Native **Bases** (GUI database) is eating Dataview's common case;
  the **official Web Clipper** ships an LLM "Interpreter" that summarises on capture. The setup-pain
  gap is one Obsidian is actively narrowing.
- **Note Companion** — live Obsidian plugin doing AI auto-tag/organise/format, YouTube + audio
  transcription, @-mention chat, BYO-key or cloud. Desktop-only (same as v1), and it sees only the
  sparse vault note, not the full source.

Differentiation rests on the three-part moat above, not on "we capture the source."

---

## 2. Product pillars

1. **Foundation — universal capture & effortless recall.** Throw in anything, in any form (video,
   article, PDF, typed brain-dump, voice, scanned page); AI distils, tags, links, and files it. Zero
   macros, zero templates, zero config.
2. **Hero — ask your whole brain, every answer cited.** Query across *everything* you've captured, not
   one note at a time; get synthesised answers grounded in your knowledge, each claim linked to the
   exact chunk or timestamp.
3. **Migration — move your brain in, lose nothing.** Open your existing Obsidian/markdown vault on day
   one (the format is compatible, so it's just opening the folder); Notion as the first import
   fast-follow.
4. **Later (north star) — proactive thinking-partner.** Surfaces connections, prompts, and matured
   ideas without being asked.

---

## 3. Business model & tiers (north star, not v1)

Mirrors Obsidian's proven model: the local app is free and complete; the cloud is the paid layer.

| Layer | Who it's for | Free / Paid |
|---|---|---|
| Local files (source of truth, ownership) | Everyone; desktop-strong | Free |
| BYO-key / local AI | Power lane (true privacy only with *local* AI — see below) | Free |
| Cloud **Sync** (multi-device equaliser) | Multi-device users | **Paid** |
| Cloud **AI** managed (mid-flight processing, mobile parity) | "Just handle it" users | **Paid** |

**Parity is by tier, not platform.** A paying (cloud) user gets identical full-power features on
desktop and mobile; a free local-first user gets a powerful *desktop* brain and a deliberately
thinner *mobile* one — because the thing that lights up mobile (cloud sync + cloud AI) is the paid
layer. "Fully-local AI" is realistically a desktop strength; on-device phone models are improving
fast, but the heavy models still want a desktop (treat this as a v1-era assumption, not a permanent
law).

**Open-core for trust — timed deliberately.** The long-term shape is an open desktop client with a
closed server / managed-AI / sync layer. But *when* to open the client matters more than whether:

- **Not at v1.** Pre-traction the effort is better spent on the product than on running a clean
  open-source release. And the RAG *code* is not a secret worth guarding — it is already open-source
  elsewhere (AnythingLLM/Khoj/Reor). What's worth protecting is brand, distribution, accumulated user
  trust, and citation-fidelity execution, none of which open-sourcing the client gives away. (This
  corrects the earlier framing that the moat "lives in the client code" — it does not.)
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

**Privacy, stated honestly.** "Local-first" describes *where your files live*, not *where your
content goes*. In the v1 BYO-cloud-key configuration the full content of every source is sent to a
third party: to the LLM provider on distil, to the embedding provider on ingest (v1 commits to an API
embedder — Section 4), and to the LLM again on every chat query. Your *files* stay on disk; your
*content* does not. The genuinely private configuration — local embeddings + a local LLM — is a later
option, not v1. Do not market v1 as *private*; market it as *yours* (you own the files) and *honest*
(we tell you exactly what leaves the machine).

---

## 4. v1 — the smallest lovable cut

v1 exists to answer one question: **does cited chat across your whole auto-distilled library actually
feel like magic?** Everything else is downstream of that yes. v1 target user is the **Obsidian
refugee** — a power user who finds the setup exhausting and can comfortably supply their own API key —
but the value story it proves out is the broader one: *throw anything in, query a clear cited brain
back* (Section 1).

**In scope:**

- **Platform:** desktop only, **Tauri 2** (single framework; mobile-capable *later* with real
  caveats, not free parity — see Section 8).
- **Data:** local-first **markdown + YAML frontmatter**, deliberately **Obsidian-vault-compatible**
  (schema in Appendix A). Local **SQLite** index + **embedded vector store**. The **full source** is
  retained in a hidden in-vault sidecar (`.neuralnote/sources/`, ignored by Obsidian's dotfolder
  rule) and referenced from the note's frontmatter — so it travels with the vault and survives a move,
  without dumping raw transcripts into the user's file tree.
- **AI:** **BYO-key.** Default to Claude (a fast model for distillation, a strong model for chat);
  OpenAI-compatible endpoints supported. **Embeddings: a strong API model (e.g. Voyage / OpenAI),
  committed at v1** — the embedding model is near-irreversible to change (Section 8), so v1 buys
  quality now rather than deferring. A local-embeddings option is a later privacy config, not v1.
- **Secrets:** the API key is stored in the **OS keychain** (macOS Keychain / Windows Credential
  Manager / libsecret), never in plaintext config.
- **Capture paths.** The vision is *capture in any form*; v1 ships the highest-leverage subset and
  fast-follows the rest, each reusing the same distil → embed → cite pipeline:
  - **In v1:** links (YouTube transcript / web article), files (PDF), typed/pasted text — including
    raw **brain-dumps**: ramble out a half-formed note and the distiller returns a clean, titled,
    tagged, linked version. *Messy-in, structured-out* is a first-class job here, not just summarising
    external sources.
  - **First fast-follows** (cheap, because the pipeline already exists): **voice** (dictate → STT →
    distil), then **image / scanned page → note** (OCR → distil) — the latter turns a photo of
    handwritten or printed notes into a searchable, citable note, riding the same OCR + low-confidence
    citation tier already specced for scanned PDFs (Section 6). These are *not* in v1, but they're the
    next two adapters and the architecture is built to take them.
  - Capture is **idempotent**: re-capturing the same URL or file (matched on a normalised source URL
    or content hash) updates the existing note rather than spawning duplicate notes, embeddings, or
    citations.
- **The core loop:**
  `capture → AI distil (summary + key claims) + infer title/tags/links/frontmatter → write note +
  full source to vault → embed → cited chat (scoped to note / folder / whole vault)`.
  ("Project" scope = a **vault folder**, the Obsidian-native zero-config grouping primitive. No new
  data concept; the user's folder structure *is* the project structure.)
- **Cheap wins that earn their v1 place** (each near-free given the infra above):
  - AI-inferred title/tags/links/frontmatter on capture (collapses QuickAdd + Templater + Linter
    into nothing).
  - Semantic auto-linking on ingest (free from the vector store).
  - Semantic + keyword search (a better Omnisearch, free from the vector store).
  - **Open an existing Obsidian/markdown vault** — the headline onboarding feature. "Migrate from
    Obsidian" is just "open the folder."

**Cost is a first-class concern (BYO-key = the user pays per token).** Full-source ingestion and RAG
chat both burn the user's own tokens. v1 must: (a) show an estimated token/cost footprint before
embedding a large source; (b) cap and warn on retrieval context size per chat turn; (c) keep distil
prompts lean. Embedding spend is small (≈$18 per 100M tokens even on Voyage); the real cost is chat
over large retrieved context, so context-window management is the lever. Never surprise the user with
a bill.

**What "done" looks like (the v1 ship gate).** v1 exists to answer "does cited chat over
auto-distilled captures feel like magic?" — so make that measurable:

- **Citation faithfulness ≥ 95%** of sampled answer-citations actually support their claim (Section 7
  defines the harness). Any regression below the last release's number blocks ship.
- End-to-end capture → cited answer works on all three v1 capture types against real fixtures.
- Dogfood: Tom's daily YouTube-distillation workflow runs for two weeks with no silent failures.

(The 95% is a starting proposal — tune it against the first real eval runs, but ship *with* a number,
not a vibe.)

**Explicitly NOT in v1** (on the roadmap, off the critical path):

voice capture (1st capture fast-follow) · image/scanned-page-to-note (2nd capture fast-follow) · sync ·
mobile · managed cloud AI · PWA · billing · proactive nudges/resurface feed · NL-query-over-metadata
(Dataview replacement; Bases is eating it anyway) · Notion import (first import fast-follow) ·
tasks/kanban/canvas · spaced-repetition cards · live file-watching (v1 re-indexes on launch/focus
instead) · open-source-release decision.

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

*Not drawn: every stage has a failure edge back to the UI (Section 6). Capture, distil, embed, and
chat each surface errors explicitly rather than failing silently.*

**Components:**

- **Ingest adapters** — one per source type, all converging on the same `raw source + metadata`
  contract so new forms are additive. v1: URL → YouTube transcript or readable article text; PDF →
  extracted text; text → passthrough (incl. raw brain-dumps). Fast-follow, same contract: voice → STT;
  image/scan → OCR.
- **Distiller** — LLM calls that produce the summary, extract key claims, and infer title/tags/
  links/frontmatter.
- **Vault store** — writes one markdown file per note (Obsidian-compatible frontmatter, Appendix A)
  plus the retained full source in the hidden `.neuralnote/sources/` sidecar. Atomic writes; never
  corrupts user markdown. Re-indexes externally-changed files on app launch and window focus
  (Section 6).
- **Indexer** — SQLite for structure/metadata; embedded vector store for embeddings of the
  **full-source chunks** (not just the note).
- **Retrieval / RAG** — scoped retrieval (note / folder / whole vault) over full-source chunks,
  returning chunks with exact provenance (file + offset, or video timestamp).
- **Chat orchestrator** — assembles retrieved context, calls the LLM, and maps every claim back to
  the chunk that supports it for jump-to citations. **Mechanism (the moat's crux, not an
  implementation detail):** the model is constrained to answer *only* from retrieved chunks and to
  tag each claim with its source chunk id; a **post-hoc verification pass** then checks that each
  cited chunk actually entails its claim, and **drops or flags any citation that fails**. Generated
  citation markers are never trusted unverified — that is exactly how a confident wrong citation
  slips through. The final technique is settled in the plan, but the *guarantee* is fixed here: no
  unverified citation reaches the user.

---

## 6. Failure modes & error handling (v1)

Trust is the product, so failures are first-class, never silent.

- **Capture failures** (no transcript, paywalled/garbled article, unparseable PDF) — surface
  clearly, keep the raw capture, mark a visible "couldn't distil" state. Never drop user input
  silently. **YouTube transcript fetch is explicitly best-effort, never reliability-critical:** it
  scrapes internal endpoints against YouTube ToS and can break on a player change (PoToken,
  cloud-IP blocks — Section 8). Local-first BYO-key softens this (requests originate from the user's
  own residential IP), but failures must be loud, and a commercial transcript API is the planned
  fallback.
- **LLM / API failures** (bad key, rate limit, timeout) — explicit user-facing errors; retry with
  backoff only for transient classes. A missing/invalid key is a guided setup prompt, not a stack
  trace.
- **Citation integrity** — **never fabricate a citation.** If retrieval returns nothing relevant,
  the answer says so rather than inventing one. Every citation is verified before it reaches the user
  (the mechanism is in Section 5). *A wrong citation is worse than no answer* — it destroys the one
  thing that makes NeuralNote trustworthy.
- **Citation confidence tiers** — native-text sources (typed text, native-text PDFs, clean
  transcripts) cite at exact offset/timestamp = **high confidence**. OCR'd / scanned PDFs have
  approximate sub-page offsets, so they cite at **page level only / low confidence** and are visibly
  marked as such. An OCR-derived offset is never presented with the same authority as native text.
- **Vault integrity & external edits** — writes are atomic; user markdown is never corrupted. The
  vault is just files, so they can change underneath us (mid-migration, or via another markdown tool —
  ownership means we don't lock them). v1 reconciles by **re-indexing changed files on app launch and
  on window focus** — not live
  file-watching, but enough that a stale index or citation is corrected the next time the app comes
  forward. The staleness window between an external edit and the next focus is the accepted v1
  limitation; live file-watching is a fast-follow.

---

## 7. Testing strategy (v1)

- **Unit** — ingest adapters, frontmatter generation, chunking.
- **Integration** — end-to-end capture → distil → store → chat against real fixtures (a real
  YouTube link, a real PDF, a text note). This is the honest signal that the wiring works; run it
  after each significant phase, not just unit tests.
- **Citation-faithfulness eval** — the moat needs a real harness, not a vibe check. Maintain a
  **golden set** of `question → expected-answer → known-correct-source-chunk(s)` across all capture
  types. Score each answer two ways: (1) automated **LLM-judge entailment** — does the cited chunk
  actually support the claim? — spot-audited by a human to keep the judge honest; and (2) **retrieval
  hit-rate** — did the known-correct chunk get retrieved at all? Target **≥ 95%** citation
  faithfulness; treat any drop below the last release's number as a **release blocker**. Re-run on
  every change to chunking, retrieval, or prompts (the three levers that move it).
- **Dogfood** — Tom's own YouTube-distillation workflow, from day one.

---

## 8. Stack direction & open questions

Direction is set; exact libraries/versions are **finalised in the implementation plan against
current docs**, not asserted from memory here.

- **Desktop shell:** Tauri 2 (stable since Oct 2024). Mobile is a *single-framework path*, **not
  free parity**: Tauri's own 2.0 notes call the mobile DX unfinished and flag that not all official
  plugins support mobile, and a RAG app's mobile story really hinges on the stack *underneath* —
  on-device embeddings, the vector store, the vault filesystem under iOS sandboxing, background
  embedding under Doze limits — none of which ports for free. Treat mobile as a future bet the
  framework *enables*, not a capability it delivers.
- **Storage:** official SQLite plugin (`tauri-plugin-sql`) + embedded vector search. **sqlite-vec**
  rides the SQLite we already have (one file, exact brute-force KNN) but is pre-1.0 with **no ANN
  index** and degrades past ~1M vectors. **LanceDB** is Rust-native with real ANN (HNSW + IVF) but is
  a second storage engine to back up and manage. Full-source chunking explodes vector counts fast
  (whole articles / PDFs / transcripts), so the brute-force ceiling is a live risk: **lean LanceDB
  unless the plan's chunk-volume math proves the vault stays small.** Decide in plan, with that math
  done first.
- **AI:** BYO-key; Claude default (fast model for distil, strong model for chat); OpenAI-compatible.
- **Embeddings:** **committed to an API model for v1 (e.g. Voyage / OpenAI)** for best retrieval
  quality. This is a **near-irreversible** choice: switching models later re-embeds the entire corpus
  *and* — under sqlite-vec — forces a schema migration, since the dimension is baked into `float[N]`.
  Pick the specific model deliberately in the plan and treat it as a contract. Local embeddings are a
  later privacy config.
- **Source extraction:** **PDF** — `pdfium-render` (robust; exposes page/char geometry for citation
  offsets), with OCR (`tesseract-rs` / `ocrs`) routed only to scanned pages. **YouTube** —
  best-effort scraping (`youtube-transcript-api`-class), against ToS and fragile to YouTube's PoToken
  / cloud-IP defenses; plan a commercial transcript API as fallback. Finalise exact libraries in plan.

**Open questions for plan / later:**

1. **Chunking strategy for full-source RAG** (timestamp-aware for video). *This is the most
   moat-critical open item — chunk size is where citation precision and retrieval quality are won or
   lost — so it earns the most plan attention, not the least.*
2. Vector store: sqlite-vec vs LanceDB (the chunk-volume math from Section 8 decides).
3. Exact API embedding model + dimension (the *API* path is committed; the specific model is the
   contract to lock).
4. v1 desktop reach: macOS-first vs all three desktop OSes.
5. Live file-watching as a fast-follow to v1's launch/focus re-index.
6. Open-client licence (deferred to cloud launch — Section 3).

*Resolved since the review draft:* embeddings (API, committed); external-edit reconciliation
(launch/focus re-index in v1); full-source storage layout (hidden in-vault sidecar); "project" scope
(= vault folder).

---

## 9. Risks

- **Competitors already occupy the lane** (Recall, NotebookLM, AnythingLLM/Khoj, Obsidian
  Bases/Clipper, Note Companion). → Compete on the three-part moat (local-vault + zero-setup loop +
  citation fidelity, Section 1), not on "we capture the source," which is table stakes.
- **Scope creep.** The full vision is coherent and therefore tempting to build at once. → This
  spec's v1 / non-goals line is the defence; everything else is the roadmap.
- **Citation trust.** One confident wrong citation can sink the product. → Citation-faithfulness
  eval + "no answer beats a wrong answer."
- **BYO-key friction.** Getting an API key is power-user territory; the average user won't. → v1
  deliberately targets the Obsidian refugee who can; managed cloud AI (paid) solves it for the
  average user later, not now.
- **Token-cost surprise.** BYO-key means the user pays; a careless RAG implementation can run up a
  bill. → Cost-awareness is a v1 requirement (Section 4): estimate before embedding, cap retrieval
  context, keep prompts lean.
- **Privacy expectation mismatch.** "Local-first" reads as "private," but content goes to the LLM and
  embedding providers. → Market as *yours*, not *private* (Section 3); local-AI privacy is a later
  config, stated plainly up front rather than discovered.

---

## Appendix A — Note frontmatter schema (v1)

Obsidian-compatible YAML. NeuralNote's own keys are namespaced under `nn` so they're obviously ours
and won't collide with the user's properties, Bases, or other plugins. Standard keys (`tags`,
`aliases`) stay top-level for Obsidian/Bases compatibility.

```yaml
---
title: "Attention Is All You Need — distilled"
aliases: ["Transformer paper"]
tags: [ml, transformers, architecture]
created: 2026-06-29T14:03:00Z
nn:
  source:
    type: youtube            # youtube | article | pdf | text
    url: "https://www.youtube.com/watch?v=..."
    captured_at: 2026-06-29T14:02:11Z
    full_source: ".neuralnote/sources/2026/att-is-all-you-need.vtt"   # sidecar path
    content_hash: "sha256:…"  # idempotency / dedup key
  distil:
    model: "claude-…"
    distilled_at: 2026-06-29T14:03:00Z
    status: ok               # ok | failed | raw-only
  embedding:
    model: "voyage-…"
    dim: 1024
    indexed_at: 2026-06-29T14:03:10Z
  links: ["[[Self-Attention]]", "[[Sequence Models]]"]   # AI-inferred, plain wikilinks
---
```

Design rules:

- **The body is normal markdown** the user reads and edits in Obsidian. The distilled summary + key
  claims live in the body; frontmatter is metadata only.
- **`nn.source.full_source`** points at the hidden sidecar, so the note ↔ full-source link survives a
  vault move.
- **`content_hash`** is the dedup key — re-capturing the same source updates this note rather than
  creating a duplicate.
- **`nn.embedding.{model,dim}`** records the embedding contract per note, so a model change is
  *detectable* and re-index can be targeted, not blind.
- **Citations are not stored in frontmatter** — they're resolved at chat time from chunk offsets held
  in the index, against the immutable full source in the sidecar.
- **Stripping the whole `nn:` block must leave a clean, valid Obsidian note.** The ownership promise:
  the user can walk away and lose nothing but our convenience metadata.
