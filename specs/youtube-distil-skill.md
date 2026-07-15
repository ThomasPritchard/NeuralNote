# NeuralNote — AI Slice 5: The YouTube distil skill

> Status: design draft (2026-07-10, revised same day). The first skill on the
> [`ai-skills-bank-slice.md`](ai-skills-bank-slice.md) framework, and the proof it works. Requires
> [`conversational-chat-slice.md`](conversational-chat-slice.md) (without it, the "3–8 searches
> before every answer" prompt makes the model search the vault when asked to distil a video).
> This is the first piece of the capture → distil → cite loop from `specs/neural-note.md` §4 to
> actually ship. Read `docs/definition-of-done.md` before implementing.

---

## 1. What this slice is — a port that must be a rewrite

This skill ports the reference `youtube-distill` workflow (SKILL.md + `extract_transcript.py`)
into NeuralNote: paste a YouTube link — or a playlist — and get back literature notes, atomic seed
notes, and archived transcripts, auto-routed into the vault's own organising scheme and announced
with an Undo.

**The headline adaptation, and the reason this is a rewrite rather than a copy: timestamps.** The
reference script's `clean_vtt()` strips every cue timing and joins the captions into one prose
blob — fine for a human-read transcript, fatal for NeuralNote. The product spec promises "each
claim citable back to the exact chunk or **timestamp**" (`specs/neural-note.md:31`) and names
"Timestamp-accurate, never fabricated, regression-blocking" as moat pillar 3. So the pipeline is
re-derived around a timestamped cue model (§4.3), and the archived transcript carries `[hh:mm:ss]`
anchors. Two further departures from the original: transcript fetching becomes a **layered stack**
rather than a single tool (§4.1), and routing **learns the vault's scheme** instead of assuming
PARA (§6). The rest — caption-first strategy, note templates, announce-and-invite-to-move — ports
with adaptations noted in §6.

## 2. Phase 0 — spikes. Nothing downstream starts until these answer.

Each is a half-day-max throwaway experiment with a written answer; several can invalidate parts of
this spec, which is exactly why they run first.

1. **Gatekeeper.** Can a downloaded, non-bundled `yt-dlp` (standalone macOS binary) be exec'd
   from a notarised, hardened-runtime NeuralNote build? Check the quarantine xattr on the
   downloaded file, and PyInstaller's unpack-to-tmp behaviour under the hardened runtime.
   A "no" here forces a rethink of locked decision §3.1 (e.g. `xattr` clearing, or a
   different distribution of yt-dlp) — highest-risk spike, run it first. The same question
   applies to the POT-provider binary (§4.1).
2. **PO token.** Does caption fetch succeed today from a residential IP without a Proof-of-Origin
   token, and with which yt-dlp client? The yt-dlp PO Token Guide
   (https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide) says the `web` client requires one for
   subtitle requests and that unauthenticated requests "may return HTTP Error 403, or result in
   your account or IP address being blocked." **Extended:** does layer 2 of the stack — the
   bgutil POT provider (§4.1) — actually clear the 403 in practice?
3. **whisper-cli timed output.** The capability is confirmed — whisper.cpp produces SRT-style
   `[HH:MM:SS.mmm --> HH:MM:SS.mmm]` output (https://github.com/ggml-org/whisper.cpp) — but the
   exact flag (`-ovtt` / `-osrt` / `-oj`) is **not** verified. Pin it, and pin which format parses
   cleanest into §4.3's cue model.
4. **Audio decode coverage.** Does `symphonia` + `rubato` decode the m4a rendition of a
   representative sample of YouTube videos to 16 kHz mono `pcm_s16le`? And how often does a video
   ship **no** m4a rendition (Opus/WebM only — symphonia has no Opus decoder)? This decides §4.5's
   fallback posture.
5. **Ollama reasoning.** The empty-content/full-reasoning case — owned by and specced in
   [`conversational-chat-slice.md`](conversational-chat-slice.md) §5; listed here because a distil
   run's final summary turn hits the same failure.
6. **`yt-transcript-rs` freshness.** The crate's last release (0.1.8) is thirteen months old as of
   today, and it targets an internal YouTube API. Does it still fetch a transcript successfully?
   A "no" drops layer 3 from the stack (§4.1) rather than shipping a dead fallback.

## 3. Locked decisions (and why)

### 3.1 Binaries: runtime download + self-update, never bundled

`yt-dlp`, the POT-provider binary (§4.1), and the Whisper toolchain download into the app-data dir
on first skill use, behind an in-chat consent prompt (the Slice-4 elicitation primitive). Two
reasons, stated plainly:

- **A bundled yt-dlp goes stale.** YouTube breaks it between app releases; yt-dlp ships roughly
  monthly (2026.06.09 seen) precisely to keep up, and the standalone macOS binary self-updates via
  `yt-dlp -U`.
- **A sidecar inside a notarised `.app` cannot self-update.** Rewriting a signed binary inside the
  bundle breaks the signature; app-data is the only place `yt-dlp -U` can work. (The bundled
  Ollama sidecar is the opposite trade — it doesn't need to chase a hostile upstream weekly.)

For the GPL-3.0 POT provider, runtime download has a third consequence: NeuralNote never
*distributes* it (§4.1).

**Consent is tiered:** `yt-dlp` (~32 MB) plus the POT provider unlock the captions path and are
the first ask; the Whisper toolchain (~466 MB `small` model + decoder) is optional, only offered
when a video turns out to have no captions. Downloads reuse the cancellable progress pattern of
`ai/local/pull.rs` (to a `.part` file, renamed on completion — the same interrupted-download
discipline as the reference script's model fetch). Spawning stays in Rust by absolute path;
`capabilities/default.json` keeps `shell:allow-execute` withheld (Slice 4 §4).

### 3.2 Output: full reference-workflow parity, upgraded with timestamps

Per video: a literature note and an archived transcript. Atomic notes are written **per concept,
deduplicated across the run and against the vault** (§6.1) rather than per video — the one place
this skill deliberately improves on the original rather than porting it. Templates in §6. The
transcript keeps `[hh:mm:ss]` anchors, the upgrade that makes §5 work.

### 3.3 A block is an error, never a fallback trigger

Per the PO Token Guide, a blocked caption request is a hard failure that can escalate to an IP
block. Falling through to Whisper on a 403 would (a) look like a hang — minutes of transcription
where seconds of caption fetch were expected — and (b) mask a condition the user needs to know
about. So: `yt-dlp -U` runs as the standing mitigation (once per session — §11.3); a 403 or
PO-token-shaped failure surfaces as an actionable error — *"YouTube is blocking caption downloads
right now — try again later; updating happens automatically"*. The same rule applies at the end of
the stack: a 403 that survives the POT provider, or a "Sign in to confirm you're not a bot"
response, is a **loud, actionable, terminal error** (§4.1). **Only a genuine absence of caption
tracks** (empty `subtitles` and `automatic_captions` in the metadata) triggers the Whisper offer.

### 3.4 Auto-route and announce

Full reference-workflow parity: the model picks the folder — within the vault's own detected scheme
(§6) — writes immediately via `write_note`, then reports where and why, inviting the user to move
it. The safety weight is carried by the Slice-4 `write_note` guardrails (create-only,
vault-confined, bounded per work item, Undo) — reviewed adversarially there; this skill adds no
new write primitive.

## 4. Architecture — pipeline, and where each half lives

```
model (SKILL.md instructions — judgement: distil, route, voice)
  │ tool calls
  ▼
shell (src-tauri)  — ALL I/O and network: TranscriptSource impls (yt-dlp · POT sidecar ·
                     yt-transcript-rs · whisper-cli) · yt-dlp -U · audio + thumbnail download ·
                     binary downloads · playlist enumeration
  │ raw bytes / VTT text
  ▼
core (neuralnote-core::capture) — ALL logic, pure, tested:
  transcript-stack fallback policy · vtt.rs (VTT → Vec<Cue> + cleaning) · transcript rendering
  ([hh:mm:ss] anchors) · note templating & frontmatter · vault-scheme detection + routing policy ·
  filename/slug derivation · audio decode-to-WAV policy (§4.5) · cost estimation (§7)
```

The Slice-2 governing constraint holds: coverage is measured from the core, so logic lives there
and the shell stays a thin husk. The model-facing tool surface stays small —
`fetch_video_info(url)`, `fetch_captions(url, lang)`, `transcribe_audio(url)` (gated on the
Whisper requirement), `select_playlist_videos(playlist_url)` (§7), plus Slice 4's `write_note` and
`ask_user` — and the layering below is **internal to the shell**, behind those tools. The model
asks for captions; the stack decides how.

### 4.1 The transcript stack — layered by failure mode, not by vendor

The thesis of this section: each layer exists to fix a **different failure**, so the stack is not
redundancy for its own sake — remove any layer and one named failure class becomes fatal. A
`TranscriptSource` trait gives them one shape; the **fallback policy — which source next, on which
error, and when to stop — is pure core logic with tests**, while every implementation (process
spawn, HTTP) lives in the shell, per the core's network-free rule.

| # | Source | Licence | Fixes which failure |
|---|---|---|---|
| 1 | `yt-dlp` binary | Unlicense | primary: metadata, captions, playlists, audio |
| 2 | `bgutil-ytdlp-pot-provider-rs` | GPL-3.0 | PO-token 403s, at the root |
| 3 | `yt-transcript-rs` crate | MIT | yt-dlp extractor rot (independent implementation) |
| 4 | `whisper-cli` | MIT | the video genuinely has no captions |

**Layer 2 — the POT provider — is not a fallback; it is the root-cause fix** for the failure
yt-dlp's own docs call most common. `bgutil-ytdlp-pot-provider-rs`
(https://github.com/jim60105/bgutil-ytdlp-pot-provider-rs) is a Rust rewrite of the TypeScript
original: "single binary with no runtime dependencies" — no Node, no Deno, no embedded JS engine.
It runs as `bgutil-pot server` on a configurable host/port (default 4416); yt-dlp additionally
needs the provider's **Python plugin zip** dropped into a yt-dlp plugin directory, and is pointed
at the server with `--extractor-args "youtubepot-bgutilhttp:base_url=http://127.0.0.1:<port>"`.
v0.8.1 released 2026-03-12; 19 releases, 411 commits — actively maintained.

- **Reuse the Ollama sidecar pattern wholesale.** `src-tauri/src/local.rs:187-232` already does
  exactly this shape: spawn from Rust on a private loopback port, health-poll, re-probe a stale
  port, handle the concurrent-start race, and reap on app exit (`local.rs:301`, wired at
  `lib.rs:180-188`). This is a second instance of an established pattern, not a new one.
- **Licence, precisely.** GPL-3.0 — but it is invoked as a **separate process over a loopback
  socket**, which is arm's-length under the GPL (the FSF's own line: programs communicating over
  sockets are separate works, not a combined work). And because it is **runtime-downloaded from
  upstream** (§3.1), NeuralNote never *distributes* it, so no distribution obligation attaches.
  It must therefore **never be bundled into the `.app`**. Both halves of this reasoning should be
  confirmed by someone qualified before any commercial release — this spec records the analysis,
  not a legal conclusion.

**Layer 3 — `yt-transcript-rs`** (https://lib.rs/crates/yt-transcript-rs): MIT, v0.1.8 released
2025-06-24, uses "YouTube's internal InnerTube API exclusively for transcript fetching", no
external binary (`reqwest` under the hood), and also provides video metadata and thumbnails. Its
value is that it is an **independent extractor implementation**: a yt-dlp extractor break does not
take it down with it. It does **not** rescue a PO-token or IP block — without saying that, the
layer reads as more redundant than it is. It is a **shell** dependency (the core is network-free;
the core owns only the fallback policy). Supply-chain honesty: 0.1.8 is thirteen months old as of
today — pin the version, rely on `cargo-audit` (already in `scripts/rust-quality-gate.sh`), and
record single-maintainer staleness as an accepted, named risk. Spike 6 checks it still works
before it earns its slot.

**Evaluated and rejected: `rustypipe`** (https://lib.rs/crates/rustypipe, 0.11.4, 2025-04-23) —
recorded so nobody re-proposes it. It is GPL-3.0 **as an in-process crate**, which would make
NeuralNote GPL-3.0; and it needs its own `rustypipe-botguard` external binary for PO tokens
anyway, so it buys nothing over layer 2.

**The honest limit — stated here, not buried.** No free source survives an IP block. That is
precisely what a commercial transcript API sells: a residential proxy fleet somebody pays for.
When the stack is exhausted on a block-shaped failure, the error is loud, actionable, and
terminal (§3.3) — never a silent fall-through to Whisper. The only remaining deferral is a
BYO-key commercial API in Settings (§10).

### 4.2 Metadata and strategy — ported from the script

One `yt-dlp --dump-single-json --skip-download --no-playlist` call yields metadata + the caption
inventory. Prefer human `subtitles`; fall back to `automatic_captions`; only a genuinely empty
inventory reaches the Whisper offer (§3.3). Language pick ports the script's logic (exact match →
base-language variant). The `--no-playlist` flag means playlist support is an **explicit new
branch keyed on the URL shape** (§7), not an accident of the existing call.

### 4.3 `capture/vtt.rs` — the cue model (the TDD heart of the slice)

A pure core module parses VTT into `Vec<Cue { start_ms, end_ms, text }>` rather than a prose
blob. The reference cleaner's passes are re-derived **over cues**:

1. Strip headers, `-->` cue timings into the struct (not the bin), numeric indices, inline
   `<...>` word-timing tags; HTML-unescape.
2. Adjacent-duplicate removal (the styled+plain pair; the echoed on-screen line).
3. Rolling-prefix collapse — when a cue's text is a prefix of the next cue's (auto-caption
   accumulation), keep the **last** cue of the rolling group and **widen its span** to cover the
   group's full `start_ms..end_ms`.
4. Final adjacent-duplicate sweep (pass 3 exposes new ones).

This is the densest, most testable pure logic in the feature: fixture VTTs in, cues out. No I/O,
no network. Fixtures must cover human captions, auto-captions with word-level tags, rolling
repetition, and malformed/truncated VTT (the DoD's failure/edge paths). Vault-scheme detection
(§6) is the second pure-policy TDD target alongside it.

### 4.4 All transcript paths converge on VTT

Captions arrive as VTT already (layers 1–3 all yield timed cues); whisper-cli is instructed to
emit timed output (flag per spike 3) that is parsed by — or trivially converted into the input
of — the **same** `vtt.rs` parser. One parser, one test suite, one shape of bug. The archived
transcript is rendered from cues with one `[hh:mm:ss]` anchor per ~30 s paragraph (§11.2).

### 4.5 The ffmpeg problem — resolved with a recommendation

whisper-cli "currently runs only with 16-bit WAV files" — 16 kHz mono `pcm_s16le` — and cannot
read compressed audio (https://github.com/ggml-org/whisper.cpp; its own README converts with
ffmpeg). Two ways to feed it:

- **Ship/download a third binary (ffmpeg, 40–80 MB)** — maximal codec coverage, another moving
  part, another consent line-item.
- **Decode in pure Rust** — ask yt-dlp for `-f bestaudio[ext=m4a]` (AAC-LC in MP4) and decode
  with `symphonia` + resample with `rubato`. **Verified against current docs (Context7,
  /pdeljanov/symphonia, 2026-07-10):** symphonia's AAC decoder implements the **LC profile**
  (ISO/IEC 14496-3) behind a non-default `aac` feature flag, with MP4/isomp4 demuxing likewise
  feature-gated. Two labelled caveats: HE-AAC (SBR) is **not** implemented, and symphonia has
  **no Opus decoder** — so a video with only Opus/WebM audio cannot take this path.

**Recommendation: the Rust path, with ffmpeg as a consented fallback.** It removes a binary from
the default install, keeps the work in-process, and fits the shell-owns-I/O / core-owns-logic
split (decode policy is core logic with fixture tests). The trade-off is codec coverage when no
m4a rendition exists — spike 4 measures how often that actually happens before the fallback is
built at all (YAGNI: if the m4a rendition is effectively universal, the fallback is a `TODO` with
a trigger, not day-one code). `rubato`'s exact resampler API is an implementation-plan detail to
verify then, not asserted here.

### 4.6 Spike 4 resolved — measurement, threshold, and the fallback decision (#38 → #59)

Spike 4 is delivered as a **measure-and-decide** slice, not a blind ffmpeg build.

**What ships now (#38).** A deterministic, pure classifier (`capture::audio_coverage`,
`classify_audio_coverage`) maps a video's yt-dlp audio renditions onto the decoder's real
capability, unit-tested offline with fixture format lists:

- `aac_lc_m4a` — has an `mp4a.40.2` m4a rendition; **decodable today**.
- `he_aac` — best m4a is HE-AAC (`mp4a.40.5` / `mp4a.40.29`); the LC decoder rejects it.
- `opus` — no usable m4a; audio is Opus (WebM/Ogg), which symphonia cannot decode.
- `no_m4a` — audio exists but neither a decodable m4a nor Opus (e.g. Vorbis, or progressive-only).
- `other` — no audio renditions listed, or a runtime decode failure the listing can't predict
  (a data-quality bucket, excluded from the undecodable rate).

A runnable, `#[ignore]`-gated harness (`youtube_audio_coverage_report`, in the desktop crate)
runs yt-dlp format listing over a URL sample, classifies each video via the core classifier, and
prints per-class counts + rates plus the threshold decision. It mirrors the repo's live-eval
gating: it skips unless yt-dlp is **proven runnable** (a bounded `--version` probe, not mere
presence) *and* a non-empty URL sample is supplied (`NN_AUDIO_COVERAGE_URLS`, else a checked-in
seed). It never touches the network in the default `cargo test` run.

**The written threshold.** Add the consented ffmpeg fallback when a representative sample
(**≥ 50 captionless videos** spanning the target content classes) shows that **> 10 % lack a
decodable AAC-LC m4a rendition** (no-m4a + HE-AAC + Opus combined), **OR any single class**
(HE-AAC, Opus, or no-m4a) **individually exceeds 5 %**. These bounds live in code as
`UNDECODABLE_COMBINED_THRESHOLD`, `SINGLE_CLASS_THRESHOLD`, and `MIN_REPRESENTATIVE_SAMPLE`, and
`CoverageTally::fallback_triggered` is the single source of truth the harness prints.

**The decision.** The product direction is to **implement the consented ffmpeg fallback.** But the
actual binary integration — pinning, downloading, and executing a third-party LGPL ffmpeg build on
untrusted media — is **deferred to a dedicated follow-up (#59)** so it lands with real sample data
and a focused security review rather than blind. #38 delivers the measurement harness, the
threshold, this decision record, and an **actionable interim limitation**: until #59, a video with
no decodable AAC-LC m4a fails with `unsupported_audio_codec` whose message explains the video's
audio isn't in the supported format, suggests trying a captioned video or a different source, and
notes ffmpeg support is planned. The trigger is recorded at the code site
(`capture/audio.rs::unsupported_codec`, `TODO(ffmpeg-fallback, #59)`), pointing back at the harness
and this threshold.

## 5. Timestamped citation comes for free — the argument that justifies the rewrite

Citations are line-based today: `EvidenceSpan` carries `rel_path`, `start_line`, `end_line`,
`text`, `content_hash` (`ai/evidence.rs:19-29`), and `CitationVerifier::verify` (`ai/verify.rs:29`)
re-reads the note from disk and checks the hash and `raw.contains(text)` byte-exactly.

So if the archived transcript carries `[hh:mm:ss]` anchors **in the line text**, then:

- `read_note_span` returns the timestamp *inside* the evidence text;
- the verifier verifies it byte-exactly like any other quote — a fabricated timestamp fails
  verification and is dropped (`orchestrator.rs:327` → `CitationDropped`), exactly the discipline
  spec §6 demands;
- `SourceChip` (`ChatMessages.tsx:367`) can parse the anchor out of the cited text and offer a
  "▸ 14:32" jump to `youtu.be/<id>?t=872` alongside the existing open-note-at-line action.

No new citation machinery: no schema change to `EvidenceSpan`, no new verifier, no new event.
Moat pillar 3 — the timestamp-accurate citation — is delivered by a rendering convention plus one
frontend affordance. This is why the timestamp rewrite in §4.3 pays for itself.

## 6. Notes, routing, and the report card — ported, with adaptations

**Routing learns the vault; PARA is one recognised pattern, not the assumption.** Not every vault
is PARA-shaped, so the skill infers the vault's actual organising scheme and conforms to it:

- **Scheme detection is pure core policy** over the `list_folders` output (`ai/tools.rs` —
  vault-relative paths with recursive note counts, which is enough to classify). Fixture vault
  trees in, a classification out — the second TDD target alongside `capture/vtt.rs`. Recognise at
  least: **PARA** (`Projects`/`Areas`/`Resources`/`Archive`), **flat/Zettelkasten** (few or no
  folders, many root notes), **topic folders**, **date-based** (`2026/07/`), and
  **Johnny.Decimal** (`10-19 Area/11 Category/`). **Unknown is a first-class outcome, not a
  failure.**
- **Then copy the local conventions.** Before writing, read one or two existing notes in the
  chosen folder and match their frontmatter keys and heading structure. The reference workflow's SKILL.md
  already instructs this ("Read a note already in that folder to copy its exact conventions
  before writing") — generalised here from a PARA-specific step to the general rule.
- **Never invent a folder without asking.**
- **No confident scheme → ask once, remember forever.** `ask_user` with a folder picker built
  from `list_folders` (implementation-authored options — Slice 4 §3.4), and the answer persists
  as a **vault profile** so it is never asked twice. The profile lives at
  `<vault>/.neuralnote/profile.json` — vault-scoped facts do not belong in the app-scoped
  `ai-config.json`, the dotfolder is invisible to Obsidian, and the product spec already
  anticipates `.neuralnote/sources/`. This does not violate the "data format is sacred" rule: no
  markdown, no frontmatter, nothing Obsidian reads is touched.
- Within a detected PARA vault, the ported tree applies unchanged and total:
  `Areas/<topic>/` → `Resources/<topic>/` → `Projects/<project>/` → `Inbox/` as the honest
  fallback. Wrong-but-announced beats wrong-and-silent.

### 6.1 Atomic notes are scoped to concepts, not to videos

The reference workflow spins out "1–3 seeds per video". Ported literally into a playlist run that
produces one seed per video per idea, which is the wrong grain: three videos that each discuss
Markov chains should yield **one** `Markov chains.md`, wikilinked from all three literature notes —
not three near-duplicate seeds. Tom's framing: *"recurring notes that can be moved to an atomic note
is better than just making one note per video … think more on that smarter level."*

So the atomic step is **concept-first and deduplicated in two directions**:

1. **Against the vault.** Before writing an atomic note, search for one that already covers the
   concept (`search_notes` plus a title scan via `list_notes`). If it exists, do not write —
   **wikilink it** from the literature note. `write_note(kind: atomic)` enforces this structurally:
   a collision returns `{ existed: true, rel_path }` rather than suffixing (Slice 4 §3.3). An
   existing atomic note is never modified; the link is one-directional, and Obsidian's backlinks
   surface the rest.
2. **Within the run.** Concepts are gathered across every selected video *before* any atomic note
   is written, so a recurring idea is written once and linked from each literature note that
   touches it. This is why a 30-video playlist does not yield 60 seeds: it yields as many atomic
   notes as there are distinct new concepts, which is usually far fewer.

The sprawl worry that motivated a seed cap therefore dissolves structurally rather than by
rationing — the right answer to "too many seeds" was never a limit, it was deduplication. Seeds
that *are* written keep full parity with the single-video case: `status: seed`, the honest
`> [!note] Seed:` callout, no date prefix.

**Templates and the rest:**

- **Templates** port from SKILL.md: literature note `YYYY-MM-DD <Sentence-case title>.md`
  (body `## Summary` / `## Notes` with bold-lead-in bullets and inline `[[wikilinks]]` /
  `## Related` including the transcript link); atomic notes `<Concept>.md` (no date prefix,
  `status: seed`, the `> [!note] Seed:` callout — machine extractions honestly marked, never
  passed off as finished thinking); transcript archived with light frontmatter and a provenance
  line (`captions:en` / `captions:en-auto` / `whisper:<model>`). The transcript body is a
  **verbatim source record — never rewritten** (it is what citations verify against).
- **Frontmatter follows the vault** (per the convention-copying rule above), with the product
  spec's Appendix A `nn.source.*` block added **alongside** the vault's own keys rather than
  replacing them — `nn` is namespaced precisely so it cannot collide, and stripping it must leave
  a clean note (Appendix A's own design rule).
- **Adaptations:** NeuralNote has no `personal-vault/` prefix — paths are vault-relative, and
  `write_note` confines them. "Tom's angle" generalises to connections with the user's existing
  notes, discovered via the read-only search tools during the run.
- **The humanise step is replaced** (NeuralNote has no `humanizer` skill): voice guidance — distil
  don't transcribe, no inflated significance, bold-lead-in bullets, read a neighbouring note and
  match its register — folds into the skill's instruction markdown. The model is already writing
  in the user's voice; a second polishing pass would double LLM cost for marginal gain. Stated
  trade-off: prose quality rests on one prompt rather than a dedicated pass; revisit if
  dogfooding shows generated-sounding notes.
- **The report card** is the chat-rendered summary of `NoteWritten` events (Slice 4 §3.5): what
  was created, where, why that folder, provenance of the transcript, and **Undo** (deletes exactly
  the files this run created, hash-checked).

## 7. Playlists

A playlist URL is an explicit branch (§4.2), not a loop the model improvises.

- **Enumerate cheaply:** `yt-dlp --flat-playlist --dump-single-json` lists entries without
  fetching each video.
- **The user picks the videos.** `select_playlist_videos(playlist_url)` is the canonical
  implementation-authored elicitation (Slice 4 §3.4): its Rust body enumerates the playlist,
  builds multi-select options with titles and **thumbnails** — fetched in Rust from the derivable
  URL `https://i.ytimg.com/vi/<video_id>/mqdefault.jpg` (~10 KB each, no metadata trust needed),
  delivered as `data:` URIs so the CSP gains no third-party host — emits `Elicit`, and returns
  only the ticked video ids to the model. Large playlists are paged or lazy-loaded, not shipped
  as one giant event.
- **Tom's guard, verbatim:** *"If there are more than 20 videos in the playlist, to return a
  warning to say 'are you sure you want to do this? It can incur high usage'."* So: **no hard
  cap.** Twenty or fewer, proceed. **More than twenty (21+)**, a second `ask_user` confirmation
  carrying the usage warning and a cost estimate. Never a silent truncation — the project forbids
  silent caps.
- **Counted against the *selection*, not the playlist's length** (§11.7). Tom said
  "in the playlist", but he gave the reason in the same breath: *"it can incur high usage"*, and
  usage is incurred by what is distilled, not by what is listed. Warning on a 200-video playlist
  when the user ticked three would be noise, and noise trains people to click through warnings.
  The picker header still states the playlist's true size, so nothing is hidden, and `Select all`
  on a large playlist trips the confirmation exactly as it should.
- **The cost estimate.** For OpenRouter, the `GET /api/v1/models` payload already fetched for the
  reasoning probe ([`conversational-chat-slice.md`](conversational-chat-slice.md) §4) carries a
  per-model `pricing` object — reuse that fetch. Estimate input tokens from the transcript word
  counts and show **tokens and the derived cost**, labelled as rough with the method stated in
  one line (an unexplained number nobody trusts is worse than no number). For local Ollama, say
  "free — runs locally", not £0.00. Estimation arithmetic is pure core logic with tests.
- **Execution is sequential, live, and cancellable.** One video at a time, `SkillStep` progress
  per video, cancel keeps everything already written and the report card lists exactly which
  videos landed and which did not — the never-a-silent-half-state rule (Slice 4 §5) extended to
  playlist runs. The `write_note` budget is **per video** (Slice 4 §3.3): *n* selected videos →
  *n* × 8.
- **Output grain, settled (§11.5–6):** one literature note per video, never one combined note, so
  per-video citation survives; plus a playlist MOC note linking them, written only when the
  detected vault scheme actually uses MOCs. Atomic notes are concept-scoped across the whole run
  (§6.1), so a 30-video playlist yields as many atomic notes as it has distinct new concepts —
  not ninety.

## 8. Failure modes — all surfaced

Caption fetch 403 / PO-token block → actionable error, **never** a silent fall-through to Whisper
(§3.3) · stack exhausted on a block-shaped failure ("Sign in to confirm you're not a bot") →
loud, actionable, **terminal** error naming what was tried (§4.1) · POT sidecar fails to start →
health-poll timeout with captured stderr (the Slice-2 sidecar discipline); captions proceed
without it and a 403 then carries the hint that the provider is down · `yt-transcript-rs` errors →
next layer, logged in the run transcript, never user-visible unless the whole stack fails · no
captions at all → the tiered Whisper offer via `ask_user`, with an honest time warning ("minutes,
not seconds") and `SkillStep` progress while it runs · yt-dlp metadata failure → error with the
update hint (the script's own recovery advice: update yt-dlp first) · `yt-dlp -U` itself fails →
non-fatal, proceed with the current binary, note it in the report · binary download declined /
failed / cancelled → Slice 4 §5 behaviour · no m4a rendition on the Rust decode path → explicit
error naming the limitation (and the ffmpeg fallback once it exists) · whisper-cli non-zero exit →
surfaced with captured stderr, never a blank transcript · insufficient disk for the Whisper
model → the requirement check fails *before* the download offer, honestly · playlist enumeration
failure → error before any elicitation, never an empty picker · playlist run cancelled → partial
results kept, report card says exactly which videos landed (§7) · vault write failures → Slice 4
`write_note` semantics. In every case the raw material already fetched is not silently discarded
(spec §6: keep the capture, mark the failure).

## 9. Testing (Definition of Done)

- **Rust unit (core)** — `vtt.rs` against fixture VTTs (human, auto with word tags, rolling
  prefixes, duplicates, malformed, empty, non-UTF-8); span-widening on rolling collapse; anchor
  rendering; slug/filename derivation; **transcript-stack fallback policy** (each error class →
  the right next layer; block-shaped errors → terminal, never Whisper); **vault-scheme
  detection** against fixture trees (PARA, flat, topic, date-based, Johnny.Decimal, ambiguous →
  Unknown); cost estimation (word count → tokens → price; local → "free"); audio decode policy
  (fixture m4a → 16 kHz mono WAV; unsupported-codec error path).
- **TS unit/component** — `SourceChip` timestamp parse + `youtu.be/<id>?t=` link derivation
  (including no-anchor citations, which keep today's behaviour); report card with mixed note
  kinds and playlist partials.
- **e2e (jsdom + mockIPC, `src/e2e/`)** — the full scripted journey: paste link → `@`-activated
  skill → consent elicitation → `SkillStep` progress → `NoteWritten` ×3 → report card → citation
  chip with a timestamp jump; the 403 journey; the no-captions → Whisper-offer journey; the
  playlist journey (picker with thumbnails → >20 warning with cost estimate → sequential progress
  → cancel mid-run → partial report card); the unknown-scheme → folder-picker → profile-persisted
  journey.
- **Integration (real)** — one real video with human captions and one with auto-captions only,
  end-to-end from URL to notes on disk to a cited, timestamped chat answer; gated on network and
  skipping loudly. This doubles as the start of the citation-faithfulness golden set for
  transcripts (spec §7).
- **Security-adjacent bar (DoD §2)** applies: new untrusted inputs (YouTube metadata JSON, VTT
  content, whisper output, playlist entries, thumbnail bytes) feed parsers, an elicitation UI,
  and eventually `write_note` paths — adversarial review of the VTT parser, the metadata
  handling, and the thumbnail/data-URI path is required, on top of Slice 4's write-path review.
- **Dogfood** — Tom's daily YouTube-distillation workflow, two weeks, no silent failures (the v1
  ship-gate item from spec §4 becomes real here).

## 10. Deferred

- Other capture types on this framework (article, PDF) — same skill shape, different fetchers.
- The `.neuralnote/sources/` sidecar + embeddings over transcript chunks (spec §5's full loop);
  this slice stores the transcript as a normal vault note, which the line-based citation path
  already handles.
- **BYO-key commercial transcript API, configured in Settings** — the only rescue for users whose
  IP gets blocked (§4.1's honest limit). Trigger: recurring exhausted-stack block errors in the
  wild. This replaces the earlier deferral of a generic "commercial fallback"; the free stack is
  now in scope (§4.1).
- Non-English captions/transcription (the script's `--lang` generality) — English-first, as the
  original.
- ffmpeg fallback for non-m4a audio, pending spike 4's numbers.

## 11. Resolved decisions (were open questions)

All settled 2026-07-10.

1. **Binary integrity: verify a published checksum on first download; delegate updates to
   `yt-dlp -U`.** GitHub release assets ship a `SHA2-256SUMS` file — fetch it over TLS, verify the
   binary against it, and refuse to execute on mismatch. This does *not* break self-update, because
   `-U` verifies its own payload. The same rule applies to the POT-provider binary. Bare TLS trust
   with no hash check would let a compromised CDN object hand us an executable, which is a poor
   trade for the code it saves. Interacts with spike 1.
2. **Anchor granularity: one `[hh:mm:ss]` anchor per ~30 s paragraph**, carrying that group's start
   time. Per-cue anchors (5–15 s) make the transcript unreadable as prose, and the citation
   verifies byte-exactly either way — so this is purely a readability call, decided for the human.
3. **`yt-dlp -U` runs at most once per app session**, plus a single retry when a fetch fails with
   an extractor-shaped error. Updating before every invocation adds seconds of latency to the
   common case to defend against a failure that happens monthly.
4. **The POT sidecar starts lazily on first caption fetch and lives for the session**, matching the
   Ollama sidecar's lifecycle (`src-tauri/src/local.rs:187-232`, reaped at `lib.rs:180-188`).
   Per-run spawn-and-reap would pay process startup on every video in a playlist.
5. **Playlist output grain: one literature note per video, plus a playlist MOC note** linking them —
   the MOC written only when the detected vault scheme actually uses MOCs (§6). Per-video notes
   preserve the per-video citation that is moat pillar 3; a combined note would muddy it.
6. **Atomic notes are concept-scoped and deduplicated, not per-video** (§6.1). This supersedes the
   old "1–3 seeds per video" parity question: the sprawl it worried about dissolves through
   deduplication rather than a cap.
7. **The "more than 20" warning counts videos *selected*, not videos in the playlist** (§7). Tom's
   words said "in the playlist"; his reason — *"it can incur high usage"* — points at the selection,
   since that is what costs tokens. The picker header still shows the playlist's true size.
