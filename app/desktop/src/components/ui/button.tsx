import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { LoaderCircle } from "lucide-react";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/cn";

export const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium transition-[background-color,color,border-color,opacity,transform] duration-150 ease-spring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-px disabled:pointer-events-none disabled:opacity-45 motion-reduce:transition-none",
  {
    variants: {
      tone: {
        primary: "bg-primary text-primary-foreground hover:bg-primary/88",
        chat: "bg-chat text-chat-foreground hover:bg-chat/88",
        quiet: "border border-border bg-surface-raised text-foreground hover:bg-surface-hover",
        ghost: "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
        danger: "bg-destructive text-destructive-foreground hover:bg-destructive/88",
      },
      size: {
        sm: "h-7 px-2.5 text-xs",
        md: "h-8 px-3 text-[13px]",
        lg: "h-10 px-4 text-sm",
        icon: "size-8 p-0",
      },
    },
    defaultVariants: { tone: "quiet", size: "md" },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { asChild = false, loading = false, className, tone, size, children, disabled, ...props },
  ref,
) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      ref={ref}
      type={asChild ? undefined : (props.type ?? "button")}
      className={cn(buttonVariants({ tone, size }), className)}
      disabled={asChild ? undefined : (disabled || loading)}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />}
      {children}
    </Comp>
  );
});
