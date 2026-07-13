import {
  disable,
  enable,
  isEnabled,
} from "@tauri-apps/plugin-autostart";

/** Read the operating system registration; this is never served from preferences. */
export const getAutostartEnabled = (): Promise<boolean> => isEnabled();

/** Change registration, then confirm the state the operating system actually holds. */
export async function setAutostartEnabled(enabled: boolean): Promise<boolean> {
  if (enabled) await enable();
  else await disable();
  return isEnabled();
}
