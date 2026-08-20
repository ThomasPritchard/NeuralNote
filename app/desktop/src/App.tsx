import { VaultProvider, useVault } from "./lib/store";
import { Welcome } from "./welcome/Welcome";
import { Workspace } from "./workspace/Workspace";
import { ToastProvider } from "./notifications";
import { QuarantineRecoveryListener } from "./notifications/QuarantineRecoveryListener";
import {
  DEFAULT_PREFERENCES,
  PreferencesProvider,
  type PreferencesBootstrap,
} from "./preferences/preferences";
import { UpdateCoordinator } from "./updates/UpdateCoordinator";
import { WhatsNewModal } from "./whats-new/WhatsNewModal";

/** Top-level route: the workspace once a vault is open, otherwise the welcome
 *  screen (which also renders the brief "loading" state while a vault opens). */
function Router() {
  const { status } = useVault();
  return status === "open" ? <Workspace /> : <Welcome />;
}

const DEFAULT_LOAD: PreferencesBootstrap = {
  preferences: DEFAULT_PREFERENCES,
  recoveredFromCorrupt: false,
  readFailed: false,
  recoveryMessage: null,
};

export default function App({
  initialPreferences = DEFAULT_LOAD,
}: Readonly<{ initialPreferences?: PreferencesBootstrap }>) {
  return (
    <ToastProvider>
      <QuarantineRecoveryListener />
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
