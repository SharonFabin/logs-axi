import { describe, expect, it } from "vitest";
import { run } from "../src/cli.js";
import { cloudwatch } from "../src/sources/cloudwatch.js";
import { signoz } from "../src/sources/signoz.js";
import { evaluate, insightsFields, signozQueryFields } from "./query-contract.js";
import { NOW, TEST_CONFIG, signozStub } from "./fixtures.js";

const scanLimit = 10_000;
const range = { start: NOW - 3600e3, end: NOW };
type Row = { timestamp: string; data: Record<string, any> };
const row = (body: unknown, index = 0, data: Record<string, unknown> = {}): Row => ({ timestamp: new Date(NOW - 1000 - index).toISOString(), data: { id: `row-${index}`, body: typeof body === "string" ? body : JSON.stringify(body), ...data } });
function signozWire(rows: Row[]) {
  const requests: any[] = [];
  const pageSizes: number[] = [];
  const candidateSets = new Map<string, Row[]>();
  const transport = async (path: string, request: any) => {
    expect(path).toBe("/api/v5/query_range");
    requests.push(request);
    const results = request.compositeQuery.queries.map(({ spec }: any) => {
      expect(request.requestType).toBe("raw");
      const expression = spec.filter.expression;
      let candidates = candidateSets.get(expression);
      if (!candidates) {
        candidates = rows.filter((r) => !expression || evaluate(expression, signozQueryFields(r.data)));
        candidateSets.set(expression, candidates);
      }
      expect(spec.order).toEqual([
        { key: { name: "timestamp" }, direction: "desc" },
        { key: { name: "id" }, direction: "desc" },
      ]);
      const page = candidates.toSorted((a, b) => {
        if (a.timestamp !== b.timestamp) return a.timestamp < b.timestamp ? 1 : -1;
        return a.data.id < b.data.id ? 1 : a.data.id > b.data.id ? -1 : 0;
      }).slice(0, spec.limit);
      pageSizes.push(page.length);
      return { queryName: spec.name, rows: page };
    });
    return { status: "success", data: { data: { results } } };
  };
  return { transport, requests, pageSizes };
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
    const selected = rows.filter((r) => {
      let data = {};
      try { data = JSON.parse(r.data.body); } catch {}
      return insightsFields(last.queryString, { ...data, "@timestamp": r.timestamp, "@message": r.data.body, "@logStream": stream });
    }).slice(0, last.limit);
    return { status: "Complete", results: selected.map((r) => [{ field: "@timestamp", value: r.timestamp }, { field: "@message", value: r.data.body }, { field: "@logStream", value: stream }]) };
  };
  return { transport, requests };
}
const config = { region: "us-east-1", logGroups: ["test"] };

function createCloudwatch(rows: Row[]) {
  const wire = cloudwatchWire(rows);
  return { ...wire, source: cloudwatch(config, "test", wire.transport) };
}

describe.each(["cloudwatch", "signoz"] as const)("%s normalized selection contract", (provider) => {
  const create = (rows: Row[]) => {
    if (provider === "cloudwatch") return createCloudwatch(rows);
    const wire = signozWire(rows);
    return { ...wire, source: signoz({ endpoint: "http://x" }, "test", wire.transport) };
  };
  it.each([1, 50])("requests only %i rows when no client filter can reject them", async (limit) => {
    const test = create(Array.from({ length: 200 }, (_, i) => row({ level: "info", msg: `line-${i}` }, i)));
    const result = await test.source.query({ ...range, limit });
    expect(result.rows).toHaveLength(limit);
    expect(result.partial).toBe(false);
    expect(test.requests).toHaveLength(1);
    const sent = provider === "cloudwatch" ? test.requests[0] : test.requests[0].compositeQuery.queries[0].spec;
    expect(sent.limit).toBe(limit);
  });
  it("counts 1000 services completely using only the normalized sample", async () => {
    const input = Array.from({ length: 1000 }, (_, i) => row({ service: `service-${i}`, level: "error", msg: "failed" }, i, { severity_number: 17, resources_string: { "service.name": `service-${i}` } }));
    const test = create(input);
    const result = await test.source.serviceCounts(range);
    expect(result.partial).toBe(false);
    expect(result.rows).toHaveLength(1000);
    expect(result.rows.every((item) => item.count === 1 && item.level === "error")).toBe(true);
    expect(test.requests).toHaveLength(1);
    if (provider === "signoz") expect(test.requests[0].requestType).toBe("raw");
  });
  it("counts normalized records and marks counts as lower bounds after the sample cap", async () => {
    const input = Array.from({ length: scanLimit + 1 }, (_, i) => row({ service: i % 2 ? "case" : "ehr", level: "error", msg: "failed" }, i, { severity_text: "ERROR", resources_string: { "service.name": i % 2 ? "case" : "ehr" } }));
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

describe("cloudwatch candidate selection", () => {
  it.each([50, false, null, "", [], {}])("ignores a non-string/empty level, severity, message or service override: %j", async (invalid) => {
    const bodies = [
      { level: invalid, severity: "ERROR", msg: "request" },
      { severity: invalid, severity_text: "ERROR", msg: "request" },
      { severity_text: invalid, msg: "Error: failed" },
      { msg: invalid, message: "Error: failed" },
      { message: invalid, error: "Error: failed" },
    ];
    for (const body of bodies) {
      const test = createCloudwatch([row({ ...body, service: invalid })]);
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
    const test = createCloudwatch(candidates);
    const result = await test.source.query({ ...range, minLevel: "error", limit: 2 });
    expect(result).toMatchObject({ partial: false });
    expect(result.rows.map((r) => r.msg)).toEqual(["first", "second"]);
    expect(test.requests[0].limit).toBeGreaterThan(2);
  });
  it("reports an unfinished scan instead of claiming an empty complete result", async () => {
    const candidates = Array.from({ length: scanLimit + 1 }, (_, i) => row({ level: i === scanLimit ? "error" : "warn", severity: "error", msg: "Error: bait" }, i));
    const test = createCloudwatch(candidates);
    const result = await test.source.query({ ...range, minLevel: "error", limit: 1 });
    expect(result).toEqual({ rows: [], partial: true });
    const out = await run(["cloudwatch", "dev", "errors", "--json"], { config: TEST_CONFIG, now: NOW, transports: { cloudwatch: test.transport } });
    expect(out.code).toBe(0);
    expect(JSON.parse(out.out).partial).toBe(true);
    expect(JSON.parse(out.out).help.join(" ")).toContain("counts may be partial");
  });
});

it("SigNoz combines plain message and native metadata predicates", async () => {
  const metadata = { severity_number: 17, resources_string: { "service.name": "case" }, attributes_string: { requestId: "req-1" } };
  const wire = signozWire([
    row("socket closed", 0, metadata),
    row("connection to other service", 1, { ...metadata, resources_string: { "service.name": "other" } }),
    row("connection restored", 2, { ...metadata, severity_number: 9 }),
    row("connection for another request", 3, { ...metadata, attributes_string: { requestId: "req-2" } }),
    row("connection refused", 4, metadata),
  ]);
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wire.transport } };
  for (const { args, messages } of [
    { args: ["search", "CONNECTION"], messages: ["connection refused", "connection for another request"] },
    { args: ["trace", "req-1"], messages: ["connection refused", "socket closed"] },
  ]) {
    const result = await run(["signoz", "dev", ...args, "--level", "error", "--service", "case", "--limit", "2", "--json"], deps);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out).lines.map(({ msg }: { msg: string }) => msg)).toEqual(messages);
  }
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  const combined = await source.query({ ...range, text: "CONNECTION", id: "req-1", minLevel: "error", service: "case", limit: 1 });
  expect(combined.rows.map(({ msg }) => msg)).toEqual(["connection refused"]);
  const result = await run(["signoz", "dev", "search", "req-1", "--level", "error", "--json"], deps);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).lines).toBe(0);
  expect(wire.pageSizes).toEqual([2, 2, 1, 0]);
});

it.each([
  { query: { minLevel: "error" }, metadata: { severity_number: 17 } },
  { query: { minLevel: "error" }, metadata: { severity_text: "ErRoR" } },
  { query: { service: "case" }, metadata: { resources_string: { "service.name": "case-service" } } },
  { query: { id: "ABCDEF0123456789ABCDEF0123456789" }, metadata: { trace_id: "abcdef0123456789abcdef0123456789" } },
  { query: { id: "req-1" }, metadata: { attributes_string: { requestId: "req-1" } } },
  { query: { text: "needle" }, metadata: {} },
] as const)("SigNoz selects an older direct match in the first request for $query", async ({ query, metadata }) => {
  const noise = 'error budget for "case" in req-1 / abcdef0123456789abcdef0123456789';
  const wire = signozWire([
    ...Array.from({ length: scanLimit }, (_, i) => row(noise, i, { severity_number: 9 })),
    row("needle found", scanLimit, metadata),
  ]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect(await source.query({ ...range, ...query, limit: 1 })).toMatchObject({ partial: false, rows: [{ msg: "needle found" }] });
  expect(wire.pageSizes).toEqual([1]);
});

it.each([
  ['JOB "SYNC"', 'completed job "sync"', "completed job sync"],
  ["job\nsync", "completed job\nsync", "completed job sync"],
  ["E_CONN", "socket failed with e_conn", "socket failed with EXCONN"],
  ["50% complete", "upload is 50% complete", "upload is 50 percent complete"],
  [String.raw`E\_CONN`, String.raw`socket failed with e\_conn`, String.raw`socket failed with E\XCONN`],
])("SigNoz matches literal native messages for %j", async (text, message, nearMatch) => {
  const wire = signozWire([row(nearMatch, 0), row(message, 1)]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect(await source.query({ ...range, text, limit: 1 })).toMatchObject({ partial: false, rows: [{ msg: message }] });
  expect(wire.pageSizes).toEqual([1]);
});

it("SigNoz applies the limit to the newest provider matches in one request", async () => {
  const wire = signozWire([
    row("older native error", 2, { severity_number: 17 }),
    row("newest error", 0, { severity_text: "ERROR" }),
    row("second error", 1, { severity_number: 18 }),
  ]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  const result = await source.query({ ...range, minLevel: "error", limit: 2 });
  expect(result.rows.map(({ msg }) => msg)).toEqual(["newest error", "second error"]);
  expect(result.partial).toBe(false);
  expect(wire.pageSizes).toEqual([2]);
  expect(wire.requests[0].compositeQuery.queries[0].spec.limit).toBe(2);
});

it("SigNoz returns an underfilled legacy text result after one request", async () => {
  const wire = signozWire([row("unrelated", 0), row("needle found", 1)]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect(await source.query({ ...range, text: "needle", limit: 50 })).toMatchObject({ partial: false, rows: [{ msg: "needle found" }] });
  expect(wire.pageSizes).toEqual([1]);
  expect(wire.requests[0].compositeQuery.queries[0].spec.limit).toBe(50);
});

it("SigNoz uses numeric severity for CLI filters, grouping, and service counts", async () => {
  const wire = signozWire([
    row("routine operation", 0, { severity_number: 16, resources_string: { "service.name": "case" } }),
    row("connection refused", 1, { severity_number: 18, resources_string: { "service.name": "case" } }),
  ]);
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wire.transport } };
  const search = await run(["signoz", "dev", "search", "--level", "error", "--json"], deps);
  expect(search.code).toBe(0);
  expect(JSON.parse(search.out).lines).toMatchObject([{ msg: "connection refused", level: "error" }]);
  const errors = await run(["signoz", "dev", "errors", "--json"], deps);
  expect(errors.code).toBe(0);
  expect(JSON.parse(errors.out).groups).toMatchObject([{ template: "connection refused", count: 1 }]);
  const services = await run(["signoz", "dev", "services", "--json"], deps);
  expect(services.code).toBe(0);
  expect(JSON.parse(services.out).services).toEqual([{ service: "case", lines: 2, errors: 1, warns: 1 }]);
});

it("SigNoz uses valid severity numbers before text for selection, display, and counts", async () => {
  const resource = { resources_string: { "service.name": "case" } };
  const wire = signozWire([
    row("mismatched info", 0, { ...resource, severity_number: 9, severity_text: "ERROR" }),
    row("mismatched error", 1, { ...resource, severity_number: 17, severity_text: "INFO" }),
    row("labeled critical", 2, { ...resource, severity_number: 18, severity_text: "Critical" }),
    row("out of range", 3, { ...resource, severity_number: 25, severity_text: "WARN" }),
    row("unspecified number", 4, { ...resource, severity_number: 0, severity_text: "WARN" }),
    row("unknown label", 5, { ...resource, severity_number: 0, severity_text: "ERROR2" }),
  ]);
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wire.transport } };
  const execute = async (...args: string[]) => {
    const result = await run(["signoz", "dev", ...args, "--json"], deps);
    expect(result.code).toBe(0);
    return JSON.parse(result.out);
  };
  expect((await execute("search", "--level", "error", "--limit", "2")).lines).toMatchObject([
    { msg: "labeled critical", level: "error" }, { msg: "mismatched error", level: "error" },
  ]);
  expect((await execute("search", "--level", "fatal")).lines).toBe(0);
  expect((await execute("search", "--level", "warn")).lines).toMatchObject([
    { msg: "unspecified number", level: "warn" }, { msg: "out of range", level: "warn" },
    { msg: "labeled critical", level: "error" }, { msg: "mismatched error", level: "error" },
  ]);
  expect(await execute("errors", "--service", "case")).toMatchObject({ scanned: 2 });
  expect((await execute("services")).services).toEqual([{ service: "case", lines: 6, errors: 2, warns: 2 }]);
});

it("SigNoz excludes attribute copies of service and severity from output context", async () => {
  const wire = signozWire([row("request", 0, {
    severity_number: 17,
    resources_string: { "service.name": "case" },
    attributes_string: { service: "other", severity_text: "INFO", requestId: "req-1" },
    attributes_number: { level: 9 },
    attributes_bool: { severity: false },
  })]);
  const deps = { config: TEST_CONFIG, now: NOW, transports: { signoz: wire.transport } };
  const tail = await run(["signoz", "dev", "tail", "--json"], deps);
  expect(tail.code).toBe(0);
  expect(JSON.parse(tail.out).lines).toMatchObject([{ msg: "request", service: "case", level: "error", ctx: "requestId=req-1" }]);
  const fields = await run(["signoz", "dev", "fields", "--json"], deps);
  expect(fields.code).toBe(0);
  expect(JSON.parse(fields.out).fields).toMatchObject([{ field: "requestId", examples: "req-1" }]);
});

it("SigNoz trace uses exact operational IDs from provider attributes", async () => {
  const wire = signozWire([
    row("wrong ID case", 0, { attributes_string: { requestId: "REQ-1" } }),
    row("wrong key case", 1, { attributes_string: { RequestId: "req-1" } }),
    row("invalid native ID", 2, { trace_id: "req-1" }),
    row("selected", 3, { attributes_string: { requestId: "req-1" } }),
  ]);
  const result = await run(["signoz", "dev", "trace", "req-1", "--json"], {
    config: TEST_CONFIG, now: NOW, transports: { signoz: wire.transport },
  });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).lines).toMatchObject([{ msg: "selected" }]);
});

it("CloudWatch trace follows IDs anywhere in the wire line while honoring level and service", async () => {
  const input = [
    row("Error handling request req-123", 0),
    row({ level: "error", service: "case", msg: "failed req-123" }, 1),
    row({ level: "error", service: "case", msg: "nested match", diagnostic: { request: "req-123" } }, 2),
    row({ level: "warn", service: "case", msg: "warning req-123" }, 3),
    row({ level: "error", service: "other", msg: "other req-123" }, 4),
    row({ level: "error", service: "case", msg: "unrelated req-456" }, 5),
  ];
  const wire = cloudwatchWire(input);
  const result = await run(["cloudwatch", "dev", "trace", "req-123", "--level", "error", "--service", "case", "--json"], { config: TEST_CONFIG, now: NOW, transports: { cloudwatch: wire.transport } });
  expect(result.code).toBe(0);
  expect(JSON.parse(result.out).lines.map((line: any) => line.msg)).toEqual(["nested match", "failed req-123", "Error handling request req-123"]);
});

it("CloudWatch trace uses its requested limit for provider-only substring matching", async () => {
  const wire = cloudwatchWire([row("request 4bf92f3577b34da6a3ce929d0e0e4736 completed")]);
  const source = cloudwatch(config, "test", wire.transport);
  const result = await source.query({ ...range, id: "4BF92F3577B34DA6A3CE929D0E0E4736", limit: 1 });
  expect(result.rows).toHaveLength(1);
  expect(wire.requests).toHaveLength(1);
  expect(wire.requests[0].limit).toBe(1);
});

it("CloudWatch applies inclusive millisecond bounds before limiting every command", async () => {
  const base = Date.parse("2026-11-16T14:00:00.000Z");
  const input = [1900, 1101, 1100, 1000, 900, 899].map((offset, i) => ({
    ...row({ level: "error", service: "case", msg: "Error handling request req-123", requestId: "req-123", marker: `at-${offset}` }, i),
    timestamp: new Date(base + offset).toISOString(),
  }));
  let selected: Row[] = [];
  const transport = async (command: any) => {
    if (command.constructor.name === "StartQueryCommand") {
      const request = command.input;
      selected = input.filter((entry) => Date.parse(entry.timestamp) >= request.startTime * 1000 && Date.parse(entry.timestamp) <= request.endTime * 1000);
      for (const stage of request.queryString.split("\n")) {
        if (stage.startsWith("| filter ")) selected = selected.filter((entry) => evaluate(stage.slice(9), { ...JSON.parse(entry.data.body), "@timestamp": entry.timestamp, "@message": entry.data.body, "@logStream": "case/container/task" }));
        else if (stage === "| sort @timestamp desc") selected.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
        else if (stage.startsWith("| limit ")) selected = selected.slice(0, Number(stage.slice(8)));
      }
      selected = selected.slice(0, request.limit);
      return { queryId: "range-query" };
    }
    return { status: "Complete", results: selected.map((entry) => [{ field: "@timestamp", value: entry.timestamp }, { field: "@message", value: entry.data.body }, { field: "@logStream", value: "case/container/task" }]) };
  };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { cloudwatch: transport } };
  const from = new Date(base + 900).toISOString();
  const until = new Date(base + 1100).toISOString();
  const execute = async (...command: string[]) => {
    const result = await run(["cloudwatch", "dev", ...command, "--from", from, "--until", until, "--json"], deps);
    expect(result.code).toBe(0);
    return JSON.parse(result.out);
  };
  for (const command of [["tail"], ["search", "req-123"], ["trace", "req-123"]]) {
    const result = await execute(...command, "--limit", "1");
    expect(result.lines).toHaveLength(1);
    expect(result.lines[0].ctx).toContain("marker=at-1100");
  }
  expect((await execute("errors")).scanned).toBe(3);
  expect((await execute("services")).services).toEqual([{ service: "case", lines: 3, errors: 3, warns: 0 }]);
  const fields = await execute("fields");
  expect(fields.sampled).toBe(3);
  expect(fields.fields.find((field: any) => field.field === "marker").examples).toBe("at-1100 | at-1000 | at-900");
});

it.each(["traceId", "trace_id", "requestId", "correlationId", "caseId", "runId"])("SigNoz applies case-insensitive hex matching to string attribute %s", async (field) => {
  const lower = "4bf92f3577b34da6a3ce929d0e0e4736";
  const upper = "4BF92F3577B34DA6A3CE929D0E0E4736";
  const wire = signozWire([row("attribute match", 0, { attributes_string: { [field]: lower } })]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  const result = await source.query({ ...range, id: upper, limit: 1 });
  expect(result.rows).toMatchObject([{ msg: "attribute match", fields: { [field]: lower } }]);
});

it.each(["123", "true"])("SigNoz trace %s matches strings and skips coerced attributes", async (id) => {
  const wire = signozWire([
    row("number attribute", 0, { attributes_number: { requestId: 123 } }),
    row("boolean attribute", 1, { attributes_bool: { requestId: true } }),
    row("string attribute", 2, { attributes_string: { requestId: id } }),
  ]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect((await source.query({ ...range, id, limit: 1 })).rows).toMatchObject([{ msg: "string attribute" }]);
});

it("SigNoz excludes out-of-range numeric severities before limiting", async () => {
  const wire = signozWire([
    row("out of range", 0, { severity_number: 25 }),
    row("upper boundary", 1, { severity_number: 24 }),
    row("lower boundary", 2, { severity_number: 21 }),
    row("below fatal", 3, { severity_number: 20 }),
  ]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  expect((await source.query({ ...range, minLevel: "fatal", limit: 2 })).rows).toMatchObject([
    { msg: "upper boundary", level: "fatal" }, { msg: "lower boundary", level: "fatal" },
  ]);
});

it("SigNoz ignores structured-looking messages and shadowing attributes during selection", async () => {
  const message = '{"msg":"fake error", "error":null,"context":{"level":"error","service":"case","requestId":"req-1"}}';
  const wire = signozWire([
    row(message, 0, { resources_string: { "service.name": "ehr" }, attributes_string: { service: "case", level: "error" } }),
    row("connection refused", 1, { resources_string: { "service.name": "case" }, severity_number: 17, attributes_string: { requestId: "req-1" } }),
  ]);
  const source = signoz({ endpoint: "http://x" }, "test", wire.transport);
  for (const query of [{ minLevel: "error" }, { service: "case" }, { id: "req-1" }] as const) {
    expect((await source.query({ ...range, ...query, limit: 1 })).rows).toMatchObject([{ msg: "connection refused" }]);
  }
  expect((await source.query({ ...range, text: "fake error", limit: 1 })).rows).toMatchObject([{ msg: message, level: "-", service: "ehr" }]);
});

it("unredacted search help retains the explicit raw-data behavior and warning", async () => {
  const result = await run(["signoz", "dev", "search", "Jane Testperson", "--unredacted", "--json"], { config: TEST_CONFIG, now: NOW, transports: { signoz: signozStub([]) } });
  const output = JSON.parse(result.out);
  expect(output.warning).toContain("UNREDACTED");
  expect(output.help.join(" ")).toContain("Jane Testperson");
});
