/**
 * SigNoz through its v5 query API (POST /api/v5/query_range: read-only).
 *
 * Env config: { "endpoint": "http://localhost:3301" }
 * The key comes from $LOGS_AXI_SIGNOZ_KEY, else the credentials file
 * `logs-axi signoz login` writes (src/lib/credentials.ts). It is sent as the
 * SIGNOZ-API-KEY header and never printed.
 */
import { AxiError } from "../lib/errors.js";
import { signozKey, validKey } from "../lib/credentials.js";
import { ID_FIELDS, LEVEL_ALIASES, MAX_SCAN, countServices, isoTime, levelsAtLeast, SAFE_TOKEN, serviceAliases, str } from "../core/normalize.js";
import type { LogQuery, LogRecord, QueryResult, ServiceCount, Source, SourceFactory, TimeRange } from "../core/types.js";

export interface SignozEnv {
  endpoint: string;
}

export type SignozTransport = (path: string, body: unknown) => Promise<unknown>;

export const signoz: SourceFactory = (raw, envName, transport) => {
  const label = `sources.signoz.${envName}`;
  const env = validate(raw, label);
  return new SignozSource((transport as SignozTransport | undefined) ?? httpTransport(env, label, envName));
};

function validate(raw: Record<string, unknown>, label: string): SignozEnv {
  if (typeof raw.endpoint !== "string" || !/^https?:\/\//.test(raw.endpoint)) {
    throw new AxiError(`config ${label} needs "endpoint" (http[s]://host:port)`, {
      help: ['e.g. { "endpoint": "http://localhost:3301" }'],
    });
  }
  return raw as unknown as SignozEnv;
}

function providerError(status: number | "error", payload?: unknown, key?: string): AxiError {
  const details = payload as { code?: unknown; type?: unknown; error?: { code?: unknown; type?: unknown } } | undefined;
  const auth = status === 401 || status === 403;
  // only fixed-shape tokens, never provider text: a message can quote log rows or the key
  const safe = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) && value !== "unknown" && !value.includes(key!);
  const code = !auth && key ? [details?.error?.code, details?.error?.type, details?.code, details?.type].find(safe) : undefined;
  const message = (details as { error?: { message?: unknown }; message?: unknown } | undefined)?.error?.message ?? (details as { message?: unknown } | undefined)?.message;
  const clickhouse = !auth && key && typeof message === "string" ? /^code: (\d{1,4}),/.exec(message)?.[1] : undefined;
  const reason = [code, clickhouse && !clickhouse.includes(key!) ? `ClickHouse code ${clickhouse}` : undefined].filter(Boolean).join(", ");
  return new AxiError(`signoz: ${status === "error" ? status : `HTTP ${status}`}: query failed${reason ? ` (${reason})` : ""}`, {
    help: [auth ? "Check your viewer key with `logs-axi signoz login`" : "Check the SigNoz endpoint configuration and query filters"],
  });
}

function httpTransport(env: SignozEnv, label: string, envName: string): SignozTransport {
  return async (path, body) => {
    const key = signozKey(envName);
    if (!key) throw new AxiError(`no SigNoz API key for ${label}`, { help: ["Run `logs-axi signoz login`"] });
    if (!validKey(key)) throw new AxiError("signoz: invalid API key; use a single printable ASCII token", { help: ["Run `logs-axi signoz login` to replace it"] });
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
        help: ["is the SigNoz endpoint reachable (is the port-forward up)?"],
      });
    }
    if (!res.ok) {
      let error: unknown;
      try { error = JSON.parse(text); } catch {}
      throw providerError(res.status, error, key);
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AxiError("signoz: response is not valid JSON");
    }
    if (payload?.status && payload.status !== "success") {
      throw providerError("error", payload, key);
    }
    return payload;
  };
}

const OTEL_SEVERITY_NAMES = ["trace", "debug", "info", "warn", "error", "fatal"] as const;
const SIGNOZ_LEVEL_ALIASES = new Map([
  ...Object.entries(LEVEL_ALIASES),
  ...OTEL_SEVERITY_NAMES.flatMap((name) => [2, 3, 4].map((suffix) => [`${name}${suffix}`, LEVEL_ALIASES[name]!] as const)),
]);
const MAX_SEVERITY_NUMBER = OTEL_SEVERITY_NAMES.length * 4;
const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/i;
const quote = (text: string) => "'" + text.replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
const contains = (text: string) => `log.body CONTAINS ${quote(text.replace(/[\\%_]/g, "\\$&"))}`;
const any = (terms: string[]) => `(${terms.join(" OR ")})`;
function numberLevel(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_SEVERITY_NUMBER) return undefined;
  return OTEL_SEVERITY_NAMES[Math.floor((value - 1) / 4)];
}

/** The v5 filter expression for a LogQuery. Exported for tests. */
export function buildFilter(q: LogQuery): string {
  const groups: string[] = [];
  if (q.minLevel) {
    const levels = levelsAtLeast(q.minLevel);
    const aliases = [...SIGNOZ_LEVEL_ALIASES].filter(([, level]) => levels.includes(level)).map(([alias]) => alias);
    const minimum = OTEL_SEVERITY_NAMES.indexOf(q.minLevel === "debug" ? "trace" : q.minLevel) * 4 + 1;
    const severityText = quote(`(?i)^(?:${aliases.join("|")})$`);
    groups.push(any([
      `log.severity_text REGEXP ${severityText}`,
      `(log.severity_number >= ${minimum} AND log.severity_number <= ${MAX_SEVERITY_NUMBER})`,
    ]));
  }
  if (q.service) {
    const list = serviceAliases(q.service).map(quote).join(", ");
    const service = `resource.service.name IN (${list})`;
    groups.push(q.service === "-" ? any([service, "resource.service.name = ''", "resource.service.name NOT EXISTS"]) : service);
  }
  if (q.id) {
    const hex = /^[0-9a-f]{32}$/i.test(q.id);
    const id = quote(q.id);
    const matches = ID_FIELDS.map((field) => `attribute.${field}:string ${hex ? "ILIKE" : "="} ${id}`);
    if (TRACE_ID.test(q.id)) matches.push(`log.trace_id = ${quote(q.id.toLowerCase())}`);
    groups.push(any(matches));
  }
  if (q.text) groups.push(contains(q.text));
  return groups.join(" AND ");
}

function rawRequest(q: LogQuery): unknown {
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

interface V5Result {
  rows?: { timestamp?: unknown; data?: Record<string, unknown> }[] | null;
}

function results(payload: unknown): V5Result[] {
  const p = payload as { status?: string; error?: unknown; data?: { data?: { results?: V5Result[] | null } } };
  // never echo the payload itself: a failed response can still carry rows
  if (p?.status && p.status !== "success") throw providerError("error");
  return p?.data?.data?.results ?? [];
}

const NOISE = /^(log\.|code\.|telemetry\.|otel\.)/;

/** One v5 raw row -> a LogRecord. Exported for tests. */
export function parseRow(row: { timestamp?: unknown; data?: Record<string, unknown> }): LogRecord {
  const d = row.data ?? {};
  const resources = d.resources_string as Record<string, unknown> | undefined;
  const fields: Record<string, unknown> = {
    ...d.attributes_bool as object,
    ...d.attributes_number as object,
    ...d.attributes_string as object,
  };
  for (const key of Object.keys(fields)) if (NOISE.test(key)) delete fields[key];
  const traceId = str(d.trace_id);
  const severityText = str(d.severity_text)?.toLowerCase() ?? "";
  const severityNumber = numberLevel(d.severity_number);
  return {
    time: isoTime(row.timestamp ?? d.timestamp) ?? "",
    service: str(resources?.["service.name"]) ?? "-",
    level: SIGNOZ_LEVEL_ALIASES.get(severityText) ?? (severityNumber ? LEVEL_ALIASES[severityNumber]! : severityText || "-"),
    msg: typeof d.body === "string" ? d.body : "",
    ...(traceId && TRACE_ID.test(traceId) ? { traceId } : {}),
    fields,
  };
}

class SignozSource implements Source {
  constructor(private request: SignozTransport) {}

  async query(q: LogQuery): Promise<QueryResult<LogRecord>> {
    if (q.service && !SAFE_TOKEN.test(q.service)) throw new AxiError(`invalid service name \`${q.service}\``, { exitCode: 2 });
    if (q.id && !SAFE_TOKEN.test(q.id)) throw new AxiError(`invalid id \`${q.id}\``, { exitCode: 2 });
    const payload = await this.request("/api/v5/query_range", rawRequest(q));
    const rows = results(payload).flatMap((result) => (result.rows ?? []).map(parseRow));
    return { rows, partial: false };
  }

  async serviceCounts(range: TimeRange): Promise<QueryResult<ServiceCount>> {
    const sample = await this.query({ ...range, limit: MAX_SCAN });
    return { rows: countServices(sample.rows), partial: sample.rows.length >= MAX_SCAN };
  }
}
