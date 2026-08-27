import {
  AlertTriangle,
  Ban,
  Check,
  Square,
  TimerOff,
  UserX,
  type LucideIcon,
} from "lucide-react";
import type { ToolStatus } from "../lib/types";

export const TOOL_SETTLEMENT: Record<
  ToolStatus,
  { icon: LucideIcon; tone: string; label: string; filled?: true }
> = {
  ok: { icon: Check, tone: "text-muted-foreground/70", label: "" },
  error: { icon: AlertTriangle, tone: "text-destructive", label: "failed" },
  rejected: { icon: Ban, tone: "text-warning", label: "refused by NeuralNote" },
  denied: { icon: UserX, tone: "text-warning", label: "denied by you" },
  timedOut: { icon: TimerOff, tone: "text-warning", label: "expired unanswered" },
  cancelled: {
    icon: Square,
    tone: "text-muted-foreground/70",
    label: "run ended first",
    filled: true,
  },
};

const HINT_FIELDS = [
  "query",
  "rel_path",
  "url",
  "playlist_url",
  "topic",
  "folder",
  "id",
  "message",
  "question",
] as const;

const MAX_HINT_CHARS = 64;

export function argumentHint(argumentsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  for (const field of HINT_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") continue;
    const trimmed = value.trim();
    return trimmed.length > MAX_HINT_CHARS
      ? `${trimmed.slice(0, MAX_HINT_CHARS)}…`
      : trimmed;
  }
  return null;
}

export function formatArguments(argumentsJson: string): string {
  try {
    return JSON.stringify(JSON.parse(argumentsJson), null, 2);
  } catch {
    return argumentsJson;
  }
}
