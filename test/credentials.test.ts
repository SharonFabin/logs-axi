import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../src/cli.js";
import { credentialsPath, readSecret, realSys, saveSignozKey, signozKey, type Sys } from "../src/lib/credentials.js";
import { NOW } from "./fixtures.js";

// Expected paths come from the owner's spec: $XDG_CONFIG_HOME/logs-axi/credentials, else
// ~/.config/logs-axi/credentials on Linux/macOS; %APPDATA%\logs-axi\credentials on Windows.
describe("credentials path", () => {
  it.each<[string, Sys, string]>([
    ["linux, XDG set", { platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/u" }, "/xdg/logs-axi/credentials"],
    ["linux, no XDG", { platform: "linux", env: {}, home: "/home/u" }, "/home/u/.config/logs-axi/credentials"],
    ["linux, empty XDG", { platform: "linux", env: { XDG_CONFIG_HOME: "" }, home: "/home/u" }, "/home/u/.config/logs-axi/credentials"],
    ["macOS, no XDG", { platform: "darwin", env: {}, home: "/Users/u" }, "/Users/u/.config/logs-axi/credentials"],
    ["macOS, XDG set", { platform: "darwin", env: { XDG_CONFIG_HOME: "/Users/u/cfg" }, home: "/Users/u" }, "/Users/u/cfg/logs-axi/credentials"],
    ["windows, APPDATA set", { platform: "win32", env: { APPDATA: "C:\\Users\\u\\AppData\\Roaming", XDG_CONFIG_HOME: "/ignored" }, home: "C:\\Users\\u" }, "C:\\Users\\u\\AppData\\Roaming\\logs-axi\\credentials"],
    ["windows, no APPDATA", { platform: "win32", env: {}, home: "C:\\Users\\u" }, "C:\\Users\\u\\AppData\\Roaming\\logs-axi\\credentials"],
  ])("%s", (_name, sys, expected) => expect(credentialsPath(sys)).toBe(expected));
});

const dirs: string[] = [];
/** The real platform, with its config base redirected to a temp dir: no writes to the real home. */
function tempSys(env: NodeJS.ProcessEnv = {}): Sys {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "logs-axi-creds-"));
  dirs.push(dir);
  return { ...realSys(), env: { XDG_CONFIG_HOME: dir, APPDATA: dir, ...env } };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("credentials file", () => {
  it("stores a default key and per-env keys; the env var overrides both", () => {
    const sys = tempSys();
    expect(signozKey("dev", sys)).toBeUndefined();
    saveSignozKey("all-envs-key", undefined, sys);
    saveSignozKey("prod-key", "prod", sys);
    expect(signozKey("dev", sys)).toBe("all-envs-key");
    expect(signozKey("prod", sys)).toBe("prod-key");
    const overridden = { ...sys, env: { ...sys.env, LOGS_AXI_SIGNOZ_KEY: "from-env" } };
    expect(signozKey("dev", overridden)).toBe("from-env");
    expect(signozKey("prod", overridden)).toBe("from-env");
  });

  it.skipIf(process.platform === "win32")("writes the file 0600 in a 0700 directory, tightening existing modes", () => {
    const sys = tempSys();
    const file = credentialsPath(sys);
    fs.mkdirSync(path.dirname(file), { mode: 0o755 });
    fs.chmodSync(path.dirname(file), 0o755);
    fs.writeFileSync(file, "{}", { mode: 0o644 });
    fs.chmodSync(file, 0o644);
    saveSignozKey("k", undefined, sys);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
  });

  it.runIf(process.platform === "win32")("writes under %APPDATA% on Windows", () => {
    const sys = tempSys();
    const file = saveSignozKey("k", undefined, sys);
    expect(file).toBe(path.win32.join(sys.env.APPDATA!, "logs-axi", "credentials"));
    expect(signozKey("dev", sys)).toBe("k");
  });

  it("reports a corrupt file without quoting it", () => {
    const sys = tempSys();
    fs.mkdirSync(path.dirname(credentialsPath(sys)), { recursive: true });
    fs.writeFileSync(credentialsPath(sys), '{"signoz":{"default":KEYSECRET');
    expect(() => signozKey("dev", sys)).toThrow(/is not valid JSON$/);
    expect(() => signozKey("dev", sys)).not.toThrow(/KEYSECRET/);
  });

  it("rejects an empty scope without replacing the default key", () => {
    const sys = tempSys();
    saveSignozKey("default-key", undefined, sys);
    expect(() => saveSignozKey("replacement-key", "", sys)).toThrow("--env must not be empty");
    expect(signozKey("dev", sys)).toBe("default-key");
  });

  it.each(["write", "rename"])("preserves existing credentials when %s fails", (stage) => {
    const sys = tempSys();
    const file = saveSignozKey("default-key", undefined, sys);
    saveSignozKey("prod-key", "prod", sys);
    const before = fs.readFileSync(file);
    const failure = new Error("simulated filesystem failure");
    const operation = stage === "write"
      ? vi.spyOn(fs, "writeFileSync").mockImplementationOnce((fd) => {
          fs.writeSync(fd as number, '{"signoz":');
          throw failure;
        })
      : vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw failure; });
    try {
      expect(() => saveSignozKey("replacement-key", "prod", sys)).toThrow(failure);
    } finally {
      operation.mockRestore();
    }
    expect(fs.readFileSync(file)).toEqual(before);
    expect(signozKey("dev", sys)).toBe("default-key");
    expect(signozKey("prod", sys)).toBe("prod-key");
    expect(fs.readdirSync(path.dirname(file))).toEqual(["credentials"]);
  });
});

describe("logs-axi signoz login", () => {
  const SECRET = "szk_9f3cLoginSecret0d1e";

  it("stores the prompted key and never prints it", async () => {
    const sys = tempSys();
    const prompts: string[] = [];
    const res = await run(["signoz", "login"], { sys, readSecret: async (p) => (prompts.push(p), SECRET) });
    expect(res.code).toBe(0);
    expect(res.out).not.toContain(SECRET);
    expect(res.out).toMatch(/credentials: .*logs-axi.+credentials/);
    expect(prompts).toEqual(["SigNoz viewer API key: "]);
    expect(signozKey("dev", sys)).toBe(SECRET);
  });

  it("stores a key for one env with --env", async () => {
    const sys = tempSys();
    const res = await run(["signoz", "login", "--env", "prod"], { sys, readSecret: async () => SECRET });
    expect(res.code).toBe(0);
    expect(res.out).toContain("for: prod");
    expect(signozKey("prod", sys)).toBe(SECRET);
    expect(signozKey("dev", sys)).toBeUndefined();
  });

  it.each([["--env", ""], ["--env="]])("rejects empty scope %j before prompting", async (...flags) => {
    const sys = tempSys();
    const file = saveSignozKey("default-key", undefined, sys);
    const before = fs.readFileSync(file);
    const readSecret = vi.fn(async () => SECRET);
    const res = await run(["signoz", "login", ...flags], { sys, readSecret });
    expect(res.code).toBe(2);
    expect(res.out).toContain("--env must not be empty");
    expect(readSecret).not.toHaveBeenCalled();
    expect(fs.readFileSync(file)).toEqual(before);
  });

  it.each([undefined, "prod.eu"])("repairs malformed credentials during login for %s", async (env) => {
    const sys = tempSys();
    const file = credentialsPath(sys);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"signoz":{"default":KEYSECRET');
    const res = await run(["signoz", "login", ...(env === undefined ? [] : ["--env", env])], { sys, readSecret: async () => SECRET });
    expect(res.code).toBe(0);
    expect(res.out).not.toContain("KEYSECRET");
    expect(res.out).not.toContain(SECRET);
    expect(signozKey(env ?? "dev", sys)).toBe(SECRET);
    if (env !== undefined) expect(signozKey("dev", sys)).toBeUndefined();
    expect(fs.readdirSync(path.dirname(file))).toEqual(["credentials"]);
  });

  it.each(["tail", "search", "errors", "trace", "services", "fields"])("uses the exact dotted environment's login key for %s", async (command) => {
    const sys = tempSys();
    for (const [k, v] of Object.entries(sys.env)) vi.stubEnv(k, v!);
    vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "");
    saveSignozKey("default-key", undefined, sys);
    saveSignozKey("eu-key", "eu", sys);
    const login = await run(["signoz", "login", "--env", "prod.eu"], { sys, readSecret: async () => SECRET });
    expect(login.code).toBe(0);
    const sent: (string | null)[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(new Headers(init?.headers).get("SIGNOZ-API-KEY"));
      return new Response(JSON.stringify({ status: "success", data: { data: { results: [] } } }));
    });
    try {
      const args = command === "search" ? ["timeout"] : command === "trace" ? ["req-123"] : [];
      const res = await run(["signoz", "prod.eu", command, ...args], {
        config: { sources: { signoz: { "prod.eu": { endpoint: "http://localhost:1" } } } }, now: NOW,
      });
      expect(res.code).toBe(0);
      expect(sent).toEqual([SECRET]);
      expect(login.out + res.out).not.toContain(SECRET);
    } finally {
      fetch.mockRestore();
    }
  });

  it("notes when the env var will override the stored key", async () => {
    const sys = tempSys({ LOGS_AXI_SIGNOZ_KEY: "x" });
    const res = await run(["signoz", "login"], { sys, readSecret: async () => SECRET });
    expect(res.out).toContain("LOGS_AXI_SIGNOZ_KEY is set and overrides this file");
  });

  it.each([
    ["a positional key", ["signoz", "login", SECRET]],
    ["a --key flag", ["signoz", "login", `--key=${SECRET}`]],
    ["a --key flag with a separate value", ["signoz", "login", "--key", SECRET]],
  ])("refuses %s without echoing it or prompting", async (_name, argv) => {
    const sys = tempSys();
    const readSecret = vi.fn(async () => "unused");
    const res = await run(argv, { sys, readSecret });
    expect(res.code).toBe(2);
    expect(res.out).not.toContain(SECRET);
    expect(readSecret).not.toHaveBeenCalled();
    expect(fs.existsSync(credentialsPath(sys))).toBe(false);
  });

  it.each([
    ["empty input", "", "no key entered"],
    ["a key with a line break", "KEYPART\nOTHERPART", "invalid API key"],
  ])("rejects %s without storing or echoing it", async (_name, key, message) => {
    const sys = tempSys();
    const res = await run(["signoz", "login"], { sys, readSecret: async () => key });
    expect(res.code).toBe(2);
    expect(res.out).toContain(message);
    expect(res.out).not.toMatch(/KEYPART|OTHERPART/);
    expect(fs.existsSync(credentialsPath(sys))).toBe(false);
  });

  it("points CloudWatch users at aws sso login", async () => {
    const res = await run(["cloudwatch", "login"], { readSecret: async () => SECRET });
    expect(res.code).toBe(2);
    expect(res.out).toContain("aws sso login");
  });

  it("a SigNoz command without any key prints the one-line login hint", async () => {
    const sys = tempSys();
    for (const [k, v] of Object.entries(sys.env)) vi.stubEnv(k, v!);
    vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "");
    const fetch = vi.spyOn(globalThis, "fetch");
    try {
      const res = await run(["signoz", "dev", "tail"], { config: { sources: { signoz: { dev: { endpoint: "http://localhost:1" } } } }, now: NOW });
      expect(res.code).toBe(1);
      expect(res.out).toContain("no SigNoz API key for sources.signoz.dev");
      expect(res.out).toMatch(/help\[1\]:\n {2}Run `logs-axi signoz login`\n$/);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("SigNoz commands send the stored key, and the env var wins over it", async () => {
    const sys = tempSys();
    for (const [k, v] of Object.entries(sys.env)) vi.stubEnv(k, v!);
    vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "");
    saveSignozKey("stored-key", undefined, sys);
    const sent: (string | null)[] = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      sent.push(new Headers(init?.headers).get("SIGNOZ-API-KEY"));
      return new Response(JSON.stringify({ status: "success", data: { data: { results: [] } } }));
    });
    const config = { sources: { signoz: { dev: { endpoint: "http://localhost:1" } } } };
    try {
      const a = await run(["signoz", "dev", "tail"], { config, now: NOW });
      vi.stubEnv("LOGS_AXI_SIGNOZ_KEY", "env-key");
      const b = await run(["signoz", "dev", "tail"], { config, now: NOW });
      expect([a.code, b.code]).toEqual([0, 0]);
      expect(sent).toEqual(["stored-key", "env-key"]);
      expect(a.out + b.out).not.toMatch(/stored-key|env-key/);
    } finally {
      fetch.mockRestore();
    }
  });
});

/** A stand-in terminal: what a TTY stdin looks like to Node on every OS. */
function fakeTty() {
  const input = Object.assign(new PassThrough(), { isTTY: true, rawModes: [] as boolean[] }) as any;
  input.setRawMode = (on: boolean) => (input.rawModes.push(on), input);
  let written = "";
  const output = new PassThrough();
  output.on("data", (c) => (written += c.toString()));
  return { input, output, written: () => written };
}

describe("hidden prompt", () => {
  it("reads typed characters in raw mode and echoes none of them", async () => {
    const t = fakeTty();
    const p = readSecret("Key: ", t.input, t.output);
    t.input.write("ab");
    t.input.write("cX\u007f"); // backspace removes X
    t.input.write("d\r");
    expect(await p).toBe("abcd");
    await new Promise((r) => setImmediate(r));
    expect(t.written()).toBe("Key: \n");
    expect(t.input.rawModes).toEqual([true, false]);
  });

  it("accepts a pasted key in one chunk, including Windows backspace (\\b)", async () => {
    const t = fakeTty();
    const p = readSecret("Key: ", t.input, t.output);
    t.input.write("pasted-KEY-1x\b\r\n");
    expect(await p).toBe("pasted-KEY-1");
    expect(t.input.rawModes).toEqual([true, false]);
  });

  it("Ctrl-C cancels and restores the terminal", async () => {
    const t = fakeTty();
    const p = readSecret("Key: ", t.input, t.output);
    t.input.write("partial\u0003");
    await expect(p).rejects.toThrow("login cancelled");
    expect(t.input.rawModes).toEqual([true, false]);
    expect(t.written()).not.toContain("partial");
  });

  it("reads piped stdin whole without prompting", async () => {
    const t = fakeTty();
    t.input.isTTY = false;
    const p = readSecret("Key: ", t.input, t.output);
    t.input.end("  piped-key\n");
    expect(await p).toBe("piped-key");
    expect(t.written()).toBe("");
    expect(t.input.rawModes).toEqual([]);
  });
});
