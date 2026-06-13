// skilled-pr enable-gate
//
// Automates the only manual step `init` currently leaves to the user: going
// to GitHub Settings → Branches → Branch protection rules and adding the
// Skilled PR status checks as required. One command replaces five clicks.
//
// Strategy:
//   1. Read `.skilledpr.jsonc` for requiredSkills + statusName
//   2. Build the expected contexts list (e.g. `Skilled PR / review`)
//   3. GET the existing protection on the default branch
//      - If 404 (no protection) → PUT a minimal protection with our contexts
//      - If exists → POST only the MISSING contexts (additive, non-destructive)
//
// The additive path is critical: users may have already set up PR-review
// requirements, admin enforcement, push restrictions, etc. We must not
// clobber any of that. GitHub's `POST .../required_status_checks/contexts`
// endpoint is purpose-built for this.

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

import { run } from "./proc";
import { collectAllSkillNames, loadConfig } from "./config";
import { findBypassWorkflowSource, writeFileWithMkdir } from "./init";
import {
  parseGitHubRemote,
  buildStatusContext,
  classifyGhError,
  type GitHubRemote,
} from "./github";

export const BYPASS_WORKFLOW_PATH = ".github/workflows/skilled-pr-bypass.yml";

// ---------------------------------------------------------------------------
// Pure helpers (testable, no I/O)
// ---------------------------------------------------------------------------

/**
 * Read the package's own version at runtime so the workflow's version
 * pin matches the CLI that wrote it. Falls back to "latest" if package.json
 * can't be located (shouldn't happen in a sane install).
 */
function readOwnVersion(): string {
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
 * Substitute the version placeholder in the workflow template. Exported
 * pure for tests.
 */
export function renderBypassWorkflow(templateContent: string, version: string): string {
  return templateContent.replaceAll("__SKILLED_PR_VERSION__", version);
}

/**
 * Write the skilled-pr-bypass workflow with the CLI's current version
 * pinned in. Idempotent: writes only if content differs. Returns the
 * action taken so the caller can log it appropriately.
 */
export function writeBypassWorkflow(): "created" | "updated" | "skipped" | "missing-template" {
  const source = findBypassWorkflowSource();
  if (source === null) return "missing-template";
  const template = readFileSync(source, "utf8");
  const rendered = renderBypassWorkflow(template, readOwnVersion());
  const existing = existsSync(BYPASS_WORKFLOW_PATH)
    ? readFileSync(BYPASS_WORKFLOW_PATH, "utf8")
    : null;
  if (existing === rendered) return "skipped";
  writeFileWithMkdir(BYPASS_WORKFLOW_PATH, rendered);
  return existing === null ? "created" : "updated";
}

/**
 * Build the list of status-check contexts that should be required, given
 * the configured `requiredSkills` and `statusName`. Mirrors what `attest`
 * produces via `buildStatusContext`.
 */
export function buildRequiredContexts(
  requiredSkills: ReadonlyArray<string>,
  statusName: string,
): string[] {
  return requiredSkills.map((skill) => buildStatusContext(statusName, skill));
}

/**
 * Compare expected contexts against what's already required. Returns
 * `missing` (need to add) and `present` (already there) — `extra` is
 * intentionally NOT returned because we don't touch other tools' contexts.
 */
export function diffContexts(
  existing: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
): { missing: string[]; present: string[] } {
  const existingSet = new Set(existing);
  const missing: string[] = [];
  const present: string[] = [];
  for (const ctx of expected) {
    if (existingSet.has(ctx)) present.push(ctx);
    else missing.push(ctx);
  }
  return { missing, present };
}

/**
 * Build the JSON payload for `PUT /branches/<b>/protection`. Used only
 * when no protection exists yet — must include the full set of top-level
 * fields (GitHub rejects partial payloads).
 *
 * Defaults:
 *  - strict: false (don't force branches up-to-date; users can opt in later)
 *  - admins, PR reviews, restrictions: null (off — user can configure separately)
 */
export function buildInitialProtectionPayload(contexts: ReadonlyArray<string>): object {
  return {
    required_status_checks: {
      strict: false,
      contexts: [...contexts],
    },
    enforce_admins: null,
    required_pull_request_reviews: null,
    restrictions: null,
  };
}

// ---------------------------------------------------------------------------
// I/O entry point
// ---------------------------------------------------------------------------

// `tryRun` was extracted to `./proc` as `run` so attest.ts, branch-protection.ts,
// and doctor.ts share one implementation. Local alias keeps callsites unchanged.
const tryRun = run;

function getRemote(): GitHubRemote | null {
  const result = tryRun(["git", "remote", "get-url", "origin"]);
  if (result.exitCode !== 0) return null;
  return parseGitHubRemote(result.stdout);
}

function getDefaultBranch(): string {
  const result = tryRun([
    "gh",
    "repo",
    "view",
    "--json",
    "defaultBranchRef",
    "-q",
    ".defaultBranchRef.name",
  ]);
  if (result.exitCode !== 0) return "main";
  const branch = result.stdout.trim();
  return branch.length > 0 ? branch : "main";
}

/** Fetch existing required-status-check contexts, or null on 404. */
function fetchExistingContexts(remote: GitHubRemote, branch: string): {
  contexts: string[] | null;
  exitCode: number;
  stderr: string;
} {
  const result = tryRun([
    "gh",
    "api",
    `repos/${remote.owner}/${remote.repo}/branches/${branch}/protection/required_status_checks`,
  ]);
  if (result.exitCode !== 0) {
    return { contexts: null, exitCode: result.exitCode, stderr: result.stderr };
  }
  try {
    const parsed = JSON.parse(result.stdout) as { contexts?: string[] };
    return { contexts: parsed.contexts ?? [], exitCode: 0, stderr: "" };
  } catch {
    return { contexts: null, exitCode: -1, stderr: "malformed JSON response from gh" };
  }
}

export async function enableGate() {
  // 1. Load config
  const config = await loadConfig();
  if (!config) {
    console.error("Skilled PR: no .skilledpr/config.jsonc found. Run `skilled-pr init` first.");
    process.exit(1);
  }
  // Branch protection is static while rules resolve per-PR, so the gate
  // must register the UNION of every skill any PR could require (top-level
  // defaults + every rule's override). ci-resolve posts "not required for
  // this PR" successes on the contexts a given PR's profile doesn't use.
  const allSkills = collectAllSkillNames(config);
  if (allSkills.length === 0) {
    console.error(
      "Skilled PR: no skills are required anywhere — requiredSkills is empty and no rule adds any. Add at least one skill.",
    );
    process.exit(1);
  }

  // 2. Detect remote
  const remote = getRemote();
  if (!remote) {
    console.error("Skilled PR: no GitHub remote configured for `origin`. Push to GitHub first.");
    process.exit(1);
  }

  // 3. Detect default branch
  const branch = getDefaultBranch();

  // 4. Build expected contexts (union across defaults + rules)
  const expected = buildRequiredContexts(allSkills, config.statusName);

  console.log(`Skilled PR: enabling gate on ${remote.owner}/${remote.repo}@${branch}`);
  console.log(`  Required checks: ${expected.join(", ")}`);

  // 5. Look at existing protection
  const existing = fetchExistingContexts(remote, branch);
  const protectionExists = existing.contexts !== null;

  if (!protectionExists) {
    // No protection at all — create one with our contexts. Uses PUT, which
    // requires the full top-level payload.
    const payload = JSON.stringify(buildInitialProtectionPayload(expected));
    const result = tryRun(
      [
        "gh",
        "api",
        `repos/${remote.owner}/${remote.repo}/branches/${branch}/protection`,
        "-X",
        "PUT",
        "--input",
        "-",
      ],
      payload,
    );
    if (result.exitCode !== 0) {
      const classified = classifyGhError(result.stderr, { operation: "post-status", remote });
      console.error(
        `Skilled PR: failed to create branch protection on ${branch}.\n\n${classified.message}`,
      );
      process.exit(1);
    }
    console.log(
      `Skilled PR: ✓ created branch protection on ${branch} with ${expected.length} required check(s).`,
    );
    return;
  }

  // Protection already exists — only add the MISSING contexts. Additive,
  // non-destructive, idempotent.
  const { missing, present } = diffContexts(existing.contexts!, expected);
  if (missing.length === 0) {
    console.log(
      `Skilled PR: ✓ all required checks already configured (${present.length}/${expected.length} present).`,
    );
    return;
  }

  console.log(
    `Skilled PR: adding ${missing.length} missing check(s); ${present.length} already present.`,
  );

  // POST to .../contexts — body is just a JSON array of context names.
  const result = tryRun(
    [
      "gh",
      "api",
      `repos/${remote.owner}/${remote.repo}/branches/${branch}/protection/required_status_checks/contexts`,
      "-X",
      "POST",
      "--input",
      "-",
    ],
    JSON.stringify(missing),
  );
  if (result.exitCode !== 0) {
    const classified = classifyGhError(result.stderr, { operation: "post-status", remote });
    console.error(`Skilled PR: failed to add status checks.\n\n${classified.message}`);
    process.exit(1);
  }
  console.log(
    `Skilled PR: ✓ added ${missing.length} required check(s) to ${branch} (existing rules preserved).`,
  );

  // 6. Write the bypass workflow file. CI runs `ci-resolve --post` on
  //    every PR event; PRs that resolve to `requiredSkills: []` (via a
  //    matching bypass rule) auto-succeed without anyone running a
  //    skill. PRs that still need a review get a pending status with
  //    a CTA description until attest replaces it. The workflow is a
  //    pure status-poster — no AI runs in CI.
  writeBypassWorkflowWithLog();
}

/**
 * Convenience wrapper around `writeBypassWorkflow` that logs the result.
 * Extracted so the migrator (in src/migrate.ts) can reuse the underlying
 * write logic without duplicating the log messages.
 */
function writeBypassWorkflowWithLog(): void {
  const result = writeBypassWorkflow();
  switch (result) {
    case "created":
      console.log(`Skilled PR: ✓ wrote ${BYPASS_WORKFLOW_PATH}.`);
      break;
    case "updated":
      console.log(`Skilled PR: ✓ refreshed ${BYPASS_WORKFLOW_PATH} (pinned to current version).`);
      break;
    case "skipped":
      console.log(`Skilled PR: ${BYPASS_WORKFLOW_PATH} already up to date.`);
      break;
    case "missing-template":
      console.warn(
        `⚠ Could not locate templates/skilled-pr-bypass.yml in the package. ` +
          `${BYPASS_WORKFLOW_PATH} not written. The PR gate will still work via attest, ` +
          `but bypass rules (requiredSkills: []) won't auto-succeed on CI.`,
      );
      break;
  }
}
