import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Severity = "error" | "warning" | "info";
export type DiffSide = "LEFT" | "RIGHT";
export type FailOn = "error" | "warning" | "none";

/** What a review skill produces. Minimal shape; tool adds the rest. */
export interface FindingInput {
  path: string;
  line: number;
  side?: DiffSide;
  severity: Severity;
  title: string;
  body: string;
  suggestion?: string;
}

/** A finding after the tool has enriched it with a fingerprint. */
export interface Finding extends FindingInput {
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Fingerprinting (per plan line 218)
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
// Parsing + validation
// ---------------------------------------------------------------------------

export function parseFindings(raw: string): Finding[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("findings input must be a JSON array of findings");
  }
  return parsed.map((item, i) => validateAndEnrich(item, i));
}

function validateAndEnrich(item: unknown, index: number): Finding {
  if (typeof item !== "object" || item === null) {
    throw new Error(`findings[${index}] must be an object`);
  }
  const f = item as Record<string, unknown>;

  const path = requireString(f, "path", index);
  const line = requireNumber(f, "line", index);
  const severity = requireSeverity(f, "severity", index);
  const title = requireString(f, "title", index);
  const body = requireString(f, "body", index);

  const side = optionalSide(f, "side", index);
  const suggestion = optionalString(f, "suggestion", index);

  const fingerprint = computeFingerprint({ path, title, body });

  return {
    path,
    line,
    side,
    severity,
    title,
    body,
    suggestion,
    fingerprint,
  };
}

function requireString(f: Record<string, unknown>, key: string, i: number): string {
  const v = f[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`findings[${i}].${key} must be a non-empty string`);
  }
  return v;
}

function requireNumber(f: Record<string, unknown>, key: string, i: number): number {
  const v = f[key];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
    throw new Error(`findings[${i}].${key} must be a positive integer`);
  }
  return v;
}

function requireSeverity(f: Record<string, unknown>, key: string, i: number): Severity {
  const v = f[key];
  if (v !== "error" && v !== "warning" && v !== "info") {
    throw new Error(`findings[${i}].${key} must be "error", "warning", or "info"`);
  }
  return v;
}

function optionalString(f: Record<string, unknown>, key: string, i: number): string | undefined {
  if (!(key in f) || f[key] === undefined || f[key] === null) return undefined;
  const v = f[key];
  if (typeof v !== "string") {
    throw new Error(`findings[${i}].${key} must be a string if provided`);
  }
  return v;
}

function optionalSide(f: Record<string, unknown>, key: string, i: number): DiffSide | undefined {
  if (!(key in f) || f[key] === undefined || f[key] === null) return undefined;
  const v = f[key];
  if (v !== "LEFT" && v !== "RIGHT") {
    throw new Error(`findings[${i}].${key} must be "LEFT" or "RIGHT" if provided`);
  }
  return v;
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
