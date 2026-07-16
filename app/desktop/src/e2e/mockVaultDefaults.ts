// Local-AI and skills default fixtures (a capable Apple-Silicon machine on the
// supported path). Shared by the AI-provider and chat-runtime backends.

import type {
  CandidateModel,
  HardwareSpec,
  PullEvent,
  Recommendation,
  SkillListing,
} from "../lib/types";

const GIB = 1024 ** 3;

export const DEFAULT_HARDWARE: HardwareSpec = {
  totalRamBytes: 16 * GIB,
  cpuCores: 8,
  cpuBrand: "Apple M2",
  gpuLabel: null,
  arch: "aarch64",
  os: "macos",
};

export const DEFAULT_LOCAL_CANDIDATES: CandidateModel[] = [
  {
    tag: "llama3.2:3b",
    params: "3.2B",
    downloadBytes: 2_000_000_000,
    minRamBytes: 6_000_000_000,
    license: "Llama 3.2",
    hfRepo: "meta-llama/Llama-3.2-3B-Instruct",
  },
  {
    tag: "qwen2.5:7b",
    params: "7.6B",
    downloadBytes: 4_700_000_000,
    minRamBytes: 10_000_000_000,
    license: "Apache-2.0",
    hfRepo: "Qwen/Qwen2.5-7B-Instruct",
  },
];

export const DEFAULT_RECOMMENDATION: Recommendation = {
  status: "supported",
  modelTag: "qwen2.5:7b",
  params: "7.6B",
  estRamBytes: 10_000_000_000,
  why: "Fits comfortably in your 11 GB of usable memory.",
};

/** Mirror of the compiled-in registry's fixture skill (`fixture_manifest`,
 *  crates/neuralnote-core/src/ai/skills.rs), enabled by default as it ships. */
export const DEFAULT_SKILLS: SkillListing[] = [
  {
    id: "fixture-note-workflow",
    name: "Fixture note workflow",
    description: "Demonstrate progress, elicitation, and a guarded note write.",
    icon: "flask",
    enabled: true,
    requirements: [],
  },
];

/** A short, realistic pull: manifest → half → full → success. */
export const DEFAULT_PULL_SCRIPT: PullEvent[] = [
  { type: "progress", status: "pulling manifest", digest: null, completed: null, total: null, percent: null },
  { type: "progress", status: "downloading", digest: "sha256:abc", completed: 2_350_000_000, total: 4_700_000_000, percent: 50 },
  { type: "progress", status: "downloading", digest: "sha256:abc", completed: 4_700_000_000, total: 4_700_000_000, percent: 100 },
  { type: "success" },
];

export const DEFAULT_REQUIREMENT_DOWNLOAD_SCRIPT: PullEvent[] = [
  {
    type: "progress",
    status: "downloading",
    digest: null,
    completed: null,
    total: null,
    percent: null,
  },
  { type: "success" },
];
