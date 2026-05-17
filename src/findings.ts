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

// `findingsSchemaForPrompt` was moved to `./findings-prompt` so hook.ts can
// import it without dragging the zod schema (+ its ~490 KB of bundled
// zod-core and locales) onto the PostToolUse hot path. Re-exported here
// so attest.ts and any other importer keeps the existing import path.
export { findingsSchemaForPrompt } from "./findings-prompt";

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
// Artifact summary comment (per-skill, top-level on the PR)
//
// While inline fingerprint-marked comments cover individual findings, the
// artifact comment is the single per-skill summary that posts even when
// there are zero findings. Without it, the only PR-visible evidence of a
// review is a green status check — easy to fabricate or miss. The artifact
// is the audit trail: it tells reviewers "this skill ran on this commit
// and produced N findings of severity X/Y/Z."
//
// Posted as a top-level PR comment (issues endpoint), edited (PATCHed) on
// each re-attestation so there's only ever ONE artifact per skill. Marker
// `<!-- skilled-pr:artifact:<skill-name> -->` lets us find and update it.
// Distinct from the inline `:fp:<hash>` marker — no collision risk.
// ---------------------------------------------------------------------------

/**
 * Render the per-skill artifact summary comment. Always include the marker
 * at end-of-body so subsequent runs can find and edit this comment.
 */
export function formatArtifactComment(
  skillName: string,
  sha: string,
  findings: Finding[],
  failOn: FailOn,
): string {
  const counts = countBySeverity(findings);
  const blocking = findingsExceedingThreshold(findings, failOn);
  const isBlocked = blocking.length > 0;
  const icon = isBlocked ? "🚫" : findings.length === 0 ? "✅" : "⚠️";
  const shortSha = sha.slice(0, 7);

  const parts: string[] = [];
  parts.push(`## ${icon} \`${skillName}\` reviewed \`${shortSha}\``);
  parts.push("");

  if (findings.length === 0) {
    parts.push("**Findings:** 0");
    parts.push("");
    parts.push("No issues found in the diff.");
  } else {
    const breakdown = formatSeverityBreakdown(counts);
    parts.push(`**Findings:** ${findings.length} (${breakdown})`);
    parts.push("");
    if (isBlocked) {
      const label = blocking.length === 1 ? "finding has" : "findings have";
      parts.push(
        `**🚫 This PR is blocked** because \`failOn: ${failOn}\` is set and ${blocking.length} ${label} severity at or above that threshold.`,
      );
    } else {
      parts.push(
        `Findings exist but none reach the \`failOn: ${failOn}\` threshold; the gate is passing.`,
      );
    }
    parts.push("");
    parts.push("See inline comments on the PR for details on each finding.");
  }

  parts.push("");
  parts.push(`<sub>via \`skilled-pr\` · updated on each attestation</sub>`);
  parts.push(`<!-- skilled-pr:artifact:${skillName} -->`);

  return parts.join("\n");
}

/**
 * Format the severity breakdown for the comment header, e.g.
 *   "1 🔴 error · 2 🟡 warning · 0 🔵 info"  →  "1 🔴 error · 2 🟡 warning"
 * Zero-count severities are omitted so the header stays scannable.
 */
function formatSeverityBreakdown(counts: SeverityCounts): string {
  const parts: string[] = [];
  if (counts.error > 0) parts.push(`${counts.error} 🔴 error`);
  if (counts.warning > 0) parts.push(`${counts.warning} 🟡 warning`);
  if (counts.info > 0) parts.push(`${counts.info} 🔵 info`);
  return parts.join(" · ");
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
