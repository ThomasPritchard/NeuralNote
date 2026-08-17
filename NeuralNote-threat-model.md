# NeuralNote threat model

Date: 2026-07-31

## Scope and assumptions

This model covers the current single-user Tauri 2 desktop application. NeuralNote has no
multi-tenant backend. It reads and writes a user-selected local markdown vault, talks outbound to
OpenRouter or an app-owned loopback Ollama sidecar, optionally reads curated Hugging Face metadata,
and runs app-owned capture helpers for YouTube. Mobile, sync, billing, managed cloud AI, and the
future full-source capture pipeline are out of scope.

The native E2E harness is in scope because its test-only WebdriverIO plugins can execute code inside
the application process and its configuration-root override redirects privileged persistence.

The host OS, signed NeuralNote bundle, OS keychain, updater public key embedded in a release build,
and user-approved vault selection are trusted. The updater signing private key is a release asset
that must remain outside the repository and webview.
Vault markdown, frontmatter, imported filenames, provider responses, model tool calls, YouTube
responses, downloaded requirement bytes, helper output, and webview IPC arguments are untrusted.

## Assets and security objectives

- Vault contents: preserve confidentiality, integrity, Obsidian compatibility, and user ownership.
- Citation evidence: never attribute content to the wrong note or stale source.
- Provider API keys: never persist in plaintext config, return to the webview, or leak in errors.
- Local model and helper executables: execute only reviewed or upstream-verified code with bounded
  authority.
- User intent: model-authored tools must not write, delete, navigate, download, or execute beyond
  explicit policy.
- Availability: untrusted inputs must be bounded so parsing, processes, and streaming terminate.

## Trust boundaries

1. Webview to Rust IPC: all command arguments are attacker-controlled if the webview is compromised.
2. Vault filesystem: notes and directory structure may be malformed, oversized, non-UTF-8, or
   symlinked.
3. Model boundary: provider text and tool calls are untrusted proposals, not authority.
4. Network boundary: OpenRouter, Hugging Face, GitHub updater manifests/release assets, and YouTube
   are external and untrusted until their application-specific validation completes.
5. Process boundary: Ollama, yt-dlp, POT, and transcription helpers run outside the Rust process.
6. CI and build boundary: third-party actions, npm packages, crates, and downloaded tools can affect
   produced binaries and test verdicts.

## Entry points and controls

| Entry point | Principal threats | Primary controls |
|---|---|---|
| Vault open/read/write and skill profile state | traversal, symlink escape, overwrite, parser DoS, durable route poisoning | user-selected roots, canonical parent checks, descriptor-relative no-follow/regular-file checks, bounded parsing, create-new note semantics, atomic profile replacement, lifecycle cancellation, hash-guarded undo |
| Markdown/frontmatter render | XSS, remote beacons, broken content hiding | no raw HTML, safe URL transform, inert links, CSP, failed-image fallback, explicit lossy/parse notices |
| Source-native editor | source normalization, widget injection, unsafe navigation, remote fetches, parser or allocation DoS | exact separator map, text-node labels, viewport-bounded decorations, inert images/embeds, guarded vault resolver, safe external schemes, 8 MiB full-document write limit, optimistic concurrency, atomic write |
| Window-state IPC | unintended native window authority | `core:window:allow-is-fullscreen` exposes only the current main-window fullscreen boolean; it grants no window mutation authority |
| Chat/tool loop | prompt injection, excessive writes, forged citations | capability grants, fixed schemas, Rust dispatch validation, per-item budgets, evidence hashes, citation revalidation, iteration and span caps |
| Elicitation | model-provided active media, choice forgery | model images rejected, implementation images fully decoded and bounded, offered IDs and arity validated |
| Provider IPC/network and settings | key disclosure, arbitrary requests, ranking-data poisoning, hangs, concurrent preference loss | OS keychain, redaction, fixed HTTPS origins, no redirects, authenticated daily rankings, bounded reads, connect/total timeouts, defensive join/filter validation, exact last-offered model selection, in-process mutation sequencing, cross-process advisory lock, atomic config replacement |
| Ollama sidecar | port hijack, arbitrary model operation | loopback binding, child ownership/health checks, app-owned model store, curated pull/select/chat/delete tags |
| YouTube helpers | command injection, ambient config/plugin execution, output DoS, malformed caption inventory | typed YouTube URLs, fixed argv, no shell, absolute binaries, cleared environment, no config/default plugins, explicit pinned POT directory, time/output/cancel bounds, bounded versioned metadata projection with field/key grammar and cardinality checks |
| Requirement installer | malicious archive/binary, race, partial install | compiled HTTPS URL and digest, streamed SHA-256, archive entry/type/size limits, install locks, atomic publication |
| Application updater | manifest spoofing, malicious or downgraded archive, signing-key loss/theft | HTTPS production endpoint, mandatory Tauri artifact signature, embedded public key, strictly newer version comparison, explicit review/install consent, minimal updater/process capabilities |
| Local updater harness | replacement of the real app, private-key leak, exposed local files, insecure transport escaping to production | distinct bundle identity, unique ignored target, owner-only key path, allowlisted build environment, exact loopback binding/routes, generated-only HTTP override, valid and one-byte-tampered archive journeys |
| Native E2E automation | test-only direct execution escaping into production, arbitrary config-root replacement, cleanup outside the fixture root, production-keychain access, vault or credential disclosure in artifacts | optional `native-e2e` dependencies, release-profile compile guard, explicit production capability allowlist, distinct bundle and keychain identities, canonical marked temporary root, inherited `HOME`, post-exit marker-checked cleanup, content-redacted failure artifacts |
| Contributor CI | mutable dependency execution, secret misuse | full action commit hashes, exact locked Rust tools, read-only token, no workflow secrets |
| Release pipeline | signing-key exfiltration, write-token misuse, tag/ref race, artifact substitution, updater-key mismatch, trust-mode mislabelling | protected signing environment, secret-free preflight, protected immutable release tags, repeated remote tag-to-commit validation, read-only build token, signing-secret-free write publisher, fixed checksum-bound artifact set, updater signature verified with the configured public key before upload, exact-asset recovery check, explicit signing-mode notes, manifest published last |

## Threat analysis

### Spoofing

An unrelated loopback process could impersonate Ollama or POT. NeuralNote binds app-owned children,
checks their lifecycle and health, and rejects a healthy endpoint when its own child has exited.
External provider identity relies on platform TLS and the configured HTTPS origin.
The OpenRouter model menu fetches only the compiled
`https://openrouter.ai/api/v1/datasets/rankings-daily` and
`https://openrouter.ai/api/v1/models` endpoints, with redirects disabled. The API key authenticates
only the daily dataset request and remains inside the Rust/keychain boundary. Ranking and catalogue
responses are size-bounded, parsed into fixed data-only structs, joined and filtered in the core,
and cached only after complete validation. The webview receives no raw provider body, token total,
or credential and may persist only an identifier from the last validated offer set. The rankings
attribution opener accepts no caller URL and uses a Rust-owned constant.

### Tampering

Vault path and symlink swaps are the highest-impact local tampering path. Writes open and validate
the actual parent, create without overwrite, retain the filesystem's stored spelling, and record
content hashes for undo. Downloaded helpers are verified before atomic publication. Citation spans
are rechecked against note hashes before emission.

Vault-scoped skill routing is stored at `.neuralnote/profile.json` only after the normal durable-tool
approval. The desktop binds one raw-byte profile backend to the chat run's canonical vault and close
signal. On Unix it opens the vault and state directory as stable descriptors, refuses directory and
leaf symlinks or non-regular profile files, stages bytes with exclusive no-follow creation, syncs,
and atomically renames before syncing the directory. Missing state is a genuine absence and does not
create `.neuralnote` during ordinary chat. Non-Unix builds fail this seam closed alongside their
already-unavailable descriptor-confined note writer rather than substituting weaker path operations.

The source-native editor keeps complete Markdown source authoritative. Its line-ending map follows
CodeMirror transactions and blocks saving if that map becomes inconsistent. Decorations and
completion use DOM text nodes: raw HTML/MDX/JSX is never mounted, and images and embeds have no
fetching URL. Widget interaction can move the source selection, edit a bounded task marker, or insert
a normalized source H1 at a conservatively proven BOM/frontmatter boundary; malformed frontmatter
keeps the title external. Modifier-key wikilink and Markdown-link navigation can emit only a path
returned by the existing vault resolver; the native open path remains independently guarded. Every
save uses the existing expected-hash, serialized-mutation, vault-contained atomic write path.

The native E2E root override accepts only a canonical real directory created directly under the
process temporary directory, with the expected prefix and a small non-symlink ownership marker.
The runner records a per-session identifier in that marker and cleanup revalidates the same root,
marker and identifier only after every embedded-driver child returns normally and the app has
exited. A signalled child leaves the marked root intact because app exit is unproven. The harness
never replaces `HOME`. Feature builds address the separate `com.neuralnote.desktop.e2e` /
`openrouter-api-key-e2e` keychain namespace, so merely mounting the native fixture cannot read,
overwrite or clear the production OpenRouter credential.
The same debug-only feature records only `read_note` file names in the marked root so inert-image
tests can prove that decoration never requests an image or embed from native storage. The artifacts
directory must be a canonical direct child of that root; directory-relative no-follow opens on Unix
and locked reparse-point-aware handles on Windows prevent the audit append from following links.
The audit is absent from production builds, contains no note body or parent path, and is deleted
with the marked root after a confirmed app exit.

### Repudiation

NeuralNote is single-user and has no audit-log identity system. User-visible progress, explicit
errors, created-note events, and undo ledgers provide local accountability. This is sufficient for
v1 but is not a forensic audit trail.

### Information disclosure

The API key stays in the OS keychain and error bodies are redacted. Editor image and embed widgets
contain no `src` or network action, the webview cannot load remote images, model-authored image URIs are rejected, helper error details are bounded and path-free before
model exposure, and the production bundle emits no source maps. Vault content is intentionally sent
to the selected model only through chat/retrieval flows initiated by the user.
Native E2E failure capture clones and redacts editable DOM content before writing page source, hides
editable content while taking screenshots, redacts credential-shaped log values and the temporary
root, and uploads only the resulting artifact directory rather than seeded vault fixtures.

### Denial of service

Editable full-document writes are capped at 8 MiB before filesystem mutation. Editor decorations
iterate visible ranges and use CodeMirror's maintained incremental Markdown parser; retained tab
sessions are bounded. Other parsers cap bytes, lines, entries, dimensions, aliases, and decoded media. Tool loops cap iterations,
spans, write budgets, and playlist work. Network and process operations have deadlines, bounded pipes,
and cancellation. The Sonar-reported backtracking expression was replaced by a linear scan.

Vault profile reads take at most 64 KiB plus one detection byte and use non-blocking no-follow opens,
so a FIFO, device, oversized file, or symlink is rejected rather than read or waited on. Profile saves
enforce the same byte limit before creating the state directory and bound temporary-name collisions.

The yt-dlp metadata projection excludes signed caption URLs and validates record order, top-level
field presence, key grammar, extension grammar, uniqueness, and cardinality. Its formatter renders
an empty caption dictionary and other falsey values identically, so dictionary type still relies on
the pinned yt-dlp schema. A stale helper that violates that documented schema could misclassify a
malformed inventory as empty and reach the user-approved Whisper fallback; this is a retained
residual risk, not authority to write or execute without the normal approval gates.

### Elevation of privilege

The webview has minimal Tauri capabilities and no shell/filesystem plugin access. Rust commands are
still privileged, so their validators are the security boundary. External tools receive fixed argv,
sanitised environments, app-owned workspaces, and no ambient yt-dlp plugins. Model calls gain tools
only through explicit skill activation and can never bypass Rust write or citation policy.

The WebdriverIO execution and WebDriver plugins are intentionally high-authority test principals.
They are optional dependencies activated only by the `native-e2e` Cargo feature, registered behind
that feature, and granted only by the E2E capability/config using the distinct
`com.neuralnote.desktop.e2e` identity. Enabling the feature in Cargo's release profile, including a
release profile with debug assertions forced on, is a compile-time error, while production config
explicitly selects only the default capability. The E2E frontend's minimal automation bridge is
likewise imported only by the E2E build; a
post-build marker scan fails both production bundles containing the bridge and E2E bundles missing
it. The bridge exposes only bounded document mutations and the fixed `close-vault` menu event
required where embedded WKWebView cannot deliver WebDriver input. It returns no note source and
accepts no arbitrary command name. On macOS, one feature-gated IPC command accepts no serialized
arguments and dispatches a fixed Command-S `NSEvent` through the active AppKit window so the
installed Tauri menu key equivalent is exercised. It cannot choose another key or command and never
emits the save event or writes a note directly. The E2E capability adds only window-fullscreen
mutation beyond the production capability so the native titlebar transition can be exercised and
reversed.

## Abuse cases retained as regression targets

- `../`, absolute, Unicode-normalised, case-variant, and symlink-swapped note paths.
- Alias-amplified or malformed YAML, huge lines, invalid UTF-8, and binary files.
- BOM, LF, CRLF, CR, mixed endings, tabs, trailing whitespace, Unicode, ambiguous separator maps,
  oversized drafts, malformed Markdown, raw HTML/MDX/JSX, unsafe links, remote image/embed targets,
  completion-label injection, unresolved wikilinks, and forged widget navigation targets.
- Unknown citation IDs and notes modified between retrieval and answer emission.
- Model-authored remote and data image URIs.
- Unknown Hugging Face repositories and Ollama tags sent directly over IPC.
- Oversized, malformed, duplicate, wrong-day, redirected, or unauthenticated OpenRouter ranking
  responses; catalogue/ranking slug mismatches; and model IDs not in the last validated offer set.
- YouTube URLs with option-like video IDs, shell suffixes, block/rate-limit responses, oversized
  metadata, falsey non-dictionary caption inventories, captions, playlists, thumbnails, stderr,
  and process output.
- Missing, oversized, non-UTF-8, symlinked, non-regular, path-swapped, and cancellation-raced vault
  profiles, including predictable temporary-file collisions.
- Portable/system yt-dlp configuration and default plugin locations.
- Archive traversal, symlink entries, oversized extraction, checksum mismatch, and concurrent install.
- Spoofed, malformed, equal-version, downgraded, empty-signature, and wrong-signature updater manifests.
- Local updater traversal requests, config/signature/key-file requests, non-loopback endpoints, and
  harness app paths that resolve outside the unique session.
- Native E2E roots that are relative, outside the process temp directory, symlinked, unmarked,
  forged, oversized, or replaced before cleanup; release-profile automation builds; note content,
  credentials, or absolute fixture roots in failure artifacts; and late failures retried after the
  first-test readiness sentinel.
- Release dispatch from a non-main ref, missing or moved tag, tag/main mismatch, missing mode-specific
  credentials, absent ad-hoc acknowledgement, duplicate release or manifest, unexpected transferred
  artifact, checksum mismatch, and an ad-hoc build labelled as notarized.

## Residual risk and review triggers

- Revisit the model when full-source article/PDF capture, embeddings, sync, mobile, managed cloud AI,
  or plugin installation authority is added. Revisit updater controls when adding another release
  origin, downgrade support, background installation, or key rotation.
- Any new Tauri command, capability, external origin, helper binary, archive format, or model tool must
  be added to the boundary table and receive adversarial tests.
- Any expansion of native automation beyond debug E2E builds, or any new direct-execution
  permission, must re-open this review. The automation plugins must never enter production features,
  capabilities, bundles, or release profiles.
- Gatekeeper friction is accepted for ad-hoc alpha builds until Developer ID credentials are
  available. The release notes and runbook must not describe an ad-hoc build as Apple-verified.
- A future Linux release should re-evaluate Tauri's GTK/WebKit dependency chain and RustSec
  informational advisories on the actual Linux target.
- Sync or multiple identities will require authentication, authorization, conflict integrity, and an
  auditable event model that v1 intentionally does not have.
