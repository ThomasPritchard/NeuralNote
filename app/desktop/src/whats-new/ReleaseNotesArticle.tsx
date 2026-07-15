import { Check } from "lucide-react";
import { CURRENT_RELEASE_NOTES } from "./releaseNotes";

export function ReleaseNotesArticle() {
  const notes = CURRENT_RELEASE_NOTES;

  return (
    <article aria-labelledby="nn-release-notes-title" className="mx-auto flex w-full max-w-2xl flex-col gap-7">
      <header className="border-b border-border pb-5 pr-8">
        <p className="nn-mono text-[0.6875rem] font-medium uppercase tracking-[0.16em] text-primary">
          Version {notes.version}
        </p>
        <h1
          id="nn-release-notes-title"
          className="nn-heading mt-2 text-2xl font-semibold tracking-tight text-foreground"
        >
          {notes.title}
        </h1>
        <p className="mt-3 max-w-xl text-[0.8125rem] leading-6 text-muted-foreground">
          {notes.introduction}
        </p>
      </header>

      <div className="flex flex-col gap-7 pb-2">
        {notes.groups.map((group) => (
          <section key={group.title} aria-labelledby={`nn-release-${group.title.toLowerCase().replaceAll(" ", "-")}`}>
            <h2
              id={`nn-release-${group.title.toLowerCase().replaceAll(" ", "-")}`}
              className="nn-heading text-sm font-semibold text-foreground"
            >
              {group.title}
            </h2>
            <ul className="mt-3 flex flex-col gap-2.5">
              {group.items.map((item) => (
                <li key={item} className="flex items-start gap-2.5 text-[0.8125rem] leading-5 text-muted-foreground">
                  <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-primary/12 text-primary">
                    <Check className="size-2.5" aria-hidden />
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </article>
  );
}
