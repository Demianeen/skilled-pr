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
function readStdin(
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
  const attestCommand = `skilled-pr attest --skill ${skillName} --findings ${findingsPath}`;
  return [
    `This repo gates merges via skilled-pr. The \`${skillName}\` skill you just loaded is listed in \`.skilledpr.jsonc\` as a required review.`,
    "",
    "After completing your review, do these three things in order:",
    "",
    `1. Write your findings to \`${findingsPath}\` as a JSON array. ${findingsSchemaForPrompt()}`,
    "",
    `2. Run: \`${attestCommand}\``,
    "",
    "3. If attest exits with code 2 (\"HEAD is not pushed\"), ask the user whether to push the branch. After they confirm, run `git push` and then re-run the attest command from step 2. Do NOT push without asking — pushing modifies the remote.",
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

  const output = buildHookOutput(event, config.requiredSkills);
  if (output) console.log(output);
}
