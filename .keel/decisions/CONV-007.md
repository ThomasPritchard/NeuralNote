---
id: CONV-007
type: convention
title: TypeScript strict mode with noUnusedLocals and noUnusedParameters
status: accepted
source: ai-drafted
applies_to:
  - app/desktop/**/*.ts
  - app/desktop/**/*.tsx
  - prototype/**/*.ts
  - prototype/**/*.tsx
provenance:
  signals:
    - kind: file
      ref: app/desktop/tsconfig.json
    - kind: file
      ref: prototype/neuralnote-proto/tsconfig.app.json
    - kind: file
      ref: prototype/neuralnote-proto/tsconfig.node.json
  model: claude-sonnet-4-6
  confidence: 0.96
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

All TypeScript compiler configurations enable strict: true (app) or equivalent strict linting flags (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch) in both the app and prototype workspaces.
