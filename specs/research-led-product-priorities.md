# NeuralNote research-led product priorities

> Status: product direction and roadmap input, not an implementation contract.
>
> Research date: 15 August 2026.
>
> Relationship to the main spec: this document records market evidence, recommended feature
> families, sequencing, and non-goals. It does not widen the v1 scope in
> [`neural-note.md`](neural-note.md). Each feature still requires its own approved slice spec before
> implementation.

## 1. Decision summary

NeuralNote should not try to rival Obsidian, Notion, and NotebookLM by accumulating all of their
features. That route would reproduce the setup burden and feature creep that users already complain
about.

The recommended product position is:

> **Apple Notes simplicity, Obsidian ownership, and NotebookLM source intelligence across one
> continuous vault.**

The product should feel like a calm notes app while capture, organisation, indexing, linking,
retrieval, provenance, and AI processing happen underneath. The user owns ordinary Markdown and
YAML files throughout.

The primary product loop remains:

`capture -> organise -> retrieve -> verify -> reuse`

The highest-priority work is anything that makes this loop faster, more trustworthy, or more useful
across the whole vault. Features that turn NeuralNote into a general workspace are lower value and
carry a high risk of diluting the product.

## 2. Research basis

### 2.1 Method

The research sampled public English-language X conversations using the logged-in X search surface on
15 August 2026. Seven thematic Top searches were reviewed, followed by two reply threads. The search
surface returned roughly 30 visible post cards, with overlap between themes; off-topic results and
duplicates were excluded from the evidence log. Because Top search is ranked and personalised, this
was a qualitative scan rather than a fixed-size or random sample.

Searches covered:

- Obsidian notes, vaults, knowledge, setup, plugins, complexity, and overwhelm;
- Notion notes, knowledge, workspace use, and feature creep;
- NotebookLM sources, research, studying, missing capabilities, and limitations;
- AI memory, second brains, context loss, old conversations, and Claude or Obsidian workflows;
- two high-engagement reply threads about simple Markdown notes and Notion feature creep.

Broad feature searches used a minimum-like threshold of 20 where the search syntax supported it.
Pain-point searches used 10. Results were not restricted to a fixed historical window; the visible
posts ranged from 2024 to August 2026. Candidate evidence was selected when a post or its replies
described a concrete job, complaint, workaround, migration, or desired outcome and exposed public
engagement counts.

The sample is directional, not statistically representative. X top search favours large accounts,
controversy, novelty, and growth-oriented posts. Detailed complaints, workflow descriptions, reply
threads, and bookmarks were treated as stronger product evidence than likes alone.

### 2.2 Product hypotheses supported by observed engagement

| Observed theme | Representative engagement observed | Hypothesis to validate |
|---|---:|---|
| AI memory and a second brain that compounds | 6.9M views, 30.9K likes, 85.2K bookmarks, 784 replies | Accumulated context may be valuable when it remains useful across sessions and sources. |
| Source-grounded learning with NotebookLM | 5.7M views, 17K likes, 32K bookmarks, 255 replies | Turning large source sets into questions, comparisons, and learning outputs may drive repeated use. |
| Automatic capture and organisation | 927K views, 4.5K likes, 10.9K bookmarks | The aspiration is a system that improves without constant manual filing. |
| Simple Markdown notes | 319K views, 1,093 bookmarks, 739 replies | Local Markdown with Apple Notes-level cognitive load is a strong target-user hypothesis. |
| Backlash against Notion feature creep | 406K views, 7.9K likes, 292 replies | Product identity, speed, and ease of use may matter more than broad feature coverage. |
| Visual knowledge graphs | Strong novelty engagement, weaker workflow evidence | Graphs are useful supporting navigation, but weak evidence supports making them the core product. |

These numbers are snapshots from 15 August 2026 and should not be treated as stable market-size
estimates.

### 2.3 Repeated jobs users want done

- Capture an idea or source immediately, without deciding where it belongs first.
- Preserve source material rather than keeping only a lossy summary.
- Turn rough input into clean, linked, searchable knowledge automatically.
- Ask questions across accumulated material without rebuilding context every session.
- Verify an answer against the exact source passage.
- Understand what is new, repeated, contradictory, important, or weakly supported.
- Keep files portable, local, fast, and readable outside the application.
- Start simply and reveal advanced controls only when they become relevant.
- Reuse knowledge for studying, writing, decisions, projects, and AI context.

### 2.4 Representative evidence log

Engagement values below were observed on 15 August 2026. They are included for traceability, not as
stable measurements or proof of product demand.

- [AI second brain built around Claude and Obsidian](https://x.com/ridark_eth/status/2068753952850546985):
  6.9M views, 30.9K likes, 85.2K bookmarks, and 784 replies. The post framed the job as recovering
  scattered notes, sources, browser tabs, and old AI conversations without rebuilding context.
- [NotebookLM study workflow](https://x.com/ihteshamali/status/2030214970353602806): 5.7M views,
  17K likes, 32K bookmarks, and 255 replies. The value proposition was turning a large body of
  source material into accelerated, question-led learning.
- [Automated multi-source Obsidian workflow](https://x.com/browomo/status/2052333456416186585):
  927K views, 4.5K likes, 10.9K bookmarks, and 89 replies. The post described automatically
  collecting articles, podcasts, and voice notes before using AI to connect them.
- [Request for Apple Notes simplicity with Markdown storage](https://x.com/fortelabs/status/2049148744742953228):
  319K views, 971 likes, 1,093 bookmarks, and 739 replies. The author and replies described Obsidian
  and Notion as creating too much startup complexity and cognitive load.
- [Notion feature-creep criticism](https://x.com/icanvardar/status/2070031817462214954): 406K views,
  7.9K likes, 425 bookmarks, and 292 replies. Replies focused on unclear product identity, difficult
  UX, performance, and returning to simpler note apps.
- [NotebookLM as an interactive research companion](https://x.com/Gemini_Notebook/status/2077803351392268314),
  posted by the official product account:
  1M views, 4.3K likes, 736 bookmarks, and 262 replies. The post emphasised moving from passive source
  storage to audio, video, and interactive learning. This is vendor positioning evidence, not
  independent evidence of user demand.
- [AI memory that decides what to retain, forget, or recheck](https://x.com/RoundtableSpace/status/2084948047788646655):
  50K views, 110 likes, 61 bookmarks, and 25 replies. This supported lifecycle controls rather than
  an unlimited, permanently authoritative memory store.

## 3. Product principles derived from the research

### 3.1 Hide machinery, preserve control

NeuralNote should automate filing, metadata, linking, retrieval, and provenance while keeping the
result inspectable and editable. Automation must not turn into opaque ownership.

### 3.2 One continuous vault

Notes, captured sources, generated outputs, and AI memories should remain part of the same vault.
Notebook-like scopes may be expressed as folders, saved searches, or views, but should not become
isolated data silos.

### 3.3 Progressive disclosure

The default surface should prioritise writing, quick capture, recent notes, and search. Metadata,
graphs, provider controls, automation details, and advanced views should appear in context rather
than competing for attention at startup.

### 3.4 Source-grounded by default

Summaries and fluent answers are insufficient. Where a claim comes from source material, the user
must be able to open the supporting note, line, chunk, page, or timestamp. Unsupported answers must
fail honestly.

### 3.5 Ordinary files are the exit strategy

The source of truth remains Obsidian-compatible Markdown and YAML. Removing NeuralNote should leave
a useful vault. Accepted links, metadata, memory records, and generated outputs must remain legible
without the application.

### 3.6 Performance is part of simplicity

A clean interface is not simple if it starts slowly or feels heavy. Startup time, capture latency,
search response, note switching, and visible AI progress are product requirements, not later polish.

### 3.7 Templates package opinionated workflows

NeuralNote should ship useful structures as vault templates rather than adding a privileged
subsystem for every use case. Templates turn the same core primitives into research, study,
writing, project-context, or AI-memory workflows without fragmenting the data model.

## 4. Priority A: recommended core product

These capabilities directly strengthen the core loop and should be treated as the main product
direction. Items already committed to v1 remain governed by the main spec.

### 4.1 Universal capture inbox

**User job:** Put material into NeuralNote before deciding how to organise it.

**Recommended capability:**

- capture URLs, YouTube videos, PDFs, pasted text, raw notes, and existing Markdown;
- add voice and photographed or scanned notes through the same ingest contract later;
- preserve the original source and useful provenance;
- detect duplicates and make repeat capture idempotent;
- show queued, processing, complete, failed, and cancelled states;
- never discard captured material because distillation, embedding, or metadata generation failed.

**Why it matters:** Automatic, multi-source collection was one of the strongest aspirational signals
in the research. It also supplies the material required by every later retrieval and learning
feature.

**Validation signals:**

- percentage of captures that reach a searchable, citable state;
- median time from capture to usable note;
- capture recovery rate after provider, network, or parse failure;
- duplicate-capture rate;
- weekly use across more than one source type.

### 4.2 Ramble in, structured note out

**User job:** Write or paste an incomplete thought without performing administrative work first.

**Recommended capability:**

- suggest a title, summary, key claims, tags, links, frontmatter, and destination;
- preserve the unmodified original input and source provenance;
- allow the user to accept, edit, partially accept, or reject suggestions;
- make generated links normal Markdown links;
- make filing suggestions reversible and visible.

**Why it matters:** The desired outcome is less manual organisation, not another configuration
system for building organisation rules.

**Validation signals:**

- suggestion acceptance and edit rates;
- time from raw capture to saved note;
- percentage of generated links retained after review;
- user-reported correction burden.

### 4.3 Whole-vault cited recall

**User job:** Ask what the accumulated library says without remembering filenames or rebuilding a
temporary notebook.

**Recommended capability:**

- retrieve across notes and retained full sources;
- scope a question to the current note, folder, saved view, or whole vault;
- show exact supporting lines, chunks, pages, or timestamps;
- open evidence in context;
- distinguish direct evidence, synthesis, and inference;
- return an explicit unsupported or not-found result when evidence is insufficient.

**Why it matters:** This is the strongest intersection of the observed demand and NeuralNote's
defensible position. It combines source intelligence with an owned, continuous vault.

**Validation signals:**

- citation faithfulness and citation coverage;
- retrieval success against a maintained real-source evaluation set;
- unsupported-answer refusal quality;
- time from question to opened supporting evidence;
- repeat use of whole-vault questions.

### 4.4 Calm default interface

**User job:** Start writing, capturing, or finding something without confronting the entire product.

**Recommended capability:**

- keep writing, recent notes, quick capture, and search immediately available;
- reveal advanced metadata, graph, provider, and automation controls in context;
- provide useful defaults without requiring a method such as PARA or Zettelkasten;
- retain keyboard-first access for expert users;
- avoid dashboards that require setup before they become useful.

**Why it matters:** The most detailed complaint thread described Obsidian and Notion as causing
immediate cognitive load even before the user began taking notes.

**Validation signals:**

- time to first note and first capture for a new vault;
- cold and warm startup time;
- task completion without opening settings;
- abandonment during first-run setup;
- usability testing with existing Obsidian and Apple Notes users.

### 4.5 Hybrid search with explainable matches

**User job:** Find something by exact wording, remembered metadata, or approximate meaning.

**Recommended capability:**

- combine exact text, filename, property, tag, backlink, and semantic retrieval;
- allow folder, source-type, and date constraints;
- explain whether each result matched by text, metadata, link, or semantic similarity;
- keep basic search fast when AI providers are unavailable;
- make all search results openable in their original context.

**Validation signals:**

- success rate on known-item and exploratory search tasks;
- search latency at representative vault sizes;
- zero-provider behaviour;
- rate at which users open or reuse a result.

### 4.6 Automatic connections stored as Markdown

**User job:** Discover useful relationships without maintaining every link manually.

**Recommended capability:**

- suggest related, supporting, duplicate, and contradictory notes;
- explain the basis for a suggested relationship;
- let users accept or dismiss suggestions;
- store accepted relationships as ordinary Markdown links or readable YAML;
- avoid silently rewriting large parts of the vault.

**Validation signals:**

- accepted suggestion rate;
- false or irrelevant suggestion reports;
- subsequent navigation through accepted links;
- compatibility after opening the vault in Obsidian or a plain editor.

### 4.7 Inspectable AI operations

**User job:** Understand what the AI is doing, what data leaves the device, what it costs, and how to
recover when it fails.

**Recommended capability:**

- show the active provider and whether processing is local or remote;
- identify which source material will be sent;
- estimate cost before unusually large operations;
- show progress, cancellation, retry, and partial-success states;
- preserve usable local content when any AI stage fails;
- provide enough provenance to inspect significant generated changes;
- let users report and correct bad organisation, links, retrieval, or citations.

**Validation signals:**

- surprise-cost and unclear-provider reports;
- cancellation success and recovery behaviour;
- percentage of failed jobs with an actionable user-visible explanation;
- local-only workflow success when configured for local providers.

## 5. Priority B: recommended next stage

These features fit the product strongly but should follow proof of the capture-to-cited-recall loop.
They are not additions to v1 unless the main spec is explicitly revised.

### 5.1 Active learning outputs

- Generate study guides, questions, quizzes, comparison tables, counterarguments, glossaries, and
  audio briefings from selected material.
- Make common learning workflows discoverable in the UI rather than dependent on prompt packs.
- Preserve citations from every generated claim back to the source set.
- Store useful outputs as ordinary vault notes that can be edited and reused.

**Sequence after:** full-source capture and reliable cited retrieval.

### 5.2 Evidence analysis

- Answer: What is new here? What repeats existing material? What contradicts it? Which claims lack
  evidence? What changed between these sources?
- Separate factual contradiction from differences in framing or opinion.
- Let the user open both sides of a comparison.
- Avoid presenting model judgement as verified fact.

**Sequence after:** reliable provenance, source comparison, and whole-vault retrieval.

### 5.3 Proactive resurfacing

- Surface forgotten notes when they become relevant to current work.
- Highlight unresolved ideas, stale assumptions, contradictions, and incomplete follow-ups.
- Let users tune, snooze, dismiss, or disable resurfacing.
- Avoid turning the product into a noisy engagement feed.

**Sequence after:** retrieval quality is high enough that irrelevant resurfacing is uncommon.

### 5.4 Vault templates

- Offer optional starter vaults for clear jobs such as research, study, long-form writing, project
  context, and AI memory.
- Materialise templates as ordinary folders, Markdown notes, YAML fields, saved searches, and
  documented conventions.
- Let users preview the generated structure before applying it.
- Never require a template to use NeuralNote's core features.
- Make template application idempotent or provide an explicit conflict review.

**Sequence after:** note-template, vault-creation, and conflict-handling operations are stable enough
to preserve user data and report conflicts safely.

### 5.5 Notion migration

- Import selected Notion exports into readable Markdown and attachments.
- Preserve original source identifiers and import provenance.
- Report unsupported blocks or lossy conversions explicitly.
- Avoid attempting to reproduce every Notion database or automation feature.

**Sequence after:** full-source ingest and import failure handling are mature.

### 5.6 Mobile capture and sync

- Treat mobile first as a fast capture, retrieval, and reading surface.
- Preserve the local vault as the ownership boundary.
- Make conflicts visible and recoverable.
- Treat sync as convenience around owned files, not as a replacement data model.

**Sequence after:** desktop data contracts, conflict semantics, and local-vault invariants are stable.

## 6. Priority C: later or conditional opportunities

These ideas may be valuable, but they require stronger demand or depend on earlier capabilities.

### 6.1 Shareable research packs

- Publish or export a selected set of notes, sources, and cited conclusions.
- Require an explicit review of included content and redactions.
- Preserve provenance in the exported result.

### 6.2 Generated views over vault data

- Offer task, timeline, kanban, spaced-repetition, or structured-table views only where they are a
  useful projection of existing Markdown data.
- Do not make these views new proprietary stores.
- Validate demand for each view separately rather than adding a general workspace framework.

### 6.3 Specialised capture adapters

- Add new adapters, such as email, meetings, podcasts, or messaging exports, only when they feed the
  same provenance-preserving ingest contract.
- Prioritise adapters using observed user demand and reuse of the core pipeline.

### 6.4 Collaboration

- Consider deliberate sharing and review workflows after the single-user ownership model is proven.
- Do not let team administration, permissions, or intranet features redefine the product before
  then.

## 7. Vault-template framework

Vault templates are the preferred extension mechanism for opinionated use cases that do not require
new privileged capabilities. A template may later benefit from shared NeuralNote capabilities, but
those behaviours require their own slice specs and are not granted by the template itself.

### 7.1 Template contract

A vault template should contain only user-owned, inspectable building blocks:

- folders and Markdown notes;
- optional YAML fields under documented namespaces;
- note templates and example notes;
- saved searches or views represented in a portable form where possible;
- a short `README` explaining the workflow and how to remove it;
- optional NeuralNote configuration that enhances the workflow without making the content unreadable
  elsewhere.

Applying or removing a vault template must not change the meaning of unrelated notes. If the target
vault already contains a conflicting path or field convention, NeuralNote should preview the conflict
and ask the user how to resolve it.

### 7.2 Template quality bar

A first-party vault template should:

- solve one recognisable job;
- be useful immediately after creation;
- work without additional plugins;
- avoid imposing more structure than the job requires;
- include realistic examples that the user can safely delete;
- remain understandable in Obsidian and a plain text editor;
- explain what AI processing may occur and where content may be sent;
- provide a clean removal path.

### 7.3 Initial template candidates

1. **AI memory:** durable, auditable context for people and AI tools.
2. **Research library:** sources, claims, evidence, questions, and writing outputs.
3. **Study vault:** source sets, concepts, questions, revision outputs, and cited explanations.
4. **Long-form writing:** sources, arguments, outline, drafts, and citation checks.
5. **Project context:** decisions, constraints, handovers, open questions, and reference material.

These should be validated one at a time. The list is not a commitment to ship all five together.

## 8. AI-memory vault template

AI memory starts as a portable use case of the normal NeuralNote vault, not a separate memory service
or proprietary store. The first deliverable is a manual starter template made from folders,
Markdown, YAML, examples, and guidance.

Automated creation, status-aware retrieval, access enforcement, provider minimisation, and lifecycle
management are later NeuralNote capabilities. They must reuse the normal vault and retrieval engine,
but they require a dedicated slice spec and security review. Installing the template alone does not
enable or enforce them.

### 8.1 User job

Give a person or an authorised AI tool durable context while retaining the ability to inspect,
correct, supersede, expire, export, or delete every memory.

The important question is not only "What do you remember?" but also "Why do you believe that?"

### 8.2 Recommended contents

The template should support ordinary notes for:

- conversation summaries and links to their source exports;
- decisions and their rationale;
- explicit user preferences;
- inferred preferences, visibly distinguished from explicit statements;
- project facts, constraints, and current state;
- commitments and unresolved questions;
- lessons learned and reusable procedures;
- people, organisations, or topics when the user chooses to track them.

The smallest useful template should not require every category. A starter structure may use folders
or note types, but the underlying records remain Markdown.

### 8.3 Suggested memory metadata

The exact schema requires a dedicated slice spec. A future design should consider readable YAML
fields for:

- `memory_type`;
- `status`, such as candidate, confirmed, superseded, disputed, or expired;
- `recorded_at` and `last_confirmed_at`;
- `source` links or citation identifiers;
- `confidence` for inferred memories;
- `supersedes` or `superseded_by` links;
- an optional review or expiry date;
- sensitivity or sharing guidance;
- the tool or person that created the record.

These fields should live under a documented NeuralNote namespace where collision risk exists. The
body of the note must still explain the memory in human-readable language.

### 8.4 Manual template lifecycle

The template should document this conceptual lifecycle as a human-readable convention:

1. A conversation, source, or user action produces a candidate memory.
2. The memory retains evidence linking back to its origin.
3. The user or an authorised workflow confirms, corrects, or rejects it.
4. The user records relevance, recency, confirmation, sensitivity, and supersession where useful.
5. New evidence may update or supersede an older memory without erasing history.
6. The user marks expired or disputed memories clearly while retaining them for inspection until
   deletion.

The manual template cannot enforce this lifecycle. Its examples and guidance should make stale,
inferred, disputed, and superseded states visible in ordinary Markdown and YAML.

### 8.5 Later memory-aware automation

The following behaviours are candidates for a separate future slice, not properties of the vault
template itself:

- creating candidate memories from authorised conversations or sources;
- retrieving according to current status, recency, sensitivity, and supersession;
- enforcing folder, memory-type, project, or tool access scopes;
- preventing expired or disputed memories from influencing answers by default;
- carrying corrections and supersession into derived indexes;
- deleting a memory from both readable files and derived retrieval indexes;
- limiting provider prompts and logs to the memory needed for the current task;
- reporting why a memory was selected and which evidence supports it.

These capabilities must share NeuralNote's normal vault, indexing, and cited-retrieval primitives.
They must not introduce a second hidden memory database.

### 8.6 Manual-template interoperability

- Template notes remain normal vault notes and require no memory-specific runtime.
- Existing cited retrieval may retrieve them like other notes, without status-aware behaviour.
- Answers should link to the memory note and, where available, its original supporting evidence.
- Export should produce ordinary Markdown and attachments.
- Integrations should not require NeuralNote to become the permanent runtime for the stored memory.

### 8.7 Privacy and safety

- Applying the template must not automatically send existing vault content to a provider.
- Sensitive memories need clear visibility and deliberate sharing boundaries.
- Any future automated provider prompts and logs must not expose more memory than the current task
  requires.
- Future deletion, expiry, and access restrictions must be enforced by code, not by model
  instructions.
- The UI must distinguish local storage from remote model processing.

### 8.8 Validation signals

Validate the manual template with:

- time from applying the template to recording the first useful memory;
- percentage of sampled memories with inspectable supporting evidence;
- successful editing, supersession, export, and deletion using normal vault operations;
- successful use of the same vault with more than one AI tool;
- user confidence in answering "why does the system remember this?"

If memory-aware automation is later specified, also measure:

- stale or superseded memory error rate;
- correction persistence across later retrievals;
- retrieval precision and cross-scope leakage;
- deletion from both files and derived indexes.

## 9. Explicit non-goals

The research supports avoiding the following directions unless later evidence materially changes the
case:

- becoming a general CRM, forms, database, enterprise workflow, or project-management platform;
- rebuilding Notion's block model or making Markdown a secondary export format;
- adding a plugin marketplace that recreates Obsidian's setup burden;
- shipping a generic chatbot without whole-vault retrieval and inspectable citations;
- giving autonomous agents unrestricted, invisible write access to the vault;
- making kanban, calendars, canvas, or spaced repetition independent proprietary systems;
- treating elaborate graph or VR visualisations as the core value proposition;
- creating a separate opaque AI-memory database;
- claiming universal privacy when a configured cloud provider receives content;
- using engagement mechanics or notifications to manufacture daily use.

## 10. Sequencing and dependency map

The recommended sequence is:

1. **Owned foundation:** reliable vault editing, compatibility, note templates, search, and explicit
   failure handling.
2. **Core proof:** universal capture, preserved sources, automatic organisation, indexing, and
   whole-vault cited recall.
3. **Trust and usability:** calm defaults, explainable search, visible AI operations, predictable
   cost, and measurable performance.
4. **Knowledge leverage:** evidence analysis, active learning outputs, and controlled resurfacing.
5. **Opinionated workflows:** first-party whole-vault starter templates, beginning with one validated
   use case.
6. **Reach and convenience:** migration, mobile capture, sync, sharing, and selected integrations.

AI memory depends on reliable provenance, scoped retrieval, and visible supersession. It may be
prototyped as a manual vault template earlier, but automated memory creation should not precede those
controls.

## 11. Feature evaluation rubric

Before promoting a researched idea into an implementation slice, score it from 0 to 2 on each axis:

| Axis | Question |
|---|---|
| Pain intensity | Is this a repeated workaround, complaint, or switching reason? |
| Cross-product recurrence | Does the job appear across more than one product community? |
| Core-loop fit | Does it improve capture, organisation, retrieval, verification, or reuse? |
| Differentiation | Does NeuralNote's owned vault or citation fidelity make the result better? |
| Technical leverage | Can it reuse the existing capture, indexing, search, or citation pipeline? |
| Trust fit | Can it preserve readable files, provenance, explicit failures, and predictable cost? |

Interpret the total as:

- **10 to 12:** strong candidate for core or near-term roadmap validation;
- **7 to 9:** useful adjacency after the core loop is proven;
- **4 to 6:** generic parity feature requiring unusually strong retention evidence;
- **0 to 3:** likely product dilution.

Engagement is recorded separately. Replies that describe real workflows, failures, migrations, or
desired behaviour count as stronger evidence than views, likes, or launch hype.

## 12. Research follow-up

Before committing significant implementation time, validate the strongest assumptions with:

- structured interviews with Obsidian users who find setup exhausting;
- task-based testing with Apple Notes or simple Markdown users;
- observation of real research, study, writing, and AI-context workflows;
- a two-week dogfood run of the full capture-to-cited-answer loop;
- a manual AI-memory template trial before automating memory creation;
- retention and repeated-use measurements rather than launch engagement alone.

The next research question should be narrower than "which competitor features are popular?" It
should be:

> Which recurring user pain can NeuralNote solve unusually well because it owns the
> capture-to-cited-recall loop while the user owns the files?
