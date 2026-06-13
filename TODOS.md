# TODOS

## MUST DO BEFORE MERGING THIS PR
(currently empty)

## Backlog (post-v1 schema)

- Files-changed matcher in rules (deferred: two valid semantics, and
  pagination edge cases for 500+ file PRs make implementation
  non-trivial; revisit when a real user asks for it).
- Windows-native hook support (currently requires WSL or Git Bash).
- Pre-push git hook trigger (requires husky or core.hooksPath; defer
  until requested).
- `skilled-pr scan ~/projects/` for multi-project upgrade discovery on
  global installs.
- `--draft` / `--amend` flag for non-bouncing PR check history (defer
  until users complain about Model A noise on amended commits).
- Historical prompt defaults bundled under `defaults/briefing/` and
  `defaults/summary/` so the migrator can detect "your prompt matches
  v0.5.0's default; upgrade to v0.7.0's?". v1 ships no historical
  defaults (there's no history yet); add per-release when defaults
  change.
- `/skilled-pr-update` skill auto-refresh of its own file (currently
  step 7 is manual; could detect drift via hash-compare and update in
  place).
- `skilled-pr migrate` uses lax `argv.includes("--apply")` parsing
  instead of `parseFlags` from src/args.ts. Surfaced as a warning by
  /review on PR #16 — silent acceptance of typos like
  `--aply`. Fix is mechanical (port to the strict parser pattern
  shared with attest/init); deferred to keep PR #16 scoped to the
  migrator + skill features.
- Several smaller polish items from /review on PR #16: duplicate
  `// 9.` step comment in init.ts, test coverage for the
  validation-error path in the migrator planner, stdout/stderr
  interleaving in `migrate --apply`, and a warn-before-overwrite for
  the bundled `/skilled-pr-update` skill when users have locally
  edited it. All info-severity; land as a single follow-up commit
  when convenient.
- Publish a real GitHub Action at `Demianeen/skilled-pr/actions/bypass`
  (bundled JS via ncc) to eliminate the ~3-5s `npx` download per PR
  event. v1 uses `npx -y -p skilled-pr@<version>` to keep the surface
  to one package; revisit once the CI cost is annoying or someone
  files an issue.
- `$GITHUB_EVENT_PATH` fast-path in `ci-resolve`: when running inside
  a GitHub Actions workflow the PR metadata is already in the event
  payload, no `gh api` call needed. Defer until measured.
- /review polish on PR #17 (all info-severity, batch into one
  follow-up commit when convenient):
    - `ci-resolve.ts` posts `pending` status on every workflow rerun;
      align with `attest.ts:346`'s `statusAlreadyMatches(state,
      description)` dedupe.
    - Bypass description interpolates user-supplied rule names with
      no length cap — GitHub silently truncates descriptions over
      140 chars. Either truncate in `formatBypassDescription` or
      enforce a maxLength in `validateRule`.
    - `fetchPRContext` swallows error class; use `classifyGhError`
      to surface auth/permission issues to the user.
    - Workflow template hardcodes `node-version: '22'`. LTS through
      2027 so safe for now; bump when 24 lands.
    - `readOwnVersion` duplicated across init.ts, branch-protection.ts,
      and migrate.ts. Extract to shared util.
    - Bypass path doesn't guard against `config.requiredSkills` being
      empty at top level (i.e., no rules match, defaults also empty);
      result is an empty `for` loop that's effectively a no-op but
      with no log line.
- End-to-end test of multi-skill + rules against REAL GitHub branch
  protection — the one path unit tests can't cover (ci-resolve.test.ts
  already covers the resolution/posting decision table). Throwaway
  public repo, local-built CLI standing in for the Action, so it runs
  regardless of whether the stack has landed (orthogonal to merge
  state). Config: two required skills with PLACEHOLDER names — the gate
  is skill-agnostic (`attest --skill <name>` needs no installed skill,
  so no gstack dependency) — plus three orthogonal rules, each isolating
  one match-type × one override-type:
    - `release`: branch glob `release-please--*` → `requiredSkills: []`
      (bypass)
    - `docs-light`: OR across `docs/*` + `chore/*` → `["review"]`
      (subset; drops the 2nd skill)
    - `deps-strict`: label `dependencies` → `failOn: "warning"` only
      (partial override; skills unchanged — resolve.ts:148)
  Five PRs (one per rule + a no-rule baseline + a PR matching two rules)
  verify: the 2-context union registers via enable-gate, "not required"
  greens unblock merge, the failOn flip (same warning finding goes red
  under deps-strict / green without), and first-match-wins ordering
  (resolve.ts:144). DO THIS BEFORE the first public release / npm
  publish — it's the only real-branch-protection validation of PR #17's
  union machinery. A bug it surfaces is fix-forward (no users yet; logic
  already unit-tested).
