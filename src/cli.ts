/**
 * Routing: `logs-axi <source> <env> <command> [args] [flags]`. Returns the text to
 * print and the exit code, so tests and the bench drive it with recorded transports.
 */
import { parseArgs, type FlagSchema, type ParsedArgs } from "./lib/args.js";
import { AxiError, usageError } from "./lib/errors.js";
import { loadConfig, configPath, type Config } from "./lib/config.js";
import { rangeLabel, resolveRange } from "./lib/time.js";
import { render, renderHelp, toon } from "./output/toon.js";
import { SOURCES } from "./sources/index.js";
import { errors, fields, search, services, tail, trace, type Ctx, type Output } from "./core/commands.js";
import { LEVELS, type Level } from "./core/types.js";

export interface Deps {
  config?: Config;
  /** Per source name: the transport its adapter uses instead of the network. */
  transports?: Record<string, unknown>;
  now?: number;
}

export const DESCRIPTION = "Read logs from CloudWatch, SigNoz and future sources, agent-first: grouped, redacted, token-light";

const COMMANDS = ["tail", "search", "errors", "trace", "services", "fields"] as const;
type Command = (typeof COMMANDS)[number];

const RANGE: FlagSchema = {
  since: { type: "string", description: "how far back: 30s, 15m, 1h, 2d, 1w" },
  from: { type: "string", description: "ISO-8601 start (overrides --since)" },
  until: { type: "string", description: "ISO-8601 end (default now)" },
  json: { type: "boolean", description: "JSON instead of TOON" },
  unredacted: { type: "boolean", description: "turn patient-data redaction OFF (prints a warning)" },
};
const SERVICE: FlagSchema = { service: { type: "string", description: "one service (case and case-service both match)" } };
const LEVEL: FlagSchema = { level: { type: "string", description: "this level or above: debug|info|warn|error|fatal" } };
const LIMIT: FlagSchema = { limit: { type: "string", description: "max rows" } };
const FULL: FlagSchema = { full: { type: "boolean", description: "do not cut long messages and values" } };

interface Spec {
  usage: string;
  summary: string;
  flags: FlagSchema;
  since: string;
  limit?: number;
}

const SPECS: Record<Command, Spec> = {
  tail: { usage: "tail", summary: "the latest lines, oldest first", flags: { ...RANGE, ...SERVICE, ...LEVEL, ...LIMIT, ...FULL }, since: "15m", limit: 50 },
  search: {
    usage: "search [text]",
    summary: "lines matching text (case-insensitive), level, service and time range",
    flags: { ...RANGE, ...SERVICE, ...LEVEL, ...LIMIT, ...FULL, text: { type: "string", description: "substring of the message" } },
    since: "15m",
    limit: 50,
  },
  errors: {
    usage: "errors",
    summary: "error lines grouped by message template: count, first/last seen, one id to follow",
    flags: { ...RANGE, ...SERVICE, ...LEVEL, limit: { type: "string", description: "max groups" } },
    since: "15m",
    limit: 20,
  },
  trace: {
    usage: "trace <id>",
    summary: "every line carrying one trace/request/case/run id, across services",
    flags: { ...RANGE, ...SERVICE, ...LEVEL, ...LIMIT, ...FULL },
    since: "24h",
    limit: 200,
  },
  services: { usage: "services", summary: "which services logged, with line, error and warning counts", flags: RANGE, since: "1h" },
  fields: {
    usage: "fields",
    summary: "which fields lines carry (sampled), with examples",
    flags: { ...RANGE, ...SERVICE, ...LEVEL },
    since: "1h",
  },
};

export const UNREDACTED_WARNING =
  "UNREDACTED output: may contain patient data (PHI). Do not paste it into tickets, chats, commits or prompts.";

export async function run(argv: string[], deps: Deps = {}): Promise<{ out: string; code: number }> {
  try {
    return { out: await route(argv, deps), code: 0 };
  } catch (e) {
    const err = e instanceof Error ? e : new Error(String(e));
    const help = err instanceof AxiError ? err.help : [];
    let out = toon({ error: err.message });
    if (help.length) out += "\n" + renderHelp(help);
    return { out: out + "\n", code: err instanceof AxiError ? err.exitCode : 1 };
  }
}

async function route(argv: string[], deps: Deps): Promise<string> {
  const [source, env, command, ...rest] = argv;
  if (!source) return home(deps);
  if (source === "--help" || source === "-h" || source === "help") return topHelp() + "\n";
  if (source.startsWith("-")) throw usageError(`unknown flag ${source}`, ["Run `logs-axi --help`"]);

  if (!SOURCES[source]) {
    throw usageError(`unknown source \`${source}\``, [`valid sources: ${Object.keys(SOURCES).join(", ")}`, "Run `logs-axi` to see what is configured"]);
  }
  const config = deps.config ?? loadConfig();
  const envs = config.sources[source] ?? {};
  if (!env || env === "--help" || env === "-h") {
    return render({ source, envs: Object.keys(envs).join(",") || "none configured", commands: COMMANDS.join(",") }, [
      Object.keys(envs).length
        ? `Run \`logs-axi ${source} ${Object.keys(envs)[0]} errors\` to group recent errors`
        : `add "${source}" to the "sources" of ${configPath()}`,
    ]);
  }
  const envConfig = envs[env];
  if (!envConfig) {
    throw usageError(`no environment \`${env}\` for ${source}`, [
      Object.keys(envs).length ? `configured: ${Object.keys(envs).join(", ")}` : `add one under sources.${source} in ${configPath()}`,
    ]);
  }

  if (command === "--help" || command === "-h") return envHelp(source, env);
  // `logs-axi <source> <env> [flags]` is content first: the error summary
  const implicit = command === undefined || command.startsWith("-");
  const cmd = (implicit ? "errors" : command) as Command;
  const cmdArgs = implicit && command ? [command, ...rest] : rest;
  if (!COMMANDS.includes(cmd)) {
    throw usageError(`unknown command \`${command}\``, [`valid commands: ${COMMANDS.join(", ")}`, `Run \`logs-axi ${source} ${env} --help\``]);
  }
  const spec = SPECS[cmd];
  const label = `${source} ${env} ${cmd}`;
  const args = parseArgs(cmdArgs, spec.flags, label);
  if (args.help) return commandHelp(source, env, cmd);

  const now = deps.now ?? Date.now();
  const range = resolveRange(args.flags, spec.since, now);
  const redact = args.flags.unredacted !== true;
  const ctx: Ctx = {
    source: SOURCES[source]!(envConfig, `sources.${source}.${env}`, deps.transports?.[source]),
    prefix: `logs-axi ${source} ${env}`,
    range,
    rangeLabel: rangeLabel(range, args.flags, spec.since),
    redact,
    full: args.flags.full === true,
    stats: { droppedFields: 0 },
  };
  const out = await dispatch(cmd, ctx, args, spec);
  if (!redact) out.body = { warning: UNREDACTED_WARNING, ...out.body };
  return render(out.body, out.help, args.flags.json === true);
}

function dispatch(cmd: Command, ctx: Ctx, args: ParsedArgs, spec: Spec): Promise<Output> {
  const f = args.flags;
  const service = typeof f.service === "string" ? f.service : undefined;
  const level = parseLevel(f.level);
  const limit = parseLimit(f.limit, spec.limit ?? 50);
  const extra = (n: number) => {
    if (args.positionals.length > n) {
      throw usageError(`unexpected argument \`${args.positionals[n]}\``, [`usage: logs-axi <source> <env> ${spec.usage}`]);
    }
  };
  switch (cmd) {
    case "tail":
      extra(0);
      return tail(ctx, { service, level, limit });
    case "search": {
      extra(1);
      const text = typeof f.text === "string" ? f.text : args.positionals[0];
      if (!text && !level && !service) {
        throw usageError("search needs text, --level or --service", [`${ctx.prefix} search "timeout" --service case`]);
      }
      return search(ctx, { service, level, text, limit });
    }
    case "errors":
      extra(0);
      return errors(ctx, { service, level, limit });
    case "trace": {
      extra(1);
      const id = args.positionals[0];
      if (!id) throw usageError("trace needs an id", [`${ctx.prefix} trace <traceId|requestId|caseId|runId>`]);
      return trace(ctx, id, { service, level, limit });
    }
    case "services":
      extra(0);
      return services(ctx);
    case "fields":
      extra(0);
      return fields(ctx, { service, level });
  }
}

function parseLevel(v: unknown): Level | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "string" && (LEVELS as readonly string[]).includes(v.toLowerCase())) return v.toLowerCase() as Level;
  throw usageError(`invalid --level \`${String(v)}\``, [`valid levels: ${LEVELS.join(", ")}`]);
}

function parseLimit(v: unknown, dflt: number): number {
  if (v === undefined) return dflt;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw usageError(`invalid --limit \`${String(v)}\``, ["use a whole number from 1 to 10000"]);
  return n;
}

/** Content first: what is configured, and what to run. Works without a config. */
function home(deps: Deps): string {
  let config: Config | undefined;
  let note: string | undefined;
  try {
    config = deps.config ?? loadConfig();
  } catch (e) {
    note = (e as Error).message;
  }
  const configured = config
    ? Object.entries(config.sources)
        .filter(([s]) => SOURCES[s])
        .map(([source, envs]) => ({ source, envs: Object.keys(envs).join(" ") }))
    : [];
  const body: Record<string, unknown> = { description: DESCRIPTION };
  if (configured.length) body.configured = configured;
  else body.configured = note ?? `none: add sources to ${configPath()}`;
  const first = configured[0];
  const help = first
    ? [
        `Run \`logs-axi ${first.source} ${first.envs.split(" ")[0]} errors\` to group recent errors`,
        `Run \`logs-axi ${first.source} ${first.envs.split(" ")[0]} services\` to see who is logging`,
        "Run `logs-axi --help` for every command and flag",
      ]
    : ["Run `logs-axi --help` for setup and commands"];
  return render(body, help);
}

function flagLines(flags: FlagSchema): string {
  return Object.entries(flags)
    .map(([name, s]) => `  --${name.padEnd(12)}${s.description}`)
    .join("\n");
}

function topHelp(): string {
  const cmds = COMMANDS.map((c) => `  ${SPECS[c].usage.padEnd(15)}${SPECS[c].summary} (default --since ${SPECS[c].since})`).join("\n");
  return `logs-axi - ${DESCRIPTION}

Usage:
  logs-axi                                   what is configured
  logs-axi <source> <env> <command> [flags]  e.g. logs-axi signoz dev errors --since 1h --service case
  logs-axi <source> <env>                    same as \`errors\`

Sources: ${Object.keys(SOURCES).join(", ")}   (environments come from ${configPath()})

Commands:
${cmds}

Flags (most commands):
  --since 15m | --from <iso> --until <iso>   time range
  --service <name>   --level <lvl>   --limit <n>   --full   --json
  --unredacted       patient-data redaction is ON by default; this turns it off and prints a warning

Output is TOON; long messages are cut with …[+N] (add --full). Read-only: nothing is ever written to a source.`;
}

function envHelp(source: string, env: string): string {
  return (
    `logs-axi ${source} ${env} <command>\n\n` +
    COMMANDS.map((c) => `  ${SPECS[c].usage.padEnd(15)}${SPECS[c].summary}`).join("\n") +
    `\n\nRun \`logs-axi ${source} ${env} <command> --help\` for its flags.\n`
  );
}

function commandHelp(source: string, env: string, cmd: Command): string {
  const s = SPECS[cmd];
  const defaults = `defaults: --since ${s.since}${s.limit ? ` --limit ${s.limit}` : ""}`;
  return `logs-axi ${source} ${env} ${s.usage} - ${s.summary}\n${defaults}\n\nFlags:\n${flagLines(s.flags)}\n`;
}
