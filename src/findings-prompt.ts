// Plain-text schema description for embedding in the PostToolUse hook's
// `additionalContext` system reminder.
//
// Lives in its own module (separate from findings.ts) so that hook.ts's hot
// path can pull in this static string without forcing the zod schema (and
// its ~280 KB of zod-core + ~210 KB of zod locales) to initialize on every
// hook event. Most hook fires bail at `extractSkillName === null` BEFORE
// any review work happens; previously they paid the zod init cost anyway
// because hook.ts's static `import { findingsSchemaForPrompt } from "./findings"`
// pulled in the whole findings module.
//
// findings.ts re-exports this for attest's use, so there's still a single
// import path for callers that don't care about hot-path budget.

/**
 * Plain-text description of `FindingInputSchema` for embedding in
 * `additionalContext` system reminders. Co-located with the schema (see
 * findings.ts) so a schema change must be reflected in both files.
 */
export function findingsSchemaForPrompt(): string {
  return [
    "Each finding must have:",
    '  - path: string (repo-relative file path)',
    "  - line: integer (1-based line on the right side of the diff)",
    '  - severity: "error" | "warning" | "info"',
    "  - title: short headline (1 line)",
    "  - body: full explanation (markdown supported)",
    "  - suggestion?: optional fix suggestion (string)",
    '  - side?: "LEFT" | "RIGHT" (defaults to RIGHT)',
    "If your review found nothing, write an empty array `[]`.",
  ].join("\n");
}
