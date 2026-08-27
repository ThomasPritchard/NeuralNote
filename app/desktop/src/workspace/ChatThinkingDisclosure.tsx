import { useState, type SyntheticEvent } from "react";
import { ChevronRight } from "lucide-react";
import { Markdown } from "./Markdown";

export function ChatThinkingDisclosure({ text }: Readonly<{ text: string }>) {
  const [open, setOpen] = useState(false);
  if (text === "") return null;

  const onToggle = (event: SyntheticEvent<HTMLDetailsElement>) => {
    setOpen(event.currentTarget.open);
  };

  return (
    <details onToggle={onToggle} className="group/thinking">
      <summary className="flex cursor-pointer list-none select-none items-center gap-1.5 rounded-sm text-[0.6875rem] font-medium text-muted-foreground/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <ChevronRight
          className="size-3 shrink-0 text-muted-foreground/60 transition-transform group-open/thinking:rotate-90 motion-reduce:transition-none"
          aria-hidden
        />
        Thinking
      </summary>
      {open && (
        <div className="mt-1.5 text-[0.6875rem] text-muted-foreground/80 [&_.nn-markdown>:first-child]:mt-0 [&_.nn-markdown>:last-child]:mb-0 [&_.nn-markdown_li]:leading-relaxed [&_.nn-markdown_ol]:my-1.5 [&_.nn-markdown_p]:my-1.5 [&_.nn-markdown_pre]:my-1.5 [&_.nn-markdown_ul]:my-1.5">
          <Markdown body={text} />
        </div>
      )}
    </details>
  );
}
