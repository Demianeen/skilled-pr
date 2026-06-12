// src/resolve.ts
//
// Pure library code that:
//   1. Resolves a v1 config + PR context into the active "profile" -- the
//      set of values that apply right now (top-level defaults overlaid by
//      the first matching rule).
//   2. Formats the attestation-instruction system reminder body, given an
//      already-resolved profile + the skill name being invoked + the
//      harness it's running in.
//
// Why pure: hook.ts and (eventually) the GH Action both need to compute
// the same answer "what skills must run, what failOn applies, what
// summaryPrompt does the model see?" without coupling to the disk read
// or to the host harness. Centralising it here means a config-shape
// change costs one edit, not three; and the perf bench fixture (PR #7)
// drives the same code path as production.
//
// Why null-resolution lives here, not in the parser: the config file is
// the user's text. Letting the parser silently substitute defaults
// destroys round-tripping (load -> save would rewrite the user's `null`
// as the full prompt text). Resolution is the right layer.

import { spawnSync } from "node:child_process";
import {
  CURRENT_SCHEMA_VERSION,
  DEFAULT_BRIEFING_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  type Rule,
  type SkilledPRConfig,
} from "./config";
import type { FailOn } from "./findings";
import { findingsSchemaForPrompt } from "./findings-prompt";

// Re-export for callers that already pull from resolve and don't want a
// second import.
export { CURRENT_SCHEMA_VERSION };

/**
 * Information about the current PR / branch that rules match against.
 * `branch` is required (every git checkout has one — even if it's a
 * detached HEAD, callers can pass an empty string and rules with
 * branch-matchers will simply not match). Author + labels come from
 * GitHub and are only available in CI / via gh; the hook reads them
 * best-effort and lives without them when missing.
 *
 * `sha` is informational only — not used in rule matching, but useful
 * for `skilled-pr show` debug output.
 */
export interface PRContext {
  branch: string;
  author?: string;
  labels?: string[];
  sha?: string;
}

/**
 * The resolved view of "what applies right now." `matchedRuleName` is
 * `null` when no rule matched (top-level defaults are in effect). All
 * prompts are fully resolved (no `null`) so callers don't have to
 * substitute defaults themselves.
 */
export interface ResolvedProfile {
  matchedRuleName: string | null;
  requiredSkills: string[];
  failOn: FailOn;
  summaryPrompt: string;
  briefingPrompt: string;
}

/**
 * Translate a branch glob with `*` into a RegExp. `*` matches any run of
 * characters (including dashes, slashes, dots). Anchored on both ends so
 * "release-*" matches "release-1.2.3" but not "fix-release-thing".
 *
 * Glob is the simplest pattern users expect; full regex would be more
 * powerful but harder to teach. If we ever need negative patterns, we
 * can add a `branchNot` field instead of escalating glob syntax.
 */
function globToRegex(pattern: string): RegExp {
  // Escape regex metacharacters EXCEPT `*`, then translate `*` to `.*`.
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`);
}

/** Exact match. Empty pattern (""), if it ever appears, matches an empty branch. */
export function matchesBranch(pattern: string, branch: string): boolean {
  // Optimisation: most matchers have no `*`, so check exact equality
  // first before paying for regex compilation.
  if (!pattern.includes("*")) return pattern === branch;
  return globToRegex(pattern).test(branch);
}

/** Author match is exact (case-sensitive). Missing author → never matches. */
export function matchesAuthor(expected: string, actual: string | undefined): boolean {
  if (actual === undefined) return false;
  return expected === actual;
}

/**
 * Required labels must ALL be present in actual labels. Extra labels on
 * the PR are fine — subset semantics. Missing actual → no match (a
 * label-gated rule can't fire when we have no label data).
 */
export function matchesLabels(required: string[], actual: string[] | undefined): boolean {
  if (actual === undefined) return false;
  const set = new Set(actual);
  return required.every((label) => set.has(label));
}

/**
 * True if `rule` matches `context`. Match-array OR; match-block-keys AND.
 * A rule with an empty `match` array never matches (the parser already
 * accepts empty arrays, but they're effectively unreachable).
 *
 * Exported for unit testing; in production this is only called through
 * `resolveProfile`.
 */
export function matchesRule(rule: Rule, context: PRContext): boolean {
  for (const block of rule.match) {
    let blockMatches = true;
    if (block.branch !== undefined && !matchesBranch(block.branch, context.branch)) {
      blockMatches = false;
    }
    if (blockMatches && block.author !== undefined && !matchesAuthor(block.author, context.author)) {
      blockMatches = false;
    }
    if (blockMatches && block.labels !== undefined && !matchesLabels(block.labels, context.labels)) {
      blockMatches = false;
    }
    // Empty block (no keys) matches anything. That's a footgun, but it's
    // explicit in the user's config — we don't second-guess it here.
    if (blockMatches) return true;
  }
  return false;
}

/**
 * Resolve `config` against `context` into the effective profile. First
 * matching rule wins; unmatched config falls back to top-level. Nulls in
 * either summaryPrompt or briefingPrompt resolve to their built-in
 * defaults so the caller never has to think about them.
 */
export function resolveProfile(config: SkilledPRConfig, context: PRContext): ResolvedProfile {
  const matched = config.rules.find((r) => matchesRule(r, context));

  const requiredSkills =
    matched?.requiredSkills !== undefined ? matched.requiredSkills : config.requiredSkills;
  const failOn = matched?.failOn !== undefined ? matched.failOn : config.failOn;

  // summaryPrompt resolution: rule override (if present, even `null`)
  // takes priority; otherwise fall back to top-level; `null` at either
  // layer means "use the built-in default."
  const summaryPromptRaw =
    matched !== undefined && "summaryPrompt" in matched ? matched.summaryPrompt : config.summaryPrompt;
  const summaryPrompt = summaryPromptRaw === null ? DEFAULT_SUMMARY_PROMPT : (summaryPromptRaw ?? DEFAULT_SUMMARY_PROMPT);

  // briefingPrompt has no rule-level override in v1; it's a per-config
  // global. (Adding a per-rule override would invite users to specialise
  // the briefing per branch, but in practice the briefing template is
  // about session-context relay, not about what to look for — that
  // belongs in summaryPrompt or the skill itself.)
  const briefingPrompt = config.briefingPrompt === null ? DEFAULT_BRIEFING_PROMPT : config.briefingPrompt;

  return {
    matchedRuleName: matched?.name ?? null,
    requiredSkills,
    failOn,
    summaryPrompt,
    briefingPrompt,
  };
}

/**
 * Slugify a skill name for use in the findings/summary filenames.
 * `coderabbit:review` -> `coderabbit-review`. Mirrors the helper that
 * used to live in hook.ts so callers don't have to import from hook.ts
 * (which carries the stdin reader and other CLI concerns).
 */
export function slugifySkill(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Identifier of the host harness the hook is running under. */
export type HarnessName = "claude" | "codex";

/**
 * Build the attestation-instruction system reminder body. Pure: no I/O.
 *
 * Takes the already-resolved profile so callers don't have to think
 * about null-prompt fallback. `harnessName` is accepted for forward
 * compatibility — today's reminder body is identical regardless, but
 * the GH Action runner (PR #2) or per-harness UX tweaks might vary it
 * later. Plumbed now so adding variance later doesn't require updating
 * every call site.
 */
export function formatReminder(
  profile: ResolvedProfile,
  skillName: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _harnessName: HarnessName,
): string {
  const slug = slugifySkill(skillName);
  const findingsPath = `.review/findings-${slug}.json`;
  const summaryPath = `.review/summary-${slug}.md`;
  const attestCommand = `skilled-pr attest --skill ${skillName} --findings ${findingsPath} --summary ${summaryPath}`;

  const lines: string[] = [];
  lines.push(
    `This repo gates merges via skilled-pr. The \`${skillName}\` skill you just loaded is listed in \`.skilledpr/config.jsonc\` as a required review.`,
  );
  lines.push("");
  lines.push("After completing your review, do these four things in order:");
  lines.push("");
  lines.push(
    `1. Write your findings to \`${findingsPath}\` as a JSON array. ${findingsSchemaForPrompt()}`,
  );
  lines.push("");
  lines.push(
    `2. Write a markdown summary to \`${summaryPath}\` following this project's summary style. The summary becomes the PR's artifact comment verbatim.`,
  );
  lines.push("");
  lines.push("   Per-project summary instructions:");
  lines.push("");
  for (const line of profile.summaryPrompt.split("\n")) {
    lines.push(`   ${line}`);
  }
  lines.push("");
  lines.push(`3. Run: \`${attestCommand}\``);
  lines.push("");
  lines.push(
    "   If `skilled-pr` isn't on PATH (project-local install), prefix with your package runner: `npx skilled-pr ...` / `pnpm exec skilled-pr ...` / `yarn skilled-pr ...` / `bunx skilled-pr ...`.",
  );
  lines.push("");
  lines.push(
    "4. If attest exits with code 2 (\"HEAD is not pushed\"), ask the user whether to push the branch. After they confirm, run `git push` and then re-run the attest command. Do NOT push without asking - pushing modifies the remote.",
  );
  lines.push("");
  lines.push(
    "This posts the GitHub status check that gates the PR. Without it, the PR cannot merge.",
  );
  return lines.join("\n");
}

/**
 * Best-effort current PR context derived from `git`. Used by `show` and
 * the hook to populate a default context for rule matching when no
 * explicit context flags are passed. Failure → empty context; rules
 * with branch-matchers simply won't match. Author + labels are not
 * derivable from git alone (live on GitHub) and are left undefined; the
 * `gh` integration in PR #2 fills them.
 */
export function getCurrentPRContext(): PRContext {
  // spawnSync rather than promisified exec because this is on the hot
  // path (every PostToolUse:Skill / UserPromptExpansion event) and we
  // want zero-async-boundary overhead. 200 ms timeout is plenty for a
  // git command that's almost always sub-10 ms.
  const proc = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    timeout: 200,
  });
  if (proc.status !== 0 || proc.error) {
    return { branch: "" };
  }
  const branch = proc.stdout.trim();
  // Detached HEAD reports "HEAD" — we treat that as no useful branch
  // info rather than letting a `branch === "HEAD"` matcher accidentally
  // fire.
  if (branch === "HEAD" || branch.length === 0) {
    return { branch: "" };
  }
  return { branch };
}
