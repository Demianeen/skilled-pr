import { createHash } from "node:crypto";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";
export type DiffSide = "LEFT" | "RIGHT";
export type FailOn = "error" | "warning" | "none";

// ---------------------------------------------------------------------------
// Schema — single source of truth.
//
// `FindingInputSchema` defines what review skills are expected to write into
// `.review/findings-<skill>.json`. The same shape is described in plain English
// by `findingsSchemaForPrompt()` below, which is embedded into the system
// reminder injected by the PostToolUse hook. Co-locating the two means a
// schema change forces a docstring change in the same edit.
// ---------------------------------------------------------------------------

export const FindingInputSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1),
  side: z.enum(["LEFT", "RIGHT"]).optional(),
  severity: z.enum(["error", "warning", "info"]),
  title: z.string().min(1),
  body: z.string().min(1),
  suggestion: z.string().optional(),
});

export const FindingsInputSchema = z.array(FindingInputSchema);

/** What a review skill produces. Inferred from the zod schema. */
export type FindingInput = z.infer<typeof FindingInputSchema>;

/** A finding after the tool has enriched it with a fingerprint. */
export interface Finding extends FindingInput {
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Fingerprinting
//   SHA256(path + ":" + title + ":" + first_20_chars_of_body)
// ---------------------------------------------------------------------------

export function computeFingerprint(input: {
  path: string;
  title: string;
  body: string;
}): string {
  const material = `${input.path}:${input.title}:${input.body.slice(0, 20)}`;
  // Truncate to 16 hex chars (64 bits): short enough to keep embedded
  // comment markers readable, long enough that collisions within a single
  // repo are effectively impossible. Bump if we ever see one.
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// Parsing + validation (zod-backed)
// ---------------------------------------------------------------------------

export function parseFindings(raw: string): Finding[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`findings input must be valid JSON: ${(e as Error).message}`);
  }

  // Catch the most common shape error with a friendlier message than zod's
  // "Expected array, received object." This message is asserted in tests.
  if (!Array.isArray(parsed)) {
    throw new Error("findings input must be a JSON array of findings");
  }

  const result = FindingsInputSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`${formatIssuePath(issue.path)}: ${issue.message}`);
  }

  return result.data.map((f) => ({
    ...f,
    fingerprint: computeFingerprint({ path: f.path, title: f.title, body: f.body }),
  }));
}

/**
 * Format a zod issue path into the dotted/bracket form the existing tests
 * assert against, e.g. `[0, "path"]` → `"findings[0].path"`.
 */
function formatIssuePath(path: ReadonlyArray<string | number | symbol>): string {
  let out = "findings";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else {
      out += `.${String(segment)}`;
    }
  }
  return out;
}

/**
 * Plain-text description of `FindingInputSchema` for embedding in
 * `additionalContext` system reminders. Co-located with the schema so a
 * schema change forces a docstring change in the same diff.
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

// ---------------------------------------------------------------------------
// Comment body formatting
// ---------------------------------------------------------------------------

const SEVERITY_BADGE: Record<Severity, string> = {
  error: "🔴 **error**",
  warning: "🟡 **warning**",
  info: "🔵 **info**",
};

/** Render a finding as a GitHub PR review comment body with a fingerprint marker. */
export function formatCommentBody(finding: Finding, skillName: string): string {
  const parts: string[] = [];
  parts.push(`${SEVERITY_BADGE[finding.severity]} · ${finding.title}`);
  parts.push("");
  parts.push(finding.body);

  if (finding.suggestion) {
    parts.push("");
    parts.push("**Suggestion:**");
    parts.push(finding.suggestion);
  }

  parts.push("");
  parts.push(`<sub>via \`skilled-pr\` · skill: \`${skillName}\`</sub>`);
  parts.push(`<!-- skilled-pr:fp:${finding.fingerprint} -->`);

  return parts.join("\n");
}

/** Extract the fingerprint from a comment body, or null if not present. */
export function extractFingerprint(commentBody: string): string | null {
  const match = commentBody.match(/<!-- skilled-pr:fp:([a-f0-9]+) -->/);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Severity threshold + status description
// ---------------------------------------------------------------------------

const FAIL_ON_BLOCKS: Record<FailOn, ReadonlySet<Severity>> = {
  error: new Set<Severity>(["error"]),
  warning: new Set<Severity>(["error", "warning"]),
  none: new Set<Severity>(),
};

/** Findings whose severity, under the given policy, should fail the check. */
export function findingsExceedingThreshold(findings: Finding[], failOn: FailOn): Finding[] {
  const blocks = FAIL_ON_BLOCKS[failOn];
  return findings.filter((f) => blocks.has(f.severity));
}

export interface SeverityCounts {
  error: number;
  warning: number;
  info: number;
}

export function countBySeverity(findings: Finding[]): SeverityCounts {
  const counts: SeverityCounts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  return counts;
}

/** Compact human description for a GitHub commit-status (140-char limit). */
export function buildStatusDescription(skillName: string, findings: Finding[] | null): string {
  if (findings === null) return `Reviewed by ${skillName}`;
  if (findings.length === 0) return `${skillName} — no findings`;
  const c = countBySeverity(findings);
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} error${c.error === 1 ? "" : "s"}`);
  if (c.warning) parts.push(`${c.warning} warning${c.warning === 1 ? "" : "s"}`);
  if (c.info) parts.push(`${c.info} info`);
  return `${skillName} — ${parts.join(", ")}`;
}
