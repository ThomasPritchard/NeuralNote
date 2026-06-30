// Mock knowledge graph for the 3D neural-galaxy prototype.
// Nodes = notes; edges = AI-inferred semantic links. Intra-cluster links are the
// obvious ones; `bridge` links are cross-topic connections the user never drew by
// hand — the thing NeuralNote surfaces that Obsidian's manual graph can't.

export interface GraphNode {
  id: string;
  title: string;
  cluster: string;
  type: "youtube" | "article" | "pdf" | "text";
  val: number; // relative size
  color: string;
}
export interface GraphLink {
  source: string;
  target: string;
  bridge?: boolean;
}

// Cluster → accent colour (tuned to the neuralnote indigo skin + a few accents).
// Colours tuned for even luminance so no cluster blows out to white under bloom
// (cyan / green / amber were intrinsically brighter than violet / pink).
export const clusters: Record<string, { label: string; color: string }> = {
  ml: { label: "Machine learning", color: "#7d6fe0" },
  pkm: { label: "Knowledge management", color: "#2f9d93" },
  product: { label: "NeuralNote / product", color: "#d83f86" },
  mind: { label: "Thinking & philosophy", color: "#cc8533" },
  neuro: { label: "Neuroscience", color: "#4ba87c" },
};

const seed: Record<string, [string, GraphNode["type"]][]> = {
  ml: [
    ["Attention Is All You Need", "youtube"],
    ["Scaling Laws for Neural LMs", "pdf"],
    ["Retrieval-Augmented Generation", "pdf"],
    ["The Bitter Lesson", "article"],
    ["Multi-head attention, explained", "youtube"],
    ["Embeddings & vector search", "article"],
    ["Chinchilla compute-optimal", "pdf"],
    ["Why context windows matter", "text"],
    ["Fine-tuning vs RAG", "article"],
    ["Tokenisation deep-dive", "youtube"],
  ],
  pkm: [
    ["Building a Second Brain", "article"],
    ["Zettelkasten method", "article"],
    ["The PARA system", "text"],
    ["Progressive summarisation", "article"],
    ["Spaced repetition & recall", "youtube"],
    ["Note-taking that compounds", "text"],
    ["Evergreen notes", "article"],
    ["Linking your thinking", "youtube"],
    ["Capture in any form", "text"],
  ],
  product: [
    ["Why citation fidelity is the moat", "text"],
    ["The capture → distil loop", "text"],
    ["Obsidian-compatible vault", "text"],
    ["Local-first vs cloud-first", "article"],
    ["BYO-key cost awareness", "text"],
    ["Competitive: Recall & NotebookLM", "article"],
    ["The Obsidian refugee", "text"],
    ["Zero-setup positioning", "text"],
  ],
  mind: [
    ["First-principles thinking", "article"],
    ["Mental models latticework", "article"],
    ["Systems thinking primer", "youtube"],
    ["The map is not the territory", "text"],
    ["Compounding knowledge", "article"],
    ["Feynman technique", "youtube"],
    ["Inversion as a tool", "text"],
  ],
  neuro: [
    ["How memory consolidates", "youtube"],
    ["Neurons & synaptic pruning", "article"],
    ["Attention in the brain", "pdf"],
    ["The hippocampus & recall", "article"],
    ["Sleep and memory", "youtube"],
    ["Chunking & working memory", "text"],
  ],
};

// Build nodes.
export const graphNodes: GraphNode[] = Object.entries(seed).flatMap(([cluster, items]) =>
  items.map(([title, type], i) => ({
    id: `${cluster}-${i}`,
    title,
    cluster,
    type,
    val: i === 0 ? 7 : 2.5 + ((i * 7) % 5) * 0.7, // first node of each cluster is a hub
    color: clusters[cluster].color,
  })),
);

// Intra-cluster links: chain + spoke to the cluster hub (node 0).
const intra: GraphLink[] = Object.entries(seed).flatMap(([cluster, items]) =>
  items.flatMap((_, i) => {
    if (i === 0) return [];
    const links: GraphLink[] = [{ source: `${cluster}-0`, target: `${cluster}-${i}` }];
    if (i > 1 && i % 2 === 0) links.push({ source: `${cluster}-${i - 1}`, target: `${cluster}-${i}` });
    return links;
  }),
);

// Cross-cluster BRIDGES — AI-inferred links the user never made by hand.
const bridges: GraphLink[] = [
  { source: "ml-0", target: "neuro-2", bridge: true }, // attention (ML) ↔ attention (brain)
  { source: "ml-2", target: "product-0", bridge: true }, // RAG ↔ citation fidelity
  { source: "pkm-0", target: "product-1", bridge: true }, // second brain ↔ capture loop
  { source: "pkm-4", target: "neuro-0", bridge: true }, // spaced repetition ↔ memory consolidation
  { source: "mind-4", target: "ml-1", bridge: true }, // compounding ↔ scaling laws
  { source: "pkm-1", target: "mind-0", bridge: true }, // zettelkasten ↔ first principles
  { source: "neuro-5", target: "ml-7", bridge: true }, // working memory ↔ context windows
  { source: "product-5", target: "pkm-8", bridge: true }, // competitors ↔ capture-in-any-form
  { source: "mind-5", target: "pkm-3", bridge: true }, // Feynman ↔ progressive summarisation
];

export const graphLinks: GraphLink[] = [...intra, ...bridges];

export const graphData = { nodes: graphNodes, links: graphLinks };
export const galaxyStats = {
  notes: graphNodes.length,
  links: graphLinks.length,
  bridges: bridges.length,
  clusters: Object.keys(clusters).length,
};
