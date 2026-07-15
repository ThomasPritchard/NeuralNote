import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, FileText, Search, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { buttonVariants } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import type { TemplateInfo, TreeNode } from "../lib/types";

interface Destination {
  path: string;
  label: string;
}

function destinations(vaultPath: string, tree: TreeNode[]): Destination[] {
  const result: Destination[] = [{ path: vaultPath, label: "Vault root" }];
  const visit = (nodes: TreeNode[]) => {
    for (const node of nodes) {
      if (node.kind !== "folder") continue;
      result.push({ path: node.path, label: node.relPath });
      if (node.children) visit(node.children);
    }
  };
  visit(tree);
  return result;
}

export function TemplateInsertDialog({
  open,
  templates,
  vaultPath,
  tree,
  onCreate,
  onClose,
}: Readonly<{
  open: boolean;
  templates: TemplateInfo[];
  vaultPath: string;
  tree: TreeNode[];
  onCreate: (template: string, name: string, parentPath: string) => void;
  onClose: () => void;
}>) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<TemplateInfo | null>(null);
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState(vaultPath);
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLUListElement>(null);
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (needle === "") return templates;
    return templates.filter(
      (template) =>
        template.name.toLocaleLowerCase().includes(needle) ||
        template.relPath.toLocaleLowerCase().includes(needle),
    );
  }, [query, templates]);
  const folders = useMemo(() => destinations(vaultPath, tree), [tree, vaultPath]);

  useEffect(() => {
    if (open && selected === null) searchRef.current?.focus();
  }, [open, selected]);

  if (!open) return null;

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        hideClose
        className="flex max-h-[min(78vh,38rem)] max-w-lg flex-col overflow-hidden p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchRef.current?.focus();
        }}
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0 flex-1">
            <DialogTitle className="nn-heading text-base font-semibold text-foreground">
              Insert from template
            </DialogTitle>
            <DialogDescription className="mt-1 text-[0.75rem] text-muted-foreground">
              {selected
                ? `Create a note from ${selected.name}.`
                : "Choose a vault template, then name the new note."}
            </DialogDescription>
          </div>
          <IconButton label="Close template picker" onClick={onClose} className="size-7">
            <X className="size-4" aria-hidden />
          </IconButton>
        </div>

        {selected === null ? (
          <div className="flex min-h-0 flex-1 flex-col gap-3 p-4">
            <label className="flex items-center gap-2 rounded-lg border border-input bg-background px-3 py-2 text-muted-foreground focus-within:ring-2 focus-within:ring-ring">
              <Search className="size-4 shrink-0" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                aria-label="Search templates"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    resultsRef.current?.querySelector("button")?.focus();
                  }
                }}
                placeholder="Search templates"
                className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/70"
              />
            </label>
            <p
              role="status"
              aria-live="polite"
              className={
                filtered.length === 0
                  ? "px-3 py-3 text-center text-xs text-muted-foreground"
                  : "sr-only"
              }
            >
              {filtered.length === 0
                ? `No templates match "${query.trim()}".`
                : ""}
            </p>
            <ul
              ref={resultsRef}
              aria-label="Templates"
              className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-surface-sunken/40 p-1"
            >
              {filtered.map((template) => (
                <li key={template.relPath}>
                  <button
                    type="button"
                    aria-label={`${template.name}, ${template.relPath}`}
                    onClick={() => setSelected(template)}
                    className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <FileText className="size-4 shrink-0 text-primary" aria-hidden />
                    <span className="min-w-0">
                      <span className="block truncate text-[0.8125rem] font-medium text-foreground">
                        {template.name}
                      </span>
                      <span className="nn-mono block truncate text-[0.625rem] text-muted-foreground">
                        {template.relPath}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <form
            className="flex flex-col gap-4 p-5"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = name.trim();
              if (trimmed !== "") onCreate(selected.relPath, trimmed, parentPath);
            }}
          >
            <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-foreground">
              <span>Note name</span>
              <input
                aria-label="Note name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[0.75rem] font-medium text-foreground">
              <span>Destination folder</span>
              <select
                aria-label="Destination folder"
                value={parentPath}
                onChange={(event) => setParentPath(event.target.value)}
                className="rounded-lg border border-input bg-background px-3 py-2 text-sm font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {folders.map((folder) => (
                  <option key={folder.path} value={folder.path}>
                    {folder.label}
                  </option>
                ))}
              </select>
            </label>
            <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
              <button
                type="button"
                onClick={() => setSelected(null)}
                className={buttonVariants({ tone: "quiet", size: "sm" })}
              >
                <ArrowLeft className="size-3.5" aria-hidden />
                Back
              </button>
              <button
                type="submit"
                disabled={name.trim() === ""}
                className={buttonVariants({ tone: "primary", size: "sm" })}
              >
                Create note
              </button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
