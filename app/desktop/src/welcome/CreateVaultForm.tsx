import { useState } from "react";
import { ArrowLeft, Check, FolderPlus, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
}: Readonly<CreateVaultFormProps>) {
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
        <Input
          id="new-vault-name"
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          disabled={submitting}
          autoFocus
          placeholder="My Brain"
          className="h-10 text-sm"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button
          type="button"
          onClick={onCancel}
          disabled={submitting}
          tone="quiet"
          size="lg"
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
          Back
        </Button>
        <Button
          type="submit"
          disabled={!canConfirm}
          tone="primary"
          size="lg"
          className="flex-1"
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
        </Button>
      </div>
    </form>
  );
}
