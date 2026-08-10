---
id: CONV-005
type: convention
title: Prototype is excluded from production analysis and coverage
status: superseded
superseded_reason: The prototype/ directory was removed at 4d87df3; nothing is in scope.
source: ai-drafted
applies_to: []
provenance:
  signals:
    - kind: file
      ref: sonar-project.properties
    - kind: file
      ref: .gitignore
  model: claude-sonnet-4-6
  confidence: 0.96
---

## Context

Extracted by Keel's first-connect analysis of ThomasPritchard/NeuralNote from the files cited in provenance.

## Decision

The prototype/ directory is explicitly excluded from SonarQube source analysis, coverage reporting, and build targets to prevent throwaway code from influencing quality metrics.

## Superseded

The prototype was deleted at `4d87df3` and its `sonar.exclusions` entry removed with it. The
design record it produced lives in `docs/design-exploration/`. This convention now governs
nothing; the underlying principle (throwaway code stays out of quality metrics) survives in the
remaining exclusions in `sonar-project.properties`.
