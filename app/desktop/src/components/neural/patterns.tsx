import { Brain, type LucideIcon } from "lucide-react";
import type { ComponentProps, ComponentPropsWithoutRef, ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Badge } from "@/components/ui/badge";

export function AiMark({ className }: Readonly<{ className?: string }>) {
  return (
    <span className={cn("grid size-7 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/12 text-primary", className)}>
      <Brain className="size-3.5" aria-hidden />
    </span>
  );
}

export function PanelHeader({
  icon: Icon,
  title,
  meta,
  className,
}: Readonly<{
  icon?: LucideIcon;
  title: string;
  meta?: ReactNode;
  className?: string;
}>) {
  return (
    <header className={cn("flex min-h-11 items-center gap-2 border-b border-border px-3", className)}>
      {Icon && <Icon className="size-3.5 text-muted-foreground" aria-hidden />}
      <h2 className="nn-heading min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{title}</h2>
      {meta}
    </header>
  );
}

export function StatusPill({
  status,
  className,
  ...props
}: Readonly<Omit<ComponentProps<typeof Badge>, "tone"> & {
  status: "neutral" | "ai" | "healthy" | "warning" | "danger";
}>) {
  return <Badge tone={status} className={cn("rounded-full", className)} {...props} />;
}

export function InlineNotice({
  tone = "neutral",
  className,
  ...props
}: Readonly<
  ComponentPropsWithoutRef<"div"> &
    ComponentPropsWithoutRef<"output"> & {
      tone?: "neutral" | "warning" | "danger";
    }
>) {
  const noticeClassName = cn(
    "rounded-lg border px-3 py-2 text-xs leading-5",
    tone === "neutral" && "border-border bg-surface-raised text-muted-foreground",
    tone === "warning" && "border-warning/30 bg-warning/10 text-warning",
    tone === "danger" && "border-destructive/30 bg-destructive/10 text-destructive",
    className,
  );

  if (tone === "danger") {
    return <div role="alert" className={noticeClassName} {...props} />;
  }

  return <output className={noticeClassName} {...props} />;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: Readonly<{
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
}>) {
  return (
    <div className="flex max-w-xs flex-col items-center gap-3 text-center">
      <span className="grid size-10 place-items-center rounded-lg border border-border bg-surface-raised text-muted-foreground">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-foreground">{title}</p>
        <p className="text-xs leading-5 text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
