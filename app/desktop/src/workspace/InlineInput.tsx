// A focused, single-line inline editor used in the tree for creating and
// renaming entries. Enter confirms a non-empty value; Escape or blur cancels.
// It is intentionally dumb — the parent owns the async op and decides when to
// unmount it, so an error can keep the input open with the user's text intact.

import { useEffect, useRef, useState } from "react";
import { cn } from "../lib/cn";

interface InlineInputProps {
  /** Pre-filled value, e.g. the current name when renaming. */
  initialValue?: string;
  placeholder: string;
  ariaLabel: string;
  /** Called with the trimmed value when the user confirms a non-empty entry. */
  onSubmit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

export function InlineInput({
  initialValue = "",
  placeholder,
  ariaLabel,
  onSubmit,
  onCancel,
  className,
}: InlineInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Guards the blur handler: once we've confirmed/cancelled deliberately, the
  // subsequent blur must not fire a second cancel.
  const settledRef = useRef(false);

  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const confirm = () => {
    const trimmed = value.trim();
    if (trimmed === "") {
      cancel();
      return;
    }
    settledRef.current = true;
    onSubmit(trimmed);
  };

  const cancel = () => {
    settledRef.current = true;
    onCancel();
  };

  return (
    <input
      ref={inputRef}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          confirm();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={() => {
        if (!settledRef.current) cancel();
      }}
      className={cn(
        "w-full rounded-md border border-primary/60 bg-background px-1.5 py-[3px] text-[13px] text-foreground",
        "outline-none ring-1 ring-primary/30 placeholder:text-muted-foreground/60",
        className,
      )}
    />
  );
}
