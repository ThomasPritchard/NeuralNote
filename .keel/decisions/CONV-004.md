---
id: CONV-004
type: convention
title: Rust quality gate enforces clippy, rustfmt, coverage ≥90%, and cargo-audit
status: accepted
source: ai-drafted
applies_to:
  - scripts/rust-quality-gate.sh
  - crates/**
  - app/desktop/src-tauri/**
provenance:
  signals:
    - kind: file
      ref: scripts/rust-quality-gate.sh
  model: claude-sonnet-4-6
  confidence: 0.97
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

A shell script runs four mandatory quality categories — clippy -D warnings, rustfmt --check, cargo-llvm-cov with --fail-under-lines 90, and cargo-audit — and exits non-zero if any enforced category fails.
