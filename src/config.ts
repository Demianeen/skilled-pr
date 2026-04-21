import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

export interface SkilledPRConfig {
  requiredSkills: string[];
  sha: "head" | "pushed";
  statusName: string;
}

const DEFAULT_CONFIG: SkilledPRConfig = {
  requiredSkills: ["review"],
  sha: "head",
  statusName: "Skilled PR",
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

  return { ...DEFAULT_CONFIG, ...parsed };
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
  "statusName": "Skilled PR"
}
`;
}
