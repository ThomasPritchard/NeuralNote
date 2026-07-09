---
id: CONV-001
type: convention
title: Separate tsconfig files for build vs typecheck
status: accepted
source: ai-drafted
applies_to:
  - app/desktop/tsconfig.build.json
  - app/desktop/tsconfig.json
provenance:
  signals:
    - kind: file
      ref: app/desktop/tsconfig.build.json
    - kind: file
      ref: app/desktop/package.json
  model: claude-sonnet-4-6
  confidence: 0.97
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

Production builds use a dedicated tsconfig.build.json that extends the main tsconfig.json but excludes test files, so test-only type quirks cannot block release builds.
