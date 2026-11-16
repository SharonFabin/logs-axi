/**
 * The contract every source adapter implements. Commands (tail, search, errors, trace,
 * services, fields) live in core and only ever see these shapes, so a new source is one
 * file in src/sources/ plus one registry line, and touches no other adapter.
 */

export const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;
export type Level = (typeof LEVELS)[number];

/** One log line, normalized. `fields` holds everything that is not one of the five columns. */
export interface LogRecord {
  /** ISO-8601 UTC. */
  time: string;
  level: string;
  service: string;
  msg: string;
  traceId?: string;
  fields: Record<string, unknown>;
}

export interface TimeRange {
  /** Epoch milliseconds. */
  start: number;
  end: number;
}

export interface LogQuery extends TimeRange {
  /** Case-insensitive substring of the message. */
  text?: string;
  /** Lines at this level or above. */
  minLevel?: Level;
  /** Service name; adapters also match the `<name>-service` spelling. */
  service?: string;
  /** A trace, request, case or run id: every line carrying it. */
  id?: string;
  /** Newest first, at most this many. */
  limit: number;
}

export interface ServiceCount {
  service: string;
  level: string;
  count: number;
}

export interface Source {
  query(q: LogQuery): Promise<LogRecord[]>;
  serviceCounts(range: TimeRange): Promise<ServiceCount[]>;
}

/**
 * Builds a source for one environment. `env` is that environment's block from the
 * config file, unvalidated: the factory checks the keys it needs. `transport` is the
 * test seam (recorded responses); production passes undefined.
 */
export type SourceFactory = (env: Record<string, unknown>, label: string, transport?: unknown) => Source;
