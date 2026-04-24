/**
 * P2 regression guard: `runtimeWorkflowModulesDir()` goes through
 * `tychonicRuntimeDirs().stateDir`, so the instance-aware suffix must
 * propagate without changes to this module.
 */

import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runtimeWorkflowModulesDir } from "../../src/temporal/workflowModules.js";
import { tychonicRuntimeDirs } from "../../src/temporal/manager.js";
import {
  getActiveInstance,
  setActiveInstance
} from "../../src/runtime/instance.js";

afterEach(() => {
  setActiveInstance(undefined);
  expect(getActiveInstance()).toBeUndefined();
});

describe("runtimeWorkflowModulesDir with active instance", () => {
  it("returns <default>/workflows/modules when no instance is active", () => {
    const dir = runtimeWorkflowModulesDir();
    const baseline = tychonicRuntimeDirs().stateDir;
    expect(dir).toBe(join(baseline, "workflows", "modules"));
  });

  it("returns <default>/instances/<name>/workflows/modules when an instance is active", () => {
    setActiveInstance("p2mods");
    const dir = runtimeWorkflowModulesDir();
    const active = tychonicRuntimeDirs().stateDir;
    expect(dir).toBe(join(active, "workflows", "modules"));
    expect(dir).toContain(join("instances", "p2mods", "workflows", "modules"));
  });
});
