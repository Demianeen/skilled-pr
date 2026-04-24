import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FailOn } from "./findings";

export interface SkilledPRConfig {
  requiredSkills: string[];
  sha: "head" | "pushed";
  statusName: string;
  failOn: FailOn;
}

const DEFAULT_CONFIG: SkilledPRConfig = {
  requiredSkills: ["review"],
  sha: "head",
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

  const merged = { ...DEFAULT_CONFIG, ...parsed };

  if (merged.failOn !== "error" && merged.failOn !== "warning" && merged.failOn !== "none") {
    throw new Error(
      `Invalid .skilledpr.jsonc: "failOn" must be "error", "warning", or "none" (got ${JSON.stringify(merged.failOn)})`,
    );
  }

  return merged;
}

export async function loadConfig(path = ".skilledpr.jsonc"): Promise<SkilledPRConfig | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return parseConfig(await file.text());
}

export function generateDefaultConfig(): string {
  return `{
  // Which review skills must run before merge
  "requiredSkills": ["review"],

  // When to attest: "head" (default) or "pushed" (only if HEAD is on remote)
  "sha": "head",

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
