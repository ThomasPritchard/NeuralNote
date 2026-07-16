// One activity/skill row's shared shape: a fixed icon gutter (a Lucide glyph,
// matching the rest of the workspace — never an emoji) plus the step's line.
// The most recent step of an in-flight run reads as "active" (violet glyph);
// everything settled is calm and muted, so the trace looks like an agent
// working, not debug output. Shared by the activity trace (ActivityRow) and the
// skill narration (SkillSteps) so both register identically.
export const ROW = "flex items-start gap-2 text-[0.6875rem] leading-snug";
export const GLYPH = "size-3.5 shrink-0 translate-y-px";
