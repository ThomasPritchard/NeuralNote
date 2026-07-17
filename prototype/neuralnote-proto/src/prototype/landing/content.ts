// Shared marketing copy for the landing-page directions. Honest to the spec:
// no fabricated testimonials, logos, or user counts.

export const hero = {
  eyebrow: "Built for instant use.",
  headline: "More knowledge, less setup.",
  sub: "Your AI-powered knowledge assistant. Open your Markdown vault and start. NeuralNote helps you capture, organise, search and understand your knowledge without assembling the workflow yourself.",
  ctaPrimary: "Download for desktop",
  ctaSecondary: "See how it works",
  note: "Works with your existing Markdown vault. macOS · Windows · Linux.",
};

export const problem = {
  title: "A complete knowledge workflow, built on files you own.",
  body: "Open your Markdown vault and start. NeuralNote brings capture, organisation, search and understanding together in one ready-made workflow.",
};

// capture -> organise -> understand
export const loop = [
  {
    step: "01",
    title: "Capture anything",
    body: "Paste a link, drop a PDF, or brain-dump a thought. Voice and scanned pages are next.",
  },
  {
    step: "02",
    title: "Your assistant organises it",
    body: "NeuralNote creates a clear title, summary, tags and links while keeping the source connected to your note.",
  },
  {
    step: "03",
    title: "Ask what you know",
    body: "Ask across your whole library. Every answer stays connected to your notes and sources so you can check the context.",
  },
];

export const pillars = [
  {
    key: "capture",
    title: "Capture anything",
    body: "Bring videos, articles, PDFs and typed thoughts into one knowledge workflow. Start with useful defaults and shape it as your library grows.",
  },
  {
    key: "recall",
    title: "Answers connected to your sources",
    body: "Ask across everything you've captured, not one note at a time. Each answer stays linked to the relevant source context, with references verified before they are shown.",
    highlight: true,
  },
  {
    key: "own",
    title: "Markdown files you own",
    body: "Your library stays in open Markdown with YAML frontmatter. Open an existing vault, keep your familiar structure and take your files with you whenever you like.",
  },
];

// Customer-centred differentiation without naming another product.
export const why = {
  title: "Useful from the first vault",
  points: [
    "A complete knowledge workflow is ready when you open your Markdown vault.",
    "Your assistant organises what you capture and helps you understand it.",
    "Answers stay connected to your notes and sources while your library remains in files you own.",
  ],
};

// Stated honestly, up front: a trust signal, not fine print.
export const privacy = {
  title: "Yours, and honest about it.",
  body: "Local-first describes where your files live, not where your content goes. In this version, source content is sent to the AI and embedding providers you choose so your assistant can organise and answer. Your files stay on disk, and we tell you exactly what leaves the machine. Fully local AI is a later option.",
};

export const finalCta = {
  title: "More knowledge, less setup.",
  sub: "Open your Markdown vault and start.",
  cta: "Download for desktop",
  note: "AI-powered · Markdown-compatible · local-first · bring your own key",
};

export const nav = ["How it works", "Connected answers", "Own your data", "Download"];
