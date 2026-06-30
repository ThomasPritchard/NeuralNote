import { useEffect, useState, type ComponentType } from "react";
import { defaultDirection, directionIds, directions } from "./directions";
import { PrototypeSwitcher } from "./PrototypeSwitcher";
import Placeholder from "./directions/Placeholder";
import NeuralNote from "./directions/NeuralNote";
import Eden from "./directions/Eden";
import Obsidian from "./directions/Obsidian";
import Collective from "./directions/Collective";
import Deepflow from "./directions/Deepflow";
import Linear from "./directions/Linear";
import Vercel from "./directions/Vercel";
import NeuralGalaxy from "./galaxy/NeuralGalaxy";
import { isGalaxy } from "./galaxy/nav";
import { landingIds } from "./landing/landings";
import { getLanding } from "./landing/nav";
import { LandingSwitcher } from "./landing/LandingSwitcher";
import LandingGalaxy from "./landing/LandingGalaxy";
import LandingProduct from "./landing/LandingProduct";
import LandingGradient from "./landing/LandingGradient";

const builtLandings: Record<string, ComponentType> = {
  galaxy: LandingGalaxy,
  product: LandingProduct,
  gradient: LandingGradient,
};

// Map of built directions. Each direction owns its own component file.
const built: Record<string, ComponentType> = {
  neuralnote: NeuralNote,
  eden: Eden,
  obsidian: Obsidian,
  collective: Collective,
  deepflow: Deepflow,
  linear: Linear,
  vercel: Vercel,
};

function readVariant(): string {
  const v = new URLSearchParams(window.location.search).get("variant");
  return v && directionIds.includes(v) ? v : defaultDirection;
}

export default function PrototypeRoute() {
  const [variant, setVariant] = useState<string>(readVariant);
  const [galaxy, setGalaxyState] = useState<boolean>(isGalaxy);
  const [landing, setLandingState] = useState<string | null>(getLanding);

  // ?shot=1 suppresses dev-only switcher chrome so full-page screenshots are clean
  // (a position:fixed switcher otherwise pins to the top of a stitched full-page image).
  const showChrome = import.meta.env.DEV && !new URLSearchParams(window.location.search).has("shot");

  const change = (id: string) => {
    setVariant(id);
    const url = new URL(window.location.href);
    url.searchParams.set("variant", id);
    window.history.replaceState(null, "", url);
  };

  // Sync galaxy surface with the URL (?galaxy=1), driven by the ribbon + back button.
  useEffect(() => {
    const sync = () => {
      setGalaxyState(isGalaxy());
      setLandingState(getLanding());
    };
    window.addEventListener("nn-nav", sync);
    window.addEventListener("popstate", sync);
    return () => {
      window.removeEventListener("nn-nav", sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  // ← / → cycle directions, except while typing or in the galaxy.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (galaxy || landing) return;
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const el = document.activeElement;
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el as HTMLElement)?.isContentEditable
      )
        return;
      const i = directionIds.indexOf(variant);
      const delta = e.key === "ArrowRight" ? 1 : -1;
      change(directionIds[(i + delta + directionIds.length) % directionIds.length]);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [variant, galaxy]);

  // Landing surface — full-scroll marketing page in the chosen (neuralnote) skin.
  if (landing && landingIds.includes(landing)) {
    const Page = builtLandings[landing];
    return (
      <div data-direction="neuralnote" className="min-h-dvh w-full overflow-y-auto">
        {Page ? <Page /> : <Placeholder label="Landing" />}
        {showChrome && <LandingSwitcher current={landing} />}
      </div>
    );
  }

  // Galaxy surface — always rendered in the chosen (neuralnote) skin.
  if (galaxy) {
    return (
      <div data-direction="neuralnote" className="h-dvh w-full overflow-hidden">
        <NeuralGalaxy />
      </div>
    );
  }

  const Active = built[variant];
  const meta = directions.find((d) => d.id === variant);

  return (
    <>
      <div data-direction={variant} className="h-dvh w-full overflow-hidden">
        {Active ? <Active /> : <Placeholder label={meta?.label ?? variant} />}
      </div>
      {showChrome && <PrototypeSwitcher current={variant} onChange={change} />}
    </>
  );
}
