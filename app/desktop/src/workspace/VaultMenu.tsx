import { FilePlus2, FolderPlus, RefreshCw, X, type LucideIcon } from "lucide-react";
import { useRef, type ReactElement } from "react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface VaultMenuProps {
  trigger?: ReactElement;
  onClose?: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCloseVault: () => void;
}

export function VaultMenu({
  trigger,
  onClose,
  onNewNote,
  onNewFolder,
  onRefresh,
  onCloseVault,
}: Readonly<VaultMenuProps>) {
  const keepNextFocus = useRef(false);

  return (
    <DropdownMenu
      defaultOpen={trigger === undefined}
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
    >
      <DropdownMenuTrigger asChild>
        {trigger ?? (
          <button type="button" className="sr-only" aria-label="Vault actions menu">
            Vault actions
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        aria-labelledby="vault-actions-menu-label"
        onCloseAutoFocus={(event) => {
          if (!keepNextFocus.current) return;
          event.preventDefault();
          keepNextFocus.current = false;
        }}
      >
        <span id="vault-actions-menu-label" className="sr-only">Vault actions</span>
        <MenuItem
          icon={FilePlus2}
          label="New note"
          onSelect={() => {
            keepNextFocus.current = true;
            onNewNote();
          }}
        />
        <MenuItem
          icon={FolderPlus}
          label="New folder"
          onSelect={() => {
            keepNextFocus.current = true;
            onNewFolder();
          }}
        />
        <MenuItem icon={RefreshCw} label="Refresh tree" onSelect={onRefresh} />
        <DropdownMenuSeparator />
        <MenuItem icon={X} label="Close vault" onSelect={onCloseVault} danger />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onSelect,
  danger = false,
}: Readonly<{
  icon: LucideIcon;
  label: string;
  onSelect: () => void;
  danger?: boolean;
}>) {
  return (
    <DropdownMenuItem onSelect={onSelect} danger={danger}>
      <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden />
      {label}
    </DropdownMenuItem>
  );
}
