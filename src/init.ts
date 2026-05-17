// skilled-pr init
// Sets up Skilled PR in the current repo.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";
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
 *
 * Atomic via write-temp + rename: writeFileSync alone is not atomic, so a
 * Ctrl-C or OOM kill mid-write would leave the file half-written. The next
 * init run would then parse the corrupted JSON via jsonc-parser's
 * error-recovery mode and merge into the partial result, silently
 * destroying the user's settings. POSIX `rename` is atomic on the same
 * filesystem; Windows's equivalent (MoveFileExW with MOVEFILE_REPLACE_EXISTING)
 * is what Node's renameSync wraps.
 */
function writeFileWithMkdir(path: string, contents: string) {
  const dir = dirname(path);
  if (dir && dir !== "." && !existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp`;
  try {
    writeFileSync(tmp, contents);
    renameSync(tmp, path);
  } catch (err) {
    // Best-effort cleanup so we never leave a dangling .tmp behind for
    // the next run to confuse with an in-progress write.
    try {
      unlinkSync(tmp);
    } catch {
      // unlinkSync throws if tmp doesn't exist; that's fine - we're cleaning up.
    }
    throw err;
  }
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
    //
    // jsonc-parser does best-effort error recovery by default: bad braces
    // return a partial parse, no throw. Without explicit error checking we'd
    // happily merge into the partial result and overwrite the user's file,
    // silently destroying broken-but-recoverable content. Pass an errors
    // array and refuse to proceed if parsing failed - the user can fix the
    // syntax error or rename the file out of the way.
    const errors: ParseError[] = [];
    existing = parseJsonc(raw, errors, { allowTrailingComma: true }) as ClaudeSettings;
    if (errors.length > 0) {
      const { error, offset, length } = errors[0];
      console.error(
        `Skilled PR: ${CLAUDE_SETTINGS_PATH} has invalid JSON (${printParseErrorCode(error)} at offset ${offset}, length ${length}).\n` +
          `Refusing to merge - the merge would overwrite your file with a best-effort parse and silently lose data.\n` +
          `Fix the syntax error in ${CLAUDE_SETTINGS_PATH}, then re-run \`skilled-pr init\`.`,
      );
      process.exit(1);
    }
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
