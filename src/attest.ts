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
  formatCommentBody,
  extractFingerprint,
  findingsExceedingThreshold,
  buildStatusDescription,
  formatArtifactComment,
  extractArtifactSkillName,
  type Finding,
} from "./findings";

type StatusState = "success" | "failure";

export async function attest(args: string[]) {
  const parsed = parseAttestArgs(args);
  if (!parsed.ok) {
    console.error(
      `Usage: skilled-pr attest --skill <name> [--findings <file>]\n  (${parsed.error})`,
    );
    process.exit(1);
  }
  const { skill: skillName, findings: findingsPath } = parsed;

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
    const retry = findingsPath
      ? `skilled-pr attest --skill ${skillName} --findings ${findingsPath}`
      : `skilled-pr attest --skill ${skillName}`;
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

  if (findings !== null) {
    const prNumber = getPullRequestForSha(remote, sha);
    if (prNumber === null) {
      console.warn(
        `Skilled PR: no open PR found for ${sha.slice(0, 7)}. ${findings.length} finding(s) not posted.`,
      );
    } else {
      const result = postFindingsAsComments(remote, prNumber, sha, findings, skillName);
      // Always post (or update) the per-skill artifact summary comment, even
      // when there are zero findings. That's the whole point — the artifact is
      // the audit trail that a review actually ran. Failures here warn-only —
      // the artifact is evidence, not the gate.
      const artifactResult = postOrUpdateArtifactComment(
        remote,
        prNumber,
        sha,
        findings,
        skillName,
        config.failOn,
      );
      const artifactNote =
        artifactResult === "created"
          ? "artifact comment created"
          : artifactResult === "updated"
            ? "artifact updated"
            : "artifact post failed";
      console.log(
        `Skilled PR: posted ${result.new} new, skipped ${result.skipped} existing finding(s) on PR #${prNumber} (${artifactNote}).`,
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
  const file = Bun.file(path);
  if (!(await file.exists())) {
    console.error(`Skilled PR: findings file not found: ${path}`);
    process.exit(1);
  }
  try {
    return parseFindings(await file.text());
  } catch (err) {
    console.error(`Skilled PR: invalid findings file: ${(err as Error).message}`);
    process.exit(1);
  }
}

function getPullRequestForSha(remote: GitHubRemote, sha: string): number | null {
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/pulls`,
  ]);
  if (proc.exitCode !== 0) return null;
  try {
    const pulls = JSON.parse(proc.stdout.toString()) as Array<{ number: number; state: string }>;
    const open = pulls.find((p) => p.state === "open");
    return open ? open.number : null;
  } catch {
    return null;
  }
}

function fetchExistingFingerprints(remote: GitHubRemote, prNumber: number): Set<string> {
  // `gh api --paginate` emits multiple concatenated JSON arrays for PRs with
  // >100 comments (one array per page). `JSON.parse` chokes on that. `--slurp`
  // wraps the pages into a single Array<Array<...>> which we flatten. Without
  // slurp, the parse silently fails → empty Set → every finding posts again as
  // a duplicate on every re-run. Found by adversarial review.
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/pulls/${prNumber}/comments`,
    "--paginate",
    "--slurp",
  ]);
  const seen = new Set<string>();
  if (proc.exitCode !== 0) return seen;
  try {
    const pages = JSON.parse(proc.stdout.toString()) as Array<Array<{ body: string }>>;
    for (const page of pages) {
      for (const c of page) {
        const fp = extractFingerprint(c.body);
        if (fp) seen.add(fp);
      }
    }
  } catch {
    // malformed JSON from gh — treat as no existing fingerprints
  }
  return seen;
}

function postFindingsAsComments(
  remote: GitHubRemote,
  prNumber: number,
  sha: string,
  findings: Finding[],
  skillName: string,
): { new: number; skipped: number } {
  const existing = fetchExistingFingerprints(remote, prNumber);
  let newCount = 0;
  let skipped = 0;

  for (const finding of findings) {
    if (existing.has(finding.fingerprint)) {
      skipped++;
      continue;
    }

    // Use --input to pipe a full JSON payload via stdin. Avoids `gh api -f`'s
    // `@`-prefix file-reference behavior, which would silently break any
    // finding whose body starts with `@` (e.g. documenting a Python decorator).
    const payload = JSON.stringify({
      body: formatCommentBody(finding, skillName),
      commit_id: sha,
      path: finding.path,
      line: finding.line,
      side: finding.side ?? "RIGHT",
    });

    const proc = Bun.spawnSync(
      [
        "gh", "api",
        `repos/${remote.owner}/${remote.repo}/pulls/${prNumber}/comments`,
        "-X", "POST",
        "--input", "-",
      ],
      { stdin: Buffer.from(payload) },
    );

    if (proc.exitCode !== 0) {
      const stderr = proc.stderr.toString();
      const classified = classifyGhError(stderr, { operation: "post-comment", remote });
      console.error(
        `Skilled PR: failed to post comment for ${finding.path}:${finding.line}.\n\n${classified.message}`,
      );
      process.exit(1);
    }
    newCount++;
  }

  return { new: newCount, skipped };
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
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/issues/${prNumber}/comments`,
    "--paginate",
    "--slurp",
  ]);
  if (proc.exitCode !== 0) return null;
  try {
    // --paginate --slurp wraps each page's array into an outer array.
    const pages = JSON.parse(proc.stdout.toString()) as Array<Array<{ id: number; body: string }>>;
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
): "created" | "updated" | "failed" {
  const body = formatArtifactComment(skillName, sha, findings, failOn);
  const existingId = findExistingArtifactComment(remote, prNumber, skillName);

  const payload = JSON.stringify({ body });

  if (existingId !== null) {
    // Update existing — PATCH /issues/comments/<id>
    const proc = Bun.spawnSync(
      [
        "gh", "api",
        `repos/${remote.owner}/${remote.repo}/issues/comments/${existingId}`,
        "-X", "PATCH",
        "--input", "-",
      ],
      { stdin: Buffer.from(payload) },
    );
    if (proc.exitCode !== 0) {
      const classified = classifyGhError(proc.stderr.toString(), {
        operation: "edit-comment",
        remote,
      });
      console.warn(`Skilled PR: artifact comment update failed.\n\n${classified.message}`);
      return "failed";
    }
    return "updated";
  }

  // Create new — POST /issues/<n>/comments
  const proc = Bun.spawnSync(
    [
      "gh", "api",
      `repos/${remote.owner}/${remote.repo}/issues/${prNumber}/comments`,
      "-X", "POST",
      "--input", "-",
    ],
    { stdin: Buffer.from(payload) },
  );
  if (proc.exitCode !== 0) {
    const classified = classifyGhError(proc.stderr.toString(), {
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
  const proc = Bun.spawnSync(["git", "rev-parse", "HEAD"]);
  if (proc.exitCode !== 0) return null;
  return proc.stdout.toString().trim();
}

function getRemote(): GitHubRemote | null {
  const proc = Bun.spawnSync(["git", "remote", "get-url", "origin"]);
  if (proc.exitCode !== 0) return null;
  return parseGitHubRemote(proc.stdout.toString());
}

/**
 * Is `sha` reachable on `origin` (the remote we post statuses to)? `git branch
 * -r --contains` lists hits across ALL remotes by default, so a sha that exists
 * on `upstream` but not `origin` would falsely pass — then `gh api ... statuses
 * /<sha>` 404s on origin. Scope the lookup to origin/* with `--list`. Found by
 * adversarial review of fork-based workflows.
 */
function isCommitPushed(sha: string): boolean {
  const proc = Bun.spawnSync([
    "git", "branch", "-r", "--contains", sha, "--list", "origin/*",
  ]);
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
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
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
  ]);
  if (proc.exitCode !== 0) return false;
  try {
    const statuses = JSON.parse(proc.stdout.toString()) as Array<{
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
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/statuses/${sha}`,
    "-X", "POST",
    "-f", `state=${state}`,
    "-f", `context=${context}`,
    "-f", `description=${description}`,
  ]);

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString();
    const classified = classifyGhError(stderr, { operation: "post-status", remote });
    console.error(classified.message);
    process.exit(1);
  }
}
