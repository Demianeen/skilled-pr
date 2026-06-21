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

/**
 * What a review skill produces. Inferred from the zod schema.
 *
 * `Finding` is now an alias for `FindingInput`. Earlier versions extended
 * the input shape with a `fingerprint` field used to dedupe inline PR
 * comments across attest re-runs. Inline comments were removed in favour
 * of a single artifact summary, so fingerprints have no consumer left.
 */
export type FindingInput = z.infer<typeof FindingInputSchema>;
export type Finding = FindingInput;

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

  return result.data;
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

// `findingsSchemaForPrompt` was moved to `./findings-prompt` so hook.ts can
// import it without dragging the zod schema (+ its ~490 KB of bundled
// zod-core and locales) onto the PostToolUse hot path. Re-exported here
// so attest.ts and any other importer keeps the existing import path.
export { findingsSchemaForPrompt } from "./findings-prompt";

// ---------------------------------------------------------------------------
// Artifact summary comment (per-skill, top-level on the PR)
//
// The skill renders the body itself, following the project's `summaryPrompt`
// (in .skilledpr/config.jsonc). skilled-pr doesn't have a built-in formatter: the
// skill knows its own domain (typo-check, security review, French
// translation, ...) and can produce a summary that suits it. attest just
// posts the rendered file verbatim (with the artifact marker appended).
//
// Posted as a top-level PR comment (issues endpoint), edited (PATCHed) on
// each re-attestation so there's only ever ONE artifact per skill. Marker
// `<!-- skilled-pr:artifact:<skill-name> -->` is what lets us find and
// update the same comment instead of creating a new one each run.
// ---------------------------------------------------------------------------

/** HTML marker the artifact comment carries so future attest runs can PATCH-in-place. */
export function artifactMarker(skillName: string): string {
  return `<!-- skilled-pr:artifact:${skillName} -->`;
}

/**
 * Wrap an arbitrary markdown body with the artifact marker so a future
 * `attest` run can find and PATCH-update it. Idempotent: if the body
 * already contains the marker (e.g. the skill's prompt inlines it), no
 * second copy is appended.
 */
export function wrapWithArtifactMarker(body: string, skillName: string): string {
  const marker = artifactMarker(skillName);
  if (body.includes(marker)) return body;
  // Trim a trailing newline so the marker sits one blank line below content.
  const trimmed = body.replace(/\n+$/, "");
  return `${trimmed}\n\n${marker}\n`;
}

/**
 * Extract the skill name from an artifact comment body, or null if not
 * present. Used to match existing comments for PATCH-vs-POST routing.
 */
export function extractArtifactSkillName(commentBody: string): string | null {
  // Skill names: letters, digits, colons (plugin namespace), dashes, underscores.
  // Stop before whitespace or the closing ` -->`.
  const match = commentBody.match(/<!-- skilled-pr:artifact:([a-zA-Z0-9:_-]+) -->/);
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
  if (findings.length === 0) return `${skillName}: no findings`;
  const c = countBySeverity(findings);
  const parts: string[] = [];
  if (c.error) parts.push(`${c.error} error${c.error === 1 ? "" : "s"}`);
  if (c.warning) parts.push(`${c.warning} warning${c.warning === 1 ? "" : "s"}`);
  if (c.info) parts.push(`${c.info} info`);
  return `${skillName}: ${parts.join(", ")}`;
}
