/**
 * Output-token bench: for the same queries, how many tokens does an agent read from
 * the raw API response (what curl, an SDK call or the SigNoz MCP hands back) versus
 * from logs-axi? Offline and deterministic: both sides come from the synthetic
 * fixtures through the stub transports, so the raw side is exactly the payload the
 * source returned for the request logs-axi made.
 *
 * Tokens are counted with gpt-tokenizer (o200k_base) as a stand-in for Claude's
 * tokenizer; the ratio is what matters. Run: npm run bench
 */
import { encode } from "gpt-tokenizer";
import { run } from "../src/cli.js";
import { NOW, TEST_CONFIG, cloudwatchStub, events, signozStub, type Recorder } from "../test/fixtures.js";

const evs = events(2000, 11);
const traceId = evs.find((e) => e.level === "error")!.traceId!;
const caseId = String(evs.find((e) => e.level === "error")!.fields.caseId);

const SCENARIOS: [string, string[], string[]][] = [
  ["tail (50 lines)", ["tail"], ["tail"]],
  ["search text+level", ["search", "payer", "--level", "error"], ["search", "payer", "--level", "error"]],
  ["errors (grouped)", ["errors"], ["errors"]],
  ["trace one id", ["trace", caseId], ["trace", traceId]],
  ["services", ["services"], ["services"]],
  ["fields", ["fields"], ["fields"]],
];

const tokens = (s: string) => encode(s).length;

async function measure(source: "cloudwatch" | "signoz", argv: string[]) {
  const rec: Recorder = { requests: [], responses: [] };
  const transport = source === "cloudwatch" ? cloudwatchStub(evs, rec) : signozStub(evs, rec);
  const { out, code } = await run([source, "dev", ...argv], { config: TEST_CONFIG, transports: { [source]: transport }, now: NOW });
  if (code !== 0) throw new Error(`${source} ${argv.join(" ")} failed:\n${out}`);
  const raw = rec.responses.map((r) => JSON.stringify(r)).join("\n");
  return { raw: tokens(raw), axi: tokens(out) };
}

const rows: string[] = [];
let rawTotal = 0;
let axiTotal = 0;
for (const [name, cw, sz] of SCENARIOS) {
  for (const [source, argv] of [["cloudwatch", cw], ["signoz", sz]] as const) {
    const m = await measure(source, argv);
    rawTotal += m.raw;
    axiTotal += m.axi;
    rows.push(`| ${name} | ${source} | ${m.raw.toLocaleString("en-US")} | ${m.axi.toLocaleString("en-US")} | ${(m.raw / m.axi).toFixed(1)}x |`);
  }
}

console.log(`synthetic corpus: ${evs.length} lines over 15 minutes, 4 services; tokenizer: o200k_base\n`);
console.log("| query | source | raw API tokens | logs-axi tokens | smaller by |");
console.log("|---|---|---:|---:|---:|");
console.log(rows.join("\n"));
console.log(`| **total** | | **${rawTotal.toLocaleString("en-US")}** | **${axiTotal.toLocaleString("en-US")}** | **${(rawTotal / axiTotal).toFixed(1)}x** |`);
