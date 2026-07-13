// Shared marketing copy for the landing-page directions. Honest to the spec —
// no fabricated testimonials, logos, or user counts. Claims here are real
// product positioning (BYO-key, Obsidian-compatible, full-source cited recall).

export const hero = {
  eyebrow: "Desktop · bring your own API key",
  headline: "The second brain that actually read your sources.",
  sub: "Throw in anything — a YouTube lecture, a PDF, an article, a half-formed thought — and get back one clean, queryable, cited knowledge base. No filing, no setup. Just open your vault.",
  ctaPrimary: "Download for desktop",
  ctaSecondary: "See how it works",
  note: "macOS · Windows · Linux. Free, local-first. Bring your own key.",
};

export const problem = {
  title: "Obsidian hands you an empty room and a hardware store.",
  body: "The filing system, the plugins, the capture pipelines — all yours to assemble. That assembly is the hump most people never get over. Neural Note's thesis is simple: the assembly is the product. The AI does the filing you'd otherwise do by hand.",
};

// capture → distil → cite
export const loop = [
  {
    step: "01",
    title: "Capture anything",
    body: "Paste a link, drop a PDF, or brain-dump a thought. Voice and scanned pages are next.",
  },
  {
    step: "02",
    title: "AI distils & files it",
    body: "A clean title, summary, tags, and links — inferred for you. The full source is kept, not just the note you typed.",
  },
  {
    step: "03",
    title: "Ask, with citations",
    body: "Question your whole library. Every claim links back to the exact chunk or timestamp it came from.",
  },
];

export const pillars = [
  {
    key: "capture",
    title: "Universal capture, zero setup",
    body: "Any form goes in the same brain — video, article, PDF, typed brain-dump. No macros, no templates, no config. The organising you'd never do by hand is done for you.",
  },
  {
    key: "recall",
    title: "Cited recall — the part nobody else nails",
    body: "Ask across everything you've captured, not one note at a time. Each answer is grounded in the full source and linked to the exact chunk or timestamp. A wrong citation never reaches you — every one is verified before it's shown.",
    highlight: true,
  },
  {
    key: "own",
    title: "Your vault, your files",
    body: "Local-first markdown with YAML frontmatter, fully Obsidian-compatible. Migrating is just opening the folder. Walk away whenever you like and lose nothing.",
  },
];

// Honest differentiation (the three-part moat) — not "we capture the source".
export const why = {
  title: "Why this beats staying in Obsidian",
  points: [
    "It knows the full sources behind your notes, so it answers questions you never wrote down.",
    "One opinionated capture → distil → cite loop that swallows any input — no toolkit to assemble.",
    "Your library lives in your own files on disk, not someone else's cloud.",
  ],
};

// Stated honestly, up front (spec Section 3) — a trust signal, not fine print.
export const privacy = {
  title: "Yours, and honest about it.",
  body: "“Local-first” describes where your files live, not where your content goes. In this version, source content is sent to the AI and embedding providers you choose, to distil and to answer. Your files stay on disk; we tell you exactly what leaves the machine. Fully-local AI is a later option.",
};

export const finalCta = {
  title: "Move your brain in. Lose nothing.",
  sub: "Open your existing Obsidian vault and start asking it questions today.",
  cta: "Download for desktop",
  note: "Free and local-first · bring your own API key",
};

export const nav = ["How it works", "Cited recall", "Own your data", "Download"];
