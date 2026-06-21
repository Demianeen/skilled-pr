// skilled-pr PostToolUse:Bash hook handler
//
// Fires when the agent runs a bash command via the Bash tool. We only
// care about `git push` invocations — that's the signal that lets the
// `autoReview.trigger=on-push` setting trigger a review reminder.
//
// What we deliberately don't try to do:
//   - Block the push (PostToolUse fires AFTER the command runs)
//   - Parse the bash command into a perfect AST
//   - Distinguish force-push, branch deletion, mirror push (the agent's
//     `skipPolicy: "agent-decides"` reasoning handles the nuance)
//
// Codex has no direct PostToolUse:Bash equivalent. The on-push trigger
// is Claude Code only; Codex users continue with manual skill invocation.

import { loadConfig } from "./config";
import { getCurrentPRContext, resolveProfile } from "./resolve";

// Operators and syntax that compose multiple operations in a single bash
// invocation. If any appear AFTER the leading-chdir strip, we treat the
// input as a composite and bail out. Safer to false-negative here.
const SHELL_OP_AMP = "&&";
const SHELL_OP_SEMI = ";";
const SHELL_OP_PIPE = "|";
const SHELL_OP_OR = "||";

/**
 * Strip a leading `cd <path> [AMP|SEMI]` prefix from simple bash commands,
 * returning the rest. This is a heuristic, not a full shell parser; quoted
 * paths are fine when they do not contain shell composition operators.
 */
export function stripLeadingChdir(command: string): string {
  const trimmed = command.replace(/^\s+/, "");
  if (!trimmed.startsWith("cd ")) return command;
  const separator = findLeadingChdirSeparator(trimmed);
  if (separator === null) return command;
  const rest = trimmed.slice(separator.idx + separator.length).replace(/^\s+/, "");
  return rest;
}

function findLeadingChdirSeparator(s: string): { idx: number; length: number } | null {
  const amp = s.indexOf(SHELL_OP_AMP);
  const semi = s.indexOf(SHELL_OP_SEMI);
  const candidates = [
    amp === -1 ? null : { idx: amp, length: SHELL_OP_AMP.length },
    semi === -1 ? null : { idx: semi, length: 1 },
  ].filter((v): v is { idx: number; length: number } => v !== null);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => a.idx - b.idx);
  return candidates[0];
}

function findFirstCompositeSyntax(s: string): number {
  // Return the earliest occurrence of shell composition syntax. This is
  // intentionally conservative, not a full parser.
  const candidates: number[] = [];
  const a = s.indexOf(SHELL_OP_AMP);
  if (a !== -1) candidates.push(a);
  const b = s.indexOf(SHELL_OP_SEMI);
  if (b !== -1) candidates.push(b);
  const c = s.indexOf(SHELL_OP_PIPE);
  if (c !== -1) candidates.push(c);
  const d = s.indexOf(SHELL_OP_OR);
  if (d !== -1) candidates.push(d);
  for (const token of ["\n", "\r", "&", "<", ">", "`", "$(", "(", ")"]) {
    const idx = s.indexOf(token);
    if (idx !== -1) candidates.push(idx);
  }
  if (candidates.length === 0) return -1;
  return Math.min(...candidates);
}

function stripGitGlobalOptions(tokens: string[]): string[] {
  const remaining = [...tokens];
  while (remaining.length > 0) {
    const current = remaining[0];
    if (current === "-C" || current === "-c" || current === "--git-dir" || current === "--work-tree") {
      if (remaining.length < 2) return remaining;
      remaining.splice(0, 2);
      continue;
    }
    if (
      current.startsWith("--git-dir=") ||
      current.startsWith("--work-tree=") ||
      current.startsWith("--namespace=") ||
      current.startsWith("--exec-path=")
    ) {
      remaining.shift();
      continue;
    }
    return remaining;
  }
  return remaining;
}

/**
 * Detect whether a bash command is a real `git push` invocation we
 * should fire on. True for `git push`, `git push origin main`,
 * `git push --force-with-lease`, etc. False for:
 *
 *   - Other git subcommands (`git pull`, `git status`)
 *   - `--dry-run` invocations
 *   - Composite shell commands where push isn't the leading command
 */
export function isGitPushInvocation(command: string): boolean {
  const stripped = stripLeadingChdir(command).trim();

  // Bail on commands that compose multiple operations after the chdir
  // strip. The leading "git push" is what we want; pipelines, multiline
  // commands, redirections, subshells, and background operators could
  // wrap it in arbitrary ways we can't reason about safely.
  if (findFirstCompositeSyntax(stripped) !== -1) return false;

  // Tokenize on whitespace and check the git subcommand. Support common
  // git global options that come before the subcommand, such as
  // `git -C /repo push`.
  const tokens = stripped.split(/\s+/);
  if (tokens[0] !== "git") return false;
  const gitArgs = stripGitGlobalOptions(tokens.slice(1));
  if (gitArgs[0] !== "push") return false;

  // Reject dry-runs (no actual remote state changes). Two forms:
  //   - Long: `--dry-run` or `--dry-run=server` (handled inline below)
  //   - Short: `-n` alone OR bundled (e.g. `-fn`, `-nv`, `-nfu`).
  //     git's getopt-style bundling means any single-dash token containing
  //     'n' includes the dry-run flag.
  for (const t of gitArgs.slice(1)) {
    if (t === "--dry-run" || t.startsWith("--dry-run=")) return false;
    if (t.length >= 2 && t.startsWith("-") && !t.startsWith("--") && t.includes("n")) {
      return false;
    }
  }

  return true;
}

/**
 * Build the on-push reminder text. Adapts based on configured
 * `skipPolicy`:
 *
 *   - "agent-decides": tells the agent to decide whether the push is
 *     new work (review) or a fix-up of prior findings (skip). Provides
 *     the exact "skipped" block to print so the user always sees that
 *     a decision was made (no silent skips).
 *
 *   - "always-fire": unconditionally invoke the required review skills.
 *
 * The reminder leaves SKILL INVOCATION to the agent. When the agent
 * invokes /review (or whatever), the existing PostToolUse:Skill hook
 * fires the attestation reminder.
 */
export function buildOnPushReminder(
  requiredSkills: ReadonlyArray<string>,
  skipPolicy: "agent-decides" | "always-fire",
  askBeforeFiring = false,
): string {
  const skillsList = requiredSkills.map((s) => `/${s}`).join(", ");
  const lines: string[] = [];
  lines.push(`You just ran \`git push\`. This repo has \`autoReview.trigger=on-push\` enabled.`);
  lines.push("");
  if (skipPolicy === "always-fire") {
    if (askBeforeFiring) {
      lines.push(
        `Ask the user before invoking the required review skill${requiredSkills.length === 1 ? "" : "s"}: ${skillsList}. ` +
          `If they approve, invoke ${skillsList}; each skill injects its own attestation reminder when loaded.`,
      );
    } else {
      lines.push(
        `Invoke the required review skill${requiredSkills.length === 1 ? "" : "s"} now: ${skillsList}. ` +
          `Each will inject its own attestation reminder when loaded.`,
      );
    }
    return lines.join("\n");
  }
  // agent-decides
  lines.push(`Decide whether this push introduced review-worthy changes since the last attested review.`);
  lines.push("");
  if (askBeforeFiring) {
    lines.push(
      `If it includes new source, tests, docs, config, behavior, or setup changes, ask the user before invoking ${skillsList}. If they approve, each skill fires its own attestation reminder when loaded.`,
    );
  } else {
    lines.push(
      `If it includes new source, tests, docs, config, behavior, or setup changes, invoke ${skillsList}. Each skill fires its own attestation reminder when loaded.`,
    );
  }
  lines.push("");
  lines.push(
    `If it only fixes findings from the most recent review, retries attestation, or publishes unchanged metadata, print EXACTLY this block to the user, then do NOT invoke a review skill:`,
  );
  lines.push("");
  lines.push("  ⏭️  Skilled PR auto-review: skipped");
  lines.push("  Reason: <one sentence - what the recent turns were doing>");
  lines.push(`  To force a fresh review, invoke ${skillsList} manually.`);
  lines.push("");
  lines.push("Be conservative: if uncertain, run the review.");
  return lines.join("\n");
}

interface BashHookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { command?: string };
}

/**
 * Decide whether the PostToolUse:Bash event we just received should
 * trigger an on-push reminder. Returns the reminder text or null.
 *
 * Bails early when:
 *   - event isn't PostToolUse:Bash
 *   - command isn't a git push invocation
 *   - config can't be loaded
 *   - autoReview.trigger isn't "on-push"
 *   - requiredSkills resolves to empty (bypass)
 */
export async function maybeOnPushReminder(event: BashHookEvent): Promise<string | null> {
  if (event.hook_event_name !== "PostToolUse") return null;
  if (event.tool_name !== "Bash") return null;
  const command = event.tool_input?.command;
  if (typeof command !== "string") return null;
  if (!isGitPushInvocation(command)) return null;

  const config = await loadConfig();
  if (!config) return null;
  if (config.autoReview.trigger !== "on-push") return null;

  const profile = resolveProfile(config, getCurrentPRContext());
  if (profile.requiredSkills.length === 0) return null;

  return buildOnPushReminder(
    profile.requiredSkills,
    config.autoReview.skipPolicy,
    config.autoReview.askBeforeFiring,
  );
}
