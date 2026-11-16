import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

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
      expect(output).toContain("[api-key]");
      expect(output).toContain("[ssn]");
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30_000);
