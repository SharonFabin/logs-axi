import { describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { maskText, redactObject } from "../src/lib/redact.js";
import { buildQuery, SERVICES_QUERY, parseRow as cwRow } from "../src/sources/cloudwatch.js";
import { buildFilter, servicesRequest, signoz, parseRow as szRow } from "../src/sources/signoz.js";
import { evaluate, insightsFields } from "./query-contract.js";
import { NOW, TEST_CONFIG, cloudwatchResults, cloudwatchStub, events, signozStub } from "./fixtures.js";

const range = { start: NOW - 3600e3, end: NOW };

it("drops prefixed insurance identifiers before preserving operational IDs", () => {
  const protectedKeys = ["memberId", "subscriberId", "policyId", "medicaidId", "medicareId", "beneficiaryId", "insuranceId"];
  const prefixes = ["patient", "resident", "prescriber", "physician", "doctor", "member", "subscriber", "guardian", "caregiver", "contact", "emergencyContact", "nextOfKin", "recipient", "sender"];
  const fields: Record<string, unknown> = { residentId: "resident-1", caseId: "case-1" };
  for (const prefix of prefixes) for (const key of protectedKeys) {
    fields[prefix + key[0]!.toUpperCase() + key.slice(1)] = "SECRET";
    fields[`${prefix}.${key}`] = "SECRET";
  }
  expect(redactObject(fields, { droppedFields: 0 })).toEqual({ residentId: "resident-1", caseId: "case-1" });
});

it("applies patient-field removal to JSON containers, encoded strings and embedded provider details", () => {
  const original = { mrn: "SECRET-MRN", medication: "apixaban", residentId: "r-1", nested: [{ patientMedicaidId: "SECRET-ID", retry: 2 }] };
  const expected = { residentId: "r-1", nested: [{ retry: 2 }] };
  expect(JSON.parse(maskText(JSON.stringify(original)))).toEqual(expected);
  expect(JSON.parse(JSON.parse(maskText(JSON.stringify(JSON.stringify(original)))))).toEqual(expected);
  expect(maskText(`upstream failed: ${JSON.stringify(original)}`)).toBe(`upstream failed: ${JSON.stringify(expected)}`);
});

it("retains all map entries despite recursive anonymization collisions", () => {
  const input = { byResident: { "Jane Testperson": 3, "Bob Example": 7, "[name]#3": 11, "[name]#2": 13 } };
  const out = redactObject({ input, encoded: JSON.stringify(input) }, { droppedFields: 0 });
  const direct = (out.input as typeof input).byResident;
  const encoded = JSON.parse(out.encoded as string).byResident;
  expect(Object.values(direct).sort((a, b) => a - b)).toEqual([3, 7, 11, 13]);
  expect(encoded).toEqual(direct);
  expect(JSON.stringify(out)).not.toMatch(/Jane|Bob/);
});

describe.each(["cloudwatch", "signoz"] as const)("%s reviewed output paths", (source) => {
  const event = { ...events(1)[0]!, level: "error", traceId: undefined, msg: 'failed {"mrn":"SECRET-MSG","retry":1}', fields: {
    patientMedicaidId: "SECRET-ID", residentId: "r-1", details: '{"medication":"apixaban","retry":2}',
    error: '{"mrn":"SECRET-ERROR","retry":3}', byResident: { "Jane Testperson": 3, "Bob Example": 7 },
  } };
  const deps = () => ({ config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } });
  it.each([["tail"], ["search", "failed"], ["trace", "follow-1"], ["errors"], ["fields"]])("redacts %j before output formatting", async (...command) => {
    const d = deps();
    if (command[0] === "trace") {
      const traced = { ...event, fields: { ...event.fields, caseId: "follow-1" } };
      d.transports[source] = source === "cloudwatch" ? cloudwatchStub([traced]) : signozStub([traced]);
    }
    const result = await run([source, "dev", ...command, "--json", ...(["tail", "search", "trace"].includes(command[0]!) ? ["--full"] : [])], d);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/SECRET|apixaban|Jane|Bob/);
    if (["tail", "search", "trace"].includes(command[0]!)) expect(JSON.parse(result.out).lines).toHaveLength(1);
    if (command[0] === "errors") {
      const output = JSON.parse(result.out);
      expect(output.groups[0].sample).toBe("-");
      expect(output.help.join(" ")).not.toContain("trace r-1");
    }
  });
  it.each(["requestId", "correlationId", "caseId", "runId"])("retains supported %s samples", async (key) => {
    const e = { ...event, fields: { ...event.fields, [key]: "follow-1" } };
    const result = await run([source, "dev", "errors", "--json"], { ...deps(), transports: { [source]: source === "cloudwatch" ? cloudwatchStub([e]) : signozStub([e]) } });
    expect(JSON.parse(result.out).groups[0].sample).toBe("follow-1");
  });
  it("selects critical as fatal and includes it in service error counts", async () => {
    const fatal = { ...event, level: "critical", msg: "fatal connection", fields: {} };
    const ordinary = { ...event, level: "error", msg: "ordinary connection", fields: {} };
    const d = { ...deps(), transports: { [source]: source === "cloudwatch" ? cloudwatchStub([fatal, ordinary]) : signozStub([fatal, ordinary]) } };
    const selected = await run([source, "dev", "tail", "--level", "fatal", "--json"], d);
    expect(JSON.parse(selected.out).lines.map((line: any) => line.level)).toEqual(["fatal"]);
    const counted = await run([source, "dev", "services", "--json"], d);
    expect(JSON.parse(counted.out).services[0]).toMatchObject({ lines: 2, errors: 2 });
  });
  it("rejects --text and emits a runnable positional search recommendation", async () => {
    const bad = await run([source, "dev", "search", "--text", "failed"], deps());
    expect(bad.code).toBe(2);
    const result = await run([source, "dev", "search", "missing", "--json"], deps());
    const recommendation = JSON.parse(result.out).help.find((h: string) => h.includes("search"));
    const args = recommendation.match(/`logs-axi (.*?)`/)[1].match(/"[^"]*"|\S+/g).map((arg: string) => arg.startsWith('"') ? JSON.parse(arg) : arg);
    expect((await run(args, deps())).code).toBe(0);
  });
});

it("CloudWatch trace follows only IDs in the serialized @message contract", async () => {
  const event = { ...events(1)[0]!, traceId: "hidden-trace", fields: { requestId: "wire-request" } };
  const wire = cloudwatchResults([event]).results[0]!.find((f) => f.field === "@message")!.value!;
  expect(wire).toContain("wire-request");
  expect(wire).not.toContain("hidden-trace");
  for (const [id, expected] of [["wire-request", 1], ["hidden-trace", 0], ["absent", 0]] as const) {
    const result = await run(["cloudwatch", "dev", "trace", id, "--json"], { config: TEST_CONFIG, now: NOW, transports: { cloudwatch: cloudwatchStub([event]) } });
    const lines = JSON.parse(result.out).lines;
    expect(Array.isArray(lines) ? lines.length : lines).toBe(expected);
  }
});

it("sanitizes complete provider JSON before truncating errors", async () => {
  const error = { details: JSON.stringify({ mrn: "SECRET", medication: "apixaban" }), padding: "x".repeat(400) };
  const src = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", error }));
  await expect(src.query({ ...range, limit: 1 })).rejects.not.toThrow(/SECRET|apixaban/);
});

it("redacts JSON HTTP failures before slicing the response body", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ mrn: "SECRET", padding: "x".repeat(400), medication: "apixaban" }), { status: 500 }));
  try {
    const src = signoz({ endpoint: "http://x", apiKey: "test" }, "t");
    await expect(src.query({ ...range, limit: 1 })).rejects.not.toThrow(/SECRET|apixaban/);
  } finally {
    fetch.mockRestore();
  }
});

const levels = ["debug", "info", "warn", "error", "fatal"] as const;
const spellings = [
  ["trace", "debug"], ["DEBUG", "debug"], ["Notice", "info"], ["info", "info"], ["warning", "warn"], ["WaRn", "warn"],
  ["ERR", "error"], ["Error", "error"], ["fatal", "fatal"], ["critical", "fatal"], ["crit", "fatal"], ["panic", "fatal"], ["emergency", "fatal"],
] as const;

describe("AWS Insights and SigNoz query contracts with the house severity alias table", () => {
  for (const [spelling, expected] of spellings) for (const field of ["level", "severity", "severity_text"]) {
    it(`${field}=${spelling} selects and counts as ${expected}`, () => {
      const body = JSON.stringify({ [field]: spelling, msg: "ordinary request" });
      const cwFields = { [field]: spelling, msg: "ordinary request", "@message": body };
      const szFields = { body, severity_text: "INFO" };
      expect(cwRow([{ field: "@message", value: body }]).level).toBe(expected);
      expect(szRow({ data: { body, severity_text: "INFO" } }).level).toBe(expected);
      expect(insightsFields(SERVICES_QUERY, cwFields)!.axiLevel).toBe(expected);
      const serviceQueries = (servicesRequest(range) as any).compositeQuery.queries;
      expect(serviceQueries.filter((q: any) => evaluate(q.spec.filter.expression, szFields)).map((q: any) => q.spec.name)).toEqual([expected]);
      for (const minLevel of levels) {
        const selected = levels.indexOf(expected) >= levels.indexOf(minLevel);
        expect(Boolean(insightsFields(buildQuery({ ...range, minLevel, limit: 10 }), cwFields))).toBe(selected);
        const filter = buildFilter({ ...range, minLevel, limit: 10 });
        expect(filter ? Boolean(evaluate(filter, szFields)) : true).toBe(selected);
      }
    });
  }
  it.each([
    [{ level: "warn", severity: "critical", severity_text: "error", msg: "panic" }, "warn"],
    [{ level: "", severity: "critical", severity_text: "error", msg: "request" }, "fatal"],
    [{ level: "custom", severity: "critical", msg: "panic" }, "custom"],
    [{ level: "", msg: "", message: "Error: connection" }, "error"],
  ])("honors field precedence for %j", (fields, expected) => {
    const body = JSON.stringify(fields);
    const wire = { ...fields, "@message": body };
    const szFields = { body, severity_text: "" };
    expect(cwRow([{ field: "@message", value: body }]).level).toBe(expected);
    expect(szRow({ data: szFields }).level).toBe(expected);
    expect(insightsFields(SERVICES_QUERY, wire)!.axiLevel).toBe(expected);
    const queries = (servicesRequest(range) as any).compositeQuery.queries;
    expect(queries.filter((q: any) => evaluate(q.spec.filter.expression, szFields)).map((q: any) => q.spec.name)).toEqual([expected === "custom" ? "unknown" : expected]);
  });
  it.each([
    ["Error: connection refused", "error"], ["panic: Error", "fatal"], ["Traceback: failed", "error"],
    ["Warning: slow", "warn"], ["noteworthy request", "-"], ["errorless", "-"], ["{Error: broken", "error"], ['{"error":"failed"}', "error"],
  ])("infers %s consistently as %s", (body, expected) => {
    const cwFields = { "@message": body };
    const szFields = { body, severity_text: "" };
    expect(cwRow([{ field: "@message", value: body }]).level).toBe(expected);
    expect(szRow({ data: szFields }).level).toBe(expected);
    expect(insightsFields(SERVICES_QUERY, cwFields)!.axiLevel || "-").toBe(expected);
    for (const minLevel of ["warn", "error", "fatal"] as const) {
      const selected = levels.indexOf(expected as any) >= levels.indexOf(minLevel);
      expect(Boolean(insightsFields(buildQuery({ ...range, minLevel, limit: 10 }), cwFields))).toBe(selected);
      expect(Boolean(evaluate(buildFilter({ ...range, minLevel, limit: 10 }), szFields))).toBe(selected);
    }
  });
});
