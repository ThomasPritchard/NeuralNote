import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

const badgeVariants = cva(
  "inline-flex min-h-5 items-center gap-1 rounded-md border px-1.5 text-[0.625rem] font-medium leading-none",
  {
    variants: {
      tone: {
        neutral: "border-border bg-surface-raised text-muted-foreground",
        ai: "border-primary/25 bg-primary/10 text-primary",
        healthy: "border-healthy/25 bg-healthy/10 text-healthy",
        warning: "border-warning/25 bg-warning/10 text-warning",
        danger: "border-destructive/25 bg-destructive/10 text-destructive",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export function Badge({ className, tone, ...props }: HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
