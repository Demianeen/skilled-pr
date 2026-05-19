import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FailOn } from "./findings";

export interface SkilledPRConfig {
  requiredSkills: string[];
  statusName: string;
  failOn: FailOn;
  /**
   * Optional per-project prompt embedded in the PostToolUse hook reminder.
   * Tells the skill how to render `.review/summary-<skill>.md`, which `attest`
   * posts verbatim as the per-skill artifact comment (instead of the
   * built-in severity-grouped default). Lets a typo-check skill emit a
   * different format than a security-review skill while sharing the same
   * attestation transport.
   */
  summaryPrompt?: string;
}

const DEFAULT_CONFIG: Omit<SkilledPRConfig, "summaryPrompt"> = {
  requiredSkills: ["review"],
  statusName: "Skilled PR",
  failOn: "error",
};

export function parseConfig(raw: string): SkilledPRConfig {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    const { error, offset, length } = errors[0];
    throw new Error(
      `Invalid .skilledpr.jsonc: ${printParseErrorCode(error)} at offset ${offset} (length ${length})`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid .skilledpr.jsonc: top-level value must be an object");
  }

  // The `sha` field used to control whether attestation skipped silently or
  // failed loudly when HEAD wasn't on the remote. Both modes hit the same
  // GitHub constraint (status posts to unknown SHAs are 404'd), so the field
  // didn't actually let you "attest an unpushed commit" — it just controlled
  // error verbosity. Removed in favour of always-loud failure with exit code 2,
  // which the agentic plug-and-play loop relies on for recovery. Users who
  // want silent-skip semantics can wrap the call: `skilled-pr attest ... || true`.
  if ("sha" in (parsed as Record<string, unknown>)) {
    throw new Error(
      `Invalid .skilledpr.jsonc: the "sha" field is no longer supported. ` +
      `Remove it from your config — attest now always errors with exit code 2 ` +
      `if HEAD isn't pushed (so the agentic recovery loop can fire). ` +
      `For silent-skip semantics, wrap the call in your shell: skilled-pr attest ... || true`,
    );
  }

  const merged = { ...DEFAULT_CONFIG, ...parsed } as SkilledPRConfig;

  if (merged.failOn !== "error" && merged.failOn !== "warning" && merged.failOn !== "none") {
    throw new Error(
      `Invalid .skilledpr.jsonc: "failOn" must be "error", "warning", or "none" (got ${JSON.stringify(merged.failOn)})`,
    );
  }

  // summaryPrompt is optional but if present must be a non-empty string.
  // Anything else (number, object, empty string) is a misconfiguration;
  // bail early so the user sees the typo instead of attest silently
  // ignoring it.
  if (merged.summaryPrompt !== undefined) {
    if (typeof merged.summaryPrompt !== "string" || merged.summaryPrompt.length === 0) {
      throw new Error(
        `Invalid .skilledpr.jsonc: "summaryPrompt" must be a non-empty string when present (got ${JSON.stringify(merged.summaryPrompt)})`,
      );
    }
  }

  return merged;
}

export async function loadConfig(path = ".skilledpr.jsonc"): Promise<SkilledPRConfig | null> {
  if (!existsSync(path)) return null;
  return parseConfig(readFileSync(path, "utf8"));
}

export function generateDefaultConfig(): string {
  return `{
  // Which review skills must run before merge
  "requiredSkills": ["review"],

  // The name shown on GitHub status checks
  "statusName": "Skilled PR",

  // When to fail the check based on finding severity:
  //   "error"   - fail if any finding has severity "error" (default)
  //   "warning" - fail on either "error" or "warning"
  //   "none"    - always succeed if the skill attested (advisory mode)
  "failOn": "error"

  // OPTIONAL: a prompt embedded in the hook reminder telling the skill how
  // to format \`.review/summary-<skill>.md\`. The summary becomes the PR's
  // artifact comment (replacing the built-in severity-grouped default).
  // Useful when different skills want different summary formats - e.g. a
  // typo-check skill emitting a "file:line: typo -> fix" table vs a
  // security-review skill embedding CVE references and threat scenarios.
  //
  // "summaryPrompt": "Group findings by file. For each finding include a severity badge, file:line, and a 1-line fix suggestion. Add a 'Why this matters' callout for severity=error findings."
}
`;
}
