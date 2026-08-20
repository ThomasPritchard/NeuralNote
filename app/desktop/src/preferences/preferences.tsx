import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { AppPreferences, AppPreferencesLoad, FontScale } from "../lib/types";
import { useToast } from "../notifications";

export const DEFAULT_PREFERENCES: AppPreferences = {
  automaticUpdateChecks: true,
  theme: "neuralVioletDark",
  fontScale: "default",
  fontFamily: "inter",
  lastSeenWhatsNewVersion: null,
};

const FONT_SCALE_PERCENT: Record<FontScale, string> = {
  small: "90%",
  default: "100%",
  large: "112.5%",
};

export function applyPreferences(
  preferences: AppPreferences,
  root: HTMLElement = document.documentElement,
) {
  root.dataset.theme = preferences.theme;
  root.dataset.fontFamily = preferences.fontFamily;
  root.style.fontSize = FONT_SCALE_PERCENT[preferences.fontScale];
}

/** Shown when a write is refused because the stored settings were never read. */
export const WRITE_REFUSED_MESSAGE =
  "Your saved settings could not be read, so they have not been overwritten. This change was not saved. Restart NeuralNote to try again.";

/** The bootstrap outcome, widened with a signal the generated `AppPreferencesLoad`
 *  cannot carry: whether the preferences file could not be READ at all.
 *
 *  The two failure modes need opposite write policies, so one flag cannot serve
 *  both. `recoveredFromCorrupt` means the file was read but its JSON was junk —
 *  the core already fell back to defaults, and overwriting those unusable bytes
 *  is a repair. `readFailed` means the bytes were never seen and are presumed
 *  intact, so writing anything destroys settings the user still has.
 *
 *  Required rather than optional on purpose: an optional boolean lets a call site
 *  construct a bootstrap without deciding which case it is in, and the case it
 *  would silently default to is the destructive one. */
export type PreferencesBootstrap = AppPreferencesLoad & { readFailed: boolean };

export async function bootstrapPreferences(): Promise<PreferencesBootstrap> {
  try {
    const loaded = await api.loadAppPreferences();
    applyPreferences(loaded.preferences);
    return { ...loaded, readFailed: false };
  } catch (error) {
    const fallback: PreferencesBootstrap = {
      preferences: { ...DEFAULT_PREFERENCES },
      // The core only rejects when the file could not be READ: a missing file and
      // unparseable JSON both RESOLVE (the latter with `recoveredFromCorrupt`).
      // So this branch is never a corrupt recovery — claiming otherwise is what
      // let the next write persist these defaults over settings that were fine.
      recoveredFromCorrupt: false,
      readFailed: true,
      recoveryMessage: `Your saved settings could not be read, so defaults are in use for this launch. They have not been changed, and new changes cannot be saved until they can be read. ${errorMessage(error)}`,
    };
    applyPreferences(fallback.preferences);
    return fallback;
  }
}

interface PreferencesContextValue {
  preferences: AppPreferences;
  saving: boolean;
  suppressAutomaticChecksThisLaunch: boolean;
  update: (
    patch: Partial<AppPreferences>,
    confirmation?: string,
  ) => Promise<boolean>;
}

const PreferencesContext = createContext<PreferencesContextValue | null>(null);

export function PreferencesProvider({
  initial,
  children,
}: Readonly<{ initial: PreferencesBootstrap; children: ReactNode }>) {
  const [preferences, setPreferences] = useState(initial.preferences);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  /** True when `preferences` are compiled-in defaults rather than the user's own,
   *  from either failure mode. Both owe the user a persistent explanation, and
   *  neither may let a background update check act on a preference we never read. */
  const usingFallbackDefaults = initial.recoveredFromCorrupt || initial.readFailed;

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!usingFallbackDefaults) return;
    toast.error(
      initial.recoveryMessage ??
        "Preferences were corrupt. Safe defaults are active for this launch.",
      { dedupKey: "preferences-recovery" },
    );
  }, [usingFallbackDefaults, initial.recoveryMessage, toast]);

  const update = useCallback(
    async (
      patch: Partial<AppPreferences>,
      confirmation = "Settings saved",
    ): Promise<boolean> => {
      // Fail closed. `preferences` here are defaults standing in for settings we
      // never managed to read, so saving them would overwrite a file that is
      // still intact — silently and permanently.
      if (initial.readFailed) {
        toast.error(WRITE_REFUSED_MESSAGE, { dedupKey: "preferences-read-failed" });
        return false;
      }
      const next = { ...preferences, ...patch };
      setSaving(true);
      try {
        await api.saveAppPreferences(next);
        setPreferences(next);
        toast.success(confirmation, { dedupKey: `preferences:${confirmation}` });
        return true;
      } catch (error) {
        toast.error(`Settings could not be saved. ${errorMessage(error)}`, {
          dedupKey: "preferences-save-error",
        });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [initial.readFailed, preferences, toast],
  );

  const value = useMemo(
    () => ({
      preferences,
      saving,
      suppressAutomaticChecksThisLaunch: usingFallbackDefaults,
      update,
    }),
    [usingFallbackDefaults, preferences, saving, update],
  );

  return (
    <PreferencesContext.Provider value={value}>
      {children}
    </PreferencesContext.Provider>
  );
}

export function usePreferences(): PreferencesContextValue {
  const value = useContext(PreferencesContext);
  if (!value) throw new Error("usePreferences must be used within PreferencesProvider");
  return value;
}
