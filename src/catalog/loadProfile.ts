import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { TychonicConfigSchema, type TychonicConfig } from "./types.js";

export function parseBundleConfigYaml(raw: string): TychonicConfig {
  return TychonicConfigSchema.parse(parse(raw));
}

export async function loadProfile(path: string): Promise<TychonicConfig> {
  const raw = await readFile(path, "utf8");
  return parseBundleConfigYaml(raw);
}
