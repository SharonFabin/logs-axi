import { describe, expect, it, vi } from "vitest";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { run } from "../src/cli.js";
import { PROTECTED_KEYS, isPatientField, maskText, redactObject, redactRecord } from "../src/lib/redact.js";
import { cloudwatch } from "../src/sources/cloudwatch.js";
import { signoz } from "../src/sources/signoz.js";
import { NOW, TEST_CONFIG, cloudwatchStub, events, signozStub } from "./fixtures.js";

const labels = [
  ...["ssn:", "SSN", "social security number", "social-security-number:"].flatMap((label) => [
    [label, "123456789", "[ssn]"], [label, "123-45-6789", "[ssn]"],
  ]),
  ["MRN:", "A12345", "[mrn]"], ["MR#", "A12345", "[mrn]"], ["medical record number:", "A12345", "[mrn]"],
  ["Rx #", "123456", "[rx]"], ["Rx number:", "123456", "[rx]"],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "mbi", "beneficiary", "insurance"].map((label) => [`${label} id:`, "MBR12345", "[id]"]),
  ...["room", "rm.", "bed"].map((label) => [`${label} #`, "12B", "[room]"]),
  ["DOB:", "1950-01-05", "[dob]"], ["date of birth:", "01/05/1950", "[dob]"], ["birth date:", "January 5, 1950", "[dob]"],
];

describe("labelled identifier value contract", () => {
  for (const [label, value, replacement] of labels) for (const quote of ["", "'", '"']) {
    it(`masks ${label} ${quote}${value}${quote} as a whole value`, () => {
      expect(maskText(`failed ${label} ${quote}${value}${quote}; retry`)).toBe(`failed ${replacement}; retry`);
    });
    if (quote) it(`masks ${label} ${quote}${value} without a closing value quote`, () => {
      for (const suffix of ["", "; requestId=987654321 caseId=case-1"]) {
        expect(maskText(`failed ${label} ${quote}${value}${suffix}`)).toBe(`failed ${replacement}${suffix}`);
      }
    });
  }
});

const protectedValues: Record<keyof typeof PROTECTED_KEYS, string[]> = {
  name: ["Jane", "jane", "Will", "J", "Jane de Silva", "Jan van Rossum", "O'Brien", "J Smith", "Dr Jane de Silva", "Smith, Jane"],
  ssn: ["123456789"], dob: ["1950-01-05"], mrn: ["A12345"], rx: ["123456"], id: ["MBR12345"], room: ["12B"],
  phone: ["+15551234567"], email: ["private@example.test"], redacted: ["PROTECTEDVALUE"],
};
const protectedCases = Object.entries(PROTECTED_KEYS).flatMap(([kind, keys]) => [...new Set(keys)].flatMap((key) => {
  const words = key.split(" ");
  const variants = new Set([words.join(""), words.join("_"), words.join("-"), words.join("."), words.join(" "), words.join("_").toUpperCase(), words.map((word, i) => i ? word[0]!.toUpperCase() + word.slice(1) : word).join("")]);
  return [...variants].flatMap((label) => protectedValues[kind as keyof typeof PROTECTED_KEYS].map((value) => [label, value, `[${kind}]`]));
})).concat(Object.entries({ id: ["group"], mrn: ["MR", "medical record", "chart"], rx: ["rx"], room: ["room", "bed"] }).flatMap(([kind, stems]) => stems.flatMap((stem) => ["no", "num", "number", "#"].flatMap((suffix) => ["", " ", "_", "-", "."].map((separator) => [`${stem}${separator}${suffix}`, protectedValues[kind as keyof typeof PROTECTED_KEYS][0]!, `[${kind}]`])))));

it.each(protectedCases)("protects %s=%s in every label/value representation", (label, value, replacement) => {
  expect(isPatientField(label)).toBe(true);
  const ids = '"requestId":"987654321","caseId":"case-1"';
  const fragments = [
    ...[":", "=", " "].map((separator) => `lookup failed ${label}${separator}${value}; ${ids}`),
    ...['"', "'"].flatMap((keyQuote) => ['"', "'", ""].flatMap((valueQuote) => [
      `lookup failed ${keyQuote}${label}${keyQuote}:${valueQuote}${value}${valueQuote}; ${ids}`,
      `lookup failed {${ids},${keyQuote}${label}${keyQuote}:${valueQuote}${value}${valueQuote}`,
      `lookup failed {${ids},${keyQuote}${label}${keyQuote}:${valueQuote}${value}`,
    ])),
    `lookup failed ${JSON.stringify({ requestId: "987654321", caseId: "case-1", [label]: value })}`,
  ];
  for (const fragment of fragments) {
    const output = maskText(fragment);
    expect(output).not.toContain(value);
    for (const token of value.match(/[\p{L}\p{N}]+/gu) ?? []) {
      expect(output.match(/[\p{L}\p{N}]+/gu) ?? []).not.toContain(token);
    }
    expect(output).toContain('"requestId":"987654321"');
    expect(output).toContain('"caseId":"case-1"');
    if (!fragment.endsWith("}")) expect(output).toContain(replacement);
  }
  if (replacement === "[name]") {
    for (const suffix of ["; retry", ", retry", "} retry", "] retry", ") retry", "| retry", "\nretry", " requestId=req-2", " requestId: req-2", ' "requestId": "req-2"', " 'caseId'=case-2"]) {
      expect(maskText(`${label}: ${value}${suffix}`)).toBe(`${label}: [name]${suffix}`);
    }
  }
});

it.each([...PROTECTED_KEYS.name, ...PROTECTED_KEYS.redacted])("consumes escaped quotes and backslashes in protected %s values", (key) => {
  const value = 'Jane "JJ" Doe\\private';
  const json = JSON.stringify({ [key]: value, caseId: "case-1" });
  const truncatedValue = JSON.stringify({ caseId: "case-1", [key]: value }).slice(0, -2);
  for (const input of [json, json.slice(0, -1), truncatedValue]) {
    const output = maskText(input);
    for (const token of ["Jane", "JJ", "Doe", "private"]) expect(output.match(/\p{L}+/gu) ?? []).not.toContain(token);
    expect(output).toContain('"caseId":"case-1"');
  }
});

it.each(Object.values(PROTECTED_KEYS).flat())("consumes internal delimiters in closed quoted %s values", (key) => {
  for (const quote of ['"', "'"]) for (const separator of [";", "}", ",", "\n", " requestId=", `\\${quote}`]) {
    const output = maskText(`failed ${key}=${quote}apixaban${separator}metoprolol${quote}; requestId=req-1`);
    expect(output).not.toMatch(/apixaban|metoprolol/);
    expect(output).toContain("requestId=req-1");
  }
});

it("masks both medications separated by a semicolon inside quotes", () => {
  expect(maskText('failed medications="apixaban;metoprolol"')).toBe("failed [redacted]");
  expect(maskText("failed patient: 'O'Brien; requestId=req-1")).toBe("failed patient: '[name]'; requestId=req-1");
});

it.each(["caseId", "residentId", "requestId", "correlationId", "traceId", "runId"])("preserves operational %s labels in every representation", (key) => {
  expect(isPatientField(key)).toBe(false);
  const json = JSON.stringify({ [key]: "req-1" });
  for (const input of [`${key}=req-1`, `${key}: req-1`, `${key} req-1`, json, json.slice(0, -1), json.slice(0, -2)]) {
    expect(maskText(input)).toBe(input);
  }
});

it.each([
  ['lookup failed first name Will; retry', 'lookup failed first name [name]; retry'],
  ['lookup failed first_name J; retry', 'lookup failed first_name [name]; retry'],
  ['request failed {"social_security_number":"123456789"', 'request failed {"social_security_number":"[ssn]"'],
  ['request failed {"patient.social-security-number":"123456789"', 'request failed {"patient.social-security-number":"[ssn]"'],
  ['request failed {"ssn#":"123456789"}', 'request failed {}'],
  ['request failed {"ssn#":"123456789"', 'request failed {"ssn#":"[ssn]"'],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "mbi", "beneficiary", "insurance"].flatMap((label) => ["#", "no", "num", "number"].map((suffix) => [`failed ${label} ${suffix}${suffix === "#" ? "" : " "}INS12345; retry`, "failed [id]; retry"])),
])("masks the reported protected-label fragment %s", (input, expected) => {
  expect(maskText(input)).toBe(expected);
});

it.each([
  ["ssn", "123456789", "[ssn]"], ["social security number", "123456789", "[ssn]"],
  ["dob", "1950-01-05", "[dob]"], ["date of birth", "01/05/1950", "[dob]"],
  ["mrn", "A12345", "[mrn]"], ["medical record number", "A12345", "[mrn]"],
  ["rxNumber", "123456", "[rx]"],
  ...["member", "subscriber", "policy", "medicaid", "medicare", "beneficiary", "insurance"].map((key) => [`${key}Id`, "MBR12345", "[id]"]),
  ["room", "12B", "[room]"], ["bed", "12B", "[room]"],
])("masks quoted %s keys in complete and truncated JSON while keeping operational IDs", (key, value, replacement) => {
  for (const keyQuote of ['"', "'"]) for (const valueQuote of ['"', "'", ""]) for (const close of ["}", ""]) {
    const input = `request failed {${keyQuote}${key}${keyQuote}:${valueQuote}${value}${valueQuote},"requestId":"987654321","caseId":"case-1"${close}`;
    const output = maskText(input);
    expect(output).not.toContain(value);
    expect(output).toContain('"requestId":"987654321"');
    expect(output).toContain('"caseId":"case-1"');
    if (keyQuote === '"' && valueQuote === '"' && close) {
      expect(output).toBe('request failed {"requestId":"987654321","caseId":"case-1"}');
    } else if (!close || keyQuote === "'" || valueQuote === "'") {
      expect(output).toContain(replacement);
    }
  }
  for (const keyQuote of ['"', "'"]) for (const valueQuote of ['"', "'"]) for (const suffix of ["", ',"requestId":"987654321","caseId":"case-1"']) {
    const prefix = 'request failed {"requestId":"987654321","caseId":"case-1",';
    const output = maskText(`${prefix}${keyQuote}${key}${keyQuote}:${valueQuote}${value}${suffix}`);
    expect(output).not.toContain(value);
    expect(output).toContain(replacement);
    expect(output).toContain('"requestId":"987654321"');
    expect(output).toContain('"caseId":"case-1"');
  }
});

it.each([
  ["patient: jane room 12B", "patient: [name]"],
  ["patient: jane room: 12B", "patient: [name] [room]"],
  ['failed {"ssns":["123456789"],"requestId":"req-1"', 'failed {"ssns":["[ssn]"],"requestId":"req-1"'],
])("protects the reported overlap or container %s", (input, expected) => {
  expect(maskText(input)).toBe(expected);
});

it.each(["ssns", "mrns", "memberIds", "names", "medications", "diagnoses", "unknown"])("masks every quoted value inside malformed %s containers", (key) => {
  const input = `failed {"${key}":[["123456789"],{"nested":["A12345","jane","apixaban"]}],"count":123456,"requestId":"1234567890"`;
  const output = maskText(input);
  for (const value of ["123456789", "A12345", "jane", "apixaban", "123456"]) {
    expect(output.replace('"requestId":"1234567890"', "")).not.toContain(value);
  }
  expect(output).toContain(`"${key}":`);
  expect(output).toContain('"nested":');
  expect(output).toContain('"requestId":"1234567890"');
});

it.each(["requestId", "correlationId", "caseId", "runId", "traceId", "trace_id", "residentId", "patientId", "orgId", "facilityId"])("never applies patient heuristics to approved %s scalars", (key) => {
  for (const spelling of [key, `${key}s`, key.replace(/Id$/, "_id"), `${key.replace(/Id$/, "_id")}s`]) {
    for (const value of ["1234567890", "123-45-6789", "Jane Testperson", 1234567890, null, true]) {
      const fields = { [spelling]: value };
      expect(redactObject(fields, { droppedFields: 0 })).toEqual(fields);
      const json = JSON.stringify(fields);
      expect(maskText(json)).toBe(json);
      expect(maskText(json.slice(0, -1))).toBe(json.slice(0, -1));
    }
  }
  expect(redactRecord({ time: "t", level: "error", service: "case-service", msg: "failed", fields: { [key]: "1234567890" } }, { droppedFields: 0 }).fields[key]).toBe("1234567890");
});

it.each(["msg", "message", "service", "level", "time", "details"])("redacts patient text under non-operational %s fields", (key) => {
  const fields = { [key]: "ssn: 123456789", requestId: "1234567890" };
  expect(redactObject(fields, { droppedFields: 0 })).toEqual({ [key]: "[ssn]", requestId: "1234567890" });
  const json = JSON.stringify(fields);
  for (const input of [`failed ${json}`, `failed ${json.slice(0, -1)}`, `failed ${json} retry`]) {
    const output = maskText(input);
    expect(output.replace('"requestId":"1234567890"', "")).not.toContain("123456789");
    expect(output).toContain('"requestId":"1234567890"');
  }
});

it("redacts the reported message fragment and embedded name-keyed map", () => {
  expect(maskText('failed {"message":"ssn: 123456789"')).toBe('failed {"message":"[ssn]"');
  expect(maskText('failed {"byResident":{"Jane Testperson":3}} retry')).toBe('failed {"byResident":{"[name]":3}} retry');
  expect(maskText('failed {"byResident":{"Jane Testperson":3')).toBe('failed {"byResident":{"[name]":3');
});

it.each(["level", "severity", "severity_text", "service", "service.name", "msg", "message", "time", "timestamp", "details", "ssn"])("decodes escaped %s fragment values before masking", (key) => {
  for (const escaped of [String.raw`ssn: \"123456789`, String.raw`context\nssn:\t123456789`, String.raw`ssn: \u0031\u0032\u0033\u0034\u0035\u0036\u0037\u0038\u0039`, String.raw`path \\share; ssn: 123456789`]) {
    for (const quote of ['"', "'"]) for (const closing of [quote, ""]) {
      const input = `failed {"${key}":${quote}${escaped}${closing}`;
      const output = maskText(input);
      expect(output).not.toContain("123456789");
      expect(output).not.toContain(String.raw`\u0031\u0032\u0033`);
      expect(output).toMatch(/\[(?:ssn|redacted)\]/);
    }
  }
  for (const invalid of [String.raw`ssn: 123456789\q`, String.raw`ssn: 123456789\u12`, "ssn: 123456789\\"]) {
    expect(maskText(`failed {"${key}":"${invalid}`)).toBe(`failed {"${key}":"[redacted]"`);
    const operational = `failed {"requestId":"${invalid}`;
    expect(maskText(operational)).toBe(operational);
  }
});

it("masks the SSN in the reported truncated escaped message", () => {
  expect(maskText(String.raw`failed {"message":"ssn: \"123456789`)).toBe('failed {"message":"[ssn]"');
});

it("masks protected-looking map keys in truncated JSON", () => {
  const output = maskText('failed {"byResident":{"Resident Jane Testperson":3');
  expect(output).toContain('"Resident [name]":');
  expect(output).not.toMatch(/Jane|Testperson/);
  expect(maskText('failed {"ssn":"123456789","patientName":"Jane Testperson","requestId":"1234567890"')).toBe('failed {"ssn":"[ssn]","patientName":"[name]","requestId":"1234567890"');
});

it.each(["requestId", "correlationId", "caseId", "runId", "traceId", "trace_id", "residentId", "patientId", "orgId", "facilityId", "caseIds", "resident_ids"])("recursively redacts containers owned by %s", (key) => {
  const nested = { ssn: "123456789", message: "patient: Jane Testperson", byResident: { "Jane Testperson": 3 }, requestId: "1234567890" };
  const clean = { message: "patient: [name]", byResident: { "[name]": 3 }, requestId: "1234567890" };
  for (const [value, expected] of [[nested, clean], [[nested], [clean]], [[[nested]], [[clean]]]]) {
    const fields = { [key]: value };
    expect(redactObject(fields, { droppedFields: 0 })).toEqual({ [key]: expected });
    const json = JSON.stringify(fields);
    expect(maskText(`failed ${json} retry`)).toBe(`failed ${JSON.stringify({ [key]: expected })} retry`);
    const fragment = maskText(`failed ${json.slice(0, -1)}`);
    for (const token of ["123456789", "Jane", "Testperson"]) expect(fragment.replace('"requestId":"1234567890"', "")).not.toContain(token);
    expect(fragment).toContain('"requestId":"1234567890"');
  }
  const fields = { [key]: ["1234567890", "Jane Testperson"] };
  expect(redactObject(fields, { droppedFields: 0 })).toEqual({ [key]: ["[phone]", "[name]"] });
  expect(maskText(JSON.stringify(fields))).toBe(JSON.stringify({ [key]: ["[phone]", "[name]"] }));
  const fragment = maskText(JSON.stringify(fields).slice(0, -1));
  expect(fragment).not.toMatch(/1234567890|Jane|Testperson/);
});

it("redacts each complete embedded container and its surrounding text", () => {
  expect(maskText('failed {"ssn":"123456789","caseId":"case-1"} retry [{"byResident":{"Jane Testperson":3}}] ssn: 987654321')).toBe('failed {"caseId":"case-1"} retry [{"byResident":{"[name]":3}}] [ssn]');
  const json = JSON.stringify({ message: 'failed at {"ssn":"123456789"} for Jane Testperson', caseId: "case-1" });
  expect(maskText(`${json} retry`)).toBe('{"message":"failed at {} for [name]","caseId":"case-1"} retry');
});

it.each(["cloudwatch", "signoz"] as const)("%s error samples retain numeric operational IDs for follow-up traces", async (source) => {
  const event = { ...events(1)[0]!, level: "error", msg: "failed", traceId: undefined, fields: { caseId: "1234567890" } };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } };
  const result = await run([source, "dev", "errors", "--json"], deps);
  expect(result.code).toBe(0);
  const output = JSON.parse(result.out);
  expect(output.groups[0].sample).toBe("1234567890");
  expect(output.help.join(" ")).toContain("trace 1234567890");
  const traced = await run([source, "dev", "trace", output.groups[0].sample, "--json"], deps);
  expect(traced.code).toBe(0);
  expect(JSON.parse(traced.out).lines).toHaveLength(1);
});

it("runs exact, person-name and prefix rules on normalized singular fields, preserving operational IDs and service names", () => {
  const protectedKeys = ["medicationName", "providerName", "userName", "personName", "memberId", "medicaidId", "mrn", "rxNumber", "medicalRecordNumber", "npi", "dob"];
  const fields: Record<string, unknown> = { residentIds: ["r-1"], caseIds: ["c-1"], residentCounts: 2, "service.name": "case-service", "host.name": "node-1" };
  const expected = { ...fields };
  for (const key of protectedKeys) for (const suffix of ["", "s"]) for (const namespace of ["", "ctx.", "ctx/", "ctx:"]) {
    const name = `${namespace}${key}${suffix}`;
    expect(isPatientField(name)).toBe(true);
    fields[name] = ["PROTECTEDVALUE"];
  }
  for (const key of ["provider.names", "user.names", "person.names", "medication.names", "patient.memberIds", "patient:medicaidIds", "patient/mrns", "ctx:patientContext", "ctx.patientContactDetails"]) {
    expect(isPatientField(key)).toBe(true);
    fields[key] = ["PROTECTEDVALUE"];
  }
  expect(redactObject(fields, { droppedFields: 0 })).toEqual(expected);
  expect(redactObject({ native: fields, encoded: JSON.stringify(fields), array: [fields] }, { droppedFields: 0 })).toEqual({ native: expected, encoded: JSON.stringify(expected), array: [expected] });
});

it.each(["cloudwatch", "signoz"] as const)("%s sanitizes plural names and quoted identifiers before every output consumer", async (source) => {
  const event = { ...events(1)[0]!, level: "error", msg: 'failed patient: Jane de Silva; {"mrn":"A12345","ssn":"123456789', fields: {
    caseId: "case-1", medicationNames: ["apixaban"], providerNames: ["PROTECTEDVALUE"], "ctx:userNames": ["PROTECTEDVALUE"],
    details: JSON.stringify({ personNames: ["PROTECTEDVALUE"], message: 'failed {"memberId":"MBR12345","social security number":"123456789","provider":"Jane' }),
    error: 'failed sender=J Smith; {"rxNumber":"123456","ssn":"123456789', note: 'failed {"bed":"12B","ssn":"123456789","recipient":"Jane',
    counts: { 'failed caregiver: Jan van Rossum; {"ssn":"123456789': 1 }, requestId: "987654321",
  } };
  const deps = { config: TEST_CONFIG, now: NOW, transports: { [source]: source === "cloudwatch" ? cloudwatchStub([event]) : signozStub([event]) } };
  for (const command of [["tail", "--full"], ["search", "failed", "--full"], ["trace", "case-1", "--full"], ["errors"], ["fields"]]) {
    const result = await run([source, "dev", ...command, "--json"], deps);
    expect(result.code).toBe(0);
    expect(result.out).not.toMatch(/A12345|MBR12345|123456|12B|PROTECTEDVALUE|apixaban|Jane|\bde\b|Silva|\bJ\b|Smith|Jan|\bvan\b|Rossum/);
    const output = JSON.parse(result.out);
    if (output.lines !== undefined || output.fields !== undefined) expect(result.out).toContain("987654321");
    if (output.lines !== undefined) expect(output.lines).toHaveLength(1);
    if (output.groups !== undefined) expect(output.groups).toHaveLength(1);
    if (output.fields !== undefined) expect(output.fields.some((field: any) => field.field === "caseId")).toBe(true);
  }
});

it("masks quoted identifiers in AWS SDK diagnostics", async () => {
  const send = vi.spyOn(CloudWatchLogsClient.prototype, "send").mockRejectedValue(new Error('failed {"mrn":"A12345","ssn":"123456789","patient":Jane de Silva'));
  try {
    const source = cloudwatch({ region: "us-east-1", logGroups: ["g"] }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[mrn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("A12345");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow(/Jane|\bde\b|Silva/);
  } finally {
    send.mockRestore();
  }
});

it("masks quoted identifiers in SigNoz HTTP and structured error diagnostics", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response('failed {"memberId":"MBR12345","social security number":"123456789","patient":J Smith', { status: 500 }));
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "test");
  try {
    const source = signoz({ endpoint: "http://x" }, "t");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[id]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
    await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow(/\bJ\b|Smith/);
  } finally {
    vi.unstubAllEnvs();
    fetch.mockRestore();
  }
  const source = signoz({ endpoint: "http://x" }, "t", async () => ({ status: "error", error: { message: 'failed {"rxNumber":"123456","ssn":"123456789","patient":Jan van Rossum' } }));
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[rx]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.toThrow("[ssn]");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow("123456789");
  await expect(source.query({ start: NOW - 1000, end: NOW, limit: 1 })).rejects.not.toThrow(/Jan|\bvan\b|Rossum/);
});
