// skilled-pr init
// Sets up Skilled PR in the current repo.
//
// What this does (in order):
//   1. Choose install mode (local devDependency vs global) — flag,
//      interactive prompt, or auto-detect heuristic.
//   2. Install skilled-pr@<version> via the detected package manager
//      (unless --install-mode=skip).
//   3. Create `.skilledpr/config.jsonc` with v1 defaults (if missing).
//   4. Copy `schema/v1.json` to `.skilledpr/schema.json` so editors
//      pick up autocompletion.
//   5. Ensure `.review/` is gitignored.
//   6. Install hooks into every detected harness (Claude Code, Codex,
//      both). Detection scans for `.claude/` and `.codex/`. Override
//      with `--for claude|codex|both`.
//   7. Install the /skilled-pr-update skill into each harness's skills
//      dir so the user can later upgrade via /skilled-pr-update.
//   8. Print next-step guidance.
//
// All the per-harness specifics live in `src/harness/*`. This file is
// orchestration + the install-mode UI.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import { parseInitArgs } from "./args";
import { CONFIG_PATH, generateDefaultConfig } from "./config";
import type { Harness } from "./harness";
import { detectHarnesses, resolveHarnessOverride } from "./harness";
import { buildInstallArgv, detectPackageManager, type PackageManager } from "./pm-detect";

// Re-export legacy types so existing imports (tests, doctor.ts) keep working.
export type { ClaudeSettings } from "./harness";
export { mergeSkilledPRHooks } from "./harness";

const SCHEMA_PATH = ".skilledpr/schema.json";

/**
 * Write `contents` to `path`, creating the parent directory if needed.
 * Atomic via write-temp + rename so a Ctrl-C mid-write never leaves a
 * half-written file behind.
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
    try {
      unlinkSync(tmp);
    } catch {
      // unlinkSync throws if tmp doesn't exist; that's fine.
    }
    throw err;
  }
}

/**
 * Idempotently ensure `entry` appears on its own line in the repo's
 * `.gitignore`. Creates `.gitignore` at the repo root if it doesn't
 * exist. Newline-bounded match so `.review/` doesn't false-positive on
 * `node_modules/something/.review/`.
 */
export function ensureGitignoreEntry(entry: string) {
  const path = ".gitignore";
  if (!existsSync(path)) {
    writeFileWithMkdir(path, `${entry}\n`);
    console.log(`✓ Created ${path} with \`${entry}\``);
    return;
  }
  const current = readFileSync(path, "utf8");
  const lines = current.split(/\r?\n/);
  if (lines.includes(entry)) {
    console.log(`✓ ${path} already ignores \`${entry}\``);
    return;
  }
  const sep = current.endsWith("\n") ? "" : "\n";
  writeFileSync(path, `${current}${sep}${entry}\n`);
  console.log(`✓ Added \`${entry}\` to ${path}`);
}

/**
 * For a single harness: read existing config (if any), merge skilled-pr's
 * hook entry, write back. Returns true if modified, false if no-op.
 */
function installForHarness(harness: Harness): boolean {
  let existing: unknown = null;
  if (existsSync(harness.settingsPath)) {
    const raw = readFileSync(harness.settingsPath, "utf8");
    const errors: ParseError[] = [];
    existing = parseJsonc(raw, errors, { allowTrailingComma: true });
    if (errors.length > 0) {
      const { error, offset, length } = errors[0];
      throw new Error(
        `${harness.settingsPath} has invalid JSON (${printParseErrorCode(error)} at offset ${offset}, length ${length}).\n` +
          `Refusing to merge; the merge would overwrite your file with a best-effort parse and silently lose data.\n` +
          `Fix the syntax error in ${harness.settingsPath}, then re-run \`skilled-pr init\`.`,
      );
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

// ---------------------------------------------------------------------------
// Install mode
// ---------------------------------------------------------------------------

type InstallChoice = "local" | "global" | "skip";

function parseInstallChoice(raw: string | undefined): InstallChoice | null {
  if (raw === undefined) return null;
  if (raw === "local" || raw === "global" || raw === "skip") return raw;
  return null;
}

/**
 * Auto-detect a sensible default install mode. Used when no flag is
 * passed AND stdin isn't a TTY (so we can't ask).
 *
 * Heuristic: `package.json` present in the cwd → "local" (the user
 * wants a per-repo install pinned in devDependencies); absent →
 * "global" (no Node project here, install once for the user).
 */
function detectDefaultInstallMode(cwd: string = process.cwd()): InstallChoice {
  return existsSync(join(cwd, "package.json")) ? "local" : "global";
}

/**
 * Read the package's own version at runtime. Looking it up from
 * package.json (not a build-time constant) means a published skilled-pr
 * always pins to its own version on install, even after re-bundling.
 */
function readOwnVersion(): string {
  // Walk up from this file's location to find package.json. tsx dev
  // mode and tsup-built mode have different layouts; check both.
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolvePath(here, "..", "package.json"),
    resolvePath(here, "..", "..", "package.json"),
    resolvePath(here, "package.json"),
  ]) {
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { version?: string };
        if (typeof pkg.version === "string" && pkg.version.length > 0) {
          return pkg.version;
        }
      } catch {
        // fall through
      }
    }
  }
  return "latest";
}

/**
 * Path to the bundled schema/v1.json inside the package. Looked up
 * relative to this file's location so it works in both dev (src/) and
 * built (dist/) layouts.
 */
export function findSchemaSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolvePath(here, "..", "schema", "v1.json"),
    resolvePath(here, "schema", "v1.json"),
    resolvePath(here, "..", "..", "schema", "v1.json"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Path to the bundled `/skilled-pr-update` skill template. Same lookup
 * pattern as `findSchemaSource`. The template lives at
 * `templates/skilled-pr-update.skill.md` in the package; init copies it
 * into each detected harness's `skillsDir`.
 */
export function findUpdateSkillSource(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    resolvePath(here, "..", "templates", "skilled-pr-update.skill.md"),
    resolvePath(here, "templates", "skilled-pr-update.skill.md"),
    resolvePath(here, "..", "..", "templates", "skilled-pr-update.skill.md"),
  ]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Install the `/skilled-pr-update` skill template into the given harness's
 * skills directory. Idempotent: writes only if content differs. Returns
 * true if the file was written/updated, false if already up to date.
 */
function installUpdateSkillForHarness(harness: Harness, templateContent: string): boolean {
  const skillPath = join(harness.skillsDir, "skilled-pr-update", harness.skillFileName);
  const existing = existsSync(skillPath) ? readFileSync(skillPath, "utf8") : null;
  if (existing === templateContent) {
    console.log(`✓ ${skillPath} already up to date (${harness.label})`);
    return false;
  }
  if (existing !== null) {
    console.warn(
      `⚠ ${skillPath} differs from the bundled /skilled-pr-update template; replacing it with the current template.`,
    );
  }
  writeFileWithMkdir(skillPath, templateContent);
  console.log(`✓ ${existing === null ? "Created" : "Updated"} ${skillPath} (${harness.label})`);
  return true;
}

/**
 * Interactive prompt asking the user which install mode they want.
 * Used only when stdin is a TTY; non-TTY callers fall back to
 * `detectDefaultInstallMode`.
 */
async function promptInstallMode(defaultChoice: InstallChoice): Promise<InstallChoice> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<InstallChoice>((resolve) => {
      const prompt =
        `Where should skilled-pr be installed?\n` +
        `  1. Local devDependency  (recommended for Node projects)\n` +
        `  2. Global               (skilled-pr available everywhere)\n` +
        `  3. Skip                 (manage the install yourself)\n` +
        `[default: ${defaultChoice}] > `;
      rl.question(prompt, (answer) => {
        const trimmed = answer.trim().toLowerCase();
        if (trimmed === "" || trimmed === "y" || trimmed === "yes") {
          resolve(defaultChoice);
        } else if (trimmed === "1" || trimmed === "local") {
          resolve("local");
        } else if (trimmed === "2" || trimmed === "global") {
          resolve("global");
        } else if (trimmed === "3" || trimmed === "skip") {
          resolve("skip");
        } else {
          // Unrecognised → fall back to the default rather than erroring;
          // re-running init is cheap.
          resolve(defaultChoice);
        }
      });
    });
  } finally {
    rl.close();
  }
}

/**
 * Run the install command for the given (pm, choice, version). Streams
 * output to the user's terminal so they see install progress. Returns
 * true on success, false on failure (does NOT throw — install failure
 * shouldn't block writing the config files).
 */
function runInstall(pm: PackageManager, choice: "local" | "global", version: string): boolean {
  const argv = buildInstallArgv(pm, choice, version);
  if (argv === null) return true; // nothing to do
  console.log(`\n  Running: ${argv.join(" ")}\n`);
  const proc = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
  if (proc.status !== 0) {
    console.warn(
      `⚠ Install command exited with code ${proc.status}. Continuing with config setup.\n` +
        `  If skilled-pr isn't on PATH after this, run the install manually:\n` +
        `    ${argv.join(" ")}\n`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function isTTY(): boolean {
  // Node sets isTTY on the stream when stdin is attached to a
  // terminal. CI / piped input gives `undefined` (falsy). Tests can
  // bypass via --install-mode.
  return process.stdin.isTTY === true;
}

export async function init(argv: string[] = []) {
  console.log("Skilled PR: setting up...\n");

  // 1. Parse args.
  const args = parseInitArgs(argv);
  if (!args.ok) {
    console.error(`skilled-pr init: ${args.error}`);
    process.exit(1);
  }

  // 2. Resolve harness selection.
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

  // 3. Resolve install mode (flag > prompt > auto-detect default).
  const explicit = parseInstallChoice(args.installMode);
  if (args.installMode !== undefined && explicit === null) {
    console.error(
      `skilled-pr init: --install-mode must be "local", "global", or "skip" (got "${args.installMode}")`,
    );
    process.exit(1);
  }
  const autoDefault = detectDefaultInstallMode();
  let installChoice: InstallChoice;
  if (explicit !== null) {
    installChoice = explicit;
  } else if (isTTY()) {
    installChoice = await promptInstallMode(autoDefault);
  } else {
    installChoice = autoDefault;
    console.log(
      `  (non-interactive; defaulting to install mode "${installChoice}". Use --install-mode to override.)`,
    );
  }

  // 4. Run install (or skip).
  if (installChoice === "skip") {
    console.log("✓ Install skipped (--install-mode=skip)");
  } else {
    const pm = detectPackageManager();
    const version = readOwnVersion();
    runInstall(pm, installChoice, version);
  }

  // 5. Create .skilledpr/config.jsonc if missing.
  if (existsSync(CONFIG_PATH)) {
    console.log(`✓ ${CONFIG_PATH} already exists`);
  } else {
    writeFileWithMkdir(CONFIG_PATH, generateDefaultConfig());
    console.log(`✓ Created ${CONFIG_PATH}`);
  }

  // 6. Write the bundled schema next to it so editors get autocompletion.
  const schemaSource = findSchemaSource();
  if (schemaSource !== null) {
    const schemaContent = readFileSync(schemaSource, "utf8");
    const existing = existsSync(SCHEMA_PATH) ? readFileSync(SCHEMA_PATH, "utf8") : null;
    if (existing === schemaContent) {
      console.log(`✓ ${SCHEMA_PATH} already up to date`);
    } else {
      writeFileWithMkdir(SCHEMA_PATH, schemaContent);
      console.log(`✓ ${existing === null ? "Created" : "Updated"} ${SCHEMA_PATH}`);
    }
  } else {
    console.warn(
      `⚠ Could not locate bundled schema/v1.json — ${SCHEMA_PATH} not written. Editor autocompletion won't work.`,
    );
  }

  // 7. Keep local review artifacts out of PR diffs.
  ensureGitignoreEntry(".review/");

  // 8. Install hooks for each selected harness.
  const installErrors: Array<{ harness: Harness; error: Error }> = [];
  for (const harness of harnesses) {
    try {
      installForHarness(harness);
    } catch (error) {
      installErrors.push({
        harness,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  if (installErrors.length > 0) {
    console.error("skilled-pr init: could not update one or more harness hook files:");
    for (const { harness, error } of installErrors) {
      console.error(`\n${harness.label} (${harness.settingsPath}):\n${error.message}`);
    }
    process.exit(1);
  }

  // 9. Install the /skilled-pr-update skill template into each harness's
  //    skills directory. The skill orchestrates future upgrades (pm-detect,
  //    run install, migrate --plan/--apply, doctor). Skipped silently if the
  //    template can't be located in the package (matches the schema behavior).
  const skillSource = findUpdateSkillSource();
  if (skillSource !== null) {
    const templateContent = readFileSync(skillSource, "utf8");
    for (const harness of harnesses) {
      installUpdateSkillForHarness(harness, templateContent);
    }
  } else {
    console.warn(
      `⚠ Could not locate bundled templates/skilled-pr-update.skill.md — /skilled-pr-update skill not installed.`,
    );
  }

  // 10. Next steps.
  const harnessList = harnesses.map((h) => h.label).join(" + ");
  console.log(`
Next steps:

  1. Review \`${CONFIG_PATH}\`. List which review skills must run
     before merge under \`requiredSkills\`. Tune \`summaryPrompt\` and
     \`briefingPrompt\` (set to null to use built-in defaults). Add
     per-context \`rules\` if you want stricter gates on release
     branches, label-gated skills, or author-based bypasses.

  2. Enable branch protection on GitHub:
     -> Repo Settings -> Branches -> Branch protection rules
     -> Add rule for your main branch
     -> Check "Require status checks to pass"
     -> Search for "Skilled PR" and add it.

  3. Invoke a required review skill in ${harnessList}. Skilled PR will
     automatically inject attestation instructions, and the model will
     write findings + post the GitHub status.

Tip: \`skilled-pr show\` prints the active config and resolved profile
for the current branch; \`skilled-pr doctor\` diagnoses common issues.

Done!
`);
}
