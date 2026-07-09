---
id: CONV-002
type: convention
title: ts-rs bindings auto-generated from Rust types and kept in sync
status: accepted
source: ai-drafted
applies_to:
  - app/desktop/src/lib/bindings/**
  - crates/**/*.rs
  - app/desktop/src-tauri/**/*.rs
provenance:
  signals:
    - kind: file
      ref: .cargo/config.toml
    - kind: file
      ref: crates/neuralnote-core/Cargo.toml
    - kind: file
      ref: scripts/rust-quality-gate.sh
    - kind: file
      ref: app/desktop/package.json
  model: claude-sonnet-4-6
  confidence: 0.98
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

Rust types annotated with #[ts(export)] generate TypeScript mirror files into app/desktop/src/lib/bindings/ during cargo test. Both the quality gate script and the npm check:bindings script fail the build if the committed output drifts from the source.
