// skilled-pr hook
//
// Invoked by the host harness (Claude Code or Codex) as a hook command.
// Reads the hook event from stdin, decides whether the invoked skill is one
// listed in `.skilledpr.jsonc`'s `requiredSkills`, and if so emits a
// `hookSpecificOutput.additionalContext` JSON payload that injects an
// attestation-instruction system reminder into the model's next turn.
//
// Why this exists: the hook turns "the user just invoked a required review
// skill" into "the agent is told to write findings + run `skilled-pr
// attest`" without modifying any skill.
//
// Stdin schemas:
//
//   Claude Code (https://code.claude.com/docs/en/hooks):
//     PostToolUse with tool_name = "Skill":
//       { hook_event_name: "PostToolUse",
//         tool_name: "Skill",
//         tool_input: { skill: "<skill-name>" }, ... }
//     UserPromptExpansion (covers the /slash-command path):
//       { hook_event_name: "UserPromptExpansion",
//         command_name: "<skill-name>", ... }
//
//   Codex:
//     Codex skills load via progressive disclosure (the agent reads the
//     SKILL.md file with the same file tool it uses for everything else),
//     so there is no PostToolUse:Skill event to match on. Instead we hook
//     UserPromptSubmit and look for a leading slash-command in the prompt:
//       { hook_event_name: "UserPromptSubmit",
//         prompt: "/review please" }
//     A leading `/word` (or `/scope:word`) is the canonical invocation;
//     natural-language "review this PR" is not gated by skilled-pr.
//
// We bail (exit 0, no output) for any event that doesn't resolve to a known
// required skill: unrelated PostToolUse events, non-required Skill
// invocations, UserPromptSubmit without a leading slash command, and
// `command_source: "builtin"` slash commands like /help.

import { loadConfig } from "./config";
// Pulled from `findings-prompt` (not `findings`) on purpose: the hook fires
// on every PostToolUse:Skill and every UserPromptExpansion event, and most
// of those bail at `extractSkillName === null` before doing any work.
// Importing from findings.ts would force its top-level `z.object(...)` to
// run on every bail, dragging zod-core + bundled locales into the hot path
// for no functional reason. findings-prompt is zod-free.
import { findingsSchemaForPrompt } from "./findings-prompt";

/**
 * Hard cap on stdin size. 16 MiB is comfortably above any realistic Claude
 * Code hook payload (PostToolUse events carry the tool_input which may
 * include large tool transcripts, but not tens of MB). Without a cap, a
 * misbehaving parent piping unbounded input would OOM the hook process.
 */
const MAX_STDIN_BYTES = 16 * 1024 * 1024;

/**
 * Stdin idle timeout in milliseconds. Resets on every chunk; only fires
 * when the stream is open but produces nothing. 5 s is long enough for
 * slow IO but short enough that a dead-parent hook doesn't block the
 * session. In the typical Claude Code flow, the parent writes the payload
 * and closes stdin in <100 ms, so the timer effectively never fires.
 */
const STDIN_IDLE_TIMEOUT_MS = 5_000;

/**
 * Read stdin to completion as a UTF-8 string. Node's process.stdin is a
 * Readable stream (not a one-shot promise like Bun.stdin.text()).
 *
 * Bounded on two axes to keep the hook safe on the hot path (the hook
 * fires on every PostToolUse:Skill and every UserPromptExpansion event):
 *   - Size cap: rejects if accumulated bytes exceed MAX_STDIN_BYTES
 *   - Idle timeout: rejects if no chunk arrives for STDIN_IDLE_TIMEOUT_MS
 * Both reject with an Error; the caller already wraps in try/catch and
 * fails open (logs + returns), so a misbehaving parent never wedges the
 * session.
 *
 * `stream` is parameterised so unit tests can pass a stub Readable.
 */
export function readStdin(
  stream: NodeJS.ReadableStream = process.stdin,
  maxBytes = MAX_STDIN_BYTES,
  idleTimeoutMs = STDIN_IDLE_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    stream.setEncoding("utf8");

    // Idle timer resets every time a chunk arrives. Triggers only when the
    // stream is open but stalled. setTimeout's value is captured by
    // closure so we can clear and recreate on each chunk.
    let idleTimer: NodeJS.Timeout;
    const onIdle = () => {
      stream.removeAllListeners();
      reject(new Error(`stdin idle timeout after ${idleTimeoutMs}ms (no data received)`));
    };
    const resetIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(onIdle, idleTimeoutMs);
    };
    resetIdle();

    stream.on("data", (chunk: string | Buffer) => {
      resetIdle();
      data += chunk.toString();
      if (data.length > maxBytes) {
        clearTimeout(idleTimer);
        stream.removeAllListeners();
        reject(new Error(`stdin exceeded max size ${maxBytes} bytes`));
      }
    });
    stream.on("end", () => {
      clearTimeout(idleTimer);
      resolve(data);
    });
    stream.on("error", (err: Error) => {
      clearTimeout(idleTimer);
      reject(err);
    });
  });
}

interface HookEvent {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: { skill?: string };
  command_name?: string;
  /** Codex UserPromptSubmit. The full text the user just submitted. */
  prompt?: string;
  /** Codex UserPromptSubmit fallback field name some hook payloads use. */
  user_message?: string;
}

/**
 * Extract the skill name from a leading slash-command in a Codex
 * UserPromptSubmit prompt. Accepts `/skill`, `/scope:skill`, `/skill-with-dashes`.
 * Returns null if no leading slash-command is present. Exported for tests.
 *
 * Matching is anchored to the start of the trimmed prompt so a stray `/`
 * mid-sentence (e.g. "and/or") doesn't trigger.
 */
export function extractLeadingSlashCommand(prompt: string): string | null {
  const trimmed = prompt.trimStart();
  const match = /^\/([\w:-]+)/.exec(trimmed);
  if (!match) return null;
  // Filter out Codex/Claude builtins so /help, /clear, etc. never trigger
  // the gate. Required skills can't be named after a builtin anyway, but
  // bailing early skips the config read for the common case.
  const BUILTINS = new Set(["help", "clear", "exit", "quit", "model", "compact"]);
  if (BUILTINS.has(match[1])) return null;
  return match[1];
}

/**
 * Resolve the skill name (if any) from a hook event payload. Returns null for
 * any event we don't care about, including events with bad shape.
 */
export function extractSkillName(event: HookEvent): string | null {
  // Claude Code: agent-invoked Skill tool.
  if (event.hook_event_name === "PostToolUse" && event.tool_name === "Skill") {
    const skill = event.tool_input?.skill;
    return typeof skill === "string" && skill.length > 0 ? skill : null;
  }
  // Claude Code: user-typed /slash-command.
  if (event.hook_event_name === "UserPromptExpansion") {
    const cmd = event.command_name;
    return typeof cmd === "string" && cmd.length > 0 ? cmd : null;
  }
  // Codex: user-typed /slash-command in the submitted prompt.
  if (event.hook_event_name === "UserPromptSubmit") {
    const text = event.prompt ?? event.user_message;
    if (typeof text !== "string" || text.length === 0) return null;
    return extractLeadingSlashCommand(text);
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

/**
 * Build the attestation-instruction system reminder for a given skill.
 *
 * `summaryPrompt` is required - it's the only description of what the PR
 * artifact comment should look like. skilled-pr no longer renders a
 * fallback, so a missing prompt means the system can't produce a
 * meaningful summary. The config parser refuses to load a config without
 * one, so this function can rely on it being present.
 */
export function buildReminder(skillName: string, summaryPrompt: string): string {
  const slug = slugifySkill(skillName);
  const findingsPath = `.review/findings-${slug}.json`;
  const summaryPath = `.review/summary-${slug}.md`;
  const attestCommand = `skilled-pr attest --skill ${skillName} --findings ${findingsPath} --summary ${summaryPath}`;

  const lines: string[] = [];
  lines.push(
    `This repo gates merges via skilled-pr. The \`${skillName}\` skill you just loaded is listed in \`.skilledpr.jsonc\` as a required review.`,
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
  // Indent the user's prompt so it visually nests inside the step.
  for (const line of summaryPrompt.split("\n")) {
    lines.push(`   ${line}`);
  }
  lines.push("");
  lines.push(`3. Run: \`${attestCommand}\``);
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
 * Format the JSON payload the host harness expects on stdout to inject an
 * additionalContext system reminder. Returns null when nothing should be
 * injected (caller should write nothing in that case).
 *
 * Claude Code and Codex both consume `hookSpecificOutput.additionalContext`
 * (Codex's hook spec is intentionally Claude-compatible); the only
 * per-harness variance is which event names they emit, which we already
 * gate on above.
 */
export function buildHookOutput(
  event: HookEvent,
  requiredSkills: ReadonlyArray<string>,
  summaryPrompt: string,
): string | null {
  const skillName = extractSkillName(event);
  if (skillName === null) return null;
  if (!requiredSkills.includes(skillName)) return null;

  const eventName = event.hook_event_name;
  const KNOWN_EVENTS = new Set([
    "PostToolUse",
    "UserPromptExpansion",
    "UserPromptSubmit",
  ]);
  if (typeof eventName !== "string" || !KNOWN_EVENTS.has(eventName)) return null;

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: eventName,
      additionalContext: buildReminder(skillName, summaryPrompt),
    },
  });
}

/**
 * CLI entry point. Reads stdin, parses, decides, prints. Always exits 0 so
 * a misconfigured skilled-pr never blocks the model — broken hook = silent
 * no-op, not a stalled session.
 *
 * Hot-path note: Claude Code fires this hook after every PostToolUse for
 * `Skill` AND for every UserPromptExpansion. Bail before the disk read
 * (`loadConfig`) when the event clearly has nothing to do with us, so the
 * dominant case (non-Skill PostToolUse, non-required-skill UserPromptExpansion)
 * does no I/O.
 */
export async function hook() {
  let event: HookEvent;
  try {
    const stdin = await readStdin();
    if (stdin.trim().length === 0) return;
    event = JSON.parse(stdin) as HookEvent;
  } catch (e) {
    console.error(`skilled-pr hook: malformed stdin (${(e as Error).message})`);
    return;
  }

  // Early bail: skip the config read entirely when the event resolves to no
  // skill name (irrelevant tools, malformed events, builtin slash-commands).
  if (extractSkillName(event) === null) return;

  let config;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`skilled-pr hook: ${(e as Error).message}`);
    return;
  }
  if (!config) return;

  const output = buildHookOutput(event, config.requiredSkills, config.summaryPrompt);
  if (output) console.log(output);
}
