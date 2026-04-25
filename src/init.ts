// skilled-pr init
// Sets up Skilled PR in the current repo.

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
  const settings: ClaudeSettings = existing
    ? { ...existing, hooks: { ...(existing.hooks ?? {}) } }
    : { hooks: {} };

  // narrowing helper — settings.hooks is now guaranteed defined
  const hooks = settings.hooks!;

  ensureSkilledPRHook(hooks, "PostToolUse", "Skill");
  ensureSkilledPRHook(hooks, "UserPromptExpansion", "");

  return settings;
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

export async function init() {
  console.log("Skilled PR — setting up...\n");

  // 1. Create .skilledpr.jsonc
  const configFile = Bun.file(".skilledpr.jsonc");
  if (await configFile.exists()) {
    console.log("✓ .skilledpr.jsonc already exists");
  } else {
    await Bun.write(".skilledpr.jsonc", generateDefaultConfig());
    console.log("✓ Created .skilledpr.jsonc");
  }

  // 2. Install Claude Code hooks. Read-merge-write so we never clobber the
  //    user's existing settings (formatters, notification hooks, etc.).
  const settingsFile = Bun.file(CLAUDE_SETTINGS_PATH);
  let existing: ClaudeSettings | null = null;
  if (await settingsFile.exists()) {
    const raw = await settingsFile.text();
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
    await Bun.write(CLAUDE_SETTINGS_PATH, JSON.stringify(merged, null, 2) + "\n");
    console.log(`✓ Updated ${CLAUDE_SETTINGS_PATH} with skilled-pr hooks`);
  }

  // 3. Guide branch protection
  console.log(`
Next steps:

  1. Make sure \`skilled-pr\` is on your PATH (the hooks invoke it as
     \`skilled-pr hook\`). Install globally with \`bun add -g skilled-pr\`
     or pin a per-project install and adjust .claude/settings.json.

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
