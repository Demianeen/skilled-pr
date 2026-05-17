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

import { spawnSync } from "node:child_process";
import { loadConfig } from "./config";
import {
  parseGitHubRemote,
  buildStatusContext,
  classifyGhError,
  type GitHubRemote,
} from "./github";

// ---------------------------------------------------------------------------
// Pure helpers (testable, no I/O)
// ---------------------------------------------------------------------------

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

function tryRun(args: string[], stdin?: string): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  // Node's spawnSync takes (command, args[], options). The exit code is
  // `status` (can be null when killed by signal — treat as -1). We pipe
  // stdin via the `input` option when caller provided one.
  const proc = spawnSync(args[0], args.slice(1), {
    encoding: "utf8",
    input: stdin,
  });
  return {
    stdout: proc.stdout ?? "",
    stderr: proc.stderr ?? "",
    exitCode: proc.status ?? -1,
  };
}

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
    console.error("Skilled PR: no .skilledpr.jsonc found. Run `skilled-pr init` first.");
    process.exit(1);
  }
  if (config.requiredSkills.length === 0) {
    console.error("Skilled PR: requiredSkills is empty in .skilledpr.jsonc. Add at least one skill.");
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

  // 4. Build expected contexts
  const expected = buildRequiredContexts(config.requiredSkills, config.statusName);

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
}
