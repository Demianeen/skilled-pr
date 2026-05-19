// skilled-pr init
// Sets up Skilled PR in the current repo.
//
// What this does:
//   1. Creates `.skilledpr.jsonc` with sensible defaults (if missing).
//   2. Installs hooks into every detected harness (Claude Code, Codex,
//      both). Detection scans for `.claude/` and `.codex/` directories.
//      Override with `--for claude|codex|both` for explicit control.
//   3. Prints next-step guidance.
//
// All the per-harness specifics (where the config file lives, what schema it
// uses, how to merge without clobbering) live in `src/harness/*`. This file
// is intentionally just orchestration.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import { parseInitArgs } from "./args";
import { generateDefaultConfig } from "./config";
import type { Harness } from "./harness";
import { detectHarnesses, resolveHarnessOverride } from "./harness";

// Re-export legacy types so existing imports (tests, doctor.ts) keep working
// while we migrate consumers to the harness module.
export type { ClaudeSettings } from "./harness";
export { mergeSkilledPRHooks } from "./harness";

/**
 * Write `contents` to `path`, creating the parent directory if needed.
 * Both `.claude/` and `.codex/` may not exist in a fresh repo; we mkdir
 * up-front when missing.
 *
 * Atomic via write-temp + rename: writeFileSync alone is not atomic, so a
 * Ctrl-C or OOM kill mid-write would leave the file half-written. The next
 * init run would then parse the corrupted JSON via jsonc-parser's
 * error-recovery mode and merge into the partial result, silently
 * destroying the user's settings. POSIX `rename` is atomic on the same
 * filesystem; Windows's equivalent (MoveFileExW with MOVEFILE_REPLACE_EXISTING)
 * is what Node's renameSync wraps.
 */
export function writeFileWithMkdir(path: string, contents: string) {
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

/**
 * For a single harness: read its existing config (if any), merge skilled-pr's
 * hook entry, write back. Prints a one-line status to stdout. Returns true if
 * the file was modified, false if nothing changed (already wired up).
 *
 * Refuses (exits 1) when the existing file has JSON syntax errors. See the
 * inline note below: silent partial-parse merging would destroy user data.
 */
function installForHarness(harness: Harness): boolean {
  let existing: unknown = null;
  if (existsSync(harness.settingsPath)) {
    const raw = readFileSync(harness.settingsPath, "utf8");
    // jsonc-parser tolerates // and /* */ comments some users keep in their
    // settings; standard JSON.parse would throw on those.
    //
    // jsonc-parser does best-effort error recovery by default: bad braces
    // return a partial parse, no throw. Without explicit error checking we'd
    // happily merge into the partial result and overwrite the user's file,
    // silently destroying broken-but-recoverable content. Pass an errors
    // array and refuse to proceed if parsing failed; the user can fix the
    // syntax error or rename the file out of the way.
    const errors: ParseError[] = [];
    existing = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const { error, offset, length } = errors[0];
      console.error(
        `Skilled PR: ${harness.settingsPath} has invalid JSON (${printParseErrorCode(error)} at offset ${offset}, length ${length}).\n` +
          `Refusing to merge; the merge would overwrite your file with a best-effort parse and silently lose data.\n` +
          `Fix the syntax error in ${harness.settingsPath}, then re-run \`skilled-pr init\`.`,
      );
      process.exit(1);
    }
  }

  const merged = harness.mergeHooks(existing);
  const before = existing === null ? null : JSON.stringify(existing);
  const after = JSON.stringify(merged);

  if (before === after) {
    console.log(`✓ ${harness.settingsPath} already has skilled-pr hooks (${harness.label})`);
    return false;
  }
  writeFileWithMkdir(harness.settingsPath, JSON.stringify(merged, null, 2) + "\n");
  console.log(`✓ Updated ${harness.settingsPath} with skilled-pr hooks (${harness.label})`);
  return true;
}

export async function init(argv: string[] = []) {
  console.log("Skilled PR: setting up...\n");

  // 1. Parse args (currently only --for).
  const args = parseInitArgs(argv);
  if (!args.ok) {
    console.error(`skilled-pr init: ${args.error}`);
    process.exit(1);
  }

  // 2. Pick harness adapters: explicit override > detection > Claude fallback.
  let harnesses: Harness[];
  if (args.forHarness) {
    const resolved = resolveHarnessOverride(args.forHarness);
    if (!resolved) {
      console.error(
        `skilled-pr init: --for must be one of "claude", "codex", "both" (got "${args.forHarness}")`,
      );
      process.exit(1);
    }
    harnesses = resolved;
  } else {
    harnesses = detectHarnesses();
  }

  // 3. Create .skilledpr.jsonc if missing.
  if (existsSync(".skilledpr.jsonc")) {
    console.log("✓ .skilledpr.jsonc already exists");
  } else {
    writeFileWithMkdir(".skilledpr.jsonc", generateDefaultConfig());
    console.log("✓ Created .skilledpr.jsonc");
  }

  // 4. Install hooks for each selected harness. Each call refuses (exit 1)
  //    if the target settings file has JSON syntax errors; that's by design,
  //    silently merging into a partial parse would destroy user data.
  for (const harness of harnesses) {
    installForHarness(harness);
  }

  // 5. Next steps. The "your harness here" wording adapts to what we wired up.
  const harnessList = harnesses.map((h) => h.label).join(" + ");
  console.log(`
Next steps:

  1. Make sure \`skilled-pr\` is on your PATH (the hooks invoke it as
     \`skilled-pr hook\`). Install globally with \`npm i -g skilled-pr\`
     (or \`pnpm add -g skilled-pr\`) or pin a per-project install and
     adjust the hook command.

  2. Review \`.skilledpr.jsonc\` and list which review skills must run
     before merge under \`requiredSkills\`.

  3. Enable branch protection on GitHub:
     -> Repo Settings -> Branches -> Branch protection rules
     -> Add rule for your main branch
     -> Check "Require status checks to pass"
     -> Search for "Skilled PR" and add it.

  4. Invoke a required review skill in ${harnessList}. Skilled PR will
     automatically inject attestation instructions, and the model will
     write findings + post the GitHub status.

Done!
`);
}
