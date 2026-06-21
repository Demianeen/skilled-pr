// skilled-pr doctor
//
// One command users run when something's off. Each check is a small pure
// classifier that takes the relevant command output (or file content) and
// returns a CheckResult. The I/O wrapper `doctor()` runs the actual commands
// and prints results. Splitting it this way means tests can hit edge cases
// without spawning processes.
//
// Output convention: ✓ pass / ⚠ warn / ✗ fail / · skip. Every failure or
// warning includes a one-line `fix` instruction the user can copy-paste.

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { run } from "./proc";
import { parseGitHubRemote, type GitHubRemote } from "./github";
import {
  CONFIG_PATH,
  CURRENT_SCHEMA_VERSION,
  LEGACY_CONFIG_PATH,
  parseConfig,
  type Rule,
  type SkilledPRConfig,
} from "./config";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail: string;
  /** Copy-pasteable fix shown when status is `warn` or `fail`. */
  fix?: string;
  /** Educational explanation shown when --why / --verbose / -v is passed. */
  why?: string;
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

const WHY_NODE =
  "skilled-pr runs on Node; the dist/cli.js shebang is `#!/usr/bin/env node`. Without node on PATH, `skilled-pr` won't execute even if it was installed. The CLI's `engines.node` is `>=22.0.0` (Node 18 and 20 are both past end-of-life); older Node versions install via npm warning-only and then crash at runtime with a SyntaxError, so the doctor enforces the floor explicitly.";

/** Minimum Node major version the CLI supports. Mirrors `engines.node` in package.json. */
const MIN_NODE_MAJOR = 22;

/**
 * Classify `node --version` output. Node stdout for `--version` is the
 * version prefixed with `v`, e.g. "v22.11.0\n". We accept both forms
 * (with and without the leading `v`) for forward-compat.
 *
 * Returns `fail` (not just `warn`) when the major version is below
 * MIN_NODE_MAJOR, because a too-old Node will SyntaxError on the
 * `node22`-target output esbuild emits. A green doctor must mean
 * "ready to run", not "node is technically installed."
 */
export function classifyNodeVersion(stdout: string | null): CheckResult {
  if (stdout === null) {
    return {
      name: "node installed",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install node 22+: https://nodejs.org/ (or `nvm install --lts`)",
      why: WHY_NODE,
    };
  }
  const version = stdout.trim();
  const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return {
      name: "node installed",
      status: "warn",
      detail: `unexpected version output: ${version}`,
      fix: "Verify node is properly installed: node --version",
      why: WHY_NODE,
    };
  }
  const major = parseInt(match[1], 10);
  if (major < MIN_NODE_MAJOR) {
    return {
      name: "node installed",
      status: "fail",
      detail: `${version} (below required >=${MIN_NODE_MAJOR}.0.0)`,
      fix: `Upgrade node: nvm install ${MIN_NODE_MAJOR} && nvm use ${MIN_NODE_MAJOR}`,
      why: WHY_NODE,
    };
  }
  return { name: "node installed", status: "pass", detail: version, why: WHY_NODE };
}

const WHY_GH =
  "skilled-pr shells out to the GitHub CLI for every API call (status checks, PR comments, branch protection). Lets us reuse your gh auth instead of managing our own tokens.";

/**
 * Classify `gh --version` output. Output is multi-line:
 *   gh version 2.45.0 (2024-03-19)
 *   https://github.com/cli/cli/releases/tag/v2.45.0
 */
export function classifyGhVersion(stdout: string | null): CheckResult {
  if (stdout === null) {
    return {
      name: "gh installed",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install GitHub CLI: https://cli.github.com/",
      why: WHY_GH,
    };
  }
  const match = stdout.match(/gh version (\d+\.\d+\.\d+)/);
  if (!match) {
    return {
      name: "gh installed",
      status: "warn",
      detail: `unexpected version output: ${stdout.split("\n")[0]}`,
      fix: "Verify gh is properly installed: gh --version",
      why: WHY_GH,
    };
  }
  return { name: "gh installed", status: "pass", detail: match[1], why: WHY_GH };
}

/**
 * Classify `gh auth status` output. On success, gh prints lines like:
 *   ✓ Logged in to github.com account Demianeen (...)
 *   - Active account: true
 *
 * On failure, gh exits non-zero and prints to stderr.
 */
const WHY_GH_AUTH =
  "Without an active gh login, attest can't post to GitHub. The active account also determines write access — a read-only account gets 404 on writes (which look like 'Not Found' errors).";

export function classifyGhAuth(
  stdout: string | null,
  stderr: string | null,
  exitCode: number,
): CheckResult {
  if (exitCode !== 0 || (stdout === null && stderr === null)) {
    return {
      name: "gh authenticated",
      status: "fail",
      detail: "not signed in",
      fix: "gh auth login",
      why: WHY_GH_AUTH,
    };
  }
  // gh writes the auth status to stderr by default (because it's a status,
  // not data). Concatenate both streams to be tolerant.
  const combined = `${stdout ?? ""}\n${stderr ?? ""}`;
  // Look for the active account marker. Modern gh shows:
  //   "Active account: true" right after the username line, OR
  //   "✓ Logged in to github.com account <user>"
  const activeMatch = combined.match(/account\s+([A-Za-z0-9-]+)/);
  if (!activeMatch) {
    return {
      name: "gh authenticated",
      status: "warn",
      detail: "active account could not be parsed",
      fix: "gh auth status",
      why: WHY_GH_AUTH,
    };
  }
  return {
    name: "gh authenticated",
    status: "pass",
    detail: activeMatch[1],
    why: WHY_GH_AUTH,
  };
}

const WHY_REMOTE =
  "skilled-pr only works with GitHub remotes (origin must be a github.com URL). The owner/repo here is what status checks and PR comments target.";

/**
 * Classify the `git remote get-url origin` output via parseGitHubRemote.
 */
export function classifyGitHubRemote(remoteUrl: string | null): CheckResult {
  if (remoteUrl === null) {
    return {
      name: "GitHub remote",
      status: "fail",
      detail: "no `origin` remote configured",
      fix: "git remote add origin git@github.com:<owner>/<repo>.git",
      why: WHY_REMOTE,
    };
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (parsed === null) {
    return {
      name: "GitHub remote",
      status: "fail",
      detail: `origin is not a GitHub URL: ${remoteUrl.trim()}`,
      fix: "skilled-pr supports GitHub only for now",
      why: WHY_REMOTE,
    };
  }
  return {
    name: "GitHub remote",
    status: "pass",
    detail: `${parsed.owner}/${parsed.repo}`,
    why: WHY_REMOTE,
  };
}

const WHY_CONFIG =
  "Lists which review skills must run before merge (requiredSkills). Without it, the hook has no idea which skill invocations to attest, and the entire plug-and-play loop is silent.";

/**
 * Classify the presence + validity of `.skilledpr/config.jsonc`. Also
 * detects the legacy `.skilledpr.jsonc` at root and routes the user
 * toward migration. Takes a third argument indicating whether the
 * legacy file exists (so doctor's I/O wrapper can probe both paths and
 * keep this classifier pure).
 */
export function classifySkilledPRConfig(
  rawContent: string | null,
  legacyExists: boolean = false,
): CheckResult {
  if (legacyExists) {
    return {
      name: CONFIG_PATH,
      status: "fail",
      detail: `legacy ${LEGACY_CONFIG_PATH} detected at repo root`,
      fix: `Invoke \`/skilled-pr-update\` to migrate automatically, or run \`skilled-pr init\` to regenerate, or manually move ${LEGACY_CONFIG_PATH} to ${CONFIG_PATH} and add \`"schemaVersion": ${CURRENT_SCHEMA_VERSION}\`.`,
      why: WHY_CONFIG,
    };
  }
  if (rawContent === null) {
    return {
      name: CONFIG_PATH,
      status: "fail",
      detail: "not found",
      fix: "skilled-pr init",
      why: WHY_CONFIG,
    };
  }
  try {
    const config = parseConfig(rawContent);
    if (config.requiredSkills.length === 0) {
      return {
        name: CONFIG_PATH,
        status: "warn",
        detail: "requiredSkills is empty — hook will never inject reminders",
        fix: `Add at least one skill to requiredSkills in ${CONFIG_PATH}`,
        why: WHY_CONFIG,
      };
    }
    return {
      name: CONFIG_PATH,
      status: "pass",
      detail: `requiredSkills: ${JSON.stringify(config.requiredSkills)}`,
      why: WHY_CONFIG,
    };
  } catch (e) {
    return {
      name: CONFIG_PATH,
      status: "fail",
      detail: `parse error: ${(e as Error).message}`,
      fix: "Fix the syntax error or run `skilled-pr init` to regenerate",
      why: WHY_CONFIG,
    };
  }
}

// ---------------------------------------------------------------------------
// v1 additions: schemaVersion drift, bundled schema freshness, rules,
// referenced skills.
// ---------------------------------------------------------------------------

const WHY_SCHEMA_VERSION =
  "skilled-pr's config schema is versioned. If your config is newer than the CLI, you'll get parse errors at runtime; if it's older, you'll miss new fields that PR #2's migrator can add automatically. doctor catches drift in both directions.";

/**
 * Compare the loaded config's schemaVersion against the CLI's known
 * CURRENT_SCHEMA_VERSION. Bumps to a newer version (config > CLI)
 * fail; older versions warn (the parser may still accept it today,
 * but the user should migrate via `skilled-pr` to pick up new
 * defaults).
 */
export function classifySchemaVersion(config: SkilledPRConfig | null): CheckResult {
  if (config === null) {
    return { name: "schemaVersion", status: "skip", detail: "skipped — no config to check" };
  }
  if (config.schemaVersion === CURRENT_SCHEMA_VERSION) {
    return {
      name: "schemaVersion",
      status: "pass",
      detail: `v${config.schemaVersion} matches CLI`,
      why: WHY_SCHEMA_VERSION,
    };
  }
  if (config.schemaVersion > CURRENT_SCHEMA_VERSION) {
    return {
      name: "schemaVersion",
      status: "fail",
      detail: `config is v${config.schemaVersion} but CLI only supports v${CURRENT_SCHEMA_VERSION}`,
      fix: "Upgrade skilled-pr to a version that knows this schema",
      why: WHY_SCHEMA_VERSION,
    };
  }
  return {
    name: "schemaVersion",
    status: "warn",
    detail: `config is v${config.schemaVersion}, CLI is v${CURRENT_SCHEMA_VERSION}`,
    fix: "Run `/skilled-pr-update` to migrate, or `skilled-pr init` to regenerate.",
    why: WHY_SCHEMA_VERSION,
  };
}

const WHY_BUNDLED_SCHEMA =
  "The .skilledpr/schema.json in your repo provides editor autocompletion for .skilledpr/config.jsonc. If it drifts from the schema bundled with the installed CLI, hover hints and field validation in your editor will be out of date.";

/**
 * Compare the in-repo `.skilledpr/schema.json` against the schema
 * bundled with the installed CLI by SHA-256 hash. Pure: both inputs
 * are content strings.
 */
export function classifyBundledSchema(
  repoSchemaContent: string | null,
  packageSchemaContent: string | null,
): CheckResult {
  if (repoSchemaContent === null) {
    return {
      name: "bundled schema",
      status: "warn",
      detail: ".skilledpr/schema.json not found in repo",
      fix: "skilled-pr init  (idempotent; writes the schema)",
      why: WHY_BUNDLED_SCHEMA,
    };
  }
  if (packageSchemaContent === null) {
    return {
      name: "bundled schema",
      status: "warn",
      detail: "could not locate the CLI's bundled schema to compare against",
      fix: "Try reinstalling skilled-pr; the bundled schema/v1.json should ship with the package.",
      why: WHY_BUNDLED_SCHEMA,
    };
  }
  const repoHash = createHash("sha256").update(repoSchemaContent).digest("hex");
  const pkgHash = createHash("sha256").update(packageSchemaContent).digest("hex");
  if (repoHash === pkgHash) {
    return {
      name: "bundled schema",
      status: "pass",
      detail: "in-repo schema matches CLI bundle",
      why: WHY_BUNDLED_SCHEMA,
    };
  }
  return {
    name: "bundled schema",
    status: "warn",
    detail: "repo schema differs from CLI bundle (drift)",
    fix: "Re-run `skilled-pr init` to refresh .skilledpr/schema.json.",
    why: WHY_BUNDLED_SCHEMA,
  };
}

const WHY_RULES =
  "Each rule's branch glob must compile cleanly; author/labels must be the right shape. doctor catches malformed rules at setup time so the hook doesn't fail silently on every event in production.";

/**
 * Validate every rule's branch pattern (must compile as a regex after
 * glob -> regex translation) plus its author + labels shape. Returns
 * a single check covering all rules.
 */
export function classifyRulePatterns(rules: Rule[]): CheckResult {
  if (rules.length === 0) {
    return {
      name: "rule patterns",
      status: "pass",
      detail: "no rules configured",
      why: WHY_RULES,
    };
  }
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    for (let j = 0; j < rule.match.length; j++) {
      const block = rule.match[j];
      if (block.branch !== undefined) {
        try {
          // Glob -> regex via the same translation resolve.ts uses,
          // inlined here to avoid a cycle (doctor doesn't depend on
          // resolve; resolve doesn't depend on doctor).
          const escaped = block.branch
            .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
            .replace(/\*/g, ".*");
          new RegExp(`^${escaped}$`);
        } catch (e) {
          return {
            name: "rule patterns",
            status: "fail",
            detail: `rules[${i}].match[${j}].branch is not a valid pattern: ${(e as Error).message}`,
            fix: "Fix the pattern in .skilledpr/config.jsonc; supported syntax is plain strings with `*` wildcards.",
            why: WHY_RULES,
          };
        }
      }
      if (block.author !== undefined && block.author.trim().length === 0) {
        return {
          name: "rule patterns",
          status: "fail",
          detail: `rules[${i}].match[${j}].author is empty`,
          fix: "Remove the author key or set it to an actual login.",
          why: WHY_RULES,
        };
      }
      if (block.labels !== undefined) {
        // Trim + dedupe check; warn on empty entries but don't fail.
        const empty = block.labels.findIndex((l) => l.trim().length === 0);
        if (empty !== -1) {
          return {
            name: "rule patterns",
            status: "fail",
            detail: `rules[${i}].match[${j}].labels[${empty}] is empty`,
            fix: "Remove empty entries from the labels array.",
            why: WHY_RULES,
          };
        }
      }
    }
  }
  return {
    name: "rule patterns",
    status: "pass",
    detail: `${rules.length} rule(s) compile cleanly`,
    why: WHY_RULES,
  };
}

const WHY_REFERENCED_SKILLS =
  "Skill names in requiredSkills / rules.requiredSkills should correspond to actual skill directories the harness can find. A typo (e.g. `gstack:reviw`) means the hook never matches and the gate silently doesn't enforce that review.";

/**
 * Warn (not fail) when a skill name in requiredSkills isn't found as a
 * subdirectory in either the Claude skills dir or the Codex skills
 * dir. Receiving lists of directory contents (not paths) keeps the
 * classifier pure.
 */
export function classifyReferencedSkills(
  rules: Rule[],
  requiredSkills: string[],
  claudeSkillNames: string[] | null,
  codexSkillNames: string[] | null,
): CheckResult {
  // Build the full set of referenced skill names.
  const referenced = new Set<string>(requiredSkills);
  for (const rule of rules) {
    if (rule.requiredSkills) {
      for (const s of rule.requiredSkills) referenced.add(s);
    }
  }
  if (referenced.size === 0) {
    return {
      name: "referenced skills",
      status: "skip",
      detail: "no skills to check (requiredSkills empty in config + all rules)",
    };
  }
  if (claudeSkillNames === null && codexSkillNames === null) {
    return {
      name: "referenced skills",
      status: "skip",
      detail: "skipped — no .claude/skills or .codex/skills directory found",
    };
  }
  // For each referenced skill, check whether it exists under EITHER
  // harness's skills dir. The first segment before `:` is the
  // namespace; we match against the bare name too because skills can
  // be installed without a namespace prefix.
  const known = new Set<string>([
    ...(claudeSkillNames ?? []),
    ...(codexSkillNames ?? []),
  ]);
  const missing: string[] = [];
  for (const name of referenced) {
    const bare = name.includes(":") ? name.split(":").pop()! : name;
    if (!known.has(name) && !known.has(bare)) {
      missing.push(name);
    }
  }
  if (missing.length === 0) {
    return {
      name: "referenced skills",
      status: "pass",
      detail: `${referenced.size} skill(s) all resolve to a skills directory`,
      why: WHY_REFERENCED_SKILLS,
    };
  }
  return {
    name: "referenced skills",
    status: "warn",
    detail: `skills not found in any harness: ${missing.join(", ")}`,
    fix: "Check for typos; install the missing skill(s); or remove from requiredSkills.",
    why: WHY_REFERENCED_SKILLS,
  };
}

const WHY_HOOKS =
  "PostToolUse matcher 'Skill' catches when Claude autonomously invokes a review skill (the most common path in agentic workflows). UserPromptExpansion catches when you type /skillname directly — that goes through a different event entirely. Without both, the slash-command path silently bypasses attestation and PRs can ship without review.";

const WHY_ON_PUSH_BASH_HOOK =
  "`autoReview.trigger=on-push` depends on Claude Code's PostToolUse:Bash hook. Existing installs may already have the normal PostToolUse:Skill hook, but that does not fire after `git push`; users must re-run init after enabling on-push so the Bash matcher is installed too.";

/**
 * Classify whether .claude/settings.json has skilled-pr's hooks installed.
 * Looks for the canonical "skilled-pr hook" command under both PostToolUse
 * and UserPromptExpansion.
 */
export function classifyClaudeHooks(rawContent: string | null): CheckResult {
  if (rawContent === null) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: ".claude/settings.json not found",
      fix: "skilled-pr init",
      why: WHY_HOOKS,
    };
  }
  // jsonc-parser does error-recovery (returns best-effort parse) instead of
  // throwing — so we have to pass an errors array and check it ourselves.
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(rawContent, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: ".claude/settings.json is not valid JSON",
      fix: "Fix the syntax error or run `skilled-pr init` to merge our hooks in",
      why: WHY_HOOKS,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: ".claude/settings.json top-level is not an object",
      fix: "Fix the file shape or run `skilled-pr init`",
      why: WHY_HOOKS,
    };
  }
  const settings = parsed as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> };
  const hooks = settings.hooks;
  if (!hooks || typeof hooks !== "object") {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: "no hooks block in .claude/settings.json",
      fix: "skilled-pr init",
      why: WHY_HOOKS,
    };
  }

  const hasSkilledPrHook = (eventName: string, matcher: string): boolean => {
    const entries = hooks[eventName];
    if (!Array.isArray(entries)) return false;
    return entries.some(
      (e) =>
        (e.matcher ?? "") === matcher &&
        Array.isArray(e.hooks) &&
        e.hooks.some((h) => h.command === "skilled-pr hook"),
    );
  };

  const postToolUse = hasSkilledPrHook("PostToolUse", "Skill");
  const userPrompt = hasSkilledPrHook("UserPromptExpansion", "");

  if (postToolUse && userPrompt) {
    return {
      name: "Claude Code hooks",
      status: "pass",
      detail: "PostToolUse + UserPromptExpansion installed",
      why: WHY_HOOKS,
    };
  }
  if (!postToolUse && !userPrompt) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: "neither hook is installed",
      fix: "skilled-pr init",
      why: WHY_HOOKS,
    };
  }
  // Partial install — one but not the other. Real users can hit this if
  // they edited settings manually.
  const missing = [postToolUse ? null : "PostToolUse:Skill", userPrompt ? null : "UserPromptExpansion"]
    .filter(Boolean)
    .join(" + ");
  return {
    name: "Claude Code hooks",
    status: "warn",
    detail: `missing: ${missing} (some review invocation paths won't trigger attestation)`,
    fix: "skilled-pr init  (idempotent, will add the missing hook)",
    why: WHY_HOOKS,
  };
}

/**
 * Classify the optional Claude Bash hook needed by
 * `autoReview.trigger=on-push`. Only call this when the parsed config's
 * trigger is already `on-push`; manual projects should not see this check.
 */
export function classifyOnPushBashHook(rawContent: string | null): CheckResult {
  if (rawContent === null) {
    return {
      name: "on-push Bash hook",
      status: "warn",
      detail: "autoReview.trigger=on-push but .claude/settings.json not found",
      fix: "skilled-pr init --for claude",
      why: WHY_ON_PUSH_BASH_HOOK,
    };
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(rawContent, errors, { allowTrailingComma: true });
  if (errors.length > 0 || parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      name: "on-push Bash hook",
      status: "fail",
      detail: "could not inspect .claude/settings.json for PostToolUse:Bash",
      fix: "Fix .claude/settings.json syntax or run `skilled-pr init --for claude`",
      why: WHY_ON_PUSH_BASH_HOOK,
    };
  }
  const settings = parsed as { hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>> };
  const entries = settings.hooks?.PostToolUse;
  const hasBashHook =
    Array.isArray(entries) &&
    entries.some(
      (e) =>
        (e.matcher ?? "") === "Bash" &&
        Array.isArray(e.hooks) &&
        e.hooks.some((h) => h.command === "skilled-pr hook"),
    );
  if (hasBashHook) {
    return {
      name: "on-push Bash hook",
      status: "pass",
      detail: "PostToolUse:Bash installed",
      why: WHY_ON_PUSH_BASH_HOOK,
    };
  }
  return {
    name: "on-push Bash hook",
    status: "warn",
    detail: "autoReview.trigger=on-push but PostToolUse:Bash is not installed",
    fix: "skilled-pr init --for claude  (idempotent, adds the Bash matcher)",
    why: WHY_ON_PUSH_BASH_HOOK,
  };
}

const WHY_CODEX =
  "Codex's `.codex/hooks.json` only fires when Codex itself is on PATH; without the binary, the hook config is inert and `/review` (or any skill that should attest) silently does nothing. doctor only nags about codex when this repo has a `.codex/` directory; if you don't use Codex, this check is skipped.";

/**
 * Classify `codex --version` output. Output format is not strictly
 * standardised (different Codex builds print different things), so we
 * accept any non-empty stdout as "installed" and report it verbatim
 * instead of parsing for a specific version pattern.
 *
 * Only invoked by the orchestrator when `.codex/` exists in the repo;
 * users who don't run Codex never see this check.
 */
export function classifyCodexVersion(stdout: string | null): CheckResult {
  if (stdout === null) {
    return {
      name: "codex installed",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install Codex CLI (e.g. `npm install -g @openai/codex`) or remove `.codex/` if you don't use Codex",
      why: WHY_CODEX,
    };
  }
  const firstLine = stdout.trim().split("\n")[0];
  if (!firstLine) {
    return {
      name: "codex installed",
      status: "warn",
      detail: "empty version output",
      fix: "Verify codex is working: codex --version",
      why: WHY_CODEX,
    };
  }
  return { name: "codex installed", status: "pass", detail: firstLine, why: WHY_CODEX };
}

const WHY_CODEX_HOOKS =
  "Codex skills load via progressive disclosure (no Skill tool to match on), so skilled-pr hooks the UserPromptSubmit event instead. When you type a /skill-name, the hook checks it against requiredSkills and injects the attestation reminder. Without this hook, the gate cannot enforce reviews in Codex sessions.";

/**
 * Classify whether .codex/hooks.json has skilled-pr's UserPromptSubmit hook.
 * Mirrors classifyClaudeHooks but for Codex's flatter schema.
 */
export function classifyCodexHooks(rawContent: string | null): CheckResult {
  if (rawContent === null) {
    return {
      name: "Codex hooks",
      status: "fail",
      detail: ".codex/hooks.json not found",
      fix: "skilled-pr init --for codex  (or just `skilled-pr init` if .codex/ exists)",
      why: WHY_CODEX_HOOKS,
    };
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(rawContent, errors, { allowTrailingComma: true });
  if (errors.length > 0) {
    return {
      name: "Codex hooks",
      status: "fail",
      detail: ".codex/hooks.json is not valid JSON",
      fix: "Fix the syntax error or re-run `skilled-pr init --for codex`",
      why: WHY_CODEX_HOOKS,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      name: "Codex hooks",
      status: "fail",
      detail: ".codex/hooks.json top-level is not an object",
      fix: "Fix the file shape or re-run `skilled-pr init --for codex`",
      why: WHY_CODEX_HOOKS,
    };
  }
  const settings = parsed as { hooks?: Array<{ event?: string; command?: string }> };
  const hooks = settings.hooks;
  if (!Array.isArray(hooks)) {
    return {
      name: "Codex hooks",
      status: "fail",
      detail: "no hooks array in .codex/hooks.json",
      fix: "skilled-pr init --for codex",
      why: WHY_CODEX_HOOKS,
    };
  }
  const hasOurHook = hooks.some(
    (h) => h?.event === "UserPromptSubmit" && h?.command === "skilled-pr hook",
  );
  if (hasOurHook) {
    return {
      name: "Codex hooks",
      status: "pass",
      detail: "UserPromptSubmit installed",
      why: WHY_CODEX_HOOKS,
    };
  }
  return {
    name: "Codex hooks",
    status: "fail",
    detail: "skilled-pr UserPromptSubmit hook not found",
    fix: "skilled-pr init --for codex  (idempotent)",
    why: WHY_CODEX_HOOKS,
  };
}

const WHY_BRANCH_PROTECTION =
  "GitHub status checks post on every attest, but only branch protection actually GATES the merge button. Without 'Skilled PR' in required checks, the green check is decorative — PRs can merge with failing reviews. `skilled-pr enable-gate` automates this.";

/**
 * Classify a `gh api repos/.../branches/<branch>/protection` response. The
 * branch is protected if the response includes a `required_status_checks`
 * block, AND that block lists any context starting with the project's
 * statusName (e.g. "Skilled PR / review").
 */
export function classifyBranchProtection(
  apiResponse: string | null,
  exitCode: number,
  statusName: string,
): CheckResult {
  if (exitCode !== 0 || apiResponse === null) {
    // The api call fails with 404 when branch protection isn't enabled at
    // all — that's not necessarily "fail," just "not configured." Use warn
    // so the doctor output flags it but doesn't block.
    return {
      name: "Branch protection",
      status: "warn",
      detail: "no protection rules on default branch",
      fix: "skilled-pr enable-gate",
      why: WHY_BRANCH_PROTECTION,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(apiResponse);
  } catch {
    return {
      name: "Branch protection",
      status: "warn",
      detail: "could not parse gh api response",
      fix: "gh api repos/<owner>/<repo>/branches/<branch>/protection",
      why: WHY_BRANCH_PROTECTION,
    };
  }
  const required =
    (parsed as { required_status_checks?: { contexts?: string[] } }).required_status_checks
      ?.contexts ?? [];
  const skilledChecks = required.filter((c) => c.startsWith(`${statusName} /`));
  if (skilledChecks.length === 0) {
    return {
      name: "Branch protection",
      status: "warn",
      detail: `protection exists but no required check matches "${statusName} / *"`,
      fix: "skilled-pr enable-gate",
      why: WHY_BRANCH_PROTECTION,
    };
  }
  return {
    name: "Branch protection",
    status: "pass",
    detail: `${skilledChecks.length} required check(s): ${skilledChecks.join(", ")}`,
    why: WHY_BRANCH_PROTECTION,
  };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const ICON: Record<CheckStatus, string> = {
  pass: "✓",
  warn: "⚠",
  fail: "✗",
  skip: "·",
};

const COLOR: Record<CheckStatus, string> = {
  pass: "\x1b[32m", // green
  warn: "\x1b[33m", // yellow
  fail: "\x1b[31m", // red
  skip: "\x1b[90m", // gray
};
const RESET = "\x1b[0m";

/**
 * Format a single check as one to three output lines:
 *   - the check headline (icon + name + detail)
 *   - the fix line (if status is warn/fail and a fix is set)
 *   - the why line (if verbose=true and a why is set), wrapped at ~72 cols
 *     for readable terminal output.
 */
export function formatCheck(
  result: CheckResult,
  useColor = true,
  verbose = false,
): string {
  const icon = useColor ? `${COLOR[result.status]}${ICON[result.status]}${RESET}` : ICON[result.status];
  // Pad the name column for alignment. 22 chars matches our longest name
  // ("Claude Code hooks" = 17, ".skilledpr.jsonc" = 16, plus buffer).
  const name = result.name.padEnd(22, " ");
  const lines = [`${icon} ${name} ${result.detail}`];
  if (result.fix && (result.status === "warn" || result.status === "fail")) {
    lines.push(`  Fix: ${result.fix}`);
  }
  if (verbose && result.why) {
    lines.push(`  Why: ${wrap(result.why, 72, "       ")}`);
  }
  return lines.join("\n");
}

/**
 * Word-wrap `text` at `width` columns, indenting continuation lines with
 * `indent`. Used for the `Why:` paragraph so long explanations stay readable.
 */
function wrap(text: string, width: number, indent: string): string {
  const words = text.split(/\s+/);
  const out: string[] = [];
  let line = "";
  for (const word of words) {
    if (line.length === 0) {
      line = word;
    } else if (line.length + 1 + word.length <= width) {
      line += " " + word;
    } else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  return out.join("\n" + indent);
}

/**
 * Compose the full doctor output. Includes a one-line summary at the end.
 * When verbose=false, also appends a tip mentioning the --why flag so users
 * discover the option without reading --help.
 */
export function formatDoctorReport(
  results: CheckResult[],
  useColor = true,
  verbose = false,
): string {
  const lines = results.map((r) => formatCheck(r, useColor, verbose));
  const pass = results.filter((r) => r.status === "pass").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;
  lines.push("");
  if (fail === 0 && warn === 0) {
    lines.push(`All checks passed (${pass}/${results.length}).`);
  } else {
    lines.push(`${pass}/${results.length} pass, ${warn} warn, ${fail} fail.`);
  }
  if (!verbose) {
    lines.push("");
    lines.push("Tip: run `skilled-pr doctor --why` to see what each check is for.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// I/O entry point
// ---------------------------------------------------------------------------

/**
 * Run a command, return stdout (or null on failure). Thin null-on-fail
 * adapter over the shared `run()` in ./proc - the classify* functions take
 * a nullable stdout string, so we collapse "non-zero exit" and "spawn
 * failed" into the same `stdout: null` shape they expect.
 */
function tryRun(args: string[]): { stdout: string | null; stderr: string | null; exitCode: number } {
  const r = run(args);
  return {
    stdout: r.exitCode === 0 ? r.stdout : null,
    stderr: r.stderr === "" ? null : r.stderr,
    exitCode: r.exitCode,
  };
}

async function readFileOrNull(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

/**
 * List subdirectory names under `path`, or null if the directory
 * itself doesn't exist. Used to enumerate installed skills under
 * `.claude/skills/` and `.codex/skills/`.
 */
function listSubdirsOrNull(path: string): string[] | null {
  if (!existsSync(path)) return null;
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
}

/**
 * Locate the CLI's own bundled `schema/v1.json` so doctor can compare
 * it against the in-repo `.skilledpr/schema.json`. Returns the file's
 * content as a string, or null if it can't be located.
 */
async function readBundledSchema(): Promise<string | null> {
  // tsx dev mode vs tsup-built mode: the file's location relative to
  // process.argv[1] differs. We probe a couple of conventional
  // candidates and use the first that exists.
  const { fileURLToPath } = await import("node:url");
  const { dirname, resolve: resolvePath } = await import("node:path");
  let here: string;
  try {
    here = dirname(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
  for (const candidate of [
    resolvePath(here, "..", "schema", "v1.json"),
    resolvePath(here, "schema", "v1.json"),
    resolvePath(here, "..", "..", "schema", "v1.json"),
  ]) {
    if (existsSync(candidate)) {
      try {
        return readFileSync(candidate, "utf8");
      } catch {
        // fall through
      }
    }
  }
  return null;
}

export async function doctor(args: string[] = []) {
  // --why / --verbose / -v all enable the educational "Why this matters"
  // line under each check. Without any of them, the output stays compact
  // and the report footer mentions the flag so users discover it.
  const verbose = args.includes("--why") || args.includes("--verbose") || args.includes("-v");

  const results: CheckResult[] = [];

  // 1. node
  const nodeResult = tryRun(["node", "--version"]);
  results.push(classifyNodeVersion(nodeResult.stdout));

  // 2. gh installed
  const ghResult = tryRun(["gh", "--version"]);
  results.push(classifyGhVersion(ghResult.stdout));

  // 3. gh auth (only meaningful if gh is installed)
  if (ghResult.stdout !== null) {
    const authResult = tryRun(["gh", "auth", "status"]);
    results.push(classifyGhAuth(authResult.stdout, authResult.stderr, authResult.exitCode));
  } else {
    results.push({
      name: "gh authenticated",
      status: "skip",
      detail: "skipped — gh not installed",
    });
  }

  // 4. GitHub remote
  const remoteResult = tryRun(["git", "remote", "get-url", "origin"]);
  const remoteResultCheck = classifyGitHubRemote(remoteResult.stdout);
  results.push(remoteResultCheck);

  // 5. .skilledpr/config.jsonc
  const config = await readFileOrNull(CONFIG_PATH);
  const legacyExists = existsSync(LEGACY_CONFIG_PATH);
  const configCheck = classifySkilledPRConfig(config, legacyExists);
  results.push(configCheck);

  // 5b. v1 schema-related checks. parsedConfig is null when the config
  //     failed to parse or doesn't exist; the schemaVersion check
  //     skips in that case.
  let parsedConfig: SkilledPRConfig | null = null;
  if (config !== null && !legacyExists) {
    try {
      parsedConfig = parseConfig(config);
    } catch {
      // parseConfig failures are surfaced by classifySkilledPRConfig
      // above; here we just skip the dependent checks.
    }
  }
  results.push(classifySchemaVersion(parsedConfig));

  // 5c. Bundled schema freshness (repo vs CLI bundle).
  const repoSchema = await readFileOrNull(".skilledpr/schema.json");
  const bundledSchema = await readBundledSchema();
  results.push(classifyBundledSchema(repoSchema, bundledSchema));

  // 5d. Rule pattern validity.
  if (parsedConfig !== null) {
    results.push(classifyRulePatterns(parsedConfig.rules));
  } else {
    results.push({
      name: "rule patterns",
      status: "skip",
      detail: "skipped — config did not parse",
    });
  }

  // 5e. Referenced skills exist somewhere.
  if (parsedConfig !== null) {
    const claudeSkillNames = listSubdirsOrNull(".claude/skills");
    const codexSkillNames = listSubdirsOrNull(".codex/skills");
    results.push(
      classifyReferencedSkills(
        parsedConfig.rules,
        parsedConfig.requiredSkills,
        claudeSkillNames,
        codexSkillNames,
      ),
    );
  } else {
    results.push({
      name: "referenced skills",
      status: "skip",
      detail: "skipped — config did not parse",
    });
  }

  // 6. Harness hooks: Claude Code, Codex, or both.
  //    Policy: always emit one line per harness's hook config, even when
  //    that harness isn't set up in this repo. Silent skipping leaves the
  //    user unable to distinguish "I don't use this harness" from "doctor
  //    has a bug" or "this version doesn't check that harness." The skip
  //    status (with a fix hint) signals "we know how to check this, but
  //    you don't appear to use it; here's what to do if you do."
  //
  //    The binary checks (codex installed, etc.) stay conditional on the
  //    dir existing - no value in reporting whether `codex` is on PATH for
  //    a user who only runs Claude Code, and vice versa.
  //
  //    Back-compat: when NEITHER .claude/ nor .codex/ exists, default to
  //    actually running the Claude hooks check (preserves the historical
  //    "run init" message first-time users got before Codex existed).
  const claudePresent = existsSync(".claude");
  const codexPresent = existsSync(".codex");
  const shouldCheckOnPushBashHook = parsedConfig?.autoReview.trigger === "on-push";
  if (claudePresent) {
    const settings = await readFileOrNull(".claude/settings.json");
    results.push(classifyClaudeHooks(settings));
    if (shouldCheckOnPushBashHook) {
      results.push(classifyOnPushBashHook(settings));
    }
  } else if (codexPresent) {
    // Codex-only repo: report Claude as skipped instead of failing.
    results.push({
      name: "Claude Code hooks",
      status: "skip",
      detail: "no .claude/ in this repo (Claude Code is optional)",
      fix: "If you use Claude Code: skilled-pr init --for claude",
      why: WHY_HOOKS,
    });
    if (shouldCheckOnPushBashHook) {
      results.push({
        name: "on-push Bash hook",
        status: "warn",
        detail: "autoReview.trigger=on-push is Claude Code only; Codex has no PostToolUse:Bash event",
        fix: "For Codex-only repos, set autoReview.trigger to manual. If you also use Claude Code, run skilled-pr init --for claude.",
        why: WHY_ON_PUSH_BASH_HOOK,
      });
    }
  } else {
    // Neither harness present: back-compat default for first-time users.
    const settings = await readFileOrNull(".claude/settings.json");
    results.push(classifyClaudeHooks(settings));
    if (shouldCheckOnPushBashHook) {
      results.push(classifyOnPushBashHook(settings));
    }
  }
  if (codexPresent) {
    // Run the binary check before the hooks check so failure order matches
    // the dependency direction: if codex isn't installed, the hook config
    // never fires regardless of its contents.
    const codexVersion = tryRun(["codex", "--version"]);
    results.push(classifyCodexVersion(codexVersion.stdout));

    const codexSettings = await readFileOrNull(".codex/hooks.json");
    results.push(classifyCodexHooks(codexSettings));
  } else {
    // Codex isn't set up here. Surface a skip line so the user knows we
    // would check it; the fix hint nudges them toward init if they DO
    // want Codex coverage.
    results.push({
      name: "Codex hooks",
      status: "skip",
      detail: "no .codex/ in this repo (Codex is optional)",
      fix: "If you use Codex: skilled-pr init --for codex",
      why: WHY_CODEX_HOOKS,
    });
  }

  // 7. Branch protection (only if we have a GitHub remote AND gh is authed)
  if (
    remoteResultCheck.status === "pass" &&
    results.find((r) => r.name === "gh authenticated")?.status === "pass"
  ) {
    const remote = parseGitHubRemote(remoteResult.stdout!) as GitHubRemote;
    // Detect default branch (best-effort).
    const defaultBranch = tryRun([
      "gh",
      "repo",
      "view",
      "--json",
      "defaultBranchRef",
      "-q",
      ".defaultBranchRef.name",
    ]).stdout?.trim() ?? "main";

    const statusName = parsedConfig?.statusName ?? "Skilled PR";

    const protectionResult = tryRun([
      "gh",
      "api",
      `repos/${remote.owner}/${remote.repo}/branches/${defaultBranch}/protection`,
    ]);
    results.push(
      classifyBranchProtection(
        protectionResult.stdout,
        protectionResult.exitCode,
        statusName,
      ),
    );
  } else {
    results.push({
      name: "Branch protection",
      status: "skip",
      detail: "skipped — needs GitHub remote + gh auth",
    });
  }

  const useColor = process.env.NO_COLOR === undefined && process.stdout.isTTY === true;
  console.log(formatDoctorReport(results, useColor, verbose));

  // Exit non-zero if any check failed (warns are OK — they're advisory).
  const anyFail = results.some((r) => r.status === "fail");
  if (anyFail) process.exit(1);
}
