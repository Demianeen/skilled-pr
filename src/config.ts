import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FailOn } from "./findings";

export interface SkilledPRConfig {
  requiredSkills: string[];
  statusName: string;
  failOn: FailOn;
}

const DEFAULT_CONFIG: SkilledPRConfig = {
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

  const merged = { ...DEFAULT_CONFIG, ...parsed };

  if (merged.failOn !== "error" && merged.failOn !== "warning" && merged.failOn !== "none") {
    throw new Error(
      `Invalid .skilledpr.jsonc: "failOn" must be "error", "warning", or "none" (got ${JSON.stringify(merged.failOn)})`,
    );
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
  //   "error"   — fail if any finding has severity "error" (default)
  //   "warning" — fail on either "error" or "warning"
  //   "none"    — always succeed if the skill attested (advisory mode)
  "failOn": "error"
}
`;
}
