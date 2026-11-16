/**
 * SigNoz through its v5 query API (POST /api/v5/query_range: read-only).
 *
 * Env config: { "endpoint": "http://localhost:3301", "apiKeyEnv": "SIGNOZ_API_KEY_DEV" }
 * The key comes from the env var `apiKeyEnv` names (default SIGNOZ_API_KEY), or from
 * "apiKey" in the config. It is sent as the SIGNOZ-API-KEY header and never printed.
 */
import { AxiError } from "../lib/errors.js";
import { maskText } from "../lib/redact.js";
import { ID_FIELDS, INFERRED_LEVELS, LEVEL_ALIASES, MAX_SCAN, countServices, isoTime, levelsAtLeast, matchesRecord, parseLine, SAFE_TOKEN, serviceAliases, str } from "../core/normalize.js";
import type { LogQuery, LogRecord, QueryResult, ServiceCount, Source, SourceFactory, TimeRange } from "../core/types.js";

export interface SignozEnv {
  endpoint: string;
  apiKey?: string;
  apiKeyEnv?: string;
}

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
    if (typeof key !== "string" || !/^[\x21-\x7e]+$/.test(key)) throw new AxiError("signoz: invalid API key; use a single printable ASCII token");
    let res: Response;
    let text: string;
    try {
      res = await fetch(env.endpoint.replace(/\/$/, "") + path, {
        method: "POST",
        headers: { "content-type": "application/json", "SIGNOZ-API-KEY": key },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      text = await res.text();
    } catch {
      throw new AxiError("signoz: request failed; check the endpoint and connection", {
        help: ["is the SSM port-forward up? `terraform output signoz_ui_command` in infra/aws/environments/<env> prints it"],
      });
    }
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

const LEVEL_FIELDS = ["body.level", "body.severity", "body.severity_text", "attribute.level", "attribute.severity", "attribute.severity_text", "log.severity_text"];
const SERVICE_FIELDS = [
  { name: "service.name", fieldContext: "resource" },
  { name: "service", fieldContext: "attribute" },
];
const SERVICE_FILTER_FIELDS = ["body.service", ...SERVICE_FIELDS.map((field) => `${field.fieldContext}.${field.name}`)];
const any = (parts: string[]) => "(" + parts.join(" OR ") + ")";

/** The v5 filter expression for a LogQuery. Exported for tests. */
export function buildFilter(q: LogQuery): string {
  const parts: string[] = [];
  if (q.service && q.service !== "-") parts.push(any(SERVICE_FILTER_FIELDS.map((field) => `${field} IN (${serviceAliases(q.service!).map((name) => lit(name)).join(", ")})`)));
  if (q.minLevel && q.minLevel !== "debug") {
    const levels = levelsAtLeast(q.minLevel);
    const aliases = Object.entries(LEVEL_ALIASES).filter(([, level]) => levels.includes(level)).map(([alias]) => alias);
    parts.push(any([
      ...LEVEL_FIELDS.map((field) => `${field} REGEXP ${lit("(?i)^(" + aliases.join("|") + ")$")}`),
      ...["body.msg", "body.message", "log.body"].flatMap((field) => INFERRED_LEVELS.filter(([level]) => levels.includes(level)).map(([, pattern]) => `${field} REGEXP ${lit("(?i)" + pattern)}`)),
    ]));
  }
  if (q.text) parts.push(`log.body CONTAINS ${lit(q.text, true)}`);
  if (q.id) {
    const matches = ID_FIELDS.flatMap((field) => ["body", "attribute"].map((context) => /^[0-9a-f]{32}$/i.test(q.id!) ? `${context}.${field} REGEXP ${lit("(?i)^" + q.id + "$")}` : `${context}.${field} = ${lit(q.id!)}`));
    if (/^[0-9a-f]{32}$/i.test(q.id)) matches.push(`log.trace_id = ${lit(q.id.toLowerCase())}`);
    parts.push(any(matches));
  }
  return parts.join(" AND ");
}

export function rawRequest(q: LogQuery, offset = 0): unknown {
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
            offset,
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
      queries: [{
        type: "builder_query",
        spec: {
          name: "A",
          signal: "logs",
          aggregations: [{ expression: "count()", alias: "n" }],
          groupBy: SERVICE_FIELDS,
          order: [{ key: { name: "count()" }, direction: "desc" }],
          limit: 1000,
        },
      }],
    },
  };
}

interface V5Result {
  rows?: { timestamp?: unknown; data?: Record<string, unknown> }[] | null;
  columns?: { columnType?: string }[];
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
    service: str(resources["service.name"]) ?? str(attrs.service) ?? "-",
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
  constructor(private request: SignozTransport) {}

  async query(q: LogQuery): Promise<QueryResult<LogRecord>> {
    if (q.service && !SAFE_TOKEN.test(q.service)) throw new AxiError(`invalid service name \`${q.service}\``, { exitCode: 2 });
    if (q.id && !SAFE_TOKEN.test(q.id)) throw new AxiError(`invalid id \`${q.id}\``, { exitCode: 2 });
    const rows: LogRecord[] = [];
    const pageSize = Math.min(1000, Math.max(100, q.limit));
    let offset = 0;
    while (offset < MAX_SCAN) {
      const limit = Math.min(pageSize, MAX_SCAN - offset);
      const page = results(await this.request("/api/v5/query_range", rawRequest({ ...q, limit }, offset))).flatMap((result) => result.rows ?? []);
      offset += page.length;
      for (const row of page) {
        const record = parseRow(row);
        if (matchesRecord(record, q)) rows.push(record);
        if (rows.length === q.limit) return { rows, partial: false };
      }
      if (page.length < limit) return { rows, partial: false };
    }
    return { rows, partial: true };
  }

  async serviceCounts(range: TimeRange): Promise<QueryResult<ServiceCount>> {
    const groups = results(await this.request("/api/v5/query_range", servicesRequest(range)));
    let total = 0;
    let partial = false;
    for (const result of groups) {
      const count = (result.columns ?? []).findIndex((column) => column.columnType === "aggregation");
      for (const row of result.data ?? []) total += Number(row[count] ?? 0);
      if ((result.data?.length ?? 0) >= 1000) partial = true;
    }
    const sample = await this.query({ ...range, limit: MAX_SCAN });
    return { rows: countServices(sample.rows), partial: partial || sample.partial || total > sample.rows.length || sample.rows.length >= MAX_SCAN };
  }
}
