import type { FontFamily, FontScale, ThemeId } from "../lib/types";
import { usePreferences } from "../preferences/preferences";

const THEMES: ReadonlyArray<{ id: ThemeId; label: string; swatches: string }> = [
  { id: "neuralVioletLight", label: "Neural Violet Light", swatches: "#7652c8,#f8f7fb" },
  { id: "neuralVioletDark", label: "Neural Violet Dark", swatches: "#a879ef,#29282b" },
  { id: "oceanBlueLight", label: "Ocean Blue Light", swatches: "#1670b8,#f4f9fc" },
  { id: "oceanBlueDark", label: "Ocean Blue Dark", swatches: "#4fa8e8,#17232d" },
  { id: "forestLight", label: "Forest Light", swatches: "#377f58,#f5f8f4" },
  { id: "forestDark", label: "Forest Dark", swatches: "#70bc89,#18241d" },
];

const SCALES: ReadonlyArray<{ id: FontScale; label: string }> = [
  { id: "small", label: "Small 90%" },
  { id: "default", label: "Default 100%" },
  { id: "large", label: "Large 112.5%" },
];

export function AppearanceSettingsPage() {
  const { preferences, saving, update } = usePreferences();
  const save = (patch: Parameters<typeof update>[0]) =>
    void update(patch, "Appearance saved");

  return (
    <section aria-labelledby="appearance-heading" className="flex flex-col gap-6">
      <div>
        <h3 id="appearance-heading" className="nn-heading text-sm font-semibold">
          Appearance
        </h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Choose an explicit palette and readable type scale for every window.
        </p>
      </div>

      <fieldset disabled={saving} className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <legend className="col-span-full mb-1 text-xs font-medium">Theme</legend>
        {THEMES.map(({ id, label, swatches }) => {
          const [accent, surface] = swatches.split(",");
          return (
            <label
              key={id}
              className="flex cursor-pointer items-center gap-2 rounded-lg border border-border p-2.5 text-xs has-[:checked]:border-primary has-[:checked]:ring-1 has-[:checked]:ring-primary focus-within:ring-2 focus-within:ring-ring"
            >
              <input
                type="radio"
                name="theme"
                value={id}
                checked={preferences.theme === id}
                onChange={() => save({ theme: id })}
                className="sr-only"
              />
              <span className="flex shrink-0 overflow-hidden rounded-full border border-border">
                <span className="size-3" style={{ background: accent }} />
                <span className="size-3" style={{ background: surface }} />
              </span>
              {label}
            </label>
          );
        })}
      </fieldset>

      <label className="flex flex-col gap-1.5 text-xs font-medium">
        <span>Font family</span>
        <select
          value={preferences.fontFamily}
          disabled={saving}
          onChange={(event) =>
            save({ fontFamily: event.currentTarget.value as FontFamily })
          }
          className="h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <option value="inter">Inter</option>
          <option value="atkinsonHyperlegible">Atkinson Hyperlegible</option>
          <option value="sourceSerif4">Source Serif 4</option>
        </select>
      </label>

      <fieldset disabled={saving} className="flex flex-wrap gap-2">
        <legend className="mb-1 text-xs font-medium">Font scale</legend>
        {SCALES.map(({ id, label }) => (
          <label
            key={id}
            className="cursor-pointer rounded-md border border-border px-3 py-2 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary/10 focus-within:ring-2 focus-within:ring-ring"
          >
            <input
              type="radio"
              name="font-scale"
              checked={preferences.fontScale === id}
              onChange={() => save({ fontScale: id })}
              className="sr-only"
            />
            {label}
          </label>
        ))}
      </fieldset>
    </section>
  );
}
