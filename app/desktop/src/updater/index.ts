import { tauriUpdatePlatform } from "./platform";
import { createUpdateService } from "./service";

export { getAutostartEnabled, setAutostartEnabled } from "./autostart";
export type {
  UpdateCheckSource,
  UpdateMetadata,
  UpdateService,
  UpdateState,
} from "./service";

/** App-owned boundary. React consumes this service, never Tauri plugin APIs. */
export const updateService = createUpdateService(tauriUpdatePlatform);
