---
id: CONV-007
type: convention
title: TypeScript strict mode with noUnusedLocals and noUnusedParameters
status: accepted
source: ai-drafted
applies_to:
  - app/desktop/**/*.ts
  - app/desktop/**/*.tsx
provenance:
  signals:
    - kind: file
      ref: app/desktop/tsconfig.json
  model: claude-sonnet-4-6
  confidence: 0.96
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

All TypeScript compiler configurations enable strict: true (app) or equivalent strict linting flags (noUnusedLocals, noUnusedParameters, noFallthroughCasesInSwitch). This originally covered both the app and prototype workspaces; the prototype was removed at `4d87df3`, so the app is the remaining scope.
