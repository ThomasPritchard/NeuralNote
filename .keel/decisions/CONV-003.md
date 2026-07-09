---
id: CONV-003
type: convention
title: 64-bit integers mapped to TypeScript number (not bigint)
status: accepted
source: ai-drafted
applies_to:
  - .cargo/config.toml
  - crates/**/*.rs
provenance:
  signals:
    - kind: file
      ref: .cargo/config.toml
  model: claude-sonnet-4-6
  confidence: 0.97
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

TS_RS_LARGE_INT is set to "number" workspace-wide so that u64/i64 Rust types generate as TypeScript number, matching what JSON.parse yields over Tauri IPC. This is enforced via the Cargo workspace environment config.
