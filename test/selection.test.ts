import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { cloudwatch } from "../src/sources/cloudwatch.js";
import { signoz } from "../src/sources/signoz.js";
import { evaluate, insightsFields } from "./query-contract.js";
import { NOW, TEST_CONFIG, signozStub } from "./fixtures.js";

const scanLimit = 10_000;
const range = { start: NOW - 3600e3, end: NOW };
type Row = { timestamp: string; data: Record<string, any> };
const row = (body: unknown, index = 0, data: Record<string, unknown> = {}): Row => ({ timestamp: new Date(NOW - 1000 - index).toISOString(), data: { id: `row-${index}`, body: typeof body === "string" ? body : JSON.stringify(body), ...data } });
function signozWire(rows: Row[]) {
  const requests: any[] = [];
  const candidateSets = new Map<string, Row[]>();
  const fields = (r: Row) => ({ attribute: { ...r.data.attributes_string, ...r.data.attributes_number, ...r.data.attributes_bool }, resource: r.data.resources_string ?? {}, log: { body: r.data.body, severity_text: r.data.severity_text, trace_id: r.data.trace_id } });
  const transport = async (path: string, request: any) => {
    expect(path).toBe("/api/v5/query_range");
    requests.push(request);
    const results = request.compositeQuery.queries.map(({ spec }: any) => {
      if (request.requestType === "scalar") {
        if (spec.groupBy.some((key: any) => key.fieldContext === "body")) throw new Error("body fields can be filtered but not selected or grouped on a string-body store");
        const groups = new Map<string, { values: unknown[]; count: number }>();
        for (const r of rows) {
          const values = spec.groupBy.map((key: any) => evaluate(`${key.fieldContext}.${key.name}`, fields(r)) ?? null);
          const id = JSON.stringify(values);
          const group = groups.get(id) ?? { values, count: 0 };
          group.count++;
          groups.set(id, group);
        }
        return { queryName: spec.name, columns: [...spec.groupBy.map((key: any) => ({ ...key, columnType: "group" })), { name: "n", columnType: "aggregation" }], data: [...groups.values()].slice(0, spec.limit).map((group) => [...group.values, group.count]) };
      }
      const expression = spec.filter.expression;
      let candidates = candidateSets.get(expression);
      if (!candidates) {
        candidates = rows.filter((r) => !expression || evaluate(expression, fields(r)));
        candidateSets.set(expression, candidates);
      }
      return { queryName: spec.name, rows: candidates.slice(spec.offset, spec.offset + spec.limit) };
    });
    return { status: "success", data: { data: { results } } };
  };
  return { transport, requests };
}
function cloudwatchWire(rows: Row[], stream = "case/container/task") {
  const requests: any[] = [];
  let last: any;
  const transport = async (cmd: any) => {
    if (cmd.constructor.name === "StartQueryCommand") {
      last = cmd.input;
      requests.push(last);
      return { queryId: "test-query" };
    }
    if (last.queryString.includes("stats count(*)")) return { status: "Complete", results: [[{ field: "n", value: String(rows.length) }]] };
    const selected = rows.filter((r) => {
      let data = {};
      try { data = JSON.parse(r.data.body); } catch {}
      return insightsFields(last.queryString, { ...data, "@message": r.data.body, "@logStream": stream });
    }).slice(0, last.limit);
    return { status: "Complete", results: selected.map((r) => [{ field: "@timestamp", value: r.timestamp }, { field: "@message", value: r.data.body }, { field: "@logStream", value: stream }]) };
  };
  return { transport, requests };
}
const config = { region: "us-east-1", logGroups: ["test"] };

describe.each(["cloudwatch", "signoz"] as const)("%s normalized selection contract", (provider) => {
  const create = (rows: Row[]) => {
    if (provider === "cloudwatch") {
      const wire = cloudwatchWire(rows);
      return { ...wire, source: cloudwatch(config, "test", wire.transport) };
    }
    const wire = signozWire(rows);
    return { ...wire, source: signoz({ endpoint: "http://x" }, "test", wire.transport) };
  };
  it.each([50, false, null, "", [], {}])("ignores a non-string/empty level, severity, message or service override: %j", async (invalid) => {
    const bodies = [
      { level: invalid, severity: "ERROR", msg: "request" },
      { severity: invalid, severity_text: "ERROR", msg: "request" },
      { severity_text: invalid, msg: "Error: failed" },
      { msg: invalid, message: "Error: failed" },
      { message: invalid, error: "Error: failed" },
    ];
    for (const body of bodies) {
      const test = create([row({ ...body, service: invalid }, 0, { resources_string: { "service.name": "case" } })]);
      const result = await test.source.query({ ...range, minLevel: "error", service: "case", limit: 1 });
      expect(result.partial).toBe(false);
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ level: "error", service: "case" });
      expect(await test.source.serviceCounts(range)).toEqual({ rows: [{ level: "error", service: "case", count: 1 }], partial: false });
    }
  });
  it("fills the requested limit after rejecting newer candidate rows", async () => {
    const candidates = Array.from({ length: 150 }, (_, i) => row({ level: "warn", severity: "error", msg: "Error: bait", service: "case" }, i));
    candidates.push(row({ level: 50, severity: "error", msg: "first", service: "case" }, 150), row({ level: false, severity: "error", msg: "second", service: "case" }, 151));
    const test = create(candidates);
    const result = await test.source.query({ ...range, minLevel: "error", limit: 2 });
    expect(result).toMatchObject({ partial: false });
    expect(result.rows.map((r) => r.msg)).toEqual(["first", "second"]);
    if (provider === "signoz") expect(test.requests.some((r) => r.compositeQuery.queries[0].spec.offset >= 100)).toBe(true);
    else expect(test.requests[0].limit).toBeGreaterThan(2);
  });
  it("uses rendered service and supported IDs rather than lower-priority field matches", async () => {
    const input = row({ level: "error", service: "chosen", requestId: "chosen-id", msg: "failed" }, 0, { attributes_string: { service: "ignored", requestId: "ignored-id" }, resources_string: { "service.name": "ignored" } });
    const test = create([input]);
    expect((await test.source.query({ ...range, service: provider === "cloudwatch" ? "case" : "ignored", limit: 1 })).rows).toEqual([]);
    expect((await test.source.query({ ...range, id: "ignored-id", limit: 1 })).rows).toEqual([]);
    expect((await test.source.query({ ...range, id: "chosen-id", service: "chosen", limit: 1 })).rows).toHaveLength(1);
  });
  it("reports an unfinished scan instead of claiming an empty complete result", async () => {
    const candidates = Array.from({ length: scanLimit + 1 }, (_, i) => row({ level: i === scanLimit ? "error" : "warn", severity: "error", msg: "Error: bait" }, i));
    const test = create(candidates);
    const result = await test.source.query({ ...range, minLevel: "error", limit: 1 });
    expect(result).toEqual({ rows: [], partial: true });
    const out = await run([provider, "dev", "errors", "--json"], { config: TEST_CONFIG, now: NOW, transports: { [provider]: test.transport } });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out).partial).toBe(true);
    expect(JSON.parse(out.out).help.join(" ")).toContain("counts may be partial");
  });
  it("counts normalized records and marks counts as lower bounds after the sample cap", async () => {
    const input = Array.from({ length: scanLimit + 1 }, (_, i) => row({ service: i % 2 ? "case" : "ehr", level: "error", msg: "failed" }, i, { resources_string: { "service.name": "shared" } }));
    const test = create(input);
    const result = await test.source.serviceCounts(range);
    expect(result.partial).toBe(true);
    expect(result.rows.reduce((n, item) => n + item.count, 0)).toBe(scanLimit);
    expect(result.rows.map((item) => item.service).sort()).toEqual(["case", "ehr"]);
    expect(result.rows.every((item) => item.level === "error")).toBe(true);
  });
  it.each([[], ["--json"]])("omits sensitive search input from empty-result hints %j", async (...format) => {
    for (const text of ["Jane Testperson", "jane testperson", "MRN: 'A12345'", '{"medication":"apixaban"}']) {
      const test = create([]);
      const result = await run([provider, "dev", "search", text, ...format], { config: TEST_CONFIG, now: NOW, transports: { [provider]: test.transport } });
      expect(result.code).toBe(0);
      expect(result.out).not.toMatch(/Jane|jane|A12345|apixaban/);
      expect(result.out).toContain("<search text>");
    }
  });
});

it("SigNoz string-body stores reject body grouping but still count normalized body services", async () => {
  const input = [row({ service: "case", level: 50, msg: "failed" }, 0, { severity_text: "ERROR", resources_string: { "service.name": "shared" } }), row({ service: "ehr", level: false, msg: "failed" }, 1, { severity_text: "ERROR", resources_string: { "service.name": "shared" } })];
  const wire = signozWire(input);
  await expect(wire.transport("/api/v5/query_range", { requestType: "scalar", compositeQuery: { queries: [{ spec: { name: "A", groupBy: [{ name: "service", fieldContext: "body" }], limit: 1000 } }] } })).rejects.toThrow("not selected or grouped");
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect(await source.serviceCounts(range)).toEqual({ rows: [{ service: "case", level: "error", count: 1 }, { service: "ehr", level: "error", count: 1 }], partial: false });
});

it.each(["level", "severity", "severity_text"])("SigNoz ignores numeric/boolean attribute.%s before using native severity", async (field) => {
  for (const invalid of [50, false]) {
    const input = row("request", 0, { severity_text: "ERROR", attributes_number: { [field]: invalid } });
    const wire = signozWire([input]);
    const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
    expect((await source.query({ ...range, minLevel: "error", limit: 1 })).rows[0]?.level).toBe("error");
  }
});

it("unredacted search help retains the explicit raw-data behavior and warning", async () => {
  const result = await run(["signoz", "dev", "search", "Jane Testperson", "--unredacted", "--json"], { config: TEST_CONFIG, now: NOW, transports: { signoz: signozStub([]) } });
  const output = JSON.parse(result.out);
  expect(output.warning).toContain("UNREDACTED");
  expect(output.help.join(" ")).toContain("Jane Testperson");
});
