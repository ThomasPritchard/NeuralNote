import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Download, Loader2 } from "lucide-react";
import { usePreferences } from "../preferences/preferences";
import { useToast } from "../notifications";
import {
  messageOf,
  updateService,
  type UpdateCheckSource,
  type UpdateState,
} from "../updater";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";

/**
 * Tauri's plugin dispatcher rejects an invoke call with this exact,
 * fixed-format string — `` `plugin ${name} not found` `` — when the command
 * targets a plugin that was never registered with the app (Tauri core,
 * `crates/tauri/src/plugin.rs`, `PluginStore::extend_api`). It is emitted by
 * Tauri itself before the updater plugin's own logic ever runs, so it never
 * overlaps with any of `tauri-plugin-updater`'s own error variants (network,
 * signature, malformed manifest, HTTP) — those are worded completely
 * differently and some legitimately contain "not found" as substrings (e.g.
 * a manifest missing the current platform), which is exactly why this match
 * is an exact string, not a substring test. See
 * `app/desktop/src-tauri/src/lib.rs:183-191`: the updater plugin is
 * registered only when `plugins.updater.pubkey` resolves to a non-empty
 * string (that is the whole check — emptiness, not validity). The base
 * `tauri.conf.json` ships an `updater` block carrying `endpoints` and no
 * `pubkey` at all; release builds merge the key in, while `tauri dev` and
 * the unsigned local/smoke build inherit that base config unchanged and so
 * leave the plugin unregistered. Their automatic check therefore always
 * fails this exact way. That is expected app configuration — not a genuine
 * update-check failure — so
 * UpdateCoordinator downgrades it below sticky error severity (see the
 * `subscribeAutomaticErrors` handler below). The Rust shell still logs
 * `updater disabled: no public verification key configured` whenever this
 * happens, so the condition is never silent even when suppressed here.
 * Regression-pinned in UpdateCoordinator.test.tsx.
 *
 * TODO(#158): GeneralSettingsPage.tsx still renders lastAutomaticError
 * unconditionally under "Last automatic update check failed", so it
 * mislabels this same expected condition in Settings. Export this
 * classifier once that page is in scope and reuse it there.
 */
const MISSING_UPDATER_PLUGIN_MESSAGE = "plugin updater not found";

function isMissingUpdaterPluginError(message: string): boolean {
  return message === MISSING_UPDATER_PLUGIN_MESSAGE;
}

function installProgressAnnouncement(status: UpdateState["status"]): string {
  if (status === "installing") return "Installing update.";
  if (status === "relaunching") return "Update installed. Relaunching NeuralNote.";
  return "";
}

function installButtonLabel(status: UpdateState["status"]): string {
  if (status === "installing") return "Installing…";
  if (status === "relaunching") return "Relaunching…";
  return "Install and relaunch";
}

/**
 * A gate the install must pass before it starts. `proceed` is the continuation
 * that actually installs, so the guard decides *when* — never *how*.
 *
 * This exists because the coordinator is mounted ABOVE VaultProvider (App.tsx)
 * and so cannot see the workspace's dirty tabs. Rather than lift tab state up,
 * the install is pushed down: the workspace registers a guard that routes it
 * through the same unsaved-edit confirmation as quitting (issue #205).
 */
type InstallGuard = (proceed: () => void) => void;

interface UpdateContextValue {
  state: UpdateState;
  lastAutomaticError: string | null;
  check: (source: UpdateCheckSource) => Promise<void>;
  review: () => void;
  /** Start installing, via the registered guard when there is one. */
  install: () => void;
  /** Register the guard; the returned function unregisters it. */
  registerInstallGuard: (guard: InstallGuard) => () => void;
}

const UpdateContext = createContext<UpdateContextValue | null>(null);

export function UpdateCoordinator({ children }: Readonly<{ children: ReactNode }>) {
  const { preferences, suppressAutomaticChecksThisLaunch } = usePreferences();
  const toast = useToast();
  const [state, setState] = useState<UpdateState>(() => updateService.getState());
  const [lastAutomaticError, setLastAutomaticError] = useState<string | null>(
    () => updateService.getLastAutomaticError(),
  );
  const [dialogOpen, setDialogOpen] = useState(false);
  const checkedAutomatically = useRef(false);
  const installGuardRef = useRef<InstallGuard | null>(null);

  useEffect(() => updateService.subscribe(setState), []);

  useEffect(
    () =>
      updateService.subscribeAutomaticErrors((message) => {
        setLastAutomaticError(message);
        // Expected dev/unsigned-build configuration, not a failure — see
        // isMissingUpdaterPluginError above. The message is still retained
        // in lastAutomaticError above for anything that reads it; only the
        // sticky, unmissable error toast is skipped.
        if (isMissingUpdaterPluginError(message)) return;
        toast.error(`Automatic update check failed. ${message}`, {
          dedupKey: "automatic-update-error",
        });
      }),
    [toast],
  );

  const check = useCallback(async (source: UpdateCheckSource) => {
    try {
      await updateService.check(source);
    } catch {
      // The service publishes manual failures and the once-per-session
      // automatic error channel owns background failures.
    }
  }, []);

  useEffect(() => {
    if (
      suppressAutomaticChecksThisLaunch ||
      !preferences.automaticUpdateChecks ||
      checkedAutomatically.current
    ) return;
    checkedAutomatically.current = true;
    void check("background");
  }, [check, preferences.automaticUpdateChecks, suppressAutomaticChecksThisLaunch]);

  useEffect(() => {
    if (state.status !== "available") return;
    toast.info(`NeuralNote ${state.update.version} is available.`, {
      dedupKey: `update:${state.update.version}`,
      action: { label: "Review update", onClick: () => setDialogOpen(true) },
    });
  }, [state, toast]);

  const registerInstallGuard = useCallback((guard: InstallGuard) => {
    installGuardRef.current = guard;
    return () => {
      if (installGuardRef.current === guard) installGuardRef.current = null;
    };
  }, []);

  const startInstall = useCallback(() => {
    void updateService.installAndRelaunch().catch((error: unknown) => {
      // Only a failure DURING the install reaches the dialog: the service sets
      // `installFailed` from its own catch. Its two pre-state rejections — no
      // update accepted, and an install already running — throw before the first
      // setState, so nothing would be published and the user would see the
      // button they just pressed do nothing at all. Report every one of them
      // here; a redundant toast beside the dialog's alert is the cheap half of
      // that trade, and an error toast outlives the dialog either way.
      toast.error(`The update could not be installed. ${messageOf(error)}`, {
        dedupKey: "update-install-failed",
      });
    });
  }, [toast]);

  const install = useCallback(() => {
    // No guard registered means no vault is open, so there is no unsaved work
    // a relaunch could destroy — installing straight away is correct there.
    const guard = installGuardRef.current;
    if (!guard) {
      startInstall();
      return;
    }
    // Stand the release notes down while the guard puts its own confirmation on
    // screen — two stacked modals otherwise, with the lower one answering a
    // question the user has already moved past. Reopened on the way through,
    // because install progress and any install failure render ONLY here.
    setDialogOpen(false);
    guard(() => {
      setDialogOpen(true);
      startInstall();
    });
  }, [startInstall]);

  const value = useMemo(
    () => ({
      state,
      lastAutomaticError,
      check,
      review: () => setDialogOpen(true),
      install,
      registerInstallGuard,
    }),
    [check, install, lastAutomaticError, registerInstallGuard, state],
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
      <UpdateDialog
        state={state}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onInstall={install}
      />
    </UpdateContext.Provider>
  );
}

export function useUpdateCoordinator(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error("useUpdateCoordinator must be used within UpdateCoordinator");
  return value;
}

function UpdateDialog({ state, open, onOpenChange, onInstall }: Readonly<{
  state: UpdateState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onInstall: () => void;
}>) {
  const update = "update" in state ? state.update : null;
  const installing = state.status === "installing" || state.status === "relaunching";
  if (!update) return null;
  return (
    <Dialog open={open} onOpenChange={(next) => !installing && onOpenChange(next)}>
      <DialogContent hideClose={installing} className="max-w-lg">
        <DialogTitle>NeuralNote {update.version} is available</DialogTitle>
        <DialogDescription>
          Review the alpha release notes before choosing whether to install and relaunch.
        </DialogDescription>
        <div className="max-h-60 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {update.notes?.trim() || "No release notes were provided."}
        </div>
        {state.status === "installFailed" && (
          <p role="alert" className="text-sm text-destructive">{state.message}</p>
        )}
        <p role="status" aria-live="polite" className="sr-only">
          {installProgressAnnouncement(state.status)}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={installing} onClick={() => onOpenChange(false)} className={buttonVariants({ tone: "quiet" })}>Later</button>
          <button
            type="button"
            disabled={installing}
            onClick={onInstall}
            className={buttonVariants({ tone: "primary" })}
          >
            {installing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            {installButtonLabel(state.status)}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
