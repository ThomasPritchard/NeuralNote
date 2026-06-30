import { useState } from "react";
import { ArrowLeft, Check, FolderPlus, Loader2 } from "lucide-react";

interface CreateVaultFormProps {
  /** The chosen parent directory the new vault folder will live inside. */
  parentDir: string;
  /** True while the vault is being created (disables inputs, shows progress). */
  submitting: boolean;
  /** Confirm creation with a validated, non-empty name. */
  onConfirm: (name: string) => void;
  /** Abandon the create flow and return to the action buttons. */
  onCancel: () => void;
}

/** Inline naming step of the create-new-vault flow. Shows the chosen parent
 *  path and collects a vault name, only enabling confirm once it is non-empty. */
export function CreateVaultForm({
  parentDir,
  submitting,
  onConfirm,
  onCancel,
}: CreateVaultFormProps) {
  const [name, setName] = useState("");
  const trimmed = name.trim();
  const canConfirm = trimmed.length > 0 && !submitting;

  // Inlined in onSubmit below so the event type is inferred (avoids the
  // deprecated top-level FormEvent re-export in @types/react).
  const submit = () => {
    if (!canConfirm) return;
    onConfirm(trimmed);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="space-y-3 text-left"
    >
      <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2">
        <FolderPlus
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        <span
          className="nn-mono truncate text-xs text-muted-foreground"
          title={parentDir}
        >
          {parentDir}
        </span>
      </div>

      <div className="space-y-1.5">
        <label
          htmlFor="new-vault-name"
          className="block text-xs font-medium text-muted-foreground"
        >
          Vault name
        </label>
        <input
          id="new-vault-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          autoFocus
          placeholder="My Brain"
          className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
        />
      </div>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          className="flex items-center justify-center gap-1.5 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium text-foreground transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60 motion-reduce:transition-none"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </button>
        <button
          type="submit"
          disabled={!canConfirm}
          className="flex flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-colors duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-primary/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none"
        >
          {submitting ? (
            <Loader2
              className="size-4 animate-spin motion-reduce:animate-none"
              aria-hidden="true"
            />
          ) : (
            <Check className="size-4" aria-hidden="true" />
          )}
          {submitting ? "Creating…" : "Create vault"}
        </button>
      </div>
    </form>
  );
}
