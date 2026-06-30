// Registry of the three landing-page directions (one per hero treatment).
export interface LandingMeta {
  id: string;
  label: string;
  hero: string;
}

export const landings: LandingMeta[] = [
  { id: "galaxy", label: "Galaxy hero", hero: "live 3D neural galaxy behind the hero" },
  { id: "product", label: "Product hero", hero: "workspace screenshot as the hero" },
  { id: "gradient", label: "Gradient hero", hero: "abstract gradient / motion hero" },
];

export const landingIds = landings.map((l) => l.id);
