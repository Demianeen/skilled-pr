import { existsSync, readFileSync } from "node:fs";
import { run } from "./proc";
import { loadConfig, type SkilledPRConfig } from "./config";
import {
  parseGitHubRemote,
  buildStatusContext,
  classifyGhError,
  type GitHubRemote,
} from "./github";
import { parseAttestArgs } from "./args";
import {
  parseFindings,
  findingsExceedingThreshold,
  buildStatusDescription,
  formatArtifactComment,
  extractArtifactSkillName,
  wrapWithArtifactMarker,
  type Finding,
} from "./findings";

type StatusState = "success" | "failure";

export async function attest(args: string[]) {
  const parsed = parseAttestArgs(args);
  if (!parsed.ok) {
    console.error(
      `Usage: skilled-pr attest --skill <name> [--findings <file>] [--summary <file>]\n  (${parsed.error})`,
    );
    process.exit(1);
  }
  const { skill: skillName, findings: findingsPath, summary: summaryPath } = parsed;

  const config = await loadConfig();
  if (!config) {
    console.warn("Skilled PR: no .skilledpr.jsonc found. Run 'skilled-pr init' to set up.");
    process.exit(0);
  }

  const sha = getCommitSha();
  if (!sha) {
    console.error("Skilled PR: not in a git repo or no commits yet.");
    process.exit(1);
  }

  const remote = getRemote();
  if (!remote) {
    console.error("Skilled PR: no GitHub remote configured. Push to GitHub first.");
    process.exit(1);
  }

  // GitHub rejects commit-status posts for SHAs that aren't on the remote
  // ("Not Found (HTTP 404)"). Pre-flight here so the model gets a clear,
  // actionable error instead of a 404 deep in the call stack.
  //
  // Exit code 2 is the explicit "needs push" signal — distinct from generic
  // exit 1 — so the system reminder injected by the hook can pattern-match it
  // and offer push recovery. Users who want silent skip in passive workflows
  // (e.g. post-commit hooks) can wrap the call: `skilled-pr attest ... || true`.
  if (!isCommitPushed(sha)) {
    const retryFlags = [
      `--skill ${skillName}`,
      findingsPath ? `--findings ${findingsPath}` : null,
      summaryPath ? `--summary ${summaryPath}` : null,
    ]
      .filter(Boolean)
      .join(" ");
    const retry = `skilled-pr attest ${retryFlags}`;
    console.error(
      `Skilled PR: HEAD (${sha.slice(0, 7)}) is not pushed to ${remote.owner}/${remote.repo}. ` +
      `GitHub rejects status posts for unknown SHAs.\n\n` +
      `Push the branch first:\n  git push\n\n` +
      `Then re-run:\n  ${retry}`,
    );
    process.exit(2);
  }

  // --- Findings ------------------------------------------------------------

  const findings = findingsPath ? await loadFindings(findingsPath) : null;
  // Optional skill-rendered summary. When provided, replaces the built-in
  // artifact comment body verbatim (with the artifact marker auto-appended
  // so future runs can find and PATCH this same comment). When absent we
  // fall back to formatArtifactComment's auto-render from findings.json.
  const summaryOverride = summaryPath ? loadSummary(summaryPath) : null;

  if (findings !== null) {
    const prNumber = getPullRequestForSha(remote, sha);
    if (prNumber === null) {
      console.warn(
        `Skilled PR: no open PR found for ${sha.slice(0, 7)}. Artifact comment not posted (status check still updates).`,
      );
    } else {
      // Post (or update) the per-skill artifact summary comment. This is now
      // the single PR-visible audit trail for the review - inline comments
      // were dropped in favour of one consolidated summary per skill. The
      // status check (below) is the gate; the artifact is the evidence.
      // Failure here is warn-only - the artifact is evidence, not the gate.
      const artifactResult = postOrUpdateArtifactComment(
        remote,
        prNumber,
        sha,
        findings,
        skillName,
        config.failOn,
        summaryOverride,
      );
      const artifactNote =
        artifactResult === "created"
          ? "artifact comment created"
          : artifactResult === "updated"
            ? "artifact updated"
            : "artifact post failed";
      const summaryNote = summaryOverride ? " (using --summary override)" : "";
      console.log(
        `Skilled PR: ${findings.length} finding(s) on PR #${prNumber} (${artifactNote})${summaryNote}.`,
      );
    }
  }

  // --- Status (with severity gate) -----------------------------------------

  const { state, description } = computeStatus(findings, config, skillName);
  const context = buildStatusContext(config.statusName, skillName);

  if (statusAlreadyMatches(remote, sha, context, state, description)) {
    console.log(
      `Skilled PR: "${context}" already ${state} on ${sha.slice(0, 7)} with matching description. Skipping status.`,
    );
    process.exit(0);
  }

  postStatus(remote, sha, context, state, description);
  const icon = state === "success" ? "✓" : "✗";
  console.log(`Skilled PR ${icon} — ${description} on ${sha.slice(0, 7)}`);
}

function computeStatus(
  findings: Finding[] | null,
  config: SkilledPRConfig,
  skillName: string,
): { state: StatusState; description: string } {
  const description = buildStatusDescription(skillName, findings);
  if (findings === null) return { state: "success", description };
  const blocking = findingsExceedingThreshold(findings, config.failOn);
  return { state: blocking.length > 0 ? "failure" : "success", description };
}

// ---------------------------------------------------------------------------
// Findings helpers
// ---------------------------------------------------------------------------

async function loadFindings(path: string): Promise<Finding[]> {
  if (!existsSync(path)) {
    console.error(`Skilled PR: findings file not found: ${path}`);
    process.exit(1);
  }
  try {
    return parseFindings(readFileSync(path, "utf8"));
  } catch (err) {
    console.error(`Skilled PR: invalid findings file: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * Read the optional --summary file. Missing-file is an error (the skill
 * was told to write it; absence means the skill broke or the path is wrong).
 * Empty-file is also an error - an empty artifact comment is useless and
 * almost certainly a skill bug. Bail loudly in both cases so the model
 * notices and can recover instead of silently posting a blank comment.
 */
function loadSummary(path: string): string {
  if (!existsSync(path)) {
    console.error(
      `Skilled PR: summary file not found: ${path}. ` +
        `The hook reminder asked the skill to write this file; if your skill ` +
        `doesn't produce summaries yet, remove the \`summaryPrompt\` from .skilledpr.jsonc ` +
        `or drop the --summary flag.`,
    );
    process.exit(1);
  }
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) {
    console.error(`Skilled PR: summary file is empty: ${path}.`);
    process.exit(1);
  }
  return raw;
}

function getPullRequestForSha(remote: GitHubRemote, sha: string): number | null {
  const proc = run([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/pulls`,
  ]);
  if (proc.exitCode !== 0) return null;
  try {
    const pulls = JSON.parse(proc.stdout) as Array<{ number: number; state: string }>;
    const open = pulls.find((p) => p.state === "open");
    return open ? open.number : null;
  } catch {
    return null;
  }
}

/**
 * Find the existing artifact comment for a given skill on a PR, if any.
 * Artifact comments are top-level PR comments (issues endpoint, not pulls),
 * tagged with `<!-- skilled-pr:artifact:<skill-name> -->`. Returns the
 * GitHub comment id (for PATCH), or null if no artifact exists yet.
 */
function findExistingArtifactComment(
  remote: GitHubRemote,
  prNumber: number,
  skillName: string,
): number | null {
  const proc = run([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--slurp",
  ]);
  if (proc.exitCode !== 0) return null;
  try {
    // --paginate --slurp wraps each page's array into an outer array.
    const pages = JSON.parse(proc.stdout) as Array<Array<{ id: number; body: string }>>;
    for (const page of pages) {
      for (const c of page) {
        if (extractArtifactSkillName(c.body) === skillName) return c.id;
      }
    }
  } catch {
    // malformed JSON — treat as no existing artifact, will POST a new one
  }
  return null;
}

/**
 * Post or update the per-skill artifact summary comment. Returns the action
 * taken — used by the caller for log output. Never throws / exits; the
 * artifact is evidence, not a gate.
 */
function postOrUpdateArtifactComment(
  remote: GitHubRemote,
  prNumber: number,
  sha: string,
  findings: Finding[],
  skillName: string,
  failOn: SkilledPRConfig["failOn"],
  summaryOverride: string | null,
): "created" | "updated" | "failed" {
  // When a skill-rendered summary is provided, use it verbatim and just
  // append the artifact marker so future runs find this same comment for
  // PATCH-in-place updates. Otherwise auto-render from findings.json.
  const body = summaryOverride
    ? wrapWithArtifactMarker(summaryOverride, skillName)
    : formatArtifactComment(skillName, sha, findings, failOn);
  const existingId = findExistingArtifactComment(remote, prNumber, skillName);

  const payload = JSON.stringify({ body });

  if (existingId !== null) {
    // Update existing — PATCH /issues/comments/<id>
    const proc = run(
      [
        "gh", "api",
        `repos/${remote.owner}/${remote.repo}/issues/comments/${existingId}`,
        "-X", "PATCH",
        "--input", "-",
      ],
      payload,
    );
    if (proc.exitCode !== 0) {
      const classified = classifyGhError(proc.stderr, {
        operation: "edit-comment",
        remote,
      });
      console.warn(`Skilled PR: artifact comment update failed.\n\n${classified.message}`);
      return "failed";
    }
    return "updated";
  }

  // Create new — POST /issues/<n>/comments
  const proc = run(
    [
      "gh", "api",
      `repos/${remote.owner}/${remote.repo}/issues/${prNumber}/comments`,
      "-X", "POST",
      "--input", "-",
    ],
    payload,
  );
  if (proc.exitCode !== 0) {
    const classified = classifyGhError(proc.stderr, {
      operation: "post-comment",
      remote,
    });
    console.warn(`Skilled PR: artifact comment post failed.\n\n${classified.message}`);
    return "failed";
  }
  return "created";
}

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

function getCommitSha(): string | null {
  const proc = run(["git", "rev-parse", "HEAD"]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.trim();
}

function getRemote(): GitHubRemote | null {
  const proc = run(["git", "remote", "get-url", "origin"]);
  if (proc.exitCode !== 0) return null;
  return parseGitHubRemote(proc.stdout);
}

/**
 * Is `sha` reachable on `origin` (the remote we post statuses to)? `git branch
 * -r --contains` lists hits across ALL remotes by default, so a sha that exists
 * on `upstream` but not `origin` would falsely pass — then `gh api ... statuses
 * /<sha>` 404s on origin. Scope the lookup to origin/* with `--list`. Found by
 * adversarial review of fork-based workflows.
 */
function isCommitPushed(sha: string): boolean {
  const proc = run([
    "git", "branch", "-r", "--contains", sha, "--list", "origin/*",
  ]);
  return proc.exitCode === 0 && proc.stdout.trim().length > 0;
}

/**
 * The GitHub commit-status API lets you POST multiple statuses per (sha,
 * context) — the latest wins visually. Dedupe here means: only skip if the
 * *most recent* status for our context already has the same state AND
 * description. If any detail differs (a new severity count, a flip from
 * success to failure), we want to POST to replace it.
 */
function statusAlreadyMatches(
  remote: GitHubRemote,
  sha: string,
  context: string,
  state: StatusState,
  description: string,
): boolean {
  const proc = run([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
  ]);
  if (proc.exitCode !== 0) return false;
  try {
    const statuses = JSON.parse(proc.stdout) as Array<{
      context: string;
      state: string;
      description: string | null;
    }>;
    // GitHub returns statuses most recent first.
    const latest = statuses.find((s) => s.context === context);
    return latest?.state === state && (latest?.description ?? "") === description;
  } catch {
    return false;
  }
}

function postStatus(
  remote: GitHubRemote,
  sha: string,
  context: string,
  state: StatusState,
  description: string,
) {
  const proc = run([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/statuses/${sha}`,
    "-X", "POST",
    "-f", `state=${state}`,
    "-f", `context=${context}`,
    "-f", `description=${description}`,
  ]);

  if (proc.exitCode !== 0) {
    const classified = classifyGhError(proc.stderr, { operation: "post-status", remote });
    console.error(classified.message);
    process.exit(1);
  }
}
