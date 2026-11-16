/**
 * One config file names every source and environment:
 *   { "sources": { "<source>": { "<env>": { ...that source's settings } } } }
 * Location: $LOGS_AXI_CONFIG, else $XDG_CONFIG_HOME/logs-axi/config.json, else
 * ~/.config/logs-axi/config.json. Secrets may live in env vars the file names
 * (SigNoz `apiKeyEnv`), so the file itself can stay secret-free.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AxiError } from "./errors.js";

export interface Config {
  sources: Record<string, Record<string, Record<string, unknown>>>;
}

export function configPath(): string {
  if (process.env.LOGS_AXI_CONFIG) return process.env.LOGS_AXI_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "logs-axi", "config.json");
}

/** The example shipped next to dist/, for the "no config yet" hint. */
export function examplePath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "config.example.json");
}

export function loadConfig(): Config {
  const file = configPath();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new AxiError(`no config at ${file}`, {
      help: [
        `Run \`mkdir -p ${path.dirname(file)} && cp ${examplePath()} ${file}\` and edit it`,
        "Or point LOGS_AXI_CONFIG at a config file",
      ],
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new AxiError(`config ${file} is not valid JSON: ${(e as Error).message}`);
  }
  const sources = (parsed as Config | null)?.sources;
  if (!sources || typeof sources !== "object") {
    throw new AxiError(`config ${file} has no "sources" object`, { help: [`see ${examplePath()}`] });
  }
  return { sources };
}
