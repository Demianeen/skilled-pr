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

export function stripJsonComments(jsonc: string): string {
  return jsonc
    .replace(/\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/,\s*([}\]])/g, "$1");
}

export function parseConfig(raw: string): SkilledPRConfig {
  const parsed = JSON.parse(stripJsonComments(raw));
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
