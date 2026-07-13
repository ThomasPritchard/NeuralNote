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

export async function bootstrapPreferences(): Promise<AppPreferencesLoad> {
  try {
    const loaded = await api.loadAppPreferences();
    applyPreferences(loaded.preferences);
    return loaded;
  } catch (error) {
    const fallback: AppPreferencesLoad = {
      preferences: { ...DEFAULT_PREFERENCES },
      recoveredFromCorrupt: true,
      recoveryMessage: `Preferences could not be loaded. Safe defaults are active for this launch. ${errorMessage(error)}`,
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
}: Readonly<{ initial: AppPreferencesLoad; children: ReactNode }>) {
  const [preferences, setPreferences] = useState(initial.preferences);
  const [saving, setSaving] = useState(false);
  const toast = useToast();

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  useEffect(() => {
    if (!initial.recoveredFromCorrupt) return;
    toast.error(
      initial.recoveryMessage ??
        "Preferences were corrupt. Safe defaults are active for this launch.",
      { dedupKey: "preferences-recovery" },
    );
  }, [initial.recoveredFromCorrupt, initial.recoveryMessage, toast]);

  const update = useCallback(
    async (
      patch: Partial<AppPreferences>,
      confirmation = "Settings saved",
    ): Promise<boolean> => {
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
    [preferences, toast],
  );

  const value = useMemo(
    () => ({
      preferences,
      saving,
      suppressAutomaticChecksThisLaunch: initial.recoveredFromCorrupt,
      update,
    }),
    [initial.recoveredFromCorrupt, preferences, saving, update],
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
