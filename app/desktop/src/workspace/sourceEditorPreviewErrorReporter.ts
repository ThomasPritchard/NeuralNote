/**
 * Which preview failure the editor's single banner shows.
 *
 * Two passes decorate a note and they fail independently: the inline collector
 * (`safeCollectMarkdownPreview`, run by the preview `ViewPlugin`) and the table
 * `StateField`. Their triggers differ — the field recomputes on a document,
 * selection, viewport, remeasure, reparse or reconfiguration, while the plugin
 * ALSO recomputes on a focus change and on the refresh effect a vault-index
 * rebuild dispatches — so
 * one shared callback let the inline pass's routine success clear a banner the
 * table pass had raised, with every table on screen still raw pipes. The
 * project's rule is that failures are never silent, and a banner that vanishes
 * on an unrelated success is silence with extra steps.
 */
export type PreviewErrorChannel = "inline" | "table";

/**
 * Multiplex both channels onto one banner.
 *
 * The table failure wins a tie: it names the construct that actually broke, and
 * the generic inline message reported over it would send the user looking in the
 * wrong place. Emits only when the message the user should see CHANGES, so a
 * pass that succeeds every keystroke costs one comparison rather than a render.
 *
 * @param onError - the editor's single banner sink
 * @returns a reporter to call with each channel's current failure, or `null`
 */
export function createPreviewErrorReporter(
  onError: (message: string | null) => void,
): (channel: PreviewErrorChannel, message: string | null) => void {
  const errors: Record<PreviewErrorChannel, string | null> = { inline: null, table: null };
  // `undefined` rather than `null`, so the first report always reaches the sink
  // and clears whatever the previous note left on screen.
  let lastReported: string | null | undefined;

  return (channel, message) => {
    errors[channel] = message;
    const combined = errors.table ?? errors.inline;
    if (combined === lastReported) return;
    lastReported = combined;
    onError(combined);
  };
}
