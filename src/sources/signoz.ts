/**
 * SigNoz through its v5 query API (POST /api/v5/query_range: read-only).
 *
 * Env config: { "endpoint": "http://localhost:3301", "apiKeyEnv": "SIGNOZ_API_KEY_DEV" }
 * The key comes from the env var `apiKeyEnv` names (default SIGNOZ_API_KEY), or from
 * "apiKey" in the config. It is sent as the SIGNOZ-API-KEY header and never printed.
 */
import { AxiError } from "../lib/errors.js";
import { maskText } from "../lib/redact.js";
import { INFERRED_LEVELS, LEVEL_ALIASES, isoTime, levelsAtLeast, normalizeLevel, parseLine, SAFE_TOKEN, serviceAliases } from "../core/normalize.js";
import { LEVELS, type Level, type LogQuery, type LogRecord, type ServiceCount, type Source, type SourceFactory, type TimeRange } from "../core/types.js";

export interface SignozEnv {
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

/** POST a JSON body to a path, return the parsed JSON. Tests replace it with recorded responses. */
export type SignozTransport = (path: string, body: unknown) => Promise<unknown>;

export const signoz: SourceFactory = (raw, label, transport) => {
  const env = validate(raw, label);
  return new SignozSource((transport as SignozTransport | undefined) ?? httpTransport(env, label));
};

function validate(raw: Record<string, unknown>, label: string): SignozEnv {
  if (typeof raw.endpoint !== "string" || !/^https?:\/\//.test(raw.endpoint)) {
    throw new AxiError(`config ${label} needs "endpoint" (http[s]://host:port)`, {
      help: ['e.g. { "endpoint": "http://localhost:3301", "apiKeyEnv": "SIGNOZ_API_KEY_DEV" }'],
    });
  }
  return raw as unknown as SignozEnv;
}

function httpTransport(env: SignozEnv, label: string): SignozTransport {
  const keyVar = env.apiKeyEnv ?? "SIGNOZ_API_KEY";
  return async (path, body) => {
    const key = process.env[keyVar] || env.apiKey;
    if (!key) {
      throw new AxiError(`no SigNoz API key for ${label}`, {
        help: [`export ${keyVar}=<viewer key> (or set "apiKey" in the config) and retry`],
      });
    }
    let res: Response;
    try {
      res = await fetch(env.endpoint.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (e) {
      throw new AxiError(`signoz: cannot reach ${env.endpoint}: ${(e as Error).cause ?? (e as Error).message}`, {
        help: ["is the SSM port-forward up? `terraform output signoz_ui_command` in infra/aws/environments/<env> prints it"],
      });
    }
    const text = await res.text();
    if (!res.ok) {
      throw new AxiError(`signoz: HTTP ${res.status}: ${maskText(text).slice(0, 300)}`, {
        help: res.status === 401 || res.status === 403 ? [`check the key in ${keyVar}`] : [],
      });
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new AxiError("signoz: response is not valid JSON");
    }
  };
}

/** Quote a literal for the v5 filter grammar; LIKE wildcards made literal when `like`. */
const lit = (s: string, like = false) =>
  "'" + (like ? s.replace(/[\\%_]/g, "\\$&") : s).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";

/** Ids the house logger binds as attributes; a non-trace id is looked up in these. */
const ID_ATTRIBUTES = ["requestId", "correlationId", "caseId", "runId"];

const LEVEL_FIELDS = ["body.level", "body.severity", "body.severity_text", "level", "severity", "severity_text"];
const missing = (field: string) => `(${field} NOT EXISTS OR ${field} = '')`;
const all = (parts: string[]) => "(" + parts.join(" AND ") + ")";
const any = (parts: string[]) => "(" + parts.join(" OR ") + ")";

function levelFilter(level: Level): string {
  const aliases = Object.entries(LEVEL_ALIASES).filter(([, value]) => value === level).map(([alias]) => alias);
  const explicit = LEVEL_FIELDS.map((field, i) => all([
    ...LEVEL_FIELDS.slice(0, i).map(missing),
    `${field} REGEXP ${lit("(?i)^(" + aliases.join("|") + ")$")}`,
  ]));
  const inferred = INFERRED_LEVELS.findIndex(([value]) => value === level);
  if (inferred >= 0) {
    const messages = ["body.msg", "body.message", "body"];
    explicit.push(all([
      ...LEVEL_FIELDS.map(missing),
      any(messages.map((field, i) => all([
        ...messages.slice(0, i).map(missing),
        ...INFERRED_LEVELS.slice(0, inferred).map(([, pattern]) => `${field} NOT REGEXP ${lit("(?i)" + pattern)}`),
        `${field} REGEXP ${lit("(?i)" + INFERRED_LEVELS[inferred]![1])}`,
      ]))),
    ]));
  }
  return any(explicit);
}

/** The v5 filter expression for a LogQuery. Exported for tests. */
export function buildFilter(q: LogQuery): string {
  const parts: string[] = [];
  if (q.service) parts.push(`service.name IN (${serviceAliases(q.service).map((s) => lit(s)).join(", ")})`);
  if (q.minLevel && q.minLevel !== "debug") {
    parts.push(any(levelsAtLeast(q.minLevel).map(levelFilter)));
  }
  if (q.text) parts.push(`body CONTAINS ${lit(q.text, true)}`);
  if (q.id) {
    parts.push(
      /^[0-9a-f]{32}$/i.test(q.id)
        ? `trace_id = ${lit(q.id.toLowerCase())}`
        : "(" + ID_ATTRIBUTES.map((a) => `${a} = ${lit(q.id!)}`).join(" OR ") + ")",
    );
  }
  return parts.join(" AND ");
}

export function rawRequest(q: LogQuery): unknown {
  return {
    schemaVersion: "v1",
    start: q.start,
    end: q.end,
    requestType: "raw",
    compositeQuery: {
      queries: [
        {
          type: "builder_query",
          spec: {
            name: "A",
            signal: "logs",
            filter: { expression: buildFilter(q) },
            limit: q.limit,
            offset: 0,
            order: [
              { key: { name: "timestamp" }, direction: "desc" },
              { key: { name: "id" }, direction: "desc" },
            ],
          },
        },
      ],
    },
  };
}

export function servicesRequest(range: TimeRange): unknown {
  return {
    schemaVersion: "v1",
    start: range.start,
    end: range.end,
    requestType: "scalar",
    compositeQuery: {
      queries: [...LEVELS, "unknown"].map((level) => ({
        type: "builder_query",
        spec: {
          name: level,
          signal: "logs",
          filter: { expression: level === "unknown" ? `NOT ${any(LEVELS.map(levelFilter))}` : levelFilter(level as Level) },
          aggregations: [{ expression: "count()", alias: "n" }],
          groupBy: [{ name: "service.name", fieldContext: "resource" }],
          limit: 1000,
        },
      })),
    },
  };
}

interface V5Result {
  queryName?: string;
  rows?: { timestamp?: unknown; data?: Record<string, unknown> }[] | null;
  columns?: { name: string; columnType?: string }[];
  data?: unknown[][] | null;
}

function results(payload: unknown): V5Result[] {
  const p = payload as { status?: string; error?: unknown; data?: { data?: { results?: V5Result[] | null } } };
  // never echo the payload itself: a failed response can still carry rows
  if (p?.status && p.status !== "success") throw new AxiError(`signoz: ${maskText(JSON.stringify(p.error ?? p.status)).slice(0, 300)}`);
  return p?.data?.data?.results ?? [];
}

const NOISE = /^(log\.|code\.|telemetry\.|otel\.)/;

/** One v5 raw row -> a LogRecord. Exported for tests. */
export function parseRow(row: { timestamp?: unknown; data?: Record<string, unknown> }): LogRecord {
  const d = row.data ?? {};
  const resources = { ...(d.resources_string as object), ...(d.resource as object) } as Record<string, unknown>;
  const attrs: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(d)) {
    if (/^attributes(_|$)/.test(k) && v && typeof v === "object") Object.assign(attrs, v);
  }
  for (const k of Object.keys(attrs)) if (NOISE.test(k)) delete attrs[k];
  const traceId = typeof d.trace_id === "string" && d.trace_id && !/^0+$/.test(d.trace_id) ? d.trace_id : undefined;
  const body = typeof d.body === "string" ? d.body : JSON.stringify(d.body ?? "");
  const rec = parseLine(body, {
    time: isoTime(row.timestamp ?? d.timestamp) ?? "",
    service: String(resources["service.name"] ?? attrs.service ?? "-"),
    level: [attrs.level, attrs.severity, attrs.severity_text, d.severity_text].find((v): v is string => typeof v === "string" && v !== ""),
    ...(traceId ? { traceId } : {}),
  });
  // a JSON body already carried its own fields; attributes add the rest
  delete attrs.service;
  delete attrs.level;
  delete attrs.severity;
  delete attrs.severity_text;
  return { ...rec, fields: { ...attrs, ...rec.fields } };
}

class SignozSource implements Source {
  constructor(private post: SignozTransport) {}

  async query(q: LogQuery): Promise<LogRecord[]> {
    if (q.service && !SAFE_TOKEN.test(q.service)) throw new AxiError(`invalid service name \`${q.service}\``, { exitCode: 2 });
    if (q.id && !SAFE_TOKEN.test(q.id)) throw new AxiError(`invalid id \`${q.id}\``, { exitCode: 2 });
    return results(await this.post("/api/v5/query_range", rawRequest(q))).flatMap((r) => (r.rows ?? []).map(parseRow));
  }

  async serviceCounts(range: TimeRange): Promise<ServiceCount[]> {
    const out: ServiceCount[] = [];
    for (const r of results(await this.post("/api/v5/query_range", servicesRequest(range)))) {
      const cols = r.columns ?? [];
      const at = (name: string) => cols.findIndex((c) => c.name === name);
      const svc = at("service.name");
      const n = cols.findIndex((c) => c.columnType === "aggregation");
      for (const row of r.data ?? []) {
        out.push({
          service: String(row[svc] ?? "-"),
          level: r.queryName === "unknown" ? "-" : normalizeLevel(r.queryName),
          count: Number(row[n] ?? 0),
        });
      }
    }
    return out;
  }
}
