import { useEffect, useMemo, useState } from "react";
import { FolderOpen, Loader2 } from "lucide-react";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { TemplateSettings, TemplateSettingsStatus } from "../lib/types";
import { useToast } from "../notifications";
import { buttonVariants } from "@/components/ui/button";
import { formatMomentPreview, validateTemplateFormat } from "./templateFormat";

const DEFAULTS: TemplateSettings = {
  folder: "Templates",
  dateFormat: "YYYY-MM-DD",
  timeFormat: "HH:mm",
};

export function TemplatesSettingsPage() {
  const [status, setStatus] = useState<TemplateSettingsStatus | null>(null);
  const [draft, setDraft] = useState(DEFAULTS);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    let active = true;
    void api.loadTemplateSettings().then(
      (loaded) => {
        if (!active) return;
        setStatus(loaded);
        setDraft(loaded.settings);
      },
      (error) => active && setLoadError(errorMessage(error)),
    );
    return () => {
      active = false;
    };
  }, []);

  const errors = useMemo(
    () => [validateTemplateFormat(draft.dateFormat), validateTemplateFormat(draft.timeFormat)].filter(Boolean),
    [draft.dateFormat, draft.timeFormat],
  );

  const reset = async () => {
    setSaving(true);
    try {
      const loaded = await api.resetTemplateSettings();
      setStatus(loaded);
      setDraft(loaded.settings);
      setLoadError(null);
      setValidationError(null);
      toast.success("Template settings reset");
    } catch (error) {
      toast.error(`Template settings could not be reset. ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  const pickFolder = async () => {
    try {
      const folder = await api.pickTemplateFolder();
      if (folder !== null) setDraft((current) => ({ ...current, folder }));
    } catch (error) {
      toast.error(`Template folder could not be selected. ${errorMessage(error)}`);
    }
  };

  const save = async () => {
    if (errors.length > 0) {
      setValidationError(errors[0] ?? "Invalid template format.");
      return;
    }
    setSaving(true);
    setValidationError(null);
    try {
      const saved = await api.saveTemplateSettings(draft);
      setStatus(saved);
      setDraft(saved.settings);
      toast.success("Template settings saved");
    } catch (error) {
      toast.error(`Template settings could not be saved. ${errorMessage(error)}`);
    } finally {
      setSaving(false);
    }
  };

  if (loadError !== null) {
    return (
      <section aria-labelledby="templates-heading" className="flex flex-col gap-4">
        <h3 id="templates-heading" className="nn-heading text-sm font-semibold">Templates</h3>
        <div role="alert" className="rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
          <p>{loadError}</p>
          <button type="button" disabled={saving} onClick={() => void reset()} className={buttonVariants({ tone: "quiet", size: "sm", className: "mt-3" })}>
            Reset to defaults
          </button>
        </div>
      </section>
    );
  }

  if (status === null) {
    return <output className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" aria-hidden />Loading template settings…</output>;
  }

  const folderMissing = !status.folderExists && draft.folder === status.settings.folder;

  return (
    <section aria-labelledby="templates-heading" className="flex max-w-xl flex-col gap-5">
      <div>
        <h3 id="templates-heading" className="nn-heading text-sm font-semibold">Templates</h3>
        <p className="mt-1 text-xs text-muted-foreground">Vault-specific settings stored in .neuralnote/template-settings.json.</p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="template-folder" className="text-xs font-medium">Template folder</label>
        <div className="flex gap-2">
          <input
            id="template-folder"
            value={draft.folder}
            readOnly
            aria-invalid={folderMissing || undefined}
            aria-describedby={folderMissing ? "template-folder-error" : undefined}
            className="h-9 min-w-0 flex-1 rounded-md border border-input bg-muted/30 px-3 text-sm"
          />
          <button
            type="button"
            aria-label="Choose template folder"
            onClick={() => void pickFolder()}
            className={buttonVariants({ tone: "quiet", size: "sm" })}
          >
            <FolderOpen className="size-3.5" aria-hidden />Choose…
          </button>
        </div>
        {folderMissing && (
          <p id="template-folder-error" role="alert" className="text-xs text-warning">This folder is missing. Choose an existing directory inside the vault.</p>
        )}
      </div>

      <FormatField
        id="date-format"
        label="Date format"
        value={draft.dateFormat}
        presets={["YYYY-MM-DD", "DD/MM/YYYY", "MMMM D, YYYY"]}
        previewLabel="Date preview"
        onChange={(dateFormat) => setDraft((current) => ({ ...current, dateFormat }))}
      />
      <FormatField
        id="time-format"
        label="Time format"
        value={draft.timeFormat}
        presets={["HH:mm", "HH:mm:ss", "h:mm A"]}
        previewLabel="Time preview"
        onChange={(timeFormat) => setDraft((current) => ({ ...current, timeFormat }))}
      />

      {validationError && <p role="alert" className="text-xs text-destructive">{validationError}</p>}
      <div className="flex gap-2">
        <button type="button" disabled={saving} onClick={() => void save()} className={buttonVariants({ tone: "primary", size: "sm" })}>
          Save template settings
        </button>
        <button type="button" disabled={saving} onClick={() => void reset()} className={buttonVariants({ tone: "quiet", size: "sm" })}>
          Reset to defaults
        </button>
      </div>
    </section>
  );
}

function FormatField({ id, label, value, presets, previewLabel, onChange }: Readonly<{
  id: string;
  label: string;
  value: string;
  presets: string[];
  previewLabel: string;
  onChange: (value: string) => void;
}>) {
  const error = validateTemplateFormat(value);
  const feedbackId = `${id}-feedback`;
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium">{label}</label>
      <input id={id} list={`${id}-presets`} value={value} onChange={(event) => onChange(event.currentTarget.value)} aria-invalid={error !== null} aria-describedby={feedbackId} className="h-9 rounded-md border border-input bg-background px-3 font-mono text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" />
      <datalist id={`${id}-presets`}>
        {presets.map((preset) => (
          // eslint-disable-next-line jsx-a11y/control-has-associated-label -- datalist suggestion: the option's `value` is its own visible label.
          <option key={preset} value={preset} />
        ))}
      </datalist>
      <output id={feedbackId} htmlFor={id} aria-label={previewLabel} aria-live="polite" className={error === null ? "text-xs text-muted-foreground" : "text-xs text-destructive"}>
        {error === null ? `Preview: ${formatMomentPreview(value)}` : `Error: ${error}`}
      </output>
    </div>
  );
}
