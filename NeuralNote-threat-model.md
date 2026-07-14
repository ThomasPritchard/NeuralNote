# NeuralNote threat model

Date: 2026-07-13

## Scope and assumptions

This model covers the current single-user Tauri 2 desktop application. NeuralNote has no
multi-tenant backend. It reads and writes a user-selected local markdown vault, talks outbound to
OpenRouter or an app-owned loopback Ollama sidecar, optionally reads curated Hugging Face metadata,
and runs app-owned capture helpers for YouTube. Mobile, sync, billing, managed cloud AI, and the
future full-source capture pipeline are out of scope.

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
| Vault open/read/write | traversal, symlink escape, overwrite, parser DoS | user-selected roots, canonical parent checks, no-follow/regular-file checks, bounded parsing, create-new semantics, hash-guarded undo |
| Markdown/frontmatter render | XSS, remote beacons, broken content hiding | no raw HTML, safe URL transform, inert links, CSP, failed-image fallback, explicit lossy/parse notices |
| Chat/tool loop | prompt injection, excessive writes, forged citations | capability grants, fixed schemas, Rust dispatch validation, per-item budgets, evidence hashes, citation revalidation, iteration and span caps |
| Elicitation | model-provided active media, choice forgery | model images rejected, implementation images fully decoded and bounded, offered IDs and arity validated |
| Provider IPC/network | key disclosure, arbitrary requests, hangs | OS keychain, redaction, HTTPS, exact curated repositories/models, connect/total timeouts, bounded streaming |
| Ollama sidecar | port hijack, arbitrary model operation | loopback binding, child ownership/health checks, app-owned model store, curated pull/select/chat/delete tags |
| YouTube helpers | command injection, ambient config/plugin execution, output DoS | typed YouTube URLs, fixed argv, no shell, absolute binaries, cleared environment, no config/default plugins, explicit pinned POT directory, time/output/cancel bounds |
| Requirement installer | malicious archive/binary, race, partial install | compiled HTTPS URL and digest, streamed SHA-256, archive entry/type/size limits, install locks, atomic publication |
| Application updater | manifest spoofing, malicious or downgraded archive, signing-key loss/theft | HTTPS production endpoint, mandatory Tauri artifact signature, embedded public key, strictly newer version comparison, explicit review/install consent, minimal updater/process capabilities |
| Local updater harness | replacement of the real app, private-key leak, exposed local files, insecure transport escaping to production | distinct bundle identity, unique ignored target, owner-only key path, allowlisted build environment, exact loopback binding/routes, generated-only HTTP override, valid and one-byte-tampered archive journeys |
| Contributor CI | mutable dependency execution, secret misuse | full action commit hashes, exact locked Rust tools, read-only token, no workflow secrets |
| Release pipeline | signing-key exfiltration, write-token misuse, tag/ref race, artifact substitution, updater-key mismatch, trust-mode mislabelling | protected signing environment, secret-free preflight, protected immutable release tags, repeated remote tag-to-commit validation, read-only build token, signing-secret-free write publisher, fixed checksum-bound artifact set, updater signature verified with the configured public key before upload, exact-asset recovery check, explicit signing-mode notes, manifest published last |

## Threat analysis

### Spoofing

An unrelated loopback process could impersonate Ollama or POT. NeuralNote binds app-owned children,
checks their lifecycle and health, and rejects a healthy endpoint when its own child has exited.
External provider identity relies on platform TLS and the configured HTTPS origin.

### Tampering

Vault path and symlink swaps are the highest-impact local tampering path. Writes open and validate
the actual parent, create without overwrite, retain the filesystem's stored spelling, and record
content hashes for undo. Downloaded helpers are verified before atomic publication. Citation spans
are rechecked against note hashes before emission.

### Repudiation

NeuralNote is single-user and has no audit-log identity system. User-visible progress, explicit
errors, created-note events, and undo ledgers provide local accountability. This is sufficient for
v1 but is not a forensic audit trail.

### Information disclosure

The API key stays in the OS keychain and error bodies are redacted. The webview cannot load remote
images, model-authored image URIs are rejected, helper error details are bounded and path-free before
model exposure, and the production bundle emits no source maps. Vault content is intentionally sent
to the selected model only through chat/retrieval flows initiated by the user.

### Denial of service

Parsers cap bytes, lines, entries, dimensions, aliases, and decoded media. Tool loops cap iterations,
spans, write budgets, and playlist work. Network and process operations have deadlines, bounded pipes,
and cancellation. The Sonar-reported backtracking expression was replaced by a linear scan.

### Elevation of privilege

The webview has minimal Tauri capabilities and no shell/filesystem plugin access. Rust commands are
still privileged, so their validators are the security boundary. External tools receive fixed argv,
sanitised environments, app-owned workspaces, and no ambient yt-dlp plugins. Model calls gain tools
only through explicit skill activation and can never bypass Rust write or citation policy.

## Abuse cases retained as regression targets

- `../`, absolute, Unicode-normalised, case-variant, and symlink-swapped note paths.
- Alias-amplified or malformed YAML, huge lines, invalid UTF-8, and binary files.
- Unknown citation IDs and notes modified between retrieval and answer emission.
- Model-authored remote and data image URIs.
- Unknown Hugging Face repositories and Ollama tags sent directly over IPC.
- YouTube URLs with option-like video IDs, shell suffixes, block/rate-limit responses, oversized
  metadata, captions, playlists, thumbnails, stderr, and process output.
- Portable/system yt-dlp configuration and default plugin locations.
- Archive traversal, symlink entries, oversized extraction, checksum mismatch, and concurrent install.
- Spoofed, malformed, equal-version, downgraded, empty-signature, and wrong-signature updater manifests.
- Local updater traversal requests, config/signature/key-file requests, non-loopback endpoints, and
  harness app paths that resolve outside the unique session.
- Release dispatch from a non-main ref, missing or moved tag, tag/main mismatch, missing mode-specific
  credentials, absent ad-hoc acknowledgement, duplicate release or manifest, unexpected transferred
  artifact, checksum mismatch, and an ad-hoc build labelled as notarized.

## Residual risk and review triggers

- Revisit the model when full-source article/PDF capture, embeddings, sync, mobile, managed cloud AI,
  or plugin installation authority is added. Revisit updater controls when adding another release
  origin, downgrade support, background installation, or key rotation.
- Any new Tauri command, capability, external origin, helper binary, archive format, or model tool must
  be added to the boundary table and receive adversarial tests.
- Gatekeeper friction is accepted for ad-hoc alpha builds until Developer ID credentials are
  available. The release notes and runbook must not describe an ad-hoc build as Apple-verified.
- A future Linux release should re-evaluate Tauri's GTK/WebKit dependency chain and RustSec
  informational advisories on the actual Linux target.
- Sync or multiple identities will require authentication, authorization, conflict integrity, and an
  auditable event model that v1 intentionally does not have.
