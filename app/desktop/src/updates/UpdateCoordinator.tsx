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

interface UpdateContextValue {
  state: UpdateState;
  lastAutomaticError: string | null;
  check: (source: UpdateCheckSource) => Promise<void>;
  review: () => void;
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

  useEffect(() => updateService.subscribe(setState), []);

  useEffect(
    () =>
      updateService.subscribeAutomaticErrors((message) => {
        setLastAutomaticError(message);
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

  const value = useMemo(
    () => ({
      state,
      lastAutomaticError,
      check,
      review: () => setDialogOpen(true),
    }),
    [check, lastAutomaticError, state],
  );

  return (
    <UpdateContext.Provider value={value}>
      {children}
      <UpdateDialog state={state} open={dialogOpen} onOpenChange={setDialogOpen} />
    </UpdateContext.Provider>
  );
}

export function useUpdateCoordinator(): UpdateContextValue {
  const value = useContext(UpdateContext);
  if (!value) throw new Error("useUpdateCoordinator must be used within UpdateCoordinator");
  return value;
}

function UpdateDialog({ state, open, onOpenChange }: Readonly<{
  state: UpdateState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
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
          {state.status === "installing"
            ? "Installing update."
            : state.status === "relaunching"
              ? "Update installed. Relaunching NeuralNote."
              : ""}
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" disabled={installing} onClick={() => onOpenChange(false)} className={buttonVariants({ tone: "quiet" })}>Later</button>
          <button
            type="button"
            disabled={installing}
            onClick={() => {
              void updateService.installAndRelaunch().catch(() => {
                // The service publishes the failure into state for the dialog.
              });
            }}
            className={buttonVariants({ tone: "primary" })}
          >
            {installing ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Download className="size-4" aria-hidden />}
            {state.status === "installing" ? "Installing…" : state.status === "relaunching" ? "Relaunching…" : "Install and relaunch"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
