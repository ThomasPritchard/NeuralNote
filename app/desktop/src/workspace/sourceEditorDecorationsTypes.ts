export type PreviewDecorationKind = "mark" | "replace" | "line" | "widget";

export interface PreviewDecoration {
  readonly from: number;
  readonly to: number;
  readonly kind: PreviewDecorationKind;
  readonly className: string;
  readonly label?: string;
  readonly checked?: boolean;
  readonly href?: string;
  readonly table?: PreviewTable;
  /** Set on the revealed source of a table the caret is inside. */
  readonly tableSource?: boolean;
}

export interface PreviewTable {
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
}

export interface VisibleRange {
  readonly from: number;
  readonly to: number;
}
