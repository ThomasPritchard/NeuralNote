// The docked Neural Assistant AI pane — the real cited-chat UI. The provider-aware
// states share one shell: the first-run picker (nothing configured), guided key
// setup, a "local provider chosen but no model yet" hand-off into Settings, a
// clearly-disabled "skipped" state, and the live chat view. The webview never
// sees the API key; it asks `aiStatus` which provider is effective and drives
// the streamed `ChatEvent` loop via `chat`. Orchestration stays in Rust — this
// pane only composes three concern hooks (provider/status, the turn loop, the
// composer) and lays out what they resolve.

import { useCallback, useState } from "react";
import { Cpu, Database, Loader2, Sparkles } from "lucide-react";
import { cn } from "../lib/cn";
import { useVault } from "../lib/store";
import { buttonVariants } from "@/components/ui/button";
import { StatusPill as NeuralStatusPill } from "@/components/neural/patterns";
import { ChatMessages } from "./ChatMessages";
import type { CitationView } from "./chatMessage";
import { ChatComposer } from "./ChatComposer";
import { DisconnectedPane, KeySetupPanel } from "./KeySetupPanel";
import { ProviderPicker } from "./ProviderPicker";
import type { SkillPickerEntry } from "./skillAutocomplete";
import { useChatPaneChat } from "./useChatPaneChat";
import { useChatPaneComposer } from "./useChatPaneComposer";
import { useChatPaneProvider, type View } from "./useChatPaneProvider";

/** Header connection pill. The active model now belongs at the point of send
 *  in the composer, leaving only the disconnected state in the header. */
function ChatStatusPill({ view }: Readonly<{ view: View }>) {
  if (view === "disconnected") {
    return (
      <NeuralStatusPill status="neutral" className="ml-auto shrink-0 gap-1.5 px-2.5 py-1 text-[0.6875rem]">
        <Database className="size-3" aria-hidden /> Not connected
      </NeuralStatusPill>
    );
  }
  return null;
}

export function ChatPane({
  openNoteAt,
  onOpenSettings,
  refreshSignal = 0,
}: Readonly<{
  openNoteAt: (absPath: string) => void;
  /** Opens the settings modal on the AI section (local setup lives there). */
  onOpenSettings: () => void;
  /** Bumped by the workspace when Settings closes, so a provider configured
   *  there (e.g. a first local model) is reflected without remounting — and
   *  without wiping an in-progress transcript. */
  refreshSignal?: number;
}>) {
  const { vault, reportError } = useVault();
  const vaultPath = vault?.path;

  // Chips persist across sends on purpose: an activated skill is a mode the
  // user switched on (and history-carried follow-ups — a late elicitation
  // answer — should re-activate it), not a one-message attachment. Owned here
  // because both the turn loop (send) and the composer (chip authority) read it.
  const [activeSkills, setActiveSkills] = useState<SkillPickerEntry[]>([]);

  const provider = useChatPaneProvider({ reportError, refreshSignal });
  const chat = useChatPaneChat({
    effectiveReasoning: provider.effectiveReasoning,
    activeSkills,
  });
  const composer = useChatPaneComposer({
    busy: chat.busy,
    sendPrompt: chat.sendPrompt,
    activeSkills,
    setActiveSkills,
    reportError,
    refreshSignal,
  });

  const openCitation = useCallback(
    (citation: CitationView) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${citation.relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  const openWrittenNote = useCallback(
    (relPath: string) => {
      if (vaultPath) openNoteAt(`${vaultPath}/${relPath}`);
    },
    [openNoteAt, vaultPath],
  );

  const { view } = provider;
  const stopping =
    chat.activeTurnIdRef.current !== null &&
    chat.stoppingTurnId === chat.activeTurnIdRef.current;

  return (
    <aside className="nn-chat-pane relative flex shrink-0 flex-col border-l border-border bg-sidebar">
      <p aria-live="polite" aria-atomic="true" className="sr-only">
        {chat.liveAnnouncement}
      </p>
      <header className="shrink-0 border-b border-border px-5 py-3.5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="grid size-7 place-items-center rounded-lg border border-primary/25 bg-primary/12 text-primary">
            <Sparkles className="size-3.5" aria-hidden />
          </span>
          <span className="nn-heading shrink-0 text-sm font-semibold">
            Neural Assistant AI
          </span>
          <ChatStatusPill view={view} />
        </div>
        <p className="mt-2 text-[0.6875rem] leading-snug text-muted-foreground">
          Ask questions across everything in your vault. Every claim is
          citation-checked against its source.
        </p>
      </header>

      {view === "loading" && (
        <output className="flex min-h-0 flex-1 items-center justify-center gap-2 text-[0.75rem] text-muted-foreground/70">
          <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
          Checking connection…
        </output>
      )}

      {view === "picker" && (
        <ProviderPicker
          onPickOpenRouter={() => provider.setView("setup")}
          onPickLocal={onOpenSettings}
          onSkip={() => provider.setView("disconnected")}
        />
      )}

      {view === "setup" && (
        <KeySetupPanel
          model={provider.model}
          saving={provider.saving}
          onSave={provider.handleSave}
          onSkip={() => provider.setView("disconnected")}
        />
      )}

      {view === "localSetup" && (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-8 text-center">
          <span className="grid size-11 place-items-center rounded-xl bg-card text-muted-foreground ring-1 ring-inset ring-border">
            <Cpu className="size-5" aria-hidden />
          </span>
          <p className="text-[0.8125rem] font-medium text-foreground/90">
            Local AI needs a model
          </p>
          <p className="mx-auto max-w-[17rem] text-[0.75rem] leading-relaxed text-muted-foreground">
            Local AI is selected, but no model is set up yet. Pick one to
            download in the AI settings.
          </p>
          <button
            type="button"
            onClick={onOpenSettings}
            className={cn(buttonVariants({ tone: "primary", size: "sm" }), "mt-1 px-3.5")}
          >
            Open AI settings
          </button>
        </div>
      )}

      {view === "disconnected" && (
        // Back to the provider PICKER, not the OpenRouter form — both shipped
        // providers (key or Local AI) must stay reachable after a skip. The
        // refresh guard above never lands here on its own ("picker" only
        // applies from a loading mount), so this can't loop.
        <DisconnectedPane onConnect={() => provider.setView("picker")} />
      )}

      {view === "chat" && (
        <>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
            {chat.messages.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
                <span className="grid size-11 place-items-center rounded-xl bg-primary/10 text-primary ring-1 ring-inset ring-primary/20">
                  <Sparkles className="size-5" aria-hidden />
                </span>
                <div className="flex flex-col gap-1.5">
                  <p className="text-[0.8125rem] font-medium text-foreground/90">
                    Ask anything across your vault
                  </p>
                  <p className="mx-auto max-w-[15rem] text-[0.75rem] leading-relaxed text-muted-foreground">
                    Watch the answer get searched, read and citation-checked live.
                  </p>
                </div>
              </div>
            ) : (
              <ChatMessages
                messages={chat.messages}
                onOpenCitation={openCitation}
                onOpenNote={openWrittenNote}
                onSendFollowUp={chat.sendPrompt}
                busy={chat.busy}
                runIds={chat.runIds}
              />
            )}
          </div>

          <ChatComposer
            stopError={chat.stopError}
            reasoningError={provider.reasoningError}
            activeSkills={activeSkills}
            onRemoveSkill={composer.removeSkill}
            pickerOpen={composer.pickerOpen}
            suggestions={composer.suggestions}
            pickerNotice={composer.pickerNotice}
            pickerActive={composer.pickerActive}
            onPickSkill={composer.pickSkill}
            onHoverSkill={composer.setPickerIndex}
            composerRef={composer.composerRef}
            composerActionRef={composer.composerActionRef}
            input={composer.input}
            busy={chat.busy}
            stopping={stopping}
            onInputChange={composer.onInputChange}
            onComposerKeyDown={composer.onComposerKeyDown}
            syncCaret={composer.syncCaret}
            onComposerBlur={composer.onComposerBlur}
            onComposerFocus={composer.onComposerFocus}
            onSend={composer.send}
            onCancel={() => void chat.cancelRun()}
            status={provider.status}
            onStatusChange={provider.applyStatus}
            onOpenSettings={onOpenSettings}
            onToggleReasoning={() => void provider.toggleReasoning()}
            savingReasoning={provider.savingReasoning}
            capability={provider.capability}
            reasoningOn={provider.reasoningOn}
            reasoningReasonId={provider.reasoningReasonId}
          />
        </>
      )}
    </aside>
  );
}
