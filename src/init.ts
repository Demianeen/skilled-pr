// skilled-pr init
// Sets up Skilled PR in the current repo.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { generateDefaultConfig } from "./config";

const SKILLED_PR_HOOK_COMMAND = "skilled-pr hook";
const CLAUDE_SETTINGS_PATH = ".claude/settings.json";

/** A single hook entry in `.claude/settings.json` (one matcher + one or more commands). */
interface HookEntry {
  matcher?: string;
  hooks: Array<{ type: string; command?: string; [k: string]: unknown }>;
}

/** Shape of `.claude/settings.json`. We touch only `hooks`; everything else is preserved. */
export interface ClaudeSettings {
  hooks?: {
    [eventName: string]: HookEntry[];
  };
  [other: string]: unknown;
}

/**
 * Add skilled-pr's PostToolUse + UserPromptExpansion hooks to a Claude
 * settings object, preserving all other settings. Idempotent: if an entry
 * already invokes `skilled-pr hook` for an event, it's left alone.
 *
 * Exported pure for tests; `init()` uses it to merge into the user's
 * existing settings.
 */
export function mergeSkilledPRHooks(existing: ClaudeSettings | null): ClaudeSettings {
  const hooks: NonNullable<ClaudeSettings["hooks"]> = { ...(existing?.hooks ?? {}) };

  ensureSkilledPRHook(hooks, "PostToolUse", "Skill");
  ensureSkilledPRHook(hooks, "UserPromptExpansion", "");

  return { ...(existing ?? {}), hooks };
}

function ensureSkilledPRHook(
  hooks: NonNullable<ClaudeSettings["hooks"]>,
  event: string,
  matcher: string,
) {
  const entries = hooks[event] ?? [];
  const alreadyPresent = entries.some((e) =>
    e.hooks?.some((h) => h.command === SKILLED_PR_HOOK_COMMAND),
  );
  if (alreadyPresent) {
    hooks[event] = entries;
    return;
  }
  hooks[event] = [
    ...entries,
    {
      matcher,
      hooks: [{ type: "command", command: SKILLED_PR_HOOK_COMMAND }],
    },
  ];
}

/**
 * Write `contents` to `path`, creating the parent directory if needed.
 * Mirrors `Bun.write`'s auto-mkdir behaviour, which we relied on for
 * `.claude/settings.json` (the `.claude/` dir doesn't exist in a fresh repo).
 */
function writeFileWithMkdir(path: string, contents: string) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, contents);
}

export async function init() {
  console.log("Skilled PR — setting up...\n");

  // 1. Create .skilledpr.jsonc
  if (existsSync(".skilledpr.jsonc")) {
    console.log("✓ .skilledpr.jsonc already exists");
  } else {
    writeFileWithMkdir(".skilledpr.jsonc", generateDefaultConfig());
    console.log("✓ Created .skilledpr.jsonc");
  }

  // 2. Install Claude Code hooks. Read-merge-write so we never clobber the
  //    user's existing settings (formatters, notification hooks, etc.).
  let existing: ClaudeSettings | null = null;
  if (existsSync(CLAUDE_SETTINGS_PATH)) {
    const raw = readFileSync(CLAUDE_SETTINGS_PATH, "utf8");
    // jsonc-parser tolerates // and /* */ comments some users keep in their
    // settings; standard JSON.parse would throw.
    existing = parseJsonc(raw) as ClaudeSettings;
  }

  const merged = mergeSkilledPRHooks(existing);
  const before = existing ? JSON.stringify(existing) : null;
  const after = JSON.stringify(merged);
  if (before === after) {
    console.log(`✓ ${CLAUDE_SETTINGS_PATH} already has skilled-pr hooks`);
  } else {
    writeFileWithMkdir(CLAUDE_SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n");
    console.log(`✓ Updated ${CLAUDE_SETTINGS_PATH} with skilled-pr hooks`);
  }

  // 3. Guide branch protection
  console.log(`
Next steps:

  1. Make sure \`skilled-pr\` is on your PATH (the hooks invoke it as
     \`skilled-pr hook\`). Install globally with \`npm i -g skilled-pr\`
     (or \`pnpm add -g skilled-pr\`) or pin a per-project install and
     adjust .claude/settings.json.

  2. Review \`.skilledpr.jsonc\` and list which review skills must run
     before merge under \`requiredSkills\`.

  3. Enable branch protection on GitHub:
     → Repo Settings → Branches → Branch protection rules
     → Add rule for your main branch
     → Check "Require status checks to pass"
     → Search for "Skilled PR" and add it.

  4. Invoke a required review skill in Claude Code. Skilled PR will
     automatically inject attestation instructions, and the model will
     write findings + post the GitHub status.

Done!
`);
}
