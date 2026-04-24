import { loadConfig } from "./config";
import { parseGitHubRemote, buildStatusContext, type GitHubRemote } from "./github";
import { parseAttestArgs } from "./args";
import {
  parseFindings,
  formatCommentBody,
  extractFingerprint,
  type Finding,
} from "./findings";

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

  if (config.sha === "pushed" && !isCommitPushed(sha)) {
    console.warn(
      `Skilled PR: HEAD (${sha.slice(0, 7)}) is not pushed to remote. Skipping attestation.`,
    );
    process.exit(0);
  }

  // --- Findings (Phase 1.5) -------------------------------------------------

  if (findingsPath) {
    const findings = await loadFindings(findingsPath);
    const prNumber = getPullRequestForSha(remote, sha);

    if (prNumber === null) {
      console.warn(
        `Skilled PR: no open PR found for ${sha.slice(0, 7)}. ${findings.length} finding(s) not posted.`,
      );
    } else {
      const result = postFindingsAsComments(remote, prNumber, sha, findings, skillName);
      console.log(
        `Skilled PR: posted ${result.new} new, skipped ${result.skipped} existing finding(s) on PR #${prNumber}.`,
      );
    }
  }

  // --- Status (Phase 1) ----------------------------------------------------

  const context = buildStatusContext(config.statusName, skillName);

  if (hasExistingStatus(remote, sha, context)) {
    console.log(
      `Skilled PR: "${context}" already attested for ${sha.slice(0, 7)}. Skipping status.`,
    );
    process.exit(0);
  }

  postStatus(remote, sha, context, skillName);
  console.log(`Skilled PR ✓ — attested "${skillName}" on ${sha.slice(0, 7)}`);
}

// ---------------------------------------------------------------------------
// Findings helpers (Phase 1.5)
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
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/pulls/${prNumber}/comments`,
    "--paginate",
  ]);
  const seen = new Set<string>();
  if (proc.exitCode !== 0) return seen;
  try {
    const comments = JSON.parse(proc.stdout.toString()) as Array<{ body: string }>;
    for (const c of comments) {
      const fp = extractFingerprint(c.body);
      if (fp) seen.add(fp);
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
      console.error(
        `Skilled PR: failed to post comment for ${finding.path}:${finding.line}\n${stderr}`,
      );
      process.exit(1);
    }
    newCount++;
  }

  return { new: newCount, skipped };
}

// ---------------------------------------------------------------------------
// Phase 1 helpers (unchanged)
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

function isCommitPushed(sha: string): boolean {
  const proc = Bun.spawnSync(["git", "branch", "-r", "--contains", sha]);
  return proc.exitCode === 0 && proc.stdout.toString().trim().length > 0;
}

function hasExistingStatus(remote: GitHubRemote, sha: string, context: string): boolean {
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/commits/${sha}/statuses`,
  ]);
  if (proc.exitCode !== 0) return false;
  try {
    const statuses = JSON.parse(proc.stdout.toString()) as Array<{ context: string }>;
    return statuses.some((s) => s.context === context);
  } catch {
    return false;
  }
}

function postStatus(remote: GitHubRemote, sha: string, context: string, skillName: string) {
  const proc = Bun.spawnSync([
    "gh", "api",
    `repos/${remote.owner}/${remote.repo}/statuses/${sha}`,
    "-X", "POST",
    "-f", "state=success",
    "-f", `context=${context}`,
    "-f", `description=Reviewed by ${skillName}`,
  ]);

  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString();
    if (stderr.includes("auth") || stderr.includes("login")) {
      console.error("Skilled PR: gh is not authenticated. Run 'gh auth login' first.");
    } else {
      console.error(`Skilled PR: failed to post status.\n${stderr}`);
    }
    process.exit(1);
  }
}
