// skilled-pr migrate
//
// Walks a user from any prior config state (or stale bundled files) to the
// state the currently-installed CLI expects. Two modes:
//
//   - --plan       Print the migration plan without mutating anything.
//   - --apply      Execute the plan.
//
// Default (no flag) is --plan.
//
// The plan today is intentionally small because there's no historical
// schema yet — v1 is the first formal schemaVersion. The slots that exist:
//
//   1. schemaVersion mismatch (config older than CLI, or newer)
//   2. bundled .skilledpr/schema.json drifted from the CLI's
//      schema/v1.json (happens when the user upgrades the CLI but never
//      re-runs init)
//
// Future migrations (v1 → v2, prompt-default upgrades, etc.) land here as
// new step kinds. The `/skilled-pr-update` skill orchestrates this: it
// invokes `skilled-pr migrate --plan`, shows the plan to the user, asks
// for confirmation, then invokes `--apply`.
//
// Failure mode: if `--apply` runs into a step that can't apply cleanly,
// the CLI stops at the failing step and exits non-zero. Already-applied
// steps stay applied (each step is atomic) so re-running --apply picks
// up where it left off.

import { existsSync, readFileSync } from "node:fs";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { CONFIG_PATH, CURRENT_SCHEMA_VERSION, loadConfig } from "./config";
import { findSchemaSource, writeFileWithMkdir } from "./init";

const BUNDLED_SCHEMA_PATH = ".skilledpr/schema.json";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One discrete migration action. Each step is independently apply-able and
 * idempotent — running an already-applied step is a no-op.
 *
 * `id` is the stable identifier (used in tests and the apply log). `title`
 * is the one-line human-readable description shown in the plan output.
 * `detail` is the optional explanatory paragraph shown below the title.
 * `apply` mutates the filesystem and returns a confirmation message; throws
 * on unrecoverable failure.
 */
export interface MigrationStep {
  readonly id: string;
  readonly title: string;
  readonly detail?: string;
  apply(): string;
}

/**
 * Plan: the ordered list of steps that bring the project to the
 * CLI-expected state. `currentSchemaVersion` is what the user has on disk
 * (or `null` if the config is missing); `cliSchemaVersion` is what the
 * binary expects. A plan with zero steps means everything is up to date.
 */
export interface MigrationPlan {
  readonly currentSchemaVersion: number | null;
  readonly cliSchemaVersion: number;
  readonly steps: MigrationStep[];
}

// ---------------------------------------------------------------------------
// Pure plan construction
// ---------------------------------------------------------------------------

/**
 * Compare the on-disk config + bundled files against the CLI's expectations
 * and build the migration plan. Pure where possible — reads files (relative
 * to the process cwd) but does not mutate. Tests point it at fixtures by
 * `process.chdir`-ing into a tmp dir (there is no cwd parameter).
 *
 * Read failures (missing config, missing bundled schema) are translated
 * into plan steps where appropriate — running migrate on a fresh repo with
 * no config still produces useful output ("config not found; run init
 * first") rather than crashing.
 */
export async function planMigration(): Promise<MigrationPlan> {
  const steps: MigrationStep[] = [];

  // --- 1. shallow schemaVersion peek
  //
  // The full `loadConfig` parser rejects any schemaVersion that doesn't
  // exactly match CURRENT_SCHEMA_VERSION, which loses the signal we need
  // here ("newer than CLI" vs "older than CLI" vs "syntactically broken").
  // Do a shallow JSONC parse of just the top-level schemaVersion field
  // first so the planner can distinguish those cases. If the shallow
  // parse fails outright, emit a parse-error step. If the value is
  // newer than CURRENT, emit a "upgrade CLI" step instead of trying to
  // load.
  if (!existsSync(CONFIG_PATH)) {
    steps.push({
      id: "config-missing",
      title: `${CONFIG_PATH} not found`,
      detail: "Run `skilled-pr init` to create a config before migrating.",
      apply() {
        throw new Error(
          `Cannot auto-apply: no config to migrate. Run \`skilled-pr init\` first.`,
        );
      },
    });
    return {
      currentSchemaVersion: null,
      cliSchemaVersion: CURRENT_SCHEMA_VERSION,
      steps,
    };
  }

  const raw = readFileSync(CONFIG_PATH, "utf8");
  const parseErrors: ParseError[] = [];
  const shallow = parseJsonc(raw, parseErrors, { allowTrailingComma: true });
  let configSchemaVersion: number | null = null;
  if (parseErrors.length === 0 && shallow !== null && typeof shallow === "object" && !Array.isArray(shallow)) {
    const sv = (shallow as Record<string, unknown>).schemaVersion;
    if (typeof sv === "number") configSchemaVersion = sv;
  }

  if (parseErrors.length > 0) {
    steps.push({
      id: "config-parse-error",
      title: `${CONFIG_PATH} has syntax errors`,
      detail: `Fix the JSONC syntax in ${CONFIG_PATH} before migrating.`,
      apply() {
        throw new Error(
          `Cannot auto-apply: fix the config syntax in ${CONFIG_PATH} first, then re-run migrate.`,
        );
      },
    });
    return {
      currentSchemaVersion: null,
      cliSchemaVersion: CURRENT_SCHEMA_VERSION,
      steps,
    };
  }

  if (configSchemaVersion !== null && configSchemaVersion > CURRENT_SCHEMA_VERSION) {
    // Config newer than CLI — user upgraded the config without upgrading the
    // CLI. Migrate can't fix this; surface the issue with a step that
    // explicitly refuses to apply.
    steps.push({
      id: "config-newer-than-cli",
      title: `Config schemaVersion ${configSchemaVersion} is newer than this CLI (v${CURRENT_SCHEMA_VERSION})`,
      detail: `Upgrade skilled-pr to a version that supports schemaVersion ${configSchemaVersion}, or downgrade the config.`,
      apply() {
        throw new Error(
          `Cannot auto-apply: config requires CLI to support schemaVersion ${configSchemaVersion}. ` +
            `Run \`pnpm add -D skilled-pr@latest\` (or the equivalent for your package manager) and try again.`,
        );
      },
    });
    return {
      currentSchemaVersion: configSchemaVersion,
      cliSchemaVersion: CURRENT_SCHEMA_VERSION,
      steps,
    };
  }

  // Now safe to do the full validating load. If THAT throws, the config
  // has a non-version validation error (wrong type, missing required
  // field, etc.) — surface as parse-error too since the user-facing fix
  // is the same shape: edit the config.
  try {
    await loadConfig();
  } catch (e) {
    steps.push({
      id: "config-parse-error",
      title: `${CONFIG_PATH} fails validation`,
      detail: (e as Error).message,
      apply() {
        throw new Error(
          `Cannot auto-apply: fix the config in ${CONFIG_PATH} first, then re-run migrate.`,
        );
      },
    });
    return {
      currentSchemaVersion: configSchemaVersion,
      cliSchemaVersion: CURRENT_SCHEMA_VERSION,
      steps,
    };
  }

  // v0 → v1 migration intentionally NOT implemented here: v0 was the
  // pre-formal-schema shape (root-level .skilledpr.jsonc with required
  // fields), and there are zero users on it. The error message in
  // config.ts already tells those users to re-init. Future migrations
  // (v1 → v2, etc.) attach here as new step kinds.

  // --- 2. bundled schema freshness check
  // The CLI ships schema/v1.json; init copies it to
  // .skilledpr/schema.json so editors find it via the $schema reference.
  // If the user upgraded the CLI, the in-repo copy can drift.
  const bundledSchemaSource = findSchemaSource();
  if (bundledSchemaSource !== null) {
    const cliSchemaContent = readFileSync(bundledSchemaSource, "utf8");
    const inRepoSchemaContent = existsSync(BUNDLED_SCHEMA_PATH)
      ? readFileSync(BUNDLED_SCHEMA_PATH, "utf8")
      : null;
    if (inRepoSchemaContent === null) {
      steps.push({
        id: "schema-json-missing",
        title: `${BUNDLED_SCHEMA_PATH} is missing`,
        detail:
          "Editors rely on this file for the $schema reference in config.jsonc. " +
          "Apply will copy the CLI's bundled schema/v1.json into place.",
        apply() {
          writeFileWithMkdir(BUNDLED_SCHEMA_PATH, cliSchemaContent);
          return `✓ Wrote ${BUNDLED_SCHEMA_PATH} (${cliSchemaContent.length} bytes)`;
        },
      });
    } else if (inRepoSchemaContent !== cliSchemaContent) {
      steps.push({
        id: "schema-json-stale",
        title: `${BUNDLED_SCHEMA_PATH} differs from the CLI's bundled schema`,
        detail:
          "The CLI ships an updated schema/v1.json; your in-repo copy is out of date. " +
          "Apply will overwrite the in-repo copy with the CLI's current version.",
        apply() {
          writeFileWithMkdir(BUNDLED_SCHEMA_PATH, cliSchemaContent);
          return `✓ Refreshed ${BUNDLED_SCHEMA_PATH} (${cliSchemaContent.length} bytes)`;
        },
      });
    }
  }
  // If `findSchemaSource()` returns null we can't compare, but doctor
  // already warns about that case ("can't locate bundled schema"); no need
  // to add a duplicate plan item.

  return {
    currentSchemaVersion: configSchemaVersion,
    cliSchemaVersion: CURRENT_SCHEMA_VERSION,
    steps,
  };
}

// ---------------------------------------------------------------------------
// Plan formatting
// ---------------------------------------------------------------------------

/**
 * Format a plan as the text printed by `migrate --plan` (and by `--apply`
 * as a confirmation header before mutating). Kept separate from the
 * planner so the orchestrating skill can format the plan its own way if
 * needed — call `planMigration()` and consume the structured `steps[]`
 * instead.
 */
export function formatPlan(plan: MigrationPlan, opts: { showApplyHint?: boolean } = {}): string {
  // showApplyHint defaults true (the `--plan`/default view tells the user how
  // to execute). The `--apply` path passes false — printing "run --apply"
  // while already applying is self-contradictory.
  const showApplyHint = opts.showApplyHint ?? true;
  const lines: string[] = [];
  const versionLine =
    plan.currentSchemaVersion === null
      ? `Config schemaVersion: (not found) -> CLI schemaVersion: ${plan.cliSchemaVersion}`
      : plan.currentSchemaVersion === plan.cliSchemaVersion
        ? `Config schemaVersion: ${plan.currentSchemaVersion} (matches CLI)`
        : `Config schemaVersion: ${plan.currentSchemaVersion} -> CLI schemaVersion: ${plan.cliSchemaVersion}`;
  lines.push(versionLine);
  lines.push("");
  if (plan.steps.length === 0) {
    lines.push("Everything is up to date. No migration steps needed.");
    return lines.join("\n");
  }
  lines.push(`${plan.steps.length} step${plan.steps.length === 1 ? "" : "s"}:`);
  lines.push("");
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    lines.push(`  ${i + 1}. ${step.title}`);
    if (step.detail) {
      // Indent the detail under the step number for readability.
      for (const detailLine of step.detail.split("\n")) {
        lines.push(`     ${detailLine}`);
      }
    }
  }
  if (showApplyHint) {
    lines.push("");
    lines.push("Run `skilled-pr migrate --apply` to execute these steps.");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

/**
 * Run each step in order, printing its confirmation line. Stops at the
 * first failing step and re-throws (the caller exits non-zero). Steps are
 * idempotent so a partial run leaves the project in a consistent (if
 * incomplete) state; re-running `--apply` continues from the failing step.
 */
export function applyPlan(plan: MigrationPlan): void {
  if (plan.steps.length === 0) {
    console.log("Nothing to apply.");
    return;
  }
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    process.stdout.write(`[${i + 1}/${plan.steps.length}] ${step.title} ... `);
    try {
      const result = step.apply();
      console.log("");
      console.log(`         ${result}`);
    } catch (e) {
      console.log("FAILED");
      throw e;
    }
  }
}

// ---------------------------------------------------------------------------
// CLI entry
// ---------------------------------------------------------------------------

export async function migrate(argv: string[]): Promise<void> {
  const apply = argv.includes("--apply");
  const planOnly = argv.includes("--plan");
  if (apply && planOnly) {
    console.error("skilled-pr migrate: pass either --plan or --apply, not both.");
    process.exit(1);
  }

  const plan = await planMigration();

  if (apply) {
    // Print the plan first so the user always sees what's about to change.
    // No apply-hint here — we're already applying, so "run --apply" is circular.
    console.log(formatPlan(plan, { showApplyHint: false }));
    console.log("");
    if (plan.steps.length === 0) return;
    console.log("Applying:");
    console.log("");
    try {
      applyPlan(plan);
    } catch (e) {
      console.error("");
      console.error(`skilled-pr migrate: ${(e as Error).message}`);
      process.exit(1);
    }
    console.log("");
    console.log("Done. Run `skilled-pr doctor` to verify the new state.");
    return;
  }

  // Default and --plan both print the plan and exit without mutating.
  console.log(formatPlan(plan));
}
