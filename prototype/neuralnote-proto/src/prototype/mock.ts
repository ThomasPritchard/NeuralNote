// Shared mock vault for the NeuralNote design prototype.
// Every direction renders THIS data so variants are compared on look/structure,
// not on different content. Read-only — no persistence (prototype rule).

export type SourceType = "youtube" | "article" | "pdf" | "text";

export interface VaultNote {
  id: string;
  title: string;
  type: SourceType;
  tags: string[];
  /** human "time ago" label for the prototype */
  captured: string;
  /** one-line distilled hook shown in lists */
  excerpt: string;
}

export interface VaultFolder {
  name: string;
  notes: VaultNote[];
}

export const vault: VaultFolder[] = [
  {
    name: "Research",
    notes: [
      {
        id: "attention",
        title: "Attention Is All You Need — distilled",
        type: "youtube",
        tags: ["ml", "transformers", "architecture"],
        captured: "2h ago",
        excerpt: "Self-attention replaces recurrence; parallelism is the whole point.",
      },
      {
        id: "scaling",
        title: "Scaling Laws for Neural LMs",
        type: "pdf",
        tags: ["ml", "scaling"],
        captured: "yesterday",
        excerpt: "Loss falls as a power law in compute, data, and parameters.",
      },
      {
        id: "bitter",
        title: "The Bitter Lesson",
        type: "article",
        tags: ["ml", "philosophy"],
        captured: "3d ago",
        excerpt: "General methods that leverage computation win over hand-crafted ones.",
      },
    ],
  },
  {
    name: "Reading",
    notes: [
      {
        id: "secondbrain",
        title: "Building a Second Brain — notes",
        type: "article",
        tags: ["pkm", "productivity"],
        captured: "5d ago",
        excerpt: "Capture, organise, distil, express — the CODE method.",
      },
      {
        id: "rag",
        title: "Retrieval-Augmented Generation",
        type: "pdf",
        tags: ["ml", "rag", "retrieval"],
        captured: "1w ago",
        excerpt: "Ground generation in retrieved passages to cut hallucination.",
      },
    ],
  },
  {
    name: "Ideas",
    notes: [
      {
        id: "braindump",
        title: "Why citation fidelity is the moat",
        type: "text",
        tags: ["neuralnote", "product"],
        captured: "20m ago",
        excerpt: "A wrong citation is worse than no answer. Verify before showing.",
      },
    ],
  },
];

/** Flattened convenience list. */
export const allNotes: VaultNote[] = vault.flatMap((f) => f.notes);

// ── The note currently open in the reader pane ────────────────────────────
export interface OpenNote {
  id: string;
  title: string;
  type: SourceType;
  sourceUrl: string;
  tags: string[];
  capturedAt: string;
  distilModel: string;
  summary: string;
  keyClaims: string[];
  /** full retained source, chunked with provenance (the moat) */
  sourceChunks: SourceChunk[];
}

export interface SourceChunk {
  id: string;
  /** timestamp for video, "p.4" for pdf, offset for text */
  locator: string;
  text: string;
}

export const openNote: OpenNote = {
  id: "attention",
  title: "Attention Is All You Need — distilled",
  type: "youtube",
  sourceUrl: "youtube.com/watch?v=iDulhoQ2pro",
  tags: ["ml", "transformers", "architecture"],
  capturedAt: "29 Jun 2026, 14:03",
  distilModel: "claude-haiku-4.5",
  summary:
    "The Transformer drops recurrence and convolutions entirely, relying only on self-attention to draw global dependencies between input and output. Because every position attends to every other in a single step, training parallelises across the sequence — the practical reason it overtook RNNs.",
  keyClaims: [
    "Self-attention connects all positions with O(1) sequential operations, vs O(n) for recurrent layers.",
    "Multi-head attention lets the model attend to information from different representation subspaces at once.",
    "Positional encodings reinject order information that attention alone discards.",
  ],
  sourceChunks: [
    {
      id: "c1",
      locator: "04:12",
      text: "…recurrent models factor computation along the symbol positions of the input and output sequences, which inherently precludes parallelisation within a training example…",
    },
    {
      id: "c2",
      locator: "07:48",
      text: "…the Transformer allows for significantly more parallelisation because it relies entirely on an attention mechanism to draw global dependencies between input and output…",
    },
    {
      id: "c3",
      locator: "12:30",
      text: "…we employ multi-head attention so the model can jointly attend to information from different representation subspaces at different positions…",
    },
  ],
};

// ── Cited chat thread (the hero surface) ──────────────────────────────────
export interface Citation {
  marker: number;
  noteTitle: string;
  noteType: SourceType;
  locator: string;
  snippet: string;
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
  citations?: Citation[];
}

export const chatThread: ChatTurn[] = [
  {
    role: "user",
    text: "Across what I've read, why did transformers replace RNNs?",
  },
  {
    role: "assistant",
    text: "Two reasons recur across your sources. First, transformers parallelise: self-attention relates every position in a single step, so training no longer has to walk the sequence one token at a time the way recurrence does [1]. Second, that same all-to-all attention captures long-range dependencies directly, instead of threading them through a hidden state [2]. Your scaling notes add the payoff — once training parallelises, you can pour in far more compute, and loss keeps falling as a power law [3].",
    citations: [
      {
        marker: 1,
        noteTitle: "Attention Is All You Need — distilled",
        noteType: "youtube",
        locator: "04:12",
        snippet:
          "recurrent models … inherently preclude parallelisation within a training example",
      },
      {
        marker: 2,
        noteTitle: "Attention Is All You Need — distilled",
        noteType: "youtube",
        locator: "07:48",
        snippet:
          "relies entirely on an attention mechanism to draw global dependencies between input and output",
      },
      {
        marker: 3,
        noteTitle: "Scaling Laws for Neural LMs",
        noteType: "pdf",
        locator: "p.3",
        snippet: "test loss scales as a power law with compute, dataset size, and parameters",
      },
    ],
  },
];

/** Recent capture chips for the "throw anything in" affordance. */
export const recentCaptures = [
  { label: "youtube.com/watch?v=…", type: "youtube" as SourceType, state: "distilled" },
  { label: "arxiv.org/abs/2001.08361", type: "pdf" as SourceType, state: "distilling" },
  { label: "Brain-dump · 20m ago", type: "text" as SourceType, state: "distilled" },
];

export const vaultStats = {
  notes: 142,
  sources: 168,
  folders: 9,
  embedded: "1.2M tokens",
};

// ── Nested vault tree (VSCode-style) ──────────────────────────────────────
// Additive: only the chosen `neuralnote` direction uses this. The flat `vault`
// above is untouched so the other directions keep working.
export interface VaultTreeFolder {
  name: string;
  folders?: VaultTreeFolder[];
  notes?: VaultNote[];
}

const note = (id: string): VaultNote => allNotes.find((n) => n.id === id)!;

export const vaultTree: VaultTreeFolder[] = [
  {
    name: "Research",
    folders: [
      {
        name: "Papers",
        folders: [{ name: "Foundational", notes: [note("attention")] }],
        notes: [note("scaling")],
      },
    ],
    notes: [note("bitter")],
  },
  {
    name: "Reading",
    notes: [note("secondbrain"), note("rag")],
  },
  { name: "Ideas", notes: [note("braindump")] },
];
