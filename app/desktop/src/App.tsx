import { VaultProvider, useVault } from "./lib/store";
import { Welcome } from "./welcome/Welcome";
import { Workspace } from "./workspace/Workspace";
import type { AppPreferencesLoad } from "./lib/types";
import { ToastProvider } from "./notifications";
import {
  DEFAULT_PREFERENCES,
  PreferencesProvider,
} from "./preferences/preferences";
import { UpdateCoordinator } from "./updates/UpdateCoordinator";
import { WhatsNewModal } from "./whats-new/WhatsNewModal";

/** Top-level route: the workspace once a vault is open, otherwise the welcome
 *  screen (which also renders the brief "loading" state while a vault opens). */
function Router() {
  const { status } = useVault();
  return status === "open" ? <Workspace /> : <Welcome />;
}

const DEFAULT_LOAD: AppPreferencesLoad = {
  preferences: DEFAULT_PREFERENCES,
  recoveredFromCorrupt: false,
  recoveryMessage: null,
};

export default function App({
  initialPreferences = DEFAULT_LOAD,
}: Readonly<{ initialPreferences?: AppPreferencesLoad }>) {
  return (
    <ToastProvider>
      <a className="nn-skip-link" href="#nn-main-content">Skip to content</a>
      <PreferencesProvider initial={initialPreferences}>
        <UpdateCoordinator>
          <VaultProvider>
            <Router />
          </VaultProvider>
        </UpdateCoordinator>
        <WhatsNewModal />
      </PreferencesProvider>
    </ToastProvider>
  );
}
