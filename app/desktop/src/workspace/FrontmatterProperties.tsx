import { normalizeObsidianTag } from "./obsidianTag";

type SearchTag = (tag: string) => void;

const CHIP_CLASS = "nn-mono rounded-sm bg-primary/12 px-1.5 py-0.5 text-[0.75rem] text-primary ring-1 ring-inset ring-primary/15";
const TAG_BUTTON_CLASS = `${CHIP_CLASS} cursor-pointer transition-colors hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary`;

export function FrontmatterProperties({
  frontmatter,
  onSearchTag,
}: Readonly<{
  frontmatter: Record<string, unknown>;
  onSearchTag?: SearchTag;
}>) {
  return (
    <dl className="mt-5 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-card/50">
      {Object.entries(frontmatter).map(([key, value]) => (
        <div key={key} className="flex items-start gap-3 px-4 py-2.5">
          <dt className="nn-mono flex w-28 shrink-0 items-center pt-px text-[0.75rem] text-muted-foreground">
            {key}
          </dt>
          <dd className="min-w-0 flex-1 text-[0.8125rem]">
            <FrontmatterValue propertyKey={key} value={value} onSearchTag={onSearchTag} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

function searchableTag(
  propertyKey: string,
  value: unknown,
  onSearchTag: SearchTag | undefined,
): string | null {
  if (propertyKey !== "tags" || !onSearchTag) return null;
  return normalizeObsidianTag(value);
}

function FrontmatterTagButton({
  label,
  tag,
  onSearchTag,
}: Readonly<{ label: string; tag: string; onSearchTag: SearchTag }>) {
  return (
    <button
      type="button"
      className={TAG_BUTTON_CLASS}
      aria-label={`Search for ${tag}`}
      onClick={() => queueMicrotask(() => onSearchTag(tag))}
    >
      {label}
    </button>
  );
}

function FrontmatterValue({
  propertyKey,
  value,
  onSearchTag,
}: Readonly<{
  propertyKey: string;
  value: unknown;
  onSearchTag?: SearchTag;
}>) {
  if (Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {value.map((item, index) => {
          const label = stringifyFrontmatterScalar(item);
          const tag = searchableTag(propertyKey, item, onSearchTag);
          if (tag && onSearchTag) {
            return (
              <FrontmatterTagButton
                key={`${label}-${index}`}
                label={label}
                tag={tag}
                onSearchTag={onSearchTag}
              />
            );
          }
          return (
            <span
              key={`${label}-${index}`}
              className={CHIP_CLASS}
            >
              {label}
            </span>
          );
        })}
      </div>
    );
  }
  const tag = searchableTag(propertyKey, value, onSearchTag);
  if (tag && onSearchTag) {
    return (
      <FrontmatterTagButton
        label={stringifyFrontmatterScalar(value)}
        tag={tag}
        onSearchTag={onSearchTag}
      />
    );
  }
  if (value !== null && typeof value === "object") {
    return <span className="nn-mono text-foreground/80">{stringifyFrontmatterScalar(value)}</span>;
  }
  return <span className="text-foreground/90">{stringifyFrontmatterScalar(value)}</span>;
}

export function stringifyFrontmatterScalar(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value) ?? "—";
    } catch {
      return "—";
    }
  }
  if (
    typeof value === "string"
    || typeof value === "number"
    || typeof value === "bigint"
    || typeof value === "boolean"
    || typeof value === "symbol"
  ) {
    return value.toString();
  }
  return "—";
}

function appendScalar(document: Document, parent: HTMLElement, value: unknown): void {
  const element = document.createElement("span");
  element.className = value !== null && typeof value === "object"
    ? "nn-mono text-foreground/80"
    : "text-foreground/90";
  element.append(document.createTextNode(stringifyFrontmatterScalar(value)));
  parent.append(element);
}

function appendTagButton(
  document: Document,
  parent: HTMLElement,
  label: string,
  tag: string,
  onSearchTag: SearchTag,
): void {
  const button = document.createElement("button");
  button.type = "button";
  button.className = TAG_BUTTON_CLASS;
  button.setAttribute("aria-label", `Search for ${tag}`);
  button.append(document.createTextNode(label));
  button.addEventListener("click", (event) => {
    event.preventDefault();
    queueMicrotask(() => onSearchTag(tag));
  });
  parent.append(button);
}

export function createFrontmatterPropertiesDom(
  document: Document,
  frontmatter: Record<string, unknown>,
  onSearchTag?: SearchTag,
): HTMLElement {
  const list = document.createElement("dl");
  list.className = "mt-5 flex flex-col divide-y divide-border/70 overflow-hidden rounded-lg border border-border bg-card/50";
  for (const [key, value] of Object.entries(frontmatter)) {
    const row = document.createElement("div");
    row.className = "flex items-start gap-3 px-4 py-2.5";
    const term = document.createElement("dt");
    term.className = "nn-mono flex w-28 shrink-0 items-center pt-px text-[0.75rem] text-muted-foreground";
    term.append(document.createTextNode(key));
    const definition = document.createElement("dd");
    definition.className = "min-w-0 flex-1 text-[0.8125rem]";
    if (Array.isArray(value)) {
      const values = document.createElement("div");
      values.className = "flex flex-wrap gap-1.5";
      value.forEach((item) => {
        const label = stringifyFrontmatterScalar(item);
        const tag = searchableTag(key, item, onSearchTag);
        if (tag && onSearchTag) {
          appendTagButton(document, values, label, tag, onSearchTag);
          return;
        }
        const chip = document.createElement("span");
        chip.className = CHIP_CLASS;
        chip.append(document.createTextNode(label));
        values.append(chip);
      });
      definition.append(values);
    } else {
      const tag = searchableTag(key, value, onSearchTag);
      if (tag && onSearchTag) {
        appendTagButton(document, definition, stringifyFrontmatterScalar(value), tag, onSearchTag);
      } else {
        appendScalar(document, definition, value);
      }
    }
    row.append(term, definition);
    list.append(row);
  }
  return list;
}
