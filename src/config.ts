import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FailOn } from "./findings";

export interface SkilledPRConfig {
  requiredSkills: string[];
  statusName: string;
  failOn: FailOn;
  /**
   * Per-project prompt embedded in the PostToolUse hook reminder. Tells the
   * skill how to render `.review/summary-<skill>.md`, which `attest` posts
   * verbatim as the per-skill artifact comment. Required: skilled-pr no
   * longer has a built-in fallback renderer, so the prompt is the only
   * description of what the PR comment should look like.
   *
   * `init` writes a sensible default. Users tune it per project: a
   * typo-check skill wants a different format than a security-review
   * skill; the prompt is the contract that lets one transport serve both.
   */
  summaryPrompt: string;
}

/** Built-in default `summaryPrompt`. Written into new configs by `init`. */
export const DEFAULT_SUMMARY_PROMPT =
  "Render a markdown summary of the review for posting as a GitHub PR comment.\n" +
  "\n" +
  "1. Start with a one-line header: severity emoji (🚫 if findings hit the failOn threshold, ✅ if zero findings, ⚠️ otherwise) + skill name + the short commit SHA.\n" +
  "2. Then a `**Findings:** <count> (<breakdown>)` line, where `<breakdown>` is severity emojis with counts (e.g. `2 🔴 error · 3 🟡 warning`).\n" +
  "3. Then one sentence about the gate state: blocked by failOn, or passing.\n" +
  "4. Then group findings by severity (errors first, then warnings, then info). For each finding, render as a collapsible `<details>` block: severity emoji + `<code>path:line</code>` + title in the `<summary>`, body + suggestion (if present, under a `**Suggestion:**` heading) in the expanded section.\n" +
  "\n" +
  "Keep it scannable. The reviewer should see the count and gate at a glance, then click into individual findings for detail.";

const DEFAULT_CONFIG: Omit<SkilledPRConfig, "summaryPrompt"> & { summaryPrompt: string } = {
  requiredSkills: ["review"],
  statusName: "Skilled PR",
  failOn: "error",
  summaryPrompt: DEFAULT_SUMMARY_PROMPT,
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

  const parsedObj = parsed as Record<string, unknown>;
  // summaryPrompt is REQUIRED. Defaults only apply to the other fields; the
  // prompt must be explicit so the user has consciously decided what the
  // per-skill PR comment looks like. Missing -> hard error with a hint.
  if (!("summaryPrompt" in parsedObj)) {
    throw new Error(
      `Invalid .skilledpr.jsonc: "summaryPrompt" is required. ` +
      `Run \`skilled-pr init\` to regenerate the config with the default prompt, ` +
      `or copy DEFAULT_SUMMARY_PROMPT from src/config.ts (docs/SCHEMA.md has the rendered version).`,
    );
  }

  const merged = { ...DEFAULT_CONFIG, ...parsedObj } as SkilledPRConfig;

  if (merged.failOn !== "error" && merged.failOn !== "warning" && merged.failOn !== "none") {
    throw new Error(
      `Invalid .skilledpr.jsonc: "failOn" must be "error", "warning", or "none" (got ${JSON.stringify(merged.failOn)})`,
    );
  }

  if (typeof merged.summaryPrompt !== "string" || merged.summaryPrompt.length === 0) {
    throw new Error(
      `Invalid .skilledpr.jsonc: "summaryPrompt" must be a non-empty string (got ${JSON.stringify(merged.summaryPrompt)})`,
    );
  }

  return merged;
}

export async function loadConfig(path = ".skilledpr.jsonc"): Promise<SkilledPRConfig | null> {
  if (!existsSync(path)) return null;
  return parseConfig(readFileSync(path, "utf8"));
}

export function generateDefaultConfig(): string {
  // Build the JSON-escaped prompt inline. We can't drop the multi-line
  // string into a JSON value directly; the user can edit it later in
  // whatever multi-line shape they prefer, since JSONC parsing handles
  // both single-line escaped strings and concatenated multi-strings via
  // standard JSON syntax.
  const promptEscaped = JSON.stringify(DEFAULT_SUMMARY_PROMPT);
  return `{
  // Which review skills must run before merge
  "requiredSkills": ["review"],

  // The name shown on GitHub status checks
  "statusName": "Skilled PR",

  // When to fail the check based on finding severity:
  //   "error"   - fail if any finding has severity "error" (default)
  //   "warning" - fail on either "error" or "warning"
  //   "none"    - always succeed if the skill attested (advisory mode)
  "failOn": "error",

  // REQUIRED. Embedded in the hook reminder; tells the skill how to render
  // \`.review/summary-<skill>.md\`. The rendered file becomes the PR's
  // artifact comment verbatim. Tune per project - a typo-check skill should
  // emit a different shape than a security-review skill. Keep it specific:
  // vague prompts produce vague summaries.
  "summaryPrompt": ${promptEscaped}
}
`;
}
