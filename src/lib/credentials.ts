/**
 * The per-user credentials file `logs-axi signoz login` writes:
 *   Linux/macOS: $XDG_CONFIG_HOME/logs-axi/credentials, else ~/.config/logs-axi/credentials
 *                (file 0600, directory 0700)
 *   Windows:     %APPDATA%\logs-axi\credentials (profile ACLs; no chmod)
 * Contents: { "signoz": { "default": "<key>", "envs": { "<env>": "<key>" } } }
 *
 * Lookup for a SigNoz env: $LOGS_AXI_SIGNOZ_KEY, then the file's key for that env,
 * then its default. Keys are never printed, logged or taken from argv.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { AxiError } from "./errors.js";

export const KEY_ENV = "LOGS_AXI_SIGNOZ_KEY";

/** The process facts path resolution depends on; injected by tests. */
export interface Sys {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
}

export const realSys = (): Sys => ({ platform: process.platform, env: process.env, home: os.homedir() });

const paths = (sys: Sys) => (sys.platform === "win32" ? path.win32 : path.posix);

export function credentialsPath(sys: Sys = realSys()): string {
  const p = paths(sys);
  const base =
    sys.platform === "win32"
      ? sys.env.APPDATA || p.join(sys.home, "AppData", "Roaming")
      : sys.env.XDG_CONFIG_HOME || p.join(sys.home, ".config");
  return p.join(base, "logs-axi", "credentials");
}

/** One printable ASCII token: what an HTTP header can carry, so fetch never echoes it. */
export const validKey = (key: unknown): key is string => typeof key === "string" && /^[\x21-\x7e]+$/.test(key);

interface CredentialsFile {
  signoz?: { default?: string; envs?: Record<string, string> };
}

function readFile(sys: Sys, recover = false): CredentialsFile {
  const file = credentialsPath(sys);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    if (recover) return {};
    // never quote the parser's message: it can carry part of the key
    throw new AxiError(`credentials file ${file} is not valid JSON`, { help: ["Run `logs-axi signoz login` to rewrite it"] });
  }
}

export function signozKey(env: string, sys: Sys = realSys()): string | undefined {
  if (sys.env[KEY_ENV]) return sys.env[KEY_ENV];
  const signoz = readFile(sys).signoz;
  return signoz?.envs?.[env] || signoz?.default || undefined;
}

/** Store a key for one env, or for every env when `env` is undefined. Returns the file. */
export function saveSignozKey(key: string, env: string | undefined, sys: Sys = realSys()): string {
  if (env === "") throw new AxiError("--env must not be empty");
  const file = credentialsPath(sys);
  const dir = paths(sys).dirname(file);
  const posix = sys.platform !== "win32";
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (posix) fs.chmodSync(dir, 0o700);

  const data = readFile(sys, true);
  const signoz = (data.signoz ??= {});
  if (env !== undefined) signoz.envs = { ...signoz.envs, [env]: key };
  else signoz.default = key;

  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx", 0o600);
  try {
    try {
      if (posix) fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, JSON.stringify(data, null, 2) + "\n");
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
  return file;
}

/**
 * Read a secret without echo. On a terminal (Linux, macOS and Windows consoles alike)
 * this uses raw mode and prints nothing for typed or pasted characters; piped stdin
 * (`aws ssm get-parameter ... | logs-axi signoz login`) is read whole.
 */
export async function readSecret(
  prompt: string,
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WritableStream = process.stderr,
): Promise<string> {
  if (!input.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of input) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8").trim();
  }
  output.write(prompt);
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = (err?: Error) => {
      input.off("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(value.trim());
    };
    const onData = (chunk: Buffer | string) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();
        if (ch === "\u0003") return finish(new AxiError("login cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}
