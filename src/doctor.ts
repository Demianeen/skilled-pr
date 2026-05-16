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
}

// ---------------------------------------------------------------------------
// Pure classifiers
// ---------------------------------------------------------------------------

/**
 * Classify `bun --version` output. Bun stdout for `--version` is just the
 * version number with a trailing newline, e.g. "1.3.10\n".
 */
export function classifyBunVersion(stdout: string | null): CheckResult {
  if (stdout === null) {
    return {
      name: "bun installed",
      status: "fail",
      detail: "not found on PATH",
      fix: "Install bun: curl -fsSL https://bun.sh/install | bash",
    };
  }
  const version = stdout.trim();
  if (!/^\d+\.\d+\.\d+/.test(version)) {
    return {
      name: "bun installed",
      status: "warn",
      detail: `unexpected version output: ${version}`,
      fix: "Verify bun is properly installed: bun --version",
    };
  }
  return { name: "bun installed", status: "pass", detail: version };
}

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
    };
  }
  const match = stdout.match(/gh version (\d+\.\d+\.\d+)/);
  if (!match) {
    return {
      name: "gh installed",
      status: "warn",
      detail: `unexpected version output: ${stdout.split("\n")[0]}`,
      fix: "Verify gh is properly installed: gh --version",
    };
  }
  return { name: "gh installed", status: "pass", detail: match[1] };
}

/**
 * Classify `gh auth status` output. On success, gh prints lines like:
 *   ✓ Logged in to github.com account Demianeen (...)
 *   - Active account: true
 *
 * On failure, gh exits non-zero and prints to stderr.
 */
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
    };
  }
  return { name: "gh authenticated", status: "pass", detail: activeMatch[1] };
}

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
    };
  }
  const parsed = parseGitHubRemote(remoteUrl);
  if (parsed === null) {
    return {
      name: "GitHub remote",
      status: "fail",
      detail: `origin is not a GitHub URL: ${remoteUrl.trim()}`,
      fix: "skilled-pr supports GitHub only for now",
    };
  }
  return {
    name: "GitHub remote",
    status: "pass",
    detail: `${parsed.owner}/${parsed.repo}`,
  };
}

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
      };
    }
    return {
      name: ".skilledpr.jsonc",
      status: "pass",
      detail: `requiredSkills: ${JSON.stringify(config.requiredSkills)}`,
    };
  } catch (e) {
    return {
      name: ".skilledpr.jsonc",
      status: "fail",
      detail: `parse error: ${(e as Error).message}`,
      fix: "Fix the syntax error or run `skilled-pr init` to regenerate",
    };
  }
}

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
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: ".claude/settings.json top-level is not an object",
      fix: "Fix the file shape or run `skilled-pr init`",
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
    };
  }
  if (!postToolUse && !userPrompt) {
    return {
      name: "Claude Code hooks",
      status: "fail",
      detail: "neither hook is installed",
      fix: "skilled-pr init",
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
  };
}

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
      fix: "skilled-pr enable-gate  (coming soon — see README for manual steps)",
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
      fix: "Add the Skilled PR check via Settings → Branches → Branch protection rules",
    };
  }
  return {
    name: "Branch protection",
    status: "pass",
    detail: `${skilledChecks.length} required check(s): ${skilledChecks.join(", ")}`,
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
 * Format a single check as one or two output lines (the fix line is
 * indented under the check line when present).
 */
export function formatCheck(result: CheckResult, useColor = true): string {
  const icon = useColor ? `${COLOR[result.status]}${ICON[result.status]}${RESET}` : ICON[result.status];
  // Pad the name column for alignment. 22 chars matches our longest name
  // ("Claude Code hooks" = 17, ".skilledpr.jsonc" = 16, plus buffer).
  const name = result.name.padEnd(22, " ");
  const head = `${icon} ${name} ${result.detail}`;
  if (result.fix && (result.status === "warn" || result.status === "fail")) {
    return `${head}\n  Fix: ${result.fix}`;
  }
  return head;
}

/**
 * Compose the full doctor output. Includes a one-line summary at the end.
 */
export function formatDoctorReport(results: CheckResult[], useColor = true): string {
  const lines = results.map((r) => formatCheck(r, useColor));
  const pass = results.filter((r) => r.status === "pass").length;
  const warn = results.filter((r) => r.status === "warn").length;
  const fail = results.filter((r) => r.status === "fail").length;
  lines.push("");
  if (fail === 0 && warn === 0) {
    lines.push(`All checks passed (${pass}/${results.length}).`);
  } else {
    lines.push(`${pass}/${results.length} pass, ${warn} warn, ${fail} fail.`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// I/O entry point
// ---------------------------------------------------------------------------

/** Run a command, return stdout (or null if exit != 0 / binary not found). */
function tryRun(args: string[]): { stdout: string | null; stderr: string | null; exitCode: number } {
  try {
    const proc = Bun.spawnSync(args, { stderr: "pipe" });
    return {
      stdout: proc.exitCode === 0 ? proc.stdout.toString() : null,
      stderr: proc.stderr.toString(),
      exitCode: proc.exitCode,
    };
  } catch {
    return { stdout: null, stderr: null, exitCode: -1 };
  }
}

async function readFileOrNull(path: string): Promise<string | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  return file.text();
}

export async function doctor() {
  const results: CheckResult[] = [];

  // 1. bun
  const bunResult = tryRun(["bun", "--version"]);
  results.push(classifyBunVersion(bunResult.stdout));

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

  const useColor = Bun.env.NO_COLOR === undefined && process.stdout.isTTY !== false;
  console.log(formatDoctorReport(results, useColor));

  // Exit non-zero if any check failed (warns are OK — they're advisory).
  const anyFail = results.some((r) => r.status === "fail");
  if (anyFail) process.exit(1);
}
