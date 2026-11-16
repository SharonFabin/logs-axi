/**
 * Output boundary: TOON by default, JSON as the escape hatch. Commands build plain
 * objects and a help[] list; only this file turns them into text.
 */
import { encode } from "@toon-format/toon";

/** Complete, runnable next-step commands, one per line. */
export type Help = string[];

export function toon(value: unknown): string {
  return encode(value, { delimiter: "," });
}

/** help[] is rendered by hand: lines contain commas, and one command per line is the AXI layout. */
export function renderHelp(help: Help): string {
  if (help.length === 0) return "";
  return `help[${help.length}]:\n` + help.map((h) => "  " + h).join("\n");
}

export function render(body: unknown, help: Help = [], json = false): string {
  if (json) return JSON.stringify(help.length ? { ...(body as object), help } : body) + "\n";
  let out = toon(body);
  if (help.length) out += "\n" + renderHelp(help);
  return out + "\n";
}
