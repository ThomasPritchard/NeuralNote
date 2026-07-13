import { VaultProvider, useVault } from "./lib/store";
import { Welcome } from "./welcome/Welcome";
import { Workspace } from "./workspace/Workspace";

/** Top-level route: the workspace once a vault is open, otherwise the welcome
 *  screen (which also renders the brief "loading" state while a vault opens). */
function Router() {
  const { status } = useVault();
  return status === "open" ? <Workspace /> : <Welcome />;
}

export default function App() {
  return (
    <>
      <a className="nn-skip-link" href="#nn-main-content">Skip to content</a>
      <VaultProvider>
        <Router />
      </VaultProvider>
    </>
  );
}
