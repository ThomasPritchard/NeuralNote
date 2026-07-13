import * as TogglePrimitive from "@radix-ui/react-toggle";
import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ComponentPropsWithoutRef, type ComponentRef } from "react";
import { cn } from "@/lib/cn";

const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-md text-muted-foreground outline-none transition-colors hover:bg-surface-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-[state=on]:bg-surface-selected data-[state=on]:text-foreground disabled:pointer-events-none disabled:opacity-45",
  { variants: { size: { sm: "h-7 px-2 text-xs", icon: "size-8" } }, defaultVariants: { size: "sm" } },
);

export const Toggle = forwardRef<
  ComponentRef<typeof TogglePrimitive.Root>,
  ComponentPropsWithoutRef<typeof TogglePrimitive.Root> & VariantProps<typeof toggleVariants>
>(function Toggle({ className, size, ...props }, ref) {
  return <TogglePrimitive.Root ref={ref} className={cn(toggleVariants({ size }), className)} {...props} />;
});
