// One requirement row inside a skill card: its human label, an installed /
// missing / couldn't-check status chip, the backend's reasons as plain visible
// text, a download-or-cancel action for a missing binary, and — while that
// binary downloads — the streamed progress. The row renders the download state
// the composing page owns; it holds none of its own. Every failure (a streamed
// terminal frame or a transport rejection) lands inline here, on the row that
// owns the requirement — never a silent blank.

import { AlertTriangle, Check, Download } from "lucide-react";
import { cn } from "../lib/cn";
import type {
  Requirement,
  RequirementStatus,
  SkillRequirement,
} from "../lib/types";
import { buttonVariants } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { InlineError } from "./ProviderCard";

const GIB = 1024 ** 3;
/** Whole-GB label for the free-disk-space requirement. */
const wholeGb = (bytes: number) => `${Math.round(bytes / GIB)} GB`;
/** One-decimal GB label for download progress sizes. */
const gb = (bytes: number) => `${(bytes / GIB).toFixed(1)} GB`;

/** The freshest streamed frame for the one in-flight requirement download. */
export interface DownloadProgress {
  requirement: string;
  status: string;
  completed: number | null;
  total: number | null;
  percent: number | null;
}

/** One requirement's human label. Binary and asset names render in mono —
 *  they're program/file names, and mono is the app's register for those. An
 *  asset (a downloadable data file, not an executable) carries a prose
 *  "Required file:" prefix so it never reads as a program the way a bare
 *  binary name does. */
function requirementLabel(r: Requirement): {
  /** Prose lead-in, rendered outside the mono register. */
  prefix?: string;
  text: string;
  mono: boolean;
} {
  switch (r.type) {
    case "binary":
      return { text: r.name, mono: true };
    case "asset":
      return { prefix: "Required file: ", text: r.name, mono: true };
    case "freeDiskSpace":
      return { text: `${wholeGb(r.minBytes)} free disk space`, mono: false };
    case "platform":
      return { text: `${r.os} / ${r.arch}`, mono: false };
  }
}

/** A stable per-requirement key (requirements have no id of their own). */
export function requirementKey(r: Requirement): string {
  switch (r.type) {
    case "binary":
      return `bin:${r.name}`;
    case "asset":
      return `asset:${r.name}`;
    case "freeDiskSpace":
      return `disk:${r.minBytes}`;
    case "platform":
      return `plat:${r.os}:${r.arch}`;
  }
}

/** The status chip: installed / missing / couldn't check. "Missing" and
 *  "couldn't check" are different claims — an undetected requirement may well
 *  be present, so it never renders as missing. */
function StatusChip({ status }: Readonly<{ status: RequirementStatus }>) {
  if (status.status === "installed") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
        <Check className="size-2.5" aria-hidden />
        Installed
      </span>
    );
  }
  if (status.status === "undetected") {
    return (
      <span className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[0.625rem] font-medium text-muted-foreground">
        <AlertTriangle className="size-2.5" aria-hidden />
        Couldn&apos;t check
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-[0.625rem] font-medium text-destructive ring-1 ring-inset ring-destructive/30">
      <AlertTriangle className="size-2.5" aria-hidden />
      Missing
    </span>
  );
}

/** The backend's reasons, as plain visible text — readable by everyone,
 *  screen readers included; never a tooltip. */
function ReasonList({ reasons }: Readonly<{ reasons: readonly string[] }>) {
  if (reasons.length === 0) return null;
  return (
    <ul className="flex flex-col gap-0.5">
      {reasons.map((reason, i) => (
        <li
          key={`${reason}-${i}`}
          className="text-[0.6875rem] leading-snug text-muted-foreground"
        >
          {reason}
        </li>
      ))}
    </ul>
  );
}

function statusReasons(status: RequirementStatus): string[] {
  switch (status.status) {
    case "installed":
      return [];
    case "unmet":
    case "undetected":
      return [...status.reasons];
    case "unmetAndUndetected":
      return [...status.unmet, ...status.undetected];
  }
}

export function SkillRequirementRow({
  req,
  download,
  cancelling,
  downloadErrors,
  onStartDownload,
  onCancelDownload,
}: Readonly<{
  req: SkillRequirement;
  /** The one in-flight download's freshest frame, or null — owned by the page. */
  download: DownloadProgress | null;
  /** A cancel request is in flight — the Cancel button holds. */
  cancelling: boolean;
  /** Inline download errors keyed by binary name. */
  downloadErrors: Record<string, string>;
  onStartDownload: (name: string) => void;
  onCancelDownload: (name: string) => void;
}>) {
  const label = requirementLabel(req.requirement);
  const name = req.requirement.type === "binary" ? req.requirement.name : null;
  const downloading = name !== null && download?.requirement === name;

  // The action slot: Cancel while it downloads, Download for a missing binary,
  // nothing otherwise (disk space and platform aren't downloadable). Assets are
  // downloadable in principle, but the whole download pipeline is binary-specific
  // today — the Rust command resolves names against the compiled-in BINARY
  // allowlist and installs into bin/ with executable permissions, which is the
  // wrong treatment for a data file — so an asset row offers no Download yet.
  // TODO(asset-download-ui): offer Download for non-installed assets once the
  // backend grows a kind-agnostic (or asset-specific) download path.
  const action = (() => {
    if (name === null) return null;
    if (download?.requirement === name) {
      return (
        <button
          type="button"
          onClick={() => onCancelDownload(name)}
          disabled={cancelling}
          className={buttonVariants({ tone: "quiet", size: "sm" })}
        >
          {cancelling ? "Cancelling…" : "Cancel"}
        </button>
      );
    }
    if (req.status.status === "installed") return null;
    return (
      <button
        type="button"
        onClick={() => onStartDownload(name)}
        // One download at a time (a single cancel channel).
        disabled={download !== null}
        className={buttonVariants({ tone: "quiet", size: "sm" })}
      >
        <Download className="size-3.5" aria-hidden />
        Download
      </button>
    );
  })();

  return (
    <li className="flex flex-col gap-1.5 rounded-lg bg-background/50 px-3 py-2 ring-1 ring-inset ring-border">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.75rem] font-medium text-foreground">
          {label.prefix}
          <span className={cn(label.mono && "nn-mono")}>{label.text}</span>
        </span>
        <StatusChip status={req.status} />
        <span className="ml-auto">{action}</span>
      </div>
      <ReasonList reasons={statusReasons(req.status)} />
      {downloading && download && (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-2 text-[0.6875rem] text-muted-foreground">
            <span className="min-w-0 truncate">{download.status}</span>
            <span className="nn-mono shrink-0">
              {download.completed != null && download.total != null
                ? `${gb(download.completed)} / ${gb(download.total)}`
                : ""}
              {download.percent == null
                ? ""
                : ` · ${Math.round(download.percent)}%`}
            </span>
          </div>
          <Progress
            aria-label={`Downloading ${name}`}
            value={download.percent ?? 0}
          />
        </div>
      )}
      {name !== null && downloadErrors[name] && (
        <InlineError alert>{downloadErrors[name]}</InlineError>
      )}
    </li>
  );
}
