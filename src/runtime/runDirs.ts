import { homedir } from "node:os";
import { join } from "node:path";
import { getActiveInstance, validateInstanceName } from "./instance.js";

export function tychonicRunsParentDir(): string {
  const instance = getActiveInstance();
  return instance ? tychonicInstanceRunsParentDir(instance) : tychonicOperationalRunsParentDir();
}

export function tychonicOperationalRunsParentDir(homeDir = homedir()): string {
  return join(tychonicRunsRootDir(homeDir), "operational");
}

export function tychonicInstanceRunsParentDir(instance: string, homeDir = homedir()): string {
  validateInstanceName(instance);
  return join(tychonicRunsRootDir(homeDir), "instances", instance);
}

function tychonicRunsRootDir(homeDir = homedir()): string {
  return join(homeDir, ".tychonic", "runs");
}
