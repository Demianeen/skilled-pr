// skilled-pr show
//
// Inspection / debugging UI for the v1 config + rule resolver. Three
// modes, derived from the args:
//
//   1. No args (or just context flags):
//        skilled-pr show
//        skilled-pr show --branch release-1.0 --labels security,p0
//      Prints the config overview AND the resolved profile for the
//      given context (defaults to the current branch via git).
//
//   2. One positional arg = field name:
//        skilled-pr show summaryPrompt
//        skilled-pr show rules
//      Prints field details: type, default, current configured value,
//      whether the value came from a built-in default or an override,
//      and the description from the JSON schema (if available).
//
//   3. With --reminder:
//        skilled-pr show --reminder
//        skilled-pr show --reminder --branch release-1.0
//      In addition to the overview, prints the literal reminder text
//      that would be injected for every required skill in the resolved
//      profile. Useful for "what does the model actually see?"
//      debugging.
//
// Implementation deliberately reuses resolveProfile + formatReminder so
// the output here is byte-identical to what the hook produces.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve as resolvePath } from "node:path";
import {
  CONFIG_PATH,
  CURRENT_SCHEMA_VERSION,
  DEFAULT_BRIEFING_PROMPT,
  DEFAULT_SUMMARY_PROMPT,
  loadConfig,
  type SkilledPRConfig,
} from "./config";
import {
  formatReminder,
  getCurrentPRContext,
  resolveProfile,
  type PRContext,
  type ResolvedProfile,
} from "./resolve";
import { detectHarnesses, type HarnessName } from "./harness";

// ---------------------------------------------------------------------------
// Output icons (matches doctor's convention: ✓ · ⚠ ✗)
// ---------------------------------------------------------------------------

const ICON = {
  info: "·",
  ok: "✓",
  warn: "⚠",
  fail: "✗",
} as const;

// ---------------------------------------------------------------------------
// Arg parsing
//
// show has a mixed-shape CLI (one optional positional plus several
// flags). The strict parser in args.ts errors on positionals — we have
// to walk argv directly here. Kept small + local; if a third command
// ever needs the same shape we'll lift it.
// ---------------------------------------------------------------------------

interface ShowArgs {
  field: string | null;
  branch?: string;
  author?: string;
  labels?: string[];
  reminder: boolean;
}

function parseShowArgs(argv: string[]): { ok: true; args: ShowArgs } | { ok: false; error: string } {
  const out: ShowArgs = { field: null, reminder: false };
  let i = 0;
  while (i < argv.length) {
    const token = argv[i];
    if (token === "--reminder") {
      out.reminder = true;
      i += 1;
      continue;
    }
    if (token.startsWith("--")) {
      const eq = token.indexOf("=");
      const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
      const inline = eq === -1 ? null : token.slice(eq + 1);
      const value = inline ?? argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { ok: false, error: `--${name}: requires a value` };
      }
      switch (name) {
        case "branch":
          out.branch = value;
          break;
        case "author":
          out.author = value;
          break;
        case "labels":
          out.labels = value.split(",").map((l) => l.trim()).filter((l) => l.length > 0);
          break;
        default:
          return { ok: false, error: `unknown flag: --${name}` };
      }
      i += inline === null ? 2 : 1;
      continue;
    }
    // Positional: the field name. Only one allowed.
    if (out.field !== null) {
      return { ok: false, error: `unexpected extra positional: "${token}" (already have "${out.field}")` };
    }
    out.field = token;
    i += 1;
  }
  return { ok: true, args: out };
}

// ---------------------------------------------------------------------------
// Schema lookup (for field descriptions and defaults)
// ---------------------------------------------------------------------------

interface SchemaDescriptor {
  description?: string;
  default?: unknown;
  type?: string | string[];
  enum?: string[];
}

/** Locate the bundled schema/v1.json. Returns null if not found. */
export function findBundledSchemaPath(): string | null {
  // tsx dev mode: import.meta.url points at src/show.ts; built mode
  // points at dist/cli.js. Walk up to find the schema directory in
  // either layout.
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

let _schemaCache: Record<string, SchemaDescriptor> | null = null;
function getSchemaDescriptors(): Record<string, SchemaDescriptor> {
  if (_schemaCache !== null) return _schemaCache;
  const path = findBundledSchemaPath();
  if (path === null) return (_schemaCache = {});
  try {
    const schema = JSON.parse(readFileSync(path, "utf8")) as {
      properties?: Record<string, SchemaDescriptor>;
    };
    _schemaCache = schema.properties ?? {};
  } catch {
    _schemaCache = {};
  }
  return _schemaCache;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

/** Format a value for compact one-line display. Long strings get truncated. */
function compact(value: unknown, max = 60): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    if (value.length <= max) return JSON.stringify(value);
    return JSON.stringify(value.slice(0, max - 1) + "…");
  }
  return JSON.stringify(value);
}

function printSection(title: string): void {
  console.log("");
  console.log(title);
  console.log("─".repeat(Math.min(title.length, 60)));
}

// ---------------------------------------------------------------------------
// Subcommand modes
// ---------------------------------------------------------------------------

function buildContext(args: ShowArgs): PRContext {
  // Explicit flags take precedence; otherwise pull from the current
  // checkout. The order matters because `getCurrentPRContext` shells
  // out to git, which is wasted work if the user already passed a
  // --branch.
  if (args.branch !== undefined || args.author !== undefined || args.labels !== undefined) {
    return {
      branch: args.branch ?? "",
      author: args.author,
      labels: args.labels,
    };
  }
  return getCurrentPRContext();
}

function printOverview(config: SkilledPRConfig, context: PRContext, profile: ResolvedProfile): void {
  printSection("skilled-pr config");
  console.log(`  ${ICON.info} schemaVersion:   ${config.schemaVersion}`);
  console.log(`  ${ICON.info} statusName:      ${JSON.stringify(config.statusName)}`);
  console.log(`  ${ICON.info} requiredSkills:  ${JSON.stringify(config.requiredSkills)}`);
  console.log(`  ${ICON.info} failOn:          ${JSON.stringify(config.failOn)}`);
  console.log(
    `  ${ICON.info} summaryPrompt:   ${config.summaryPrompt === null ? "null (built-in default)" : compact(config.summaryPrompt)}`,
  );
  console.log(
    `  ${ICON.info} briefingPrompt:  ${config.briefingPrompt === null ? "null (built-in default)" : compact(config.briefingPrompt)}`,
  );
  console.log(`  ${ICON.info} rules:           ${config.rules.length} rule(s)`);
  console.log(
    `  ${ICON.info} autoReview:      ` +
      `trigger=${config.autoReview.trigger}, ` +
      `execution=${config.autoReview.execution}, ` +
      `sessionBriefing=${config.autoReview.sessionBriefing}, ` +
      `skipPolicy=${config.autoReview.skipPolicy}`,
  );

  printSection("Resolved profile (for this context)");
  console.log(`  ${ICON.info} branch:          ${JSON.stringify(context.branch || "(none)")}`);
  if (context.author !== undefined) {
    console.log(`  ${ICON.info} author:          ${JSON.stringify(context.author)}`);
  }
  if (context.labels !== undefined) {
    console.log(`  ${ICON.info} labels:          ${JSON.stringify(context.labels)}`);
  }
  console.log(
    `  ${ICON.info} matched rule:    ${profile.matchedRuleName === null ? "(none — top-level defaults apply)" : JSON.stringify(profile.matchedRuleName)}`,
  );
  console.log(`  ${ICON.info} requiredSkills:  ${JSON.stringify(profile.requiredSkills)}`);
  console.log(`  ${ICON.info} failOn:          ${JSON.stringify(profile.failOn)}`);
  console.log(`  ${ICON.info} execution:       ${JSON.stringify(profile.execution)}`);
  console.log(`  ${ICON.info} sessionBriefing: ${profile.sessionBriefing}`);
  console.log(`  ${ICON.info} skipPolicy:      ${JSON.stringify(profile.skipPolicy)}`);
  console.log(
    `  ${ICON.info} summaryPrompt:   ${compact(profile.summaryPrompt)} ${config.summaryPrompt === null ? "(default)" : "(override)"}`,
  );
  console.log(
    `  ${ICON.info} briefingPrompt:  ${compact(profile.briefingPrompt)} ${config.briefingPrompt === null ? "(default)" : "(override)"}`,
  );
}

function printReminder(profile: ResolvedProfile): void {
  if (profile.requiredSkills.length === 0) {
    printSection("Reminder body");
    console.log(`  ${ICON.warn} No required skills resolved — nothing would be injected.`);
    return;
  }
  const harnessNames: HarnessName[] = detectHarnesses().map((h) => h.name);
  if (harnessNames.length === 0) harnessNames.push("claude");
  for (const skill of profile.requiredSkills) {
    for (const harnessName of harnessNames) {
      printSection(`Reminder body (skill: ${skill}, harness: ${harnessName})`);
      // Indent each line by two spaces so it's visually distinct from the
      // surrounding skilled-pr show output.
      for (const line of formatReminder(profile, skill, harnessName).split("\n")) {
        console.log(`  ${line}`);
      }
    }
  }
}

function printFieldDetail(field: string, config: SkilledPRConfig): number {
  const descriptors = getSchemaDescriptors();
  const desc = descriptors[field];

  const overrideMap: Record<string, () => { value: unknown; defaultValue: unknown; resolved?: unknown }> = {
    schemaVersion: () => ({
      value: config.schemaVersion,
      defaultValue: CURRENT_SCHEMA_VERSION,
    }),
    requiredSkills: () => ({
      value: config.requiredSkills,
      defaultValue: ["review"],
    }),
    statusName: () => ({
      value: config.statusName,
      defaultValue: "Skilled PR",
    }),
    failOn: () => ({
      value: config.failOn,
      defaultValue: "error",
    }),
    summaryPrompt: () => ({
      value: config.summaryPrompt,
      defaultValue: null,
      resolved: config.summaryPrompt === null ? DEFAULT_SUMMARY_PROMPT : config.summaryPrompt,
    }),
    briefingPrompt: () => ({
      value: config.briefingPrompt,
      defaultValue: null,
      resolved: config.briefingPrompt === null ? DEFAULT_BRIEFING_PROMPT : config.briefingPrompt,
    }),
    autoReview: () => ({
      value: config.autoReview,
      defaultValue: {
        trigger: "manual",
        execution: "main-agent",
        sessionBriefing: false,
        skipPolicy: "agent-decides",
      },
    }),
    rules: () => ({
      value: config.rules,
      defaultValue: [],
    }),
  };

  const lookup = overrideMap[field];
  if (lookup === undefined) {
    console.error(`${ICON.fail} unknown config field: "${field}"`);
    console.error("");
    console.error("Known fields:");
    for (const name of Object.keys(overrideMap)) {
      console.error(`  - ${name}`);
    }
    return 1;
  }

  const { value, defaultValue, resolved } = lookup();
  printSection(`Field: ${field}`);
  if (desc?.type !== undefined) {
    const t = Array.isArray(desc.type) ? desc.type.join(" | ") : desc.type;
    console.log(`  ${ICON.info} type:     ${t}`);
  }
  if (desc?.enum !== undefined) {
    console.log(`  ${ICON.info} allowed:  ${JSON.stringify(desc.enum)}`);
  }
  console.log(`  ${ICON.info} default:  ${JSON.stringify(defaultValue)}`);
  console.log(`  ${ICON.info} current:  ${JSON.stringify(value)}`);
  const isOverridden = JSON.stringify(value) !== JSON.stringify(defaultValue);
  console.log(`  ${ICON.info} source:   ${isOverridden ? "override (set in config)" : "built-in default"}`);
  if (resolved !== undefined && JSON.stringify(resolved) !== JSON.stringify(value)) {
    // Show the runtime-resolved value when it differs (null prompt -> default).
    console.log(`  ${ICON.info} resolved: ${compact(resolved, 120)}  (null → built-in default)`);
  }
  if (desc?.description !== undefined) {
    printSection("Description");
    for (const line of desc.description.split("\n")) {
      console.log(`  ${line}`);
    }
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function show(argv: string[]): Promise<void> {
  const parsed = parseShowArgs(argv);
  if (!parsed.ok) {
    console.error(`skilled-pr show: ${parsed.error}`);
    console.error("");
    console.error("Usage:");
    console.error("  skilled-pr show [<field>] [--branch <name>] [--author <name>] [--labels a,b,c] [--reminder]");
    process.exit(1);
  }
  const args = parsed.args;

  let config: SkilledPRConfig | null = null;
  try {
    config = await loadConfig();
  } catch (e) {
    console.error(`${ICON.fail} ${(e as Error).message}`);
    process.exit(1);
  }
  if (config === null) {
    console.error(`${ICON.fail} No config found at ${CONFIG_PATH}.`);
    console.error("");
    console.error("Run `skilled-pr init` to create one.");
    process.exit(1);
  }

  if (args.field !== null) {
    const exitCode = printFieldDetail(args.field, config);
    if (exitCode !== 0) process.exit(exitCode);
    return;
  }

  const context = buildContext(args);
  const profile = resolveProfile(config, context);
  printOverview(config, context, profile);

  if (args.reminder) {
    printReminder(profile);
  }
}
