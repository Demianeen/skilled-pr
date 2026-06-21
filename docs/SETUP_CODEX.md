# Using skilled-pr with Codex

skilled-pr supports both Claude Code and OpenAI Codex. If you've already run `skilled-pr init` and have a `.codex/` directory in your repo, the Codex hook is already installed; this page just explains how the integration differs from Claude Code and what to do if something doesn't work.

## What `skilled-pr init` writes for Codex

```jsonc
// .codex/hooks.json
{
  "hooks": [
    { "event": "UserPromptSubmit", "command": "skilled-pr hook" }
  ]
}
```

That is the main install difference from a Claude Code setup. The manual `attest` flow and GitHub status posting are identical, but Codex does not have every Claude hook event. The differences that affect review firing are listed below.

### Auto-detection

`skilled-pr init` checks for `.claude/` and `.codex/` directories and writes hooks for each one it finds. If you use both, both get wired up. If you only have Codex, only `.codex/hooks.json` is touched. If neither directory exists (fresh repo), Claude Code is assumed for backward compatibility.

### Forcing a harness

If detection guesses wrong, override with `--for`:

```bash
skilled-pr init --for codex     # only Codex
skilled-pr init --for claude    # only Claude Code
skilled-pr init --for both      # both, regardless of detection
```

## Why Codex uses `UserPromptSubmit`

In Claude Code, when the agent invokes a skill, it shows up as a `PostToolUse` event with `tool_name: "Skill"`. Clean to match on.

Codex skills are different. They follow the same `SKILL.md` spec but load via *progressive disclosure*: the agent reads the SKILL.md file with the same file tool it uses for any other file. There's no discrete "Skill was invoked" event to hook into.

So skilled-pr hooks `UserPromptSubmit` instead, and detects skill invocation by looking for a leading slash-command in the prompt:

| User types | Matches? | Why |
|---|---|---|
| `/review` | yes | Plain slash-command at start of prompt |
| `/coderabbit:review please` | yes | Colon-scoped names are supported |
| `   /review` | yes | Leading whitespace is trimmed |
| `please /review this` | no | Slash must be the first non-whitespace char |
| `/help` | no | Built-in commands are filtered out |

The "leading slash only" rule is deliberate. Gate enforcement should track explicit user intent, not the agent's natural-language inference. If you ask Codex "review this PR" without typing `/review`, the gate stays neutral; you'd just be having a chat about the code.

## What does NOT work in Codex (and why)

- **Agent-initiated reviews**: If Codex reads `SKILL.md` because it inferred the user wanted a review, `skilled-pr hook` never fires (it only fires on user-typed prompts). Workaround: have your skill instruct the model to remind the user to type `/skillname` explicitly, or wire your skill's review process to call `skilled-pr attest` directly at the end.
- **`autoReview.trigger=on-push` reminders**: The on-push reminder depends on Claude Code's `PostToolUse:Bash` event after an agent runs `git push`. Codex has no equivalent event in this release, so Codex users keep invoking `/review` or another required skill manually.
- **Slash-commands inside chained messages**: Only the leading slash is parsed. `/review and /lint` triggers `review` but not `lint`. Codex doesn't model multiple commands per turn cleanly anyway.

## Troubleshooting

Run `skilled-pr doctor` first; the "Codex hooks" check tells you exactly what's missing:

```bash
$ skilled-pr doctor
...
✗ Codex hooks                .codex/hooks.json not found
  Fix: skilled-pr init --for codex
```

If `doctor` says hooks are installed but attestations aren't firing, the most common cause is mistaken prompt format: type `/review` (with the leading slash) instead of `review` or `please review`. The other common cause is that the skill isn't listed in `requiredSkills` inside `.skilledpr.jsonc`; the hook only injects reminders for required skills.
