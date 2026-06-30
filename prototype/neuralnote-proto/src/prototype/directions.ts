// Registry of the six design directions. `id` matches the [data-direction]
// token block in themes.css and the ?variant= URL param.
export interface DirectionMeta {
  id: string;
  label: string;
  soul: string;
}

export const directions: DirectionMeta[] = [
  { id: "neuralnote", label: "NeuralNote · chosen", soul: "Deepflow indigo skin + Obsidian-native UX" },
  { id: "eden", label: "Eden", soul: "warm-dark · soft sage · calm & spacious" },
  { id: "obsidian", label: "Obsidian-native", soul: "dense · neutral grey · purple accent" },
  { id: "collective", label: "Collective OS", soul: "cream paper · heavy editorial type" },
  { id: "deepflow", label: "Deepflow", soul: "indigo dashboard · data-viz chrome" },
  { id: "linear", label: "Linear", soul: "zinc command deck · crisp & refined" },
  { id: "vercel", label: "Vercel", soul: "monochrome · graph paper · sharp" },
];

export const directionIds = directions.map((d) => d.id);
export const defaultDirection = "neuralnote";
