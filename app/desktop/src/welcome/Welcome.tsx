// The full-screen welcome experience: brand, open/create entry points, recent
// vaults, and inline loading/error feedback. All vault lifecycle goes through
// the store (`useVault`); this screen never touches `invoke` directly. The store
// owns the single error channel and surfaces every failure — never silent.
import { useState, type ReactNode } from "react";
import { AlertTriangle, Loader2, ShieldCheck, X } from "lucide-react";
import { useVault } from "../lib/store";
import { AuroraGlow } from "./AuroraGlow";
import { BrandHeader } from "./BrandHeader";
import { CreateVaultForm } from "./CreateVaultForm";
import { RecentList } from "./RecentList";
import { VaultActions } from "./VaultActions";

export function Welcome() {
  const {
    status,
    recents,
    error,
    clearError,
    openExisting,
    openByPath,
    pickNewLocation,
    createVault,
  } = useVault();

  // Non-null once a parent directory is chosen: switches the action area into
  // the inline naming step of the create flow.
  const [parentDir, setParentDir] = useState<string | null>(null);

  const isLoading = status === "loading";

  // Step 1 of the create flow: pick where the new vault folder will live. The
  // store catches and surfaces any picker error, so this can't reject.
  const startCreate = async () => {
    const dir = await pickNewLocation();
    if (dir) setParentDir(dir);
  };

  // Step 2: create the vault. On success the store flips to "open" and this
  // screen unmounts; on failure it returns to "welcome" with the form intact
  // (and the error shown above) so the name can be corrected and retried.
  const confirmCreate = (name: string) => {
    if (parentDir) void createVault(parentDir, name);
  };

  // The action area is a small three-way state machine: open the vault while it
  // loads, otherwise the inline create-naming step, otherwise the entry actions.
  let actionArea: ReactNode;
  if (isLoading && !parentDir) {
    actionArea = <LoadingPanel />;
  } else if (parentDir) {
    actionArea = (
      <CreateVaultForm
        parentDir={parentDir}
        submitting={isLoading}
        onConfirm={confirmCreate}
        onCancel={() => setParentDir(null)}
      />
    );
  } else {
    actionArea = (
      <VaultActions
        onOpen={() => void openExisting()}
        onCreate={() => void startCreate()}
      />
    );
  }

  return (
    <div className="relative flex h-full flex-col items-center justify-center overflow-hidden px-6 py-12">
      {/* With the overlay titlebar there is no chrome on this screen, so this
          strip keeps the window draggable where the native traffic lights sit.
          data-tauri-drag-region is a plain DOM attribute — no Tauri API. All
          interactive content is centred well below the 40px band. */}
      <div data-tauri-drag-region aria-hidden className="absolute inset-x-0 top-0 z-20 h-10" />
      <AuroraGlow />

      <main className="relative z-10 flex w-full max-w-md flex-col items-center gap-7 text-center">
        <BrandHeader />

        {error && <ErrorAlert message={error} onDismiss={clearError} />}

        <section className="w-full">{actionArea}</section>

        {!isLoading && !parentDir && (
          <RecentList recents={recents} onOpen={(path) => void openByPath(path)} />
        )}

        <p className="flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <ShieldCheck className="size-3.5 shrink-0" aria-hidden="true" />
          Opening a folder (including an Obsidian vault) is non-destructive — your
          files stay as plain markdown on disk.
        </p>
      </main>
    </div>
  );
}

/** Inline progress shown while a vault is opening. Spinner stops under
 *  reduced-motion. */
function LoadingPanel() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex items-center justify-center gap-2.5 py-2 text-sm text-muted-foreground"
    >
      <Loader2
        className="size-4 animate-spin motion-reduce:animate-none"
        aria-hidden="true"
      />
      <span>Opening vault…</span>
    </div>
  );
}

interface ErrorAlertProps {
  message: string;
  onDismiss: () => void;
}

/** Dismissible inline alert for the store's single error channel. */
function ErrorAlert({ message, onDismiss }: ErrorAlertProps) {
  return (
    <div
      role="alert"
      className="flex w-full items-start gap-2.5 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-left text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1 break-words">{message}</span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss error"
        className="-m-1 rounded p-1 text-destructive/80 transition-colors hover:text-destructive focus:outline-none focus-visible:ring-2 focus-visible:ring-destructive motion-reduce:transition-none"
      >
        <X className="size-4" aria-hidden="true" />
      </button>
    </div>
  );
}
