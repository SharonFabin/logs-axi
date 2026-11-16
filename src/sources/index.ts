/** The source registry. A new source is one adapter file and one line here. */
import type { SourceFactory } from "../core/types.js";
import { cloudwatch } from "./cloudwatch.js";
import { signoz } from "./signoz.js";

export const SOURCES: Record<string, SourceFactory> = { cloudwatch, signoz };
