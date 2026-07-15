import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { usePreferences } from "../preferences/preferences";
import { useToast } from "../notifications";
import { getAutostartEnabled, setAutostartEnabled } from "../updater";
import { useUpdateCoordinator } from "../updates/UpdateCoordinator";
import { errorMessage } from "../lib/api";
import { buttonVariants } from "@/components/ui/button";

export function GeneralSettingsPage() {
  const { preferences, saving, update } = usePreferences();
  const { state, lastAutomaticError, check, review } = useUpdateCoordinator();
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [changingAutostart, setChangingAutostart] = useState(false);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    void getAutostartEnabled().then(
      (enabled) => active && setAutostart(enabled),
      (error) => {
        if (!active) return;
        setAutostart(false);
        toast.error(`Startup registration could not be read. ${errorMessage(error)}`, {
          dedupKey: "autostart-read-error",
        });
      },
    );
    return () => {
      active = false;
    };
  }, [toast]);

  const changeAutostart = async (enabled: boolean) => {
    setChangingAutostart(true);
    try {
      const confirmed = await setAutostartEnabled(enabled);
      setAutostart(confirmed);
      toast.success(confirmed ? "NeuralNote will start on login" : "Start on login disabled");
    } catch (error) {
      toast.error(`Startup registration could not be changed. ${errorMessage(error)}`, {
        dedupKey: "autostart-change-error",
      });
      try {
        setAutostart(await getAutostartEnabled());
      } catch {
        // The persistent toast above already owns the failure.
      }
    } finally {
      setChangingAutostart(false);
    }
  };

  return (
    <section aria-labelledby="general-heading" className="flex max-w-xl flex-col gap-6">
      <div>
        <h3 id="general-heading" className="nn-heading text-sm font-semibold">General</h3>
        <p className="mt-1 text-xs text-muted-foreground">Updates always require your consent before installation and relaunch.</p>
      </div>

      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Software updates</p>
            <UpdateStatus state={state} />
          </div>
          <button type="button" disabled={state.status === "checking"} onClick={() => void check("manual")} className={buttonVariants({ tone: "quiet", size: "sm" })}>
            {state.status === "checking" && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            Check for updates
          </button>
        </div>
        {state.status === "available" && (
          <button type="button" onClick={review} className={buttonVariants({ tone: "primary", size: "sm", className: "self-start" })}>Review update</button>
        )}
        {lastAutomaticError !== null && (
          <p className="text-xs text-destructive">
            Last automatic update check failed: {lastAutomaticError}
          </p>
        )}
        <Toggle
          label="Automatically check for updates"
          checked={preferences.automaticUpdateChecks}
          disabled={saving}
          onChange={(checked) => void update({ automaticUpdateChecks: checked }, "Update preference saved")}
        />
      </div>

      <div className="rounded-lg border border-border p-3">
        <Toggle
          label="Start NeuralNote on login"
          checked={autostart ?? false}
          disabled={autostart === null || changingAutostart}
          onChange={(checked) => void changeAutostart(checked)}
        />
        {autostart === null && <output className="mt-1 block text-xs text-muted-foreground">Reading macOS registration…</output>}
      </div>
    </section>
  );
}

// Transient progress states render as <output> — the native element with an
// implicit polite "status" live region — so assistive tech announces them
// without interrupting; failures stay role="alert" (assertive by design).
// `block` mirrors the sibling <p> display so the swap is layout-identical.
function UpdateStatus({ state }: Readonly<{ state: ReturnType<typeof useUpdateCoordinator>["state"] }>) {
  switch (state.status) {
    case "idle": return <p className="text-xs text-muted-foreground">Ready to check.</p>;
    case "checking": return <output className="block text-xs text-muted-foreground">Checking for updates…</output>;
    case "upToDate": return <p className="text-xs text-muted-foreground">NeuralNote is up to date.</p>;
    case "available": return <p className="text-xs text-primary">Version {state.update.version} is available.</p>;
    case "checkFailed": return <p role="alert" className="text-xs text-destructive">Update check failed: {state.message}</p>;
    case "installing": return <output className="block text-xs text-muted-foreground">Installing update…</output>;
    case "relaunching": return <output className="block text-xs text-muted-foreground">Relaunching…</output>;
    case "installFailed": return <p role="alert" className="text-xs text-destructive">Install failed: {state.message}</p>;
  }
}

function Toggle({ label, checked, disabled, onChange }: Readonly<{
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}>) {
  return (
    <label className="flex items-center justify-between gap-4 py-1 text-sm">
      <span>{label}</span>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} className="size-4 accent-primary" />
    </label>
  );
}
