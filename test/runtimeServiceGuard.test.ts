import { describe, expect, it } from "vitest";
import {
  assertServiceInstallNotRuntimeUpManaged,
  assertOperationalRuntimeUpNotLaunchdManaged,
  loadedLaunchdRuntimeServices
} from "../src/runtime/serviceGuard.js";
import type { LaunchdServiceStatus } from "../src/service/launchd.js";

describe("runtime service guard", () => {
  it("allows operational runtime up when no Tychonic LaunchAgents are loaded", () => {
    const services = serviceStatuses(false);

    expect(loadedLaunchdRuntimeServices(services)).toEqual([]);
    expect(() => assertOperationalRuntimeUpNotLaunchdManaged(services)).not.toThrow();
  });

  it("rejects operational runtime up when launchd service mode is active", () => {
    const services = serviceStatuses(true);

    expect(() => assertOperationalRuntimeUpNotLaunchdManaged(services)).toThrow(
      /operational runtime is already managed by Tychonic LaunchAgents.*com\.tychonic\.worker/s
    );
  });

  it("allows service install when no operational runtime pid is recorded", async () => {
    await expect(
      assertServiceInstallNotRuntimeUpManaged({
        runtimeDirs: () => ({ stateDir: "/tmp/tychonic-state" }),
        readPid: async () => 0
      })
    ).resolves.toBeUndefined();
  });

  it("rejects service install while a verified manual operational runtime is running", async () => {
    await expect(
      assertServiceInstallNotRuntimeUpManaged({
        runtimeDirs: () => ({ stateDir: "/tmp/tychonic-state" }),
        readPid: async () => 123,
        processAlive: () => true,
        runtimeParentProcess: async () => true
      })
    ).rejects.toThrow(/already managed by `tychonic runtime up` daemon pid 123/);
  });

  it("rejects service install when the operational runtime pid points at an unverified live process", async () => {
    await expect(
      assertServiceInstallNotRuntimeUpManaged({
        runtimeDirs: () => ({ stateDir: "/tmp/tychonic-state" }),
        readPid: async () => 456,
        processAlive: () => true,
        runtimeParentProcess: async () => false
      })
    ).rejects.toThrow(/runtime PID file .*runtime\.pid points at live process 456.*refusing service install/s);
  });
});

function serviceStatuses(workerLoaded: boolean): LaunchdServiceStatus[] {
  return [
    {
      name: "temporal",
      label: "com.tychonic.temporal",
      plistPath: "/tmp/com.tychonic.temporal.plist",
      loaded: false
    },
    {
      name: "worker",
      label: "com.tychonic.worker",
      plistPath: "/tmp/com.tychonic.worker.plist",
      loaded: workerLoaded,
      ...(workerLoaded ? { pid: 123 } : {})
    },
    {
      name: "web",
      label: "com.tychonic.web",
      plistPath: "/tmp/com.tychonic.web.plist",
      loaded: false
    }
  ];
}
