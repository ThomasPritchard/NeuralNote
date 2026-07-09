---
id: CONV-005
type: convention
title: Prototype is excluded from production analysis and coverage
status: accepted
source: ai-drafted
applies_to:
  - prototype/**
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
