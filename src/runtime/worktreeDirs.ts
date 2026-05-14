import { homedir } from "node:os";
import { join } from "node:path";
import { getActiveInstance, validateInstanceName } from "./instance.js";

export function tychonicWorktreeParentDir(): string {
  const instance = getActiveInstance();
  return instance ? tychonicInstanceWorktreeParentDir(instance) : tychonicOperationalWorktreeParentDir();
}

export function tychonicOperationalWorktreeParentDir(homeDir = homedir()): string {
  return join(tychonicWorktreeRootDir(homeDir), "operational");
}

export function tychonicInstanceWorktreeParentDir(instance: string, homeDir = homedir()): string {
  validateInstanceName(instance);
  return join(tychonicWorktreeRootDir(homeDir), "instances", instance);
}

function tychonicWorktreeRootDir(homeDir = homedir()): string {
  return join(homeDir, ".tychonic", "worktrees");
}
