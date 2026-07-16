const PLAYFUL_PROGRESS_COPY = [
  { sending: "Sending message", thinking: "Thinking" },
  { sending: "Dispatching a tiny messenger", thinking: "Connecting the dots" },
  {
    sending: "Knocking on the model's door",
    thinking: "Rummaging through the mental drawers",
  },
  { sending: "Launching a thought balloon", thinking: "Consulting the inner librarian" },
] as const;

/** Pick one voice for the whole turn. The prompt-derived hash makes the choice
 * stable across React renders and phase changes without persisting UI trivia or
 * introducing random, flaky behaviour. */
export function playfulProgressCopy(prompt: string) {
  let hash = 2_166_136_261;
  for (const codePoint of prompt) {
    hash ^= codePoint.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16_777_619);
  }
  return PLAYFUL_PROGRESS_COPY[(hash >>> 0) % PLAYFUL_PROGRESS_COPY.length];
}
