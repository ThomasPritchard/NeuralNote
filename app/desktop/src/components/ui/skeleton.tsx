import type { HTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export function Skeleton({
  className,
  ...props
}: Readonly<HTMLAttributes<HTMLDivElement>>) {
  return <div aria-hidden className={cn("animate-pulse rounded-md bg-surface-hover motion-reduce:animate-none", className)} {...props} />;
}
