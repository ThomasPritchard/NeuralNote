---
id: CONV-008
type: convention
title: Co-located test files excluded from SonarQube product-code metrics
status: accepted
source: ai-drafted
applies_to:
  - app/desktop/src/**/*.test.ts
  - app/desktop/src/**/*.test.tsx
provenance:
  signals:
    - kind: file
      ref: sonar-project.properties
  model: claude-sonnet-4-6
  confidence: 0.95
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

Test files (*.test.ts, *.test.tsx) are declared under sonar.tests with sonar.test.inclusions so they are counted as tests rather than product code, and are also listed in sonar.coverage.exclusions to avoid skewing coverage figures.
