import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import { run } from "../src/cli.js";

// The owner's contract forbids printing keys, including credentials echoed by an
// upstream error. Exercise the actual CLI and HTTP transport, not a fetch stub.
it("keeps the active key out of HTTP and structured SigNoz error output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-axi-http-"));
  const key = "synthetic-credential-that-must-stay-private";
  let structured = false;
  const server = http.createServer((req, res) => {
    req.resume();
    expect(req.headers["signoz-api-key"]).toBe(key);
    res.setHeader("content-type", "application/json");
    res.statusCode = structured ? 200 : 403;
    const diagnostic = `rejected ${key}; invalid ssn: 123456789`;
    res.end(structured ? JSON.stringify({ status: "error", error: { message: diagnostic } }) : diagnostic);
  });
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const config = path.join(dir, "config.json");
    fs.writeFileSync(config, JSON.stringify({ sources: { signoz: { dev: { endpoint: `http://127.0.0.1:${port}` } } } }));
    for (structured of [false, true]) {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/index.ts", import.meta.url)), "signoz", "dev", "tail"], {
        env: { ...process.env, LOGS_AXI_SIGNOZ_KEY: key, LOGS_AXI_CONFIG: config, XDG_CONFIG_HOME: dir, APPDATA: dir },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "";
      child.stdout.on("data", (chunk) => { output += chunk; });
      child.stderr.on("data", (chunk) => { output += chunk; });
      const timer = setTimeout(() => child.kill(), 10_000);
      let code: number | null;
      try {
        code = await new Promise<number | null>((resolve, reject) => {
          child.on("error", reject);
          child.on("close", resolve);
        });
      } finally {
        clearTimeout(timer);
      }
      expect(code).toBe(1);
      expect(output).not.toContain(key);
      expect(output).not.toContain("123456789");
      expect(output).toContain("query failed");
      if (!structured) expect(output).toContain("logs-axi signoz login");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);

it.each(["sekret123", 'ab"cd', String.raw`hidden"sekret\987`])("omits encoded provider diagnostics from every SigNoz error format", async (key) => {
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", key);
  const escaped = [...key].map((char) => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
  try {
    for (const status of [401, 403, 500, 200]) for (const format of [[], ["--json"]]) for (const nested of [false, true]) {
      const details = { message: `provider-only-marker rejected ${key}; ssn: 123456789`, requestId: key, nested: [{ [key]: key }], details: JSON.stringify({ requestId: key }) };
      const diagnostic = nested ? { details: JSON.stringify(details) } : details;
      const body = JSON.stringify(status === 200 ? { status: "error", error: diagnostic } : diagnostic).replaceAll(JSON.stringify(key).slice(1, -1), escaped);
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
      try {
        const result = await run(["signoz", "dev", "tail", ...format], { config: { sources: { signoz: { dev: { endpoint: "http://signoz.test" } } } } });
        expect(result.code).toBe(1);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch.mock.calls[0]?.[1]?.headers).toMatchObject({ "SIGNOZ-API-KEY": key });
        for (const secret of [key, JSON.stringify(key).slice(1, -1), escaped, "hidden", "sekret123", "987"]) expect(result.out).not.toContain(secret);
        expect(result.out).not.toContain("123456789");
        expect(result.out).not.toContain("provider-only-marker");
        expect(result.out).not.toContain("requestId");
        if (status === 401 || status === 403) {
          expect(result.out).toContain("logs-axi signoz login");
        }
      } finally { fetch.mockRestore(); }
    }
  } finally { vi.unstubAllEnvs(); }
});

it.each(["code", "type"])("retains only a short, credential-free SigNoz error %s", async (field) => {
  const key = "sekret123";
  vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", key);
  try {
    for (const status of [400, 200]) for (const code of ["invalid_query", `invalid_${key}`, "unsafe code", "x".repeat(65)]) {
      const error = { [field]: code, message: "provider-only-marker" };
      const body = JSON.stringify(status === 200 ? { status: "error", error } : error);
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(body, { status }));
      try {
        const result = await run(["signoz", "dev", "tail", "--json"], { config: { sources: { signoz: { dev: { endpoint: "http://signoz.test" } } } } });
        expect(result.code).toBe(1);
        expect(result.out).toContain(status === 400 ? "HTTP 400" : "signoz: error");
        expect(result.out).not.toContain("provider-only-marker");
        if (code === "invalid_query") expect(result.out).toContain(code);
        else expect(result.out).not.toContain(code);
        expect(result.out).not.toContain(key);
      } finally { fetch.mockRestore(); }
    }
  } finally { vi.unstubAllEnvs(); }
});
