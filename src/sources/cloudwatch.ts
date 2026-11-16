/**
 * CloudWatch Logs through Logs Insights (StartQuery + GetQueryResults: read-only).
 *
 * Env config: { "profile": "Point360-Admin", "region": "us-east-1", "logGroups": ["/point360/dev"] }
 * The service is the line's JSON `service` field, else its stream prefix (ECS writes
 * `<service>/<container>/<task>`).
 */
import {
  CloudWatchLogsClient,
  GetQueryResultsCommand,
  StartQueryCommand,
  type ResultField,
} from "@aws-sdk/client-cloudwatch-logs";
import { AxiError } from "../lib/errors.js";
import { maskText } from "../lib/redact.js";
import { INFERRED_LEVELS, LEVEL_ALIASES, MAX_SCAN, countServices, isoTime, levelsAtLeast, matchesRecord, parseLine, SAFE_TOKEN, serviceAliases } from "../core/normalize.js";
import type { LogQuery, LogRecord, QueryResult, ServiceCount, Source, SourceFactory, TimeRange } from "../core/types.js";

export interface CloudWatchEnv {
  profile?: string;
  region: string;
  logGroups: string[];
}

/** The two calls this adapter makes; tests replace it with recorded responses. */
export type CloudWatchTransport = (cmd: StartQueryCommand | GetQueryResultsCommand) => Promise<unknown>;

const POLL_MS = 500;
const TIMEOUT_MS = 60_000;

export const cloudwatch: SourceFactory = (raw, label, transport) => {
  const env = validate(raw, label);
  let send = transport as CloudWatchTransport | undefined;
  if (!send) {
    const client = new CloudWatchLogsClient({ region: env.region, ...(env.profile ? { profile: env.profile } : {}) });
    send = (cmd) => client.send(cmd as never).catch((e) => Promise.reject(awsError(e, env)));
  }
  return new CloudWatchSource(env, send);
};

function validate(raw: Record<string, unknown>, label: string): CloudWatchEnv {
  const groups = raw.logGroups;
  if (typeof raw.region !== "string" || !Array.isArray(groups) || groups.length === 0 || !groups.every((g) => typeof g === "string")) {
    throw new AxiError(`config ${label} needs "region" and a non-empty "logGroups" list`, {
      help: ['e.g. { "profile": "Point360-Admin", "region": "us-east-1", "logGroups": ["/point360/dev"] }'],
    });
  }
  if (raw.profile !== undefined && typeof raw.profile !== "string") throw new AxiError(`config ${label}: "profile" must be a string`);
  return { region: raw.region, logGroups: groups as string[], ...(raw.profile ? { profile: raw.profile as string } : {}) };
}

function awsError(e: unknown, env: CloudWatchEnv): AxiError {
  const err = e as { name?: string; message?: string };
  const msg = `cloudwatch: ${err.name ?? "error"}: ${maskText(err.message ?? String(e))}`;
  if (/credential|token|expired|sso|profile/i.test(msg)) {
    return new AxiError(msg, { help: [`Run \`aws sso login --profile ${env.profile ?? "<profile>"}\` and retry`] });
  }
  if (/ResourceNotFound/i.test(msg)) {
    return new AxiError(msg, { help: [`check "logGroups" (${env.logGroups.join(", ")}) and "region" (${env.region}) in the config`] });
  }
  return new AxiError(msg);
}

/** Escapes text for an Insights regex literal `/.../`. */
const reEscape = (s: string) => s.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
const list = (xs: string[]) => "[" + xs.map((x) => JSON.stringify(x)).join(", ") + "]";

/** The Insights query for a LogQuery. Exported for tests. */
export function buildQuery(q: LogQuery): string {
  const filters: string[] = [];
  if (q.service && q.service !== "-") {
    const names = serviceAliases(q.service);
    filters.push(`(service in ${list(names)} or @logStream like /^(${names.map(reEscape).join("|")})\\//)`);
  }
  if (q.minLevel && q.minLevel !== "debug") {
    const levels = levelsAtLeast(q.minLevel);
    const aliases = Object.entries(LEVEL_ALIASES).filter(([, level]) => levels.includes(level)).map(([alias]) => alias);
    const explicit = ["level", "severity", "severity_text"].map((field) => `${field} like /(?i)^(${aliases.join("|")})$/`);
    const inferred = ["msg", "message", "@message"].flatMap((field) => INFERRED_LEVELS.filter(([level]) => levels.includes(level)).map(([, pattern]) => `${field} like /(?i)${pattern}/`));
    filters.push("(" + [...explicit, ...inferred].join(" or ") + ")");
  }
  if (q.text) filters.push(`@message like /(?i)${reEscape(q.text)}/`);
  if (q.id) {
    filters.push(/^[0-9a-f]{32}$/i.test(q.id) ? `@message like /(?i)${q.id}/` : `@message like ${JSON.stringify(q.id)}`);
  }
  return [
    "fields @timestamp, @message, @logStream",
    ...filters.map((f) => `| filter ${f}`),
    "| sort @timestamp desc",
    `| limit ${q.limit}`,
  ].join("\n");
}

const fieldOf = (row: ResultField[], name: string) => row.find((f) => f.field === name)?.value;

/** One Insights result row -> a LogRecord. Exported for tests. */
export function parseRow(row: ResultField[]): LogRecord {
  const stream = fieldOf(row, "@logStream") ?? "";
  return parseLine(fieldOf(row, "@message") ?? "", {
    time: isoTime(fieldOf(row, "@timestamp")) ?? "",
    service: stream.split("/")[0] || "-",
  });
}

class CloudWatchSource implements Source {
  constructor(
    private env: CloudWatchEnv,
    private send: CloudWatchTransport,
  ) {}

  private async run(queryString: string, range: TimeRange, limit: number): Promise<ResultField[][]> {
    const started = (await this.send(
      new StartQueryCommand({
        logGroupNames: this.env.logGroups,
        startTime: Math.floor(range.start / 1000),
        endTime: Math.ceil(range.end / 1000),
        queryString,
        limit,
      }),
    )) as { queryId?: string };
    if (!started.queryId) throw new AxiError("cloudwatch: StartQuery returned no queryId");
    const deadline = Date.now() + TIMEOUT_MS;
    for (;;) {
      const res = (await this.send(new GetQueryResultsCommand({ queryId: started.queryId }))) as {
        status?: string;
        results?: ResultField[][];
      };
      if (res.status === "Complete") return res.results ?? [];
      if (res.status && !["Scheduled", "Running"].includes(res.status)) {
        throw new AxiError(`cloudwatch: query ${res.status.toLowerCase()}`, { help: ["narrow --since or add --service, then retry"] });
      }
      if (Date.now() > deadline) {
        throw new AxiError("cloudwatch: query still running after 60s", { help: ["narrow --since or add --service, then retry"] });
      }
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async query(q: LogQuery): Promise<QueryResult<LogRecord>> {
    if (q.service && !SAFE_TOKEN.test(q.service)) throw new AxiError(`invalid service name \`${q.service}\``, { exitCode: 2 });
    if (q.id && !SAFE_TOKEN.test(q.id)) throw new AxiError(`invalid id \`${q.id}\``, { exitCode: 2 });
    const limit = q.minLevel || q.service ? MAX_SCAN : Math.min(q.limit, MAX_SCAN);
    const candidates = await this.run(buildQuery({ ...q, limit }), q, limit);
    const selected = candidates.map(parseRow).filter((record) => matchesRecord(record, { minLevel: q.minLevel, service: q.service }));
    return { rows: selected.slice(0, q.limit), partial: candidates.length >= MAX_SCAN && selected.length < q.limit };
  }

  async serviceCounts(range: TimeRange): Promise<QueryResult<ServiceCount>> {
    const sample = await this.query({ ...range, limit: MAX_SCAN });
    return { rows: countServices(sample.rows), partial: sample.partial || sample.rows.length >= MAX_SCAN };
  }
}
