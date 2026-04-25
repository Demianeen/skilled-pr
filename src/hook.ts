// skilled-pr hook
//
// Invoked by Claude Code as a PostToolUse / UserPromptExpansion command hook.
// Reads the hook event from stdin, decides whether the invoked skill is one
// listed in `.skilledpr.jsonc`'s `requiredSkills`, and — if so — emits a
// `hookSpecificOutput.additionalContext` JSON payload that injects an
// attestation-instruction system reminder into the model's next turn.
//
// Why this exists: see the architecture discussion. Short version: the hook
// turns "Claude just loaded a required review skill" into "Claude is told to
// write findings + run `skilled-pr attest`" without modifying any skill.
//
// Stdin schemas (from https://code.claude.com/docs/en/hooks):
//
//   PostToolUse with tool_name = "Skill":
//     { hook_event_name: "PostToolUse",
//       tool_name: "Skill",
//       tool_input: { skill: "<skill-name>" }, ... }
//
//   UserPromptExpansion (covers the /slash-command path):
//     { hook_event_name: "UserPromptExpansion",
//       command_name: "<skill-name>", ... }
//
// We bail (exit 0, no output) for any event that doesn't resolve to a known
// required skill — including unrelated PostToolUse events on Bash/Read/etc.,
// non-required Skill invocations, and `command_source: "builtin"` slash
// commands like /help.

import { loadConfig } from "./config";
import { findingsSchemaForPrompt } from "./findings";

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { skill?: string };
  command_name?: string;
}

/**
 * Resolve the skill name (if any) from a hook event payload. Returns null for
 * any event we don't care about, including events with bad shape.
 */
export function extractSkillName(event: HookEvent): string | null {
  if (event.hook_event_name === "PostToolUse" && event.tool_name === "Skill") {
    const skill = event.tool_input?.skill;
    return typeof skill === "string" && skill.length > 0 ? skill : null;
  }
  if (event.hook_event_name === "UserPromptExpansion") {
    const cmd = event.command_name;
    return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
  }
  return null;
}

/**
 * Slugify a skill name into the filename component used in the findings path.
 * `"coderabbit:review"` → `"coderabbit-review"`. Stable, lowercase, alnum-and-dash.
 */
export function slugifySkill(name: string): string {
  return name
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
}

/** Build the attestation-instruction system reminder for a given skill. */
export function buildReminder(skillName: string): string {
  const slug = slugifySkill(skillName);
  const findingsPath = `.review/findings-${slug}.json`;
  return [
    `This repo gates merges via skilled-pr. The \`${skillName}\` skill you just loaded is listed in \`.skilledpr.jsonc\` as a required review.`,
    "",
    "After completing your review, do these two things in order:",
    "",
    `1. Write your findings to \`${findingsPath}\` as a JSON array. ${findingsSchemaForPrompt()}`,
    "",
    `2. Run: \`skilled-pr attest --skill ${skillName} --findings ${findingsPath}\``,
    "",
    "This posts the GitHub status check that gates the PR. Without it, the PR cannot merge.",
  ].join("\n");
}

/**
 * Format the JSON payload Claude Code expects on stdout to inject an
 * additionalContext system reminder. Returns null when nothing should be
 * injected (caller should write nothing in that case).
 */
export function buildHookOutput(
  event: HookEvent,
  requiredSkills: ReadonlyArray<string>,
): string | null {
  const skillName = extractSkillName(event);
  if (skillName === null) return null;
  if (!requiredSkills.includes(skillName)) return null;

  const eventName = event.hook_event_name;
  if (eventName !== "PostToolUse" && eventName !== "UserPromptExpansion") return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: buildReminder(skillName),
    },
  });
}

/**
 * CLI entry point. Reads stdin, parses, decides, prints. Always exits 0 so
 * a misconfigured skilled-pr never blocks the model — broken hook = silent
 * no-op, not a stalled session.
 */
export async function hook() {
  let event: HookEvent;
  try {
    const stdin = await Bun.stdin.text();
    if (stdin.trim().length === 0) return;
    event = JSON.parse(stdin) as HookEvent;
  } catch (e) {
    console.error(`skilled-pr hook: malformed stdin (${(e as Error).message})`);
    return;
  }

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`skilled-pr hook: ${(e as Error).message}`);
    return;
  }
  if (!config) return;

  const output = buildHookOutput(event, config.requiredSkills);
  if (output) console.log(output);
}
