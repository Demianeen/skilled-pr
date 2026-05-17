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

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parseGitHubRemote, type GitHubRemote } from "./github";
import { parseConfig } from "./config";

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
 * Classify the presence + validity of .skilledpr.jsonc.
 */
export function classifySkilledPRConfig(rawContent: string | null): CheckResult {
  if (rawContent === null) {
    return {
      name: ".skilledpr.jsonc",
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
        name: ".skilledpr.jsonc",
        status: "warn",
        detail: "requiredSkills is empty — hook will never inject reminders",
        fix: "Add at least one skill to requiredSkills in .skilledpr.jsonc",
        why: WHY_CONFIG,
      };
    }
    return {
      name: ".skilledpr.jsonc",
      status: "pass",
      detail: `requiredSkills: ${JSON.stringify(config.requiredSkills)}`,
      why: WHY_CONFIG,
    };
  } catch (e) {
    return {
      name: ".skilledpr.jsonc",
      status: "fail",
      detail: `parse error: ${(e as Error).message}`,
      fix: "Fix the syntax error or run `skilled-pr init` to regenerate",
      why: WHY_CONFIG,
    };
  }
}

const WHY_HOOKS =
  "PostToolUse matcher 'Skill' catches when Claude autonomously invokes a review skill (the most common path in agentic workflows). UserPromptExpansion catches when you type /skillname directly — that goes through a different event entirely. Without both, the slash-command path silently bypasses attestation and PRs can ship without review.";

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
  const settings = parsed as { hooks?: Record<string, Array<{ hooks?: Array<{ command?: string }> }>> };
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

  const hasSkilledPrHook = (eventName: string): boolean => {
    const entries = hooks[eventName];
    if (!Array.isArray(entries)) return false;
    return entries.some(
      (e) => Array.isArray(e.hooks) && e.hooks.some((h) => h.command === "skilled-pr hook"),
    );
  };

  const postToolUse = hasSkilledPrHook("PostToolUse");
  const userPrompt = hasSkilledPrHook("UserPromptExpansion");

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
  const missing = [postToolUse ? null : "PostToolUse", userPrompt ? null : "UserPromptExpansion"]
    .filter(Boolean)
    .join(" + ");
  return {
    name: "Claude Code hooks",
    status: "warn",
    detail: `missing: ${missing} (slash-command path won't trigger attestation)`,
    fix: "skilled-pr init  (idempotent, will add the missing hook)",
    why: WHY_HOOKS,
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

/** Run a command, return stdout (or null if exit != 0 / binary not found). */
function tryRun(args: string[]): { stdout: string | null; stderr: string | null; exitCode: number } {
  try {
    // Node's spawnSync separates command and args; status is `null` when the
    // process was killed by a signal - treat that as -1. encoding:"utf8"
    // gives us string stdout/stderr instead of Buffers.
    const proc = spawnSync(args[0], args.slice(1), { encoding: "utf8" });
    // ENOENT (binary not found) doesn't throw — it sets `error` and leaves
    // status as null. Treat any null status as "couldn't run."
    if (proc.error || proc.status === null) {
      return { stdout: null, stderr: proc.stderr ?? null, exitCode: -1 };
    }
    return {
      stdout: proc.status === 0 ? (proc.stdout ?? "") : null,
      stderr: proc.stderr ?? "",
      exitCode: proc.status,
    };
  } catch {
    return { stdout: null, stderr: null, exitCode: -1 };
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
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

  // 5. .skilledpr.jsonc
  const config = await readFileOrNull(".skilledpr.jsonc");
  const configCheck = classifySkilledPRConfig(config);
  results.push(configCheck);

  // 6. Claude Code hooks
  const settings = await readFileOrNull(".claude/settings.json");
  results.push(classifyClaudeHooks(settings));

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

    const statusName =
      configCheck.status === "pass" && config !== null
        ? parseConfig(config).statusName
        : "Skilled PR";

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
