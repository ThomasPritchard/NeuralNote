import { useCallback, useState } from "react";
import { Check, ChevronDown, ExternalLink, Loader2, Settings2, Zap } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuItemIndicator,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import * as api from "../lib/api";
import { errorMessage } from "../lib/api";
import type { AiStatus, OpenRouterModelChoice, OpenRouterModelMenu } from "../lib/types";
import { cn } from "../lib/cn";

type CatalogueState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; menu: OpenRouterModelMenu }
  | { kind: "error"; message: string };

function modelLabel(status: AiStatus): string {
  const model =
    status.activeProvider === "local"
      ? status.local.activeModelTag
      : status.openrouter.model;
  return model?.split("/").pop() ?? "Choose model";
}

function rankedDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return value;
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))));
}

export function ChatModelMenu({
  status,
  busy,
  onStatusChange,
  onOpenSettings,
}: Readonly<{
  status: AiStatus;
  busy: boolean;
  onStatusChange: (status: AiStatus) => void;
  onOpenSettings: () => void;
}>) {
  const [open, setOpen] = useState(false);
  const [catalogue, setCatalogue] = useState<CatalogueState>({ kind: "idle" });
  const [writing, setWriting] = useState(false);
  const [writeError, setWriteError] = useState<string | null>(null);

  const load = useCallback(async (forceRefresh: boolean) => {
    setCatalogue({ kind: "loading" });
    try {
      setCatalogue({ kind: "ready", menu: await api.openRouterModelMenu(forceRefresh) });
    } catch (error) {
      setCatalogue({ kind: "error", message: errorMessage(error) });
    }
  }, []);

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen && (busy || writing)) return;
    setOpen(nextOpen);
    if (
      nextOpen &&
      status.activeProvider === "openRouter" &&
      (catalogue.kind === "idle" || catalogue.kind === "error")
    ) {
      void load(false);
    }
  };

  const selectModel = async (model: string) => {
    if (writing || model === status.openrouter.model) {
      setOpen(false);
      return;
    }
    setWriting(true);
    setWriteError(null);
    try {
      onStatusChange(await api.selectOpenRouterModel(model));
      setOpen(false);
    } catch (error) {
      setWriteError(errorMessage(error));
    } finally {
      setWriting(false);
    }
  };

  const openRankings = async () => {
    setWriteError(null);
    try {
      await api.openOpenRouterRankings();
    } catch (error) {
      setWriteError(errorMessage(error));
    }
  };

  return (
    <DropdownMenu open={open} onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={busy || writing}
          aria-label={`Choose AI model, current ${modelLabel(status)}`}
          className="flex min-w-0 max-w-[11rem] items-center gap-1.5 rounded-md px-1.5 py-1 text-[0.6875rem] font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed disabled:opacity-50"
        >
          {writing ? (
            <Loader2 className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Zap className="size-3.5 shrink-0 fill-current" aria-hidden />
          )}
          <span className="truncate">{modelLabel(status)}</span>
          <ChevronDown className="size-3 shrink-0" aria-hidden />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        {status.activeProvider === "local" ? (
          <DropdownMenuItem onSelect={onOpenSettings}>
            <Settings2 className="size-3.5" aria-hidden />
            Manage local models
          </DropdownMenuItem>
        ) : (
          <OpenRouterMenuBody
            state={catalogue}
            selectedModel={status.openrouter.model}
            writeError={writeError}
            writing={writing}
            onRetry={() => void load(true)}
            onSelect={(model) => void selectModel(model)}
            onOpenRankings={() => void openRankings()}
          />
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function OpenRouterMenuBody({
  state,
  selectedModel,
  writeError,
  writing,
  onRetry,
  onSelect,
  onOpenRankings,
}: Readonly<{
  state: CatalogueState;
  selectedModel: string;
  writeError: string | null;
  writing: boolean;
  onRetry: () => void;
  onSelect: (model: string) => void;
  onOpenRankings: () => void;
}>) {
  if (state.kind === "idle" || state.kind === "loading") {
    return (
      <DropdownMenuItem disabled>
        <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
        Loading today&apos;s models…
      </DropdownMenuItem>
    );
  }
  if (state.kind === "error") {
    return (
      <>
        <p role="alert" className="px-2.5 py-2 text-[0.75rem] leading-snug text-destructive">
          {state.message}
        </p>
        <DropdownMenuItem
          onSelect={(event) => {
            event.preventDefault();
            onRetry();
          }}
        >
          Retry
        </DropdownMenuItem>
      </>
    );
  }

  const choices: Array<OpenRouterModelChoice & { pinned?: boolean }> = [
    ...(state.menu.pinnedSelectedModel
      ? [{ id: state.menu.pinnedSelectedModel, name: state.menu.pinnedSelectedModel, contextLength: 0, rank: 0, pinned: true }]
      : []),
    ...state.menu.models,
  ];

  return (
    <>
      {writeError && (
        <p role="alert" className="px-2.5 py-2 text-[0.75rem] leading-snug text-destructive">
          {writeError}
        </p>
      )}
      <DropdownMenuRadioGroup value={selectedModel}>
        {choices.map((choice) => (
          <DropdownMenuRadioItem
            key={choice.id}
            value={choice.id}
            disabled={writing}
            textValue={choice.pinned ? `Current ${choice.name}` : `#${choice.rank} ${choice.name}`}
            aria-label={choice.pinned ? `Current model ${choice.name}` : `#${choice.rank} ${choice.name}`}
            onSelect={(event) => {
              event.preventDefault();
              onSelect(choice.id);
            }}
          >
            <DropdownMenuItemIndicator className="absolute left-2.5">
              <Check className="size-3.5" aria-hidden />
            </DropdownMenuItemIndicator>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">
                {choice.pinned ? "Current" : `#${choice.rank}`} · {choice.name}
              </span>
              {!choice.pinned && (
                <span className="block truncate text-[0.625rem] text-muted-foreground">
                  {choice.id} · {Math.round(choice.contextLength / 1_000)}k context
                </span>
              )}
            </span>
          </DropdownMenuRadioItem>
        ))}
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={(event) => {
          event.preventDefault();
          onOpenRankings();
        }}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        <span className="flex-1">OpenRouter rankings</span>
        <span className={cn("text-[0.625rem] text-muted-foreground")}>Ranked {rankedDate(state.menu.asOf)}</span>
      </DropdownMenuItem>
    </>
  );
}
