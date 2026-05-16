# Troubleshooting

When something doesn't work, run `skilled-pr doctor` first. It checks every common failure mode and prints exactly which one you hit.

```bash
$ skilled-pr doctor
✓ bun installed          1.3.10
✓ gh installed           2.86.0
⚠ gh authenticated       not signed in
  Fix: gh auth login
✓ GitHub remote          owner/repo
✗ .skilledpr.jsonc       not found
  Fix: skilled-pr init
...
```

Below is the same coverage as a reference page, with the failure mode → what you see → fix.

---

## "command not found: skilled-pr"

You installed the package but the binary isn't on your PATH.

**Most common cause: fish shell.** Bun's installer auto-adds `~/.bun/bin` to bash/zsh via `~/.bashrc` and `~/.zshrc`, but doesn't touch fish config. Add it manually:

```fish
# Add ~/.bun/bin to fish's universal PATH (persists across sessions)
fish_add_path ~/.bun/bin
```

Then `which skilled-pr` should print `/Users/<you>/.bun/bin/skilled-pr`.

For zsh / bash users on NixOS or with custom configs, check that `~/.bun/bin` is in `$PATH`. Add to your shell rc if not:

```bash
# zsh / bash
export PATH="$HOME/.bun/bin:$PATH"
```

## `attest` exits with code 2: "HEAD is not pushed"

You're trying to attest a commit that doesn't exist on GitHub yet. The pre-flight is doing its job — GitHub rejects status posts for unknown SHAs.

**Fix:** push the branch and re-run the exact command attest printed.

```bash
git push
# Then re-run the attest command from the previous output
```

If you're running attest via Claude Code's hook, the model should ask you before pushing per the system reminder injected by the hook. If it didn't, the reminder may not have fired — run `skilled-pr doctor` to verify hooks are installed.

## "no open PR found for `<sha>`"

attest ran successfully but couldn't find a PR matching the current commit. Inline findings comments weren't posted.

**This is expected when:**
- You're on a feature branch but haven't opened a PR yet (do that first)
- You're on the default branch (skilled-pr is for PR-gated workflows)
- The remote is wrong (`git remote -v` to verify)

The status check still posts. If you open a PR after attesting, comments won't backfill — re-run attest after the PR exists.

## "gh: Not Found (HTTP 404)" on attest

Two distinct causes share this error:

### Cause A: HEAD not pushed (most common)

skilled-pr's pre-flight catches this and exits with code 2 + a clear message. If you're seeing the raw `gh: Not Found (HTTP 404)`, your skilled-pr is old. Upgrade:

```bash
bun add -g skilled-pr@latest
```

### Cause B: gh authenticated to wrong account

GitHub returns 404 (not 403) when you try to write to a repo you can only read. Common on multi-account setups where `gh` is logged into a personal account but the repo belongs to a work org.

**Fix:**

```bash
# See which account is active
gh auth status

# If wrong, switch
gh auth switch

# Or refresh the current token's scopes
gh auth refresh -s repo
```

`skilled-pr doctor` calls this out by displaying the active account name.

## "skill not found" or hook doesn't fire

Two paths to check:

### Path 1: hooks aren't installed

```bash
cat .claude/settings.json
```

Should show `PostToolUse` matcher `"Skill"` AND `UserPromptExpansion` matcher `""`, both with `command: "skilled-pr hook"`. If missing:

```bash
skilled-pr init  # idempotent — merges with existing settings
```

### Path 2: skill name isn't in requiredSkills

The hook only injects the attestation reminder for skills listed in `.skilledpr.jsonc`'s `requiredSkills`. Verify:

```bash
cat .skilledpr.jsonc
```

If you wanted `coderabbit:review` to trigger attestation, add it:

```jsonc
{
  "requiredSkills": ["coderabbit:review"]
}
```

## "branch protection is not configured"

The `Skilled PR / <skill>` status check posts on every attest, but branch protection has to actually require it before it gates merging.

**Easy path:**

```bash
skilled-pr enable-gate
```

This adds the Skilled PR status check to your default branch's protection rules. Additive — preserves any existing rules (PR review requirements, admin enforcement, push restrictions).

**Manual path:** Repository Settings → Branches → Branch protection rules → Add rule for your default branch → Require status checks to pass → Search for "Skilled PR" → Add it.

## Hook fires too often / not often enough

The hook is triggered by Claude Code's PostToolUse + UserPromptExpansion events. Two paths:

- **Model invokes Skill via tool**: PostToolUse fires
- **User types `/skill-name` directly**: UserPromptExpansion fires

If you only see attestation reminders sometimes, you likely have only one of the two hooks installed. Run `skilled-pr doctor` — it flags partial installs.

## Re-running attest creates duplicate comments

Shouldn't happen — every comment carries a `<!-- skilled-pr:fp:<hash> -->` marker and re-runs dedupe on it. If you see duplicates:

1. Make sure you're on skilled-pr v0.2.0+ (v0.1.x had a `gh api --paginate` bug that broke dedupe on PRs with >100 comments).
2. Verify the comment marker is still in place. If a reviewer manually edited a comment and removed the HTML marker, dedupe can't find it.

## "Invalid `.skilledpr.jsonc`"

Three flavors:

- **JSONC syntax error**: fix the error or run `skilled-pr init` to regenerate.
- **`failOn` not in `error | warning | none`**: typo? Allowed values are exactly those three.
- **Legacy `sha` field present**: this field was removed in v0.2.0. Delete it from your config. The behaviour it controlled (silent-skip on unpushed HEAD) is now: always fail loudly with exit code 2. For passive-skip semantics in scripts, wrap the call:

  ```bash
  skilled-pr attest --skill review || true
  ```

## NPM install warnings about `engines: bun`

The `engines` field declares this CLI needs bun. npm warns but installs anyway. The actual enforcement is the `#!/usr/bin/env bun` shebang on the CLI script — without bun installed, running `skilled-pr` will fail with "bun: command not found."

**Fix:** install bun (`curl -fsSL https://bun.sh/install | bash`), then re-run.

## Still stuck?

Open an issue: https://github.com/Demianeen/skilled-pr/issues — include the output of `skilled-pr doctor`, your `.skilledpr.jsonc`, and the exact error message.
