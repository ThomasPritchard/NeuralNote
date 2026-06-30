// Themed markdown rendering for the reader. react-markdown v10 removed the
// `className` prop, so styling is done via a `components` map plus a wrapping
// div. Links are deliberately inert (preventDefault) — opening external URLs in
// the Tauri webview would navigate away from the app; real link-opening is a
// later phase.

import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const components: Components = {
  // `children` is destructured and rendered explicitly so the heading's text
  // content is provably present (react-markdown would otherwise forward it via
  // the spread, which a static analyzer can't verify — see S6850).
  h1: ({ node: _node, children, ...props }) => (
    <h1 className="nn-heading mt-8 mb-3 text-2xl font-semibold tracking-tight text-foreground first:mt-0" {...props}>
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...props }) => (
    <h2 className="nn-heading mt-7 mb-2.5 text-xl font-semibold tracking-tight text-foreground first:mt-0" {...props}>
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, ...props }) => (
    <h3 className="nn-heading mt-6 mb-2 text-base font-semibold text-foreground first:mt-0" {...props}>
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, ...props }) => (
    <h4 className="nn-heading mt-5 mb-2 text-sm font-semibold text-foreground first:mt-0" {...props}>
      {children}
    </h4>
  ),
  p: ({ node: _node, ...props }) => (
    <p className="my-3.5 text-[15px] leading-7 text-foreground/90" {...props} />
  ),
  a: ({ node: _node, href, children, ...props }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => e.preventDefault()}
      className="text-primary underline decoration-primary/40 underline-offset-2 transition-colors hover:decoration-primary"
      {...props}
    >
      {children}
    </a>
  ),
  ul: ({ node: _node, ...props }) => (
    <ul className="my-3.5 ml-5 list-disc space-y-1.5 text-[15px] leading-7 text-foreground/90 marker:text-primary/60" {...props} />
  ),
  ol: ({ node: _node, ...props }) => (
    <ol className="my-3.5 ml-5 list-decimal space-y-1.5 text-[15px] leading-7 text-foreground/90 marker:text-muted-foreground" {...props} />
  ),
  li: ({ node: _node, ...props }) => <li className="pl-1" {...props} />,
  blockquote: ({ node: _node, ...props }) => (
    <blockquote className="my-4 border-l-2 border-l-primary rounded-r-md bg-accent/30 px-4 py-2 text-[14px] italic text-foreground/85" {...props} />
  ),
  hr: ({ node: _node, ...props }) => <hr className="my-6 border-border" {...props} />,
  pre: ({ node: _node, ...props }) => (
    <pre className="my-4 overflow-x-auto rounded-lg border border-border bg-card/70 p-4 text-[13px] leading-6" {...props} />
  ),
  code: ({ node: _node, className, children, ...props }) => {
    const isBlock = /language-/.test(className ?? "");
    if (isBlock) {
      return (
        <code className={`nn-mono text-foreground/90 ${className ?? ""}`} {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className="nn-mono rounded bg-muted px-1.5 py-0.5 text-[0.85em] text-foreground/90" {...props}>
        {children}
      </code>
    );
  },
  strong: ({ node: _node, ...props }) => (
    <strong className="font-semibold text-foreground" {...props} />
  ),
  em: ({ node: _node, ...props }) => <em className="italic" {...props} />,
  table: ({ node: _node, ...props }) => (
    <div className="my-4 overflow-x-auto rounded-lg border border-border">
      <table className="w-full border-collapse text-[13px]" {...props} />
    </div>
  ),
  thead: ({ node: _node, ...props }) => <thead className="bg-muted/60" {...props} />,
  th: ({ node: _node, ...props }) => (
    <th className="border-b border-border px-3 py-2 text-left font-semibold text-foreground" {...props} />
  ),
  td: ({ node: _node, ...props }) => (
    <td className="border-b border-border/60 px-3 py-2 text-foreground/85" {...props} />
  ),
  img: ({ node: _node, ...props }) => (
    // eslint-disable-next-line jsx-a11y/alt-text -- alt is forwarded via props
    <img className="my-4 max-w-full rounded-lg border border-border" {...props} />
  ),
};

/** Render a markdown body with GitHub-flavoured markdown, themed to NeuralNote. */
export function Markdown({ body }: { body: string }) {
  return (
    <div className="nn-markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {body}
      </ReactMarkdown>
    </div>
  );
}
