import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { FailOn } from "./findings";

/**
 * Currently supported config schema version. Bumped on every breaking
 * change to the config shape. `doctor` compares this against the
 * `schemaVersion` field in the user's config to detect drift between the
 * CLI's expectations and what the user has on disk; PR #2 ships an
 * automated migrator that uses the same number to decide which migration
 * step(s) to apply.
 */
export const CURRENT_SCHEMA_VERSION = 1 as const;

/**
 * Auto-review behaviour. Optional in v1 — every field defaults to a
 * sensible value if missing. PR #4 (auto-review) implements the actual
 * behaviour gated by these flags; in PR #1 the fields just need to parse
 * cleanly and round-trip through `show` so users can see what's enabled.
 */
export interface AutoReviewConfig {
  /** When the gate fires. "manual" = only when the user invokes a skill; "on-push" = automatic via PR #2's GH Action. */
  trigger: "manual" | "on-push";
  /** Where the skill runs. "subagent" = isolated context; "main-agent" = inline in the orchestrator. */
  execution: "subagent" | "main-agent";
  /** Whether multiple required skills run in parallel (or serially). */
  parallel: boolean;
  /** Pass session briefing context to the skill (purpose/constraints/decisions/exclusions). */
  sessionBriefing: boolean;
  /** Whether the agent decides to skip a review for trivial diffs, or always fires. */
  skipPolicy: "agent-decides" | "always-fire";
  /** Whether to ask the user before firing a required skill that wasn't explicitly invoked. */
  askBeforeFiring: boolean;
}

/**
 * A single match block. Keys WITHIN one block AND together (branch=X
 * AND author=Y AND labels=[a,b]); blocks within a rule's `match` array
 * OR together (matchA OR matchB).
 *
 * `labels` is a *subset* check — the PR must have all listed labels, but
 * may have others too. `branch` supports a simple `*` glob; `author` is
 * exact match.
 */
export interface MatchBlock {
  branch?: string;
  author?: string;
  labels?: string[];
}

/**
 * A rule overlays the top-level defaults when its `match` matches the
 * current PR context. Rules are evaluated in source order; first match
 * wins. Optional fields (requiredSkills/failOn/summaryPrompt) fall back
 * to the top-level value when absent, so a rule can override just one
 * dimension (e.g. "stricter failOn for release branches, same skills").
 */
export interface Rule {
  /** Human-readable name shown in `skilled-pr show`. Optional but encouraged for clarity. */
  name?: string;
  /** Array of match blocks (OR semantics across blocks; AND across keys within a block). */
  match: MatchBlock[];
  /** Override the top-level requiredSkills when this rule matches. */
  requiredSkills?: string[];
  /** Override the top-level failOn when this rule matches. */
  failOn?: FailOn;
  /** Override the top-level summaryPrompt. Use null for the built-in default. */
  summaryPrompt?: string | null;
}

export interface SkilledPRConfig {
  /** Schema version. v1 is the only currently supported value. */
  schemaVersion: typeof CURRENT_SCHEMA_VERSION;
  /** Top-level required skills. Rules can override per-PR. */
  requiredSkills: string[];
  /** GitHub status check name (e.g. "Skilled PR / review"). */
  statusName: string;
  /** Top-level severity gate. Rules can override. */
  failOn: FailOn;
  /**
   * Per-project prompt embedded in the hook reminder. Tells the skill how
   * to render `.review/summary-<skill>.md`, which `attest` posts as the
   * per-skill artifact comment. `null` resolves to DEFAULT_SUMMARY_PROMPT
   * at runtime (in resolve.ts); writing the default inline is unnecessary
   * boilerplate.
   */
  summaryPrompt: string | null;
  /**
   * Session-briefing prompt used by PR #4's auto-review when launching a
   * subagent. `null` resolves to DEFAULT_BRIEFING_PROMPT. Like
   * summaryPrompt, this is the contract that lets one transport serve
   * many domains: the orchestrator fills in slots, the prompt rephrases
   * for the spawned agent.
   */
  briefingPrompt: string | null;
  /** Auto-review behaviour for PR #4. Optional; defaults baked in here. */
  autoReview: AutoReviewConfig;
  /** Per-context rule overlays. Evaluated in order; first match wins. */
  rules: Rule[];
}

/** Built-in default `summaryPrompt`. Resolves at runtime when config sets `summaryPrompt: null`. */
export const DEFAULT_SUMMARY_PROMPT =
  "Render a markdown summary of the review for posting as a GitHub PR comment.\n" +
  "\n" +
  "1. Start with a one-line header: severity emoji (🚫 if findings hit the failOn threshold, ✅ if zero findings, ⚠️ otherwise) + skill name + the short commit SHA.\n" +
  "2. Then a `**Findings:** <count> (<breakdown>)` line, where `<breakdown>` is severity emojis with counts (e.g. `2 🔴 error · 3 🟡 warning`).\n" +
  "3. Then one sentence about the gate state: blocked by failOn, or passing.\n" +
  "4. Then group findings by severity (errors first, then warnings, then info). For each finding, render as a collapsible `<details>` block: severity emoji + `<code>path:line</code>` + title in the `<summary>`, body + suggestion (if present, under a `**Suggestion:**` heading) in the expanded section.\n" +
  "\n" +
  "Keep it scannable. The reviewer should see the count and gate at a glance, then click into individual findings for detail.";

/**
 * Built-in default `briefingPrompt`. Slot-fill template used by PR #4's
 * auto-review subagent launcher. Each `{{slot}}` is filled by the
 * orchestrator from the active session context (purpose, constraints,
 * decisions, exclusions). Resolves at runtime when config sets
 * `briefingPrompt: null`.
 */
export const DEFAULT_BRIEFING_PROMPT =
  "You're reviewing this branch using the {{skill}} skill on behalf of the orchestrating agent.\n" +
  "\n" +
  "Context from the user's session (provided by the orchestrating agent):\n" +
  "- Purpose: {{purpose}}\n" +
  "- Constraints: {{constraints}}\n" +
  "- Decisions explicitly made: {{decisions}}\n" +
  "- Out of scope: {{exclusions}}\n" +
  "\n" +
  "Treat the context above as background, not as conclusions. The user's stated intent doesn't excuse bugs — review against your skill's own standards. If the brief contradicts what the diff actually does, flag the mismatch as an error-level finding.\n" +
  "\n" +
  "Now run `git diff <base>..HEAD` and review per your loaded skill's instructions.";

const DEFAULT_AUTO_REVIEW: AutoReviewConfig = {
  trigger: "manual",
  execution: "subagent",
  parallel: true,
  sessionBriefing: true,
  skipPolicy: "agent-decides",
  askBeforeFiring: false,
};

const DEFAULT_CONFIG_BASE = {
  schemaVersion: CURRENT_SCHEMA_VERSION,
  requiredSkills: ["review"],
  statusName: "Skilled PR",
  failOn: "error" as FailOn,
  summaryPrompt: null as string | null,
  briefingPrompt: null as string | null,
  autoReview: DEFAULT_AUTO_REVIEW,
  rules: [] as Rule[],
};

/** Config file path under the .skilledpr/ directory. v1+. */
export const CONFIG_PATH = ".skilledpr/config.jsonc";
/** Legacy v0 config path at repo root. Detected so we can fail loudly with a migration hint. */
export const LEGACY_CONFIG_PATH = ".skilledpr.jsonc";

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Normalize a prompt field into a single string (or null). Config authors
 * may write a prompt three ways, because JSON has no multi-line string
 * literal and a ~900-char escaped one-liner is unreadable:
 *
 *   - array of lines  (["line", "", "line"]) → joined with "\n". The
 *     readable, editable multi-line form; this is what `init` writes.
 *   - single string   ("...")                 → used as-is (one-liners).
 *   - null                                     → tracks the built-in default.
 *
 * The array is purely an authoring convenience: it's normalized to a
 * string HERE, so everything downstream (resolveProfile, formatReminder,
 * attest, show) only ever deals with `string | null`. `field` names the
 * field for error messages.
 */
export function normalizePrompt(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "${field}" must be a non-empty string, an array of strings, or null`,
      );
    }
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "${field}" array must have at least one line (or use null for the built-in default)`,
      );
    }
    if (!value.every((line) => typeof line === "string")) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "${field}" array must contain only strings (one per line)`,
      );
    }
    const joined = value.join("\n");
    if (joined.trim().length === 0) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "${field}" must not be entirely blank (use null for the built-in default)`,
      );
    }
    return joined;
  }
  throw new Error(
    `Invalid ${CONFIG_PATH}: "${field}" must be a non-empty string, an array of strings, or null (got ${JSON.stringify(value)})`,
  );
}

function validateMatchBlock(block: unknown, ctx: string): MatchBlock {
  if (!isObject(block)) {
    throw new Error(`Invalid ${CONFIG_PATH}: ${ctx} must be an object`);
  }
  const out: MatchBlock = {};
  if ("branch" in block) {
    if (typeof block.branch !== "string" || block.branch.length === 0) {
      throw new Error(`Invalid ${CONFIG_PATH}: ${ctx}.branch must be a non-empty string`);
    }
    out.branch = block.branch;
  }
  if ("author" in block) {
    if (typeof block.author !== "string" || block.author.length === 0) {
      throw new Error(`Invalid ${CONFIG_PATH}: ${ctx}.author must be a non-empty string`);
    }
    out.author = block.author;
  }
  if ("labels" in block) {
    if (!Array.isArray(block.labels) || !block.labels.every((l) => typeof l === "string")) {
      throw new Error(`Invalid ${CONFIG_PATH}: ${ctx}.labels must be an array of strings`);
    }
    out.labels = block.labels as string[];
  }
  return out;
}

function validateRule(raw: unknown, idx: number): Rule {
  if (!isObject(raw)) {
    throw new Error(`Invalid ${CONFIG_PATH}: rules[${idx}] must be an object`);
  }
  if (!("match" in raw) || !Array.isArray(raw.match)) {
    throw new Error(`Invalid ${CONFIG_PATH}: rules[${idx}].match must be an array of match blocks`);
  }
  const rule: Rule = {
    match: raw.match.map((b, j) => validateMatchBlock(b, `rules[${idx}].match[${j}]`)),
  };
  if ("name" in raw) {
    if (typeof raw.name !== "string") {
      throw new Error(`Invalid ${CONFIG_PATH}: rules[${idx}].name must be a string`);
    }
    rule.name = raw.name;
  }
  if ("requiredSkills" in raw) {
    if (
      !Array.isArray(raw.requiredSkills) ||
      !raw.requiredSkills.every((s) => typeof s === "string")
    ) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: rules[${idx}].requiredSkills must be an array of strings`,
      );
    }
    rule.requiredSkills = raw.requiredSkills as string[];
  }
  if ("failOn" in raw) {
    if (raw.failOn !== "error" && raw.failOn !== "warning" && raw.failOn !== "none") {
      throw new Error(
        `Invalid ${CONFIG_PATH}: rules[${idx}].failOn must be "error", "warning", or "none"`,
      );
    }
    rule.failOn = raw.failOn;
  }
  if ("summaryPrompt" in raw) {
    rule.summaryPrompt = normalizePrompt(raw.summaryPrompt, `rules[${idx}].summaryPrompt`);
  }
  return rule;
}

function validateAutoReview(raw: unknown): AutoReviewConfig {
  if (!isObject(raw)) {
    throw new Error(`Invalid ${CONFIG_PATH}: "autoReview" must be an object`);
  }
  const out: AutoReviewConfig = { ...DEFAULT_AUTO_REVIEW };
  if ("trigger" in raw) {
    if (raw.trigger !== "manual" && raw.trigger !== "on-push") {
      throw new Error(`Invalid ${CONFIG_PATH}: autoReview.trigger must be "manual" or "on-push"`);
    }
    out.trigger = raw.trigger;
  }
  if ("execution" in raw) {
    if (raw.execution !== "subagent" && raw.execution !== "main-agent") {
      throw new Error(
        `Invalid ${CONFIG_PATH}: autoReview.execution must be "subagent" or "main-agent"`,
      );
    }
    out.execution = raw.execution;
  }
  if ("parallel" in raw) {
    if (typeof raw.parallel !== "boolean") {
      throw new Error(`Invalid ${CONFIG_PATH}: autoReview.parallel must be a boolean`);
    }
    out.parallel = raw.parallel;
  }
  if ("sessionBriefing" in raw) {
    if (typeof raw.sessionBriefing !== "boolean") {
      throw new Error(`Invalid ${CONFIG_PATH}: autoReview.sessionBriefing must be a boolean`);
    }
    out.sessionBriefing = raw.sessionBriefing;
  }
  if ("skipPolicy" in raw) {
    if (raw.skipPolicy !== "agent-decides" && raw.skipPolicy !== "always-fire") {
      throw new Error(
        `Invalid ${CONFIG_PATH}: autoReview.skipPolicy must be "agent-decides" or "always-fire"`,
      );
    }
    out.skipPolicy = raw.skipPolicy;
  }
  if ("askBeforeFiring" in raw) {
    if (typeof raw.askBeforeFiring !== "boolean") {
      throw new Error(`Invalid ${CONFIG_PATH}: autoReview.askBeforeFiring must be a boolean`);
    }
    out.askBeforeFiring = raw.askBeforeFiring;
  }
  return out;
}

export function parseConfig(raw: string): SkilledPRConfig {
  const errors: ParseError[] = [];
  const parsed = parseJsonc(raw, errors, {
    allowTrailingComma: true,
    allowEmptyContent: false,
  });

  if (errors.length > 0) {
    const { error, offset, length } = errors[0];
    throw new Error(
      `Invalid ${CONFIG_PATH}: ${printParseErrorCode(error)} at offset ${offset} (length ${length})`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid ${CONFIG_PATH}: top-level value must be an object`);
  }

  // Legacy `sha` field (removed in 0.2). Kept in the v1 parser so users
  // upgrading from v0 with a stale `sha` see a clear migration message
  // instead of "unknown field" noise.
  if ("sha" in (parsed as Record<string, unknown>)) {
    throw new Error(
      `Invalid ${CONFIG_PATH}: the "sha" field is no longer supported. ` +
      `Remove it from your config — attest now always errors with exit code 2 ` +
      `if HEAD isn't pushed (so the agentic recovery loop can fire). ` +
      `For silent-skip semantics, wrap the call in your shell: skilled-pr attest ... || true`,
    );
  }

  const parsedObj = parsed as Record<string, unknown>;

  // schemaVersion is the v1 sentinel. Missing → migration error. Mismatch
  // (non-1 number) → version mismatch error (doctor's classifySchemaVersion
  // has the user-facing message; here we just guard the parser).
  if (!("schemaVersion" in parsedObj)) {
    throw new Error(
      `Invalid ${CONFIG_PATH}: "schemaVersion" is required (must be ${CURRENT_SCHEMA_VERSION}). ` +
        `Old configs without schemaVersion need migration. PR #2 will ship an automated migrator; ` +
        `for now, run \`skilled-pr init\` to regenerate, or add \`"schemaVersion": ${CURRENT_SCHEMA_VERSION}\` manually.`,
    );
  }
  if (parsedObj.schemaVersion !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Invalid ${CONFIG_PATH}: "schemaVersion" must be ${CURRENT_SCHEMA_VERSION} (got ${JSON.stringify(parsedObj.schemaVersion)}). ` +
        `If your config is newer than this CLI, upgrade skilled-pr; if older, regenerate via \`skilled-pr init\`.`,
    );
  }

  // ---- Build the typed config one field at a time ----
  const merged: SkilledPRConfig = {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    requiredSkills: DEFAULT_CONFIG_BASE.requiredSkills,
    statusName: DEFAULT_CONFIG_BASE.statusName,
    failOn: DEFAULT_CONFIG_BASE.failOn,
    summaryPrompt: DEFAULT_CONFIG_BASE.summaryPrompt,
    briefingPrompt: DEFAULT_CONFIG_BASE.briefingPrompt,
    autoReview: { ...DEFAULT_CONFIG_BASE.autoReview },
    rules: DEFAULT_CONFIG_BASE.rules,
  };

  if ("requiredSkills" in parsedObj) {
    if (
      !Array.isArray(parsedObj.requiredSkills) ||
      !parsedObj.requiredSkills.every((s) => typeof s === "string")
    ) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "requiredSkills" must be an array of strings`,
      );
    }
    merged.requiredSkills = parsedObj.requiredSkills as string[];
  }
  if ("statusName" in parsedObj) {
    if (typeof parsedObj.statusName !== "string" || parsedObj.statusName.length === 0) {
      throw new Error(`Invalid ${CONFIG_PATH}: "statusName" must be a non-empty string`);
    }
    merged.statusName = parsedObj.statusName;
  }
  if ("failOn" in parsedObj) {
    if (
      parsedObj.failOn !== "error" &&
      parsedObj.failOn !== "warning" &&
      parsedObj.failOn !== "none"
    ) {
      throw new Error(
        `Invalid ${CONFIG_PATH}: "failOn" must be "error", "warning", or "none" (got ${JSON.stringify(parsedObj.failOn)})`,
      );
    }
    merged.failOn = parsedObj.failOn;
  }
  if ("summaryPrompt" in parsedObj) {
    merged.summaryPrompt = normalizePrompt(parsedObj.summaryPrompt, "summaryPrompt");
  }
  if ("briefingPrompt" in parsedObj) {
    merged.briefingPrompt = normalizePrompt(parsedObj.briefingPrompt, "briefingPrompt");
  }
  if ("autoReview" in parsedObj) {
    merged.autoReview = validateAutoReview(parsedObj.autoReview);
  }
  if ("rules" in parsedObj) {
    if (!Array.isArray(parsedObj.rules)) {
      throw new Error(`Invalid ${CONFIG_PATH}: "rules" must be an array`);
    }
    merged.rules = parsedObj.rules.map((r, i) => validateRule(r, i));
  }

  return merged;
}

/**
 * Load the v1 config from disk. Returns null when no v1 config exists at
 * the expected path (`.skilledpr/config.jsonc`). Hard-errors when the
 * legacy v0 config (`.skilledpr.jsonc` at root) is present, with a
 * migration hint pointing to PR #2's automated migrator.
 */
export async function loadConfig(path = CONFIG_PATH): Promise<SkilledPRConfig | null> {
  // Detect the legacy v0 file first so users with stale configs get a
  // pointed error instead of "config not found". Only check the default
  // legacy path; if a caller passes an explicit path, respect it.
  if (path === CONFIG_PATH && existsSync(LEGACY_CONFIG_PATH)) {
    throw new Error(
      `Old config detected at ${LEGACY_CONFIG_PATH}. The v1 schema lives in ${CONFIG_PATH}. ` +
        `Move and update your config, or run \`skilled-pr init\` to regenerate. ` +
        `(PR #2 will ship an automated migrator.)`,
    );
  }
  if (!existsSync(path)) return null;
  return parseConfig(readFileSync(path, "utf8"));
}

/**
 * Generate a default JSONC config. Pointed at `./schema.json` (sibling of
 * `config.jsonc`, also written by `init`) for editor autocompletion. The
 * file ends with a trailing newline because tools (eslint, prettier,
 * git diff highlighting) all assume one and complain about its absence.
 */
/**
 * Render a prompt string as a pretty JSONC array-of-lines literal, indented
 * to sit at `indent` spaces inside the generated config. Lets
 * generateDefaultConfig write the built-in defaults in their readable,
 * editable multi-line form (one array element per line) instead of null or
 * an unreadable escaped one-liner. Round-trips: parseConfig joins the array
 * back to exactly the original string.
 */
function promptToJsoncArray(prompt: string, indent: string): string {
  const inner = prompt
    .split("\n")
    .map((line) => `${indent}  ${JSON.stringify(line)}`)
    .join(",\n");
  return `[\n${inner}\n${indent}]`;
}

export function generateDefaultConfig(): string {
  return `{
  // JSON Schema reference for editor autocompletion. The schema file is
  // copied here by \`skilled-pr init\`; \`skilled-pr doctor\` warns if it
  // drifts from the version bundled with the CLI.
  "$schema": "./schema.json",

  // Schema version. Bumped by skilled-pr on every breaking config change.
  // To see the active value: \`skilled-pr show schemaVersion\`
  "schemaVersion": ${CURRENT_SCHEMA_VERSION},

  // Which review skills must run before merge.
  // To see the active value: \`skilled-pr show requiredSkills\`
  "requiredSkills": ["review"],

  // The name shown on GitHub status checks (e.g. "Skilled PR / review").
  "statusName": "Skilled PR",

  // When to fail the check based on finding severity:
  //   "error"   - fail if any finding has severity "error" (default)
  //   "warning" - fail on either "error" or "warning"
  //   "none"    - always succeed if the skill attested (advisory mode)
  "failOn": "error",

  // Per-skill summary prompt: how each skill renders its PR comment.
  // Written as an array of lines (joined with newlines) because JSON has
  // no multi-line string literal — edit these lines freely to customize.
  // Replace the whole value with null to drop your copy and track
  // skilled-pr's built-in default instead. (A plain "string" works too.)
  //   \`skilled-pr show summaryPrompt\` prints the active text.
  "summaryPrompt": ${promptToJsoncArray(DEFAULT_SUMMARY_PROMPT, "  ")},

  // Session-briefing prompt used by auto-review when launching a reviewing
  // subagent. Same form as summaryPrompt: an array of lines you can edit,
  // or null to track the built-in default.
  //   \`skilled-pr show briefingPrompt\` prints the active text.
  "briefingPrompt": ${promptToJsoncArray(DEFAULT_BRIEFING_PROMPT, "  ")},

  // Auto-review behaviour (PR #4 will implement). Optional; defaults
  // shown here. All fields are independent — change one without changing
  // the others.
  "autoReview": {
    "trigger": "manual",
    "execution": "subagent",
    "parallel": true,
    "sessionBriefing": true,
    "skipPolicy": "agent-decides",
    "askBeforeFiring": false
  },

  // Per-context overrides. Each rule's \`match\` array OR's together;
  // keys within a single block (branch + author + labels) AND together.
  // First matching rule wins. Empty array (the default) → top-level
  // values apply to every PR.
  //
  // Example (uncomment to use):
  //   "rules": [
  //     {
  //       "name": "stricter review for release branches",
  //       "match": [{ "branch": "release-*" }],
  //       "failOn": "warning"
  //     }
  //   ]
  "rules": []
}
`;
}
