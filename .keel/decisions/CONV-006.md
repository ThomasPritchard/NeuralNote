---
id: CONV-006
type: convention
title: Ollama sidecar download verified with pinned SHA-256 before install
status: accepted
source: ai-drafted
applies_to:
  - scripts/fetch-ollama-sidecar.sh
provenance:
  signals:
    - kind: file
      ref: scripts/fetch-ollama-sidecar.sh
  model: claude-sonnet-4-6
  confidence: 0.99
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

The fetch-ollama-sidecar script pins a specific Ollama release version and verifies the downloaded archive against a hardcoded SHA-256 checksum before extracting or installing anything, failing closed on mismatch or empty hash. Both ollama and llama-server executables must be present.
