// Chat/pull Channel delivery (the streamed events a command sends).
// `api.chat` passes a `@tauri-apps/api` `Channel` as the `onEvent` invoke arg.
// The public `invoke` hands args straight to `__TAURI_INTERNALS__.invoke`, which
// under `mockIPC` is `cb(cmd, args)` with NO serialisation — so the handler
// receives the LIVE Channel instance (not its `__CHANNEL__:id` string form).
//
// The Channel registered a callback via `transformCallback` on construction;
// under mockIPC that's `registerCallback`, which stores the closure in
// `window.__TAURI_INTERNALS__.callbacks` keyed by the numeric `channel.id` and
// exposes it through `runCallback(id, data)`. The Rust side delivers each event
// as a `{ index, message }` frame to that callback; the Channel's own ordering
// machinery then forwards `message` to the `onmessage` handler `api.chat` set
// (the pane's `applyEvent`). Driving it through `runCallback` — rather than
// poking `channel.onmessage` directly — exercises that real dispatch path.

import type { CoreErrorLike } from "./mockVaultTypes";

interface TauriChannelLike {
  id: number;
}
interface TauriInternalsLike {
  runCallback?: (id: number, data: unknown) => void;
}

/** A per-stream sender that keeps its own `{ index, message }` sequence — the
 *  Channel's ordering machinery expects one monotonically increasing index per
 *  stream, so a script parked on an elicitation and resumed later must NOT
 *  restart at zero. Throws loudly if the channel isn't wired to the mock IPC —
 *  a dropped stream is never silent. */
export const channelSender = (channel: unknown): ((message: unknown) => void) => {
  const id = (channel as TauriChannelLike | null)?.id;
  const runCallback = (window as unknown as {
    __TAURI_INTERNALS__?: TauriInternalsLike;
  }).__TAURI_INTERNALS__?.runCallback;
  if (typeof id !== "number" || !runCallback) {
    throw {
      kind: "io",
      message: "event channel is not wired to the mock IPC",
    } satisfies CoreErrorLike;
  }
  let nextIndex = 0;
  return (message) => {
    runCallback(id, { index: nextIndex, message });
    nextIndex += 1;
  };
};

/** Stream a scripted event array to the invoke's Channel exactly as the Rust
 *  core would: one in-order `{ index, message }` frame per event. */
export const emitToChannel = (channel: unknown, events: readonly unknown[]): void => {
  const send = channelSender(channel);
  events.forEach(send);
};
