import { join } from "node:path";
import type { LaunchdServiceStatus } from "../service/launchd.js";
import { tychonicRuntimeDirs } from "../temporal/manager.js";
import { isProcessAlive, isRuntimeParentProcess, readPidFile } from "./detached.js";

export function loadedLaunchdRuntimeServices(
  services: readonly LaunchdServiceStatus[]
): LaunchdServiceStatus[] {
  return services.filter((service) => service.loaded);
}

export function assertOperationalRuntimeUpNotLaunchdManaged(
  services: readonly LaunchdServiceStatus[]
): void {
  const loaded = loadedLaunchdRuntimeServices(services);
  if (loaded.length === 0) return;
  const labels = loaded.map((service) => service.label).join(", ");
  throw new Error(
    "operational runtime is already managed by Tychonic LaunchAgents " +
      `(${labels}); do not run \`tychonic runtime up\` beside \`tychonic service install\`. ` +
      "Use `tychonic service status` for the service runtime, or `tychonic service uninstall` before starting the operational runtime manually. " +
      "Use `tychonic runtime up --instance <name>` only for an isolated dev instance."
  );
}

export interface OperationalRuntimeDaemonGuardDeps {
  runtimeDirs?: () => { stateDir: string };
  readPid?: (pidFile: string) => Promise<number>;
  processAlive?: (pid: number) => boolean;
  runtimeParentProcess?: (pid: number, instance: string | null, pidFile: string) => Promise<boolean>;
}

export async function assertServiceInstallNotRuntimeUpManaged(
  deps: OperationalRuntimeDaemonGuardDeps = {}
): Promise<void> {
  const dirs = deps.runtimeDirs?.() ?? tychonicRuntimeDirs();
  const pidFile = join(dirs.stateDir, "runtime.pid");
  const readRuntimePid = deps.readPid ?? readPidFile;
  const processIsAlive = deps.processAlive ?? isProcessAlive;
  const runtimeParentProcess =
    deps.runtimeParentProcess ??
    ((pid, instance, runtimePidFile) => isRuntimeParentProcess(pid, { instance, pidFile: runtimePidFile }));

  const pid = await readRuntimePid(pidFile);
  if (pid <= 0 || !processIsAlive(pid)) {
    return;
  }
  if (await runtimeParentProcess(pid, null, pidFile)) {
    throw new Error(
      `operational runtime is already managed by \`tychonic runtime up\` daemon pid ${pid}; ` +
        "do not run `tychonic service install` beside a manual operational runtime. " +
        "Stop it with `tychonic runtime stop` before installing the service set, or use `tychonic runtime up --instance <name>` for an isolated dev instance."
    );
  }
  throw new Error(
    `operational runtime PID file ${pidFile} points at live process ${pid}, ` +
      "but it is not a verified Tychonic runtime parent; refusing service install"
  );
}
