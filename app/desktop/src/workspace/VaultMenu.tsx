// The dropdown of vault-level actions, anchored under the sidebar header's
// vault-name button. A full-screen invisible backdrop handles click-outside;
// Escape closes it. Pure presentation — the actions are supplied by FileTree.

import { useEffect } from "react";
import { FilePlus2, FolderPlus, RefreshCw, X, type LucideIcon } from "lucide-react";

interface VaultMenuProps {
  onClose: () => void;
  onNewNote: () => void;
  onNewFolder: () => void;
  onRefresh: () => void;
  onCloseVault: () => void;
}

export function VaultMenu({
  onClose,
  onNewNote,
  onNewFolder,
  onRefresh,
  onCloseVault,
}: VaultMenuProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const run = (action: () => void) => () => {
    onClose();
    action();
  };

  return (
    <>
      {/* Click-outside backdrop. */}
      <button
        type="button"
        aria-hidden
        tabIndex={-1}
        onClick={onClose}
        className="fixed inset-0 z-10 cursor-default"
      />
      <div
        role="menu"
        aria-label="Vault actions"
        className="absolute left-3 top-full z-20 mt-1 w-48 overflow-hidden rounded-lg border border-border bg-popover py-1 shadow-xl"
      >
        <MenuItem icon={FilePlus2} label="New note" onClick={run(onNewNote)} />
        <MenuItem icon={FolderPlus} label="New folder" onClick={run(onNewFolder)} />
        <MenuItem icon={RefreshCw} label="Refresh tree" onClick={run(onRefresh)} />
        <div className="my-1 border-t border-border" />
        <MenuItem icon={X} label="Close vault" onClick={run(onCloseVault)} />
      </div>
    </>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
}: {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-popover-foreground transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
    >
      <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
      {label}
    </button>
  );
}
