import { describe, expect, it } from "vitest";
import { decode } from "@toon-format/toon";
import { run } from "../src/cli.js";
import { NOW, TEST_CONFIG, cloudwatchStub, events, signozStub } from "./fixtures.js";

const evs = events(200);
const deps = (source: "cloudwatch" | "signoz") => ({
  config: TEST_CONFIG,
  transports: { [source]: source === "cloudwatch" ? cloudwatchStub(evs) : signozStub(evs) },
  now: NOW,
});
const body = (out: string) => decode(out.split("\nhelp[")[0]!) as Record<string, any>;

describe.each(["cloudwatch", "signoz"] as const)("%s", (source) => {
  it("errors groups by template with counts, first/last seen and a trace id to follow", async () => {
    const { out, code } = await run([source, "dev", "errors", "--limit", "100"], deps(source));
    expect(code).toBe(0);
    const b = body(out);
    const errorLines = evs.filter((e) => e.level === "error");
    expect(b.scanned).toBe(errorLines.length);
    const total = b.groups.reduce((n: number, g: any) => n + g.count, 0);
    expect(total).toBe(errorLines.length);
    // `payer lookup failed` with a varying latency collapses into one group per service
    const payer = b.groups.filter((g: any) => g.template === "payer lookup failed: upstream <n> after <n>ms");
    expect(payer.length).toBeGreaterThan(0);
    expect(payer.reduce((n: number, g: any) => n + g.count, 0)).toBe(errorLines.filter((e) => e.msg === "payer lookup failed").length);
    // SigNoz lines carry the trace id; CloudWatch lines carry the request/case ids
    const id = source === "signoz" ? "[0-9a-f]{32}" : "[0-9a-f-]{36}";
    expect(b.groups[0].sample).toMatch(new RegExp(`^${id}$`));
    expect(out).toMatch(new RegExp(`Run \`logs-axi ${source} dev trace ${id}\``));
  });

  it("tail prints the newest lines oldest first, with a shared date", async () => {
    const { out } = await run([source, "dev", "tail", "--limit", "5"], deps(source));
    const b = body(out);
    expect(b.date).toBe("2026-11-16");
    expect(b.lines).toHaveLength(5);
    const times = b.lines.map((l: any) => l.time);
    expect([...times].sort()).toEqual(times);
    expect(b.more).toBe(true);
  });

  it("trace returns only that trace's lines", async () => {
    const id = evs[10]!.traceId!;
    const { out } = await run([source, "dev", "trace", id], deps(source));
    expect(body(out).lines).toHaveLength(1);
  });

  it("search passes text and level through", async () => {
    const { out } = await run([source, "dev", "search", "slow", "--level", "warn"], deps(source));
    const b = body(out);
    expect(b.lines.length).toBeGreaterThan(0);
    expect(b.lines.every((l: any) => l.msg === "slow query")).toBe(true);
  });

  it("services counts lines, errors and warnings per service", async () => {
    const { out } = await run([source, "dev", "services"], deps(source));
    const b = body(out);
    const ehr = b.services.find((s: any) => s.service === "ehr-service");
    expect(ehr.lines).toBe(evs.filter((e) => e.service === "ehr-service").length);
    expect(ehr.errors).toBe(evs.filter((e) => e.service === "ehr-service" && e.level === "error").length);
  });

  it("fields lists keys with counts, without patient fields", async () => {
    const { out } = await run([source, "dev", "fields"], deps(source));
    const names = body(out).fields.map((f: any) => f.field);
    expect(names).toContain("caseId");
    expect(names).toContain("requestId");
    expect(names).not.toContain("residentName");
    expect(names).not.toContain("dob");
  });

  it("--json is valid JSON carrying the same body and help", async () => {
    const { out } = await run([source, "dev", "errors", "--json"], deps(source));
    const j = JSON.parse(out);
    expect(j.groups.length).toBeGreaterThan(0);
    expect(Array.isArray(j.help)).toBe(true);
  });

  it("long messages are cut with a hint, --full keeps them", async () => {
    const long = [{ ...evs[0]!, msg: "x".repeat(500), fields: {} }];
    const d = { config: TEST_CONFIG, transports: { [source]: source === "cloudwatch" ? cloudwatchStub(long) : signozStub(long) }, now: NOW };
    const cut = await run([source, "dev", "tail"], d);
    expect(cut.out).toContain("…[+300]");
    expect(cut.out).toContain("--full");
    const full = await run([source, "dev", "tail", "--full"], d);
    expect(full.out).toContain("x".repeat(500));
  });

  it("an empty result says so and suggests a wider range", async () => {
    const d = { config: TEST_CONFIG, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([]) : signozStub([]) }, now: NOW };
    const { out, code } = await run([source, "dev", "errors"], d);
    expect(code).toBe(0);
    expect(out).toContain("errors: 0");
    expect(out).toContain("--since 24h");
  });
});

describe("routing and usage", () => {
  it("<source> <env> alone runs errors, and accepts flags", async () => {
    const a = await run(["signoz", "dev"], deps("signoz"));
    const b = await run(["signoz", "dev", "--since", "15m"], deps("signoz"));
    expect(body(a.out).groups).toBeDefined();
    expect(b.out).toBe(a.out);
  });

  it("passes --since to the source as a time range", async () => {
    const stub = signozStub(evs);
    await run(["signoz", "dev", "tail", "--since", "2h"], { config: TEST_CONFIG, transports: { signoz: stub }, now: NOW });
    expect(stub.rec.requests[0]).toMatchObject({ start: NOW - 2 * 3600e3, end: NOW });
  });

  it.each([
    [["nope", "dev"], "unknown source `nope`"],
    [["signoz", "staging"], "no environment `staging` for signoz"],
    [["signoz", "dev", "bogus"], "unknown command `bogus`"],
    [["signoz", "dev", "tail", "--bogus"], "unknown flag --bogus"],
    [["signoz", "dev", "tail", "--since", "5y"], "invalid duration `5y`"],
    [["signoz", "dev", "tail", "--level", "loud"], "invalid --level `loud`"],
    [["signoz", "dev", "tail", "--limit", "0"], "invalid --limit `0`"],
    [["signoz", "dev", "trace"], "trace needs an id"],
    [["signoz", "dev", "search"], "search needs text"],
  ])("%j -> usage error", async (argv, msg) => {
    const { out, code } = await run(argv, deps("signoz"));
    expect(code).toBe(2);
    expect(out).toContain(msg);
  });

  it("home view lists configured sources and next steps", async () => {
    const { out } = await run([], { config: TEST_CONFIG });
    expect(out).toContain("configured[2]{source,envs}:");
    expect(out).toContain("Run `logs-axi cloudwatch dev errors`");
  });

  it("help lists every command", async () => {
    const { out } = await run(["--help"], {});
    for (const c of ["tail", "search", "errors", "trace", "services", "fields", "--unredacted"]) expect(out).toContain(c);
  });
});
