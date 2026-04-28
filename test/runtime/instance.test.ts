import { afterEach, describe, expect, it } from "vitest";
import {
  deriveInstancePort,
  getActiveInstance,
  resolveInstanceRuntime,
  setActiveInstance,
  validateInstanceName
} from "../../src/runtime/instance.js";

// Operational defaults used as baseline for resolver tests. These match
// the shapes produced by `tychonicRuntimeDirs()` on darwin but are
// supplied here directly — the resolver is pure and does not read the
// real filesystem.
const DEFAULT_STATE = "/Users/test/Library/Application Support/Tychonic";
const DEFAULT_LOG = "/Users/test/Library/Logs/Tychonic";

describe("validateInstanceName", () => {
  it("accepts canonical names", () => {
    for (const name of ["dev", "a1", "a1-z-9", "dev-abq", "abq-patch"]) {
      expect(() => validateInstanceName(name)).not.toThrow();
    }
  });

  it("accepts the 32-character max length", () => {
    const name = "a" + "b".repeat(31); // 32 chars total
    expect(name).toHaveLength(32);
    expect(() => validateInstanceName(name)).not.toThrow();
  });

  it("rejects the 33-character length", () => {
    const name = "a" + "b".repeat(32); // 33 chars total
    expect(() => validateInstanceName(name)).toThrow(
      /does not match \^\[a-z\]/
    );
  });

  it("rejects empty string", () => {
    expect(() => validateInstanceName("")).toThrow(/does not match/);
  });

  it("rejects names with uppercase letters", () => {
    expect(() => validateInstanceName("Dev")).toThrow(/does not match/);
    expect(() => validateInstanceName("ABQ")).toThrow(/does not match/);
  });

  it("rejects names with underscores", () => {
    expect(() => validateInstanceName("abq_patch")).toThrow(/does not match/);
  });

  it("rejects names starting with a digit", () => {
    expect(() => validateInstanceName("1abq")).toThrow(/does not match/);
  });

  it("rejects names starting with a hyphen", () => {
    expect(() => validateInstanceName("-abq")).toThrow(/does not match/);
  });

  it("rejects reserved words with a reserved-word message", () => {
    for (const reserved of ["default", "prod", "production", "service"]) {
      expect(() => validateInstanceName(reserved)).toThrow(/is reserved/);
    }
  });
});

describe("deriveInstancePort", () => {
  it("is deterministic for the same name", () => {
    const first = deriveInstancePort("abq-patch");
    const second = deriveInstancePort("abq-patch");
    expect(first).toBe(second);
  });

  it("stays within 17000 <= port < 18000", () => {
    for (const name of ["a", "dev", "abq-patch", "a1-z-9", "smoke", "test-a"]) {
      const port = deriveInstancePort(name);
      expect(port).toBeGreaterThanOrEqual(17000);
      expect(port).toBeLessThan(18000);
    }
  });

  it("does not map every distinct name to a single collision slot", () => {
    const names = ["abq-patch", "dev", "dev-abq", "smoke", "test-a"];
    const ports = names.map((n) => deriveInstancePort(n));
    const unique = new Set(ports);
    // We cannot assert total collision-freedom for a 32-bit hash mod
    // 1000, but 5 names collapsing to 1 slot would signal a broken hash.
    expect(unique.size).toBeGreaterThan(1);
  });

  it("throws on invalid names (validator is invoked defensively)", () => {
    expect(() => deriveInstancePort("")).toThrow();
    expect(() => deriveInstancePort("default")).toThrow(/is reserved/);
  });
});

describe("setActiveInstance / getActiveInstance", () => {
  afterEach(() => {
    setActiveInstance(undefined);
  });

  it("is undefined when nothing has been set", () => {
    setActiveInstance(undefined);
    expect(getActiveInstance()).toBeUndefined();
  });

  it("stores a valid name", () => {
    setActiveInstance("abq-patch");
    expect(getActiveInstance()).toBe("abq-patch");
  });

  it("clears the active instance when given undefined", () => {
    setActiveInstance("abq-patch");
    setActiveInstance(undefined);
    expect(getActiveInstance()).toBeUndefined();
  });

  it("throws when asked to set an invalid name", () => {
    expect(() => setActiveInstance("UPPER")).toThrow(/does not match/);
    expect(() => setActiveInstance("default")).toThrow(/is reserved/);
  });
});

describe("resolveInstanceRuntime — operational (instance unset)", () => {
  it("returns operational defaults when nothing is set", () => {
    const resolved = resolveInstanceRuntime({
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG
    });
    expect(resolved).toEqual({
      stateDir: DEFAULT_STATE,
      logDir: DEFAULT_LOG,
      temporal: {
        address: "127.0.0.1:7233",
        namespace: "default",
        taskQueue: "tychonic",
        apiPort: 7233
      },
      webPort: 8765,
      warnings: []
    });
    // `instance` key is omitted entirely when unset (exactOptionalPropertyTypes).
    expect(Object.prototype.hasOwnProperty.call(resolved, "instance")).toBe(
      false
    );
  });

  it("applies explicit overrides without any instance rules", () => {
    const resolved = resolveInstanceRuntime({
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: {
        address: "127.0.0.1:9999",
        taskQueue: "tychonic-custom",
        webPort: 9000
      }
    });
    expect(resolved.temporal.address).toBe("127.0.0.1:9999");
    expect(resolved.temporal.taskQueue).toBe("tychonic-custom");
    expect(resolved.webPort).toBe(9000);
    // API port stayed on operational default.
    expect(resolved.temporal.apiPort).toBe(7233);
    expect(resolved.warnings).toEqual([]);
  });
});

describe("resolveInstanceRuntime — instance set, no explicit", () => {
  it("derives all isolation fields for abq-patch", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG
    });
    expect(resolved.instance).toBe("abq-patch");
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/abq-patch`);
    expect(resolved.logDir).toBe(`${DEFAULT_LOG}/instances/abq-patch`);
    // Locked deterministic values from fnv1a32("abq-patch") mod 1000 = 706.
    expect(resolved.temporal.apiPort).toBe(17706);
    expect(resolved.temporal.address).toBe("127.0.0.1:17706");
    expect(resolved.temporal.namespace).toBe("default");
    expect(resolved.temporal.taskQueue).toBe("tychonic-abq-patch");
    expect(resolved.webPort).toBe(18706);
    expect(resolved.warnings).toEqual([]);
  });

  it("still appends instances/<name>/ when the state dir already ends with a slash", () => {
    const resolved = resolveInstanceRuntime({
      instance: "dev",
      defaultStateDir: `${DEFAULT_STATE}/`,
      defaultLogDir: `${DEFAULT_LOG}/`
    });
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/dev`);
    expect(resolved.logDir).toBe(`${DEFAULT_LOG}/instances/dev`);
  });
});

describe("resolveInstanceRuntime — field-level explicit override", () => {
  it("lets --temporal-address beat instance-derived address but leaves other fields derived", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { address: "127.0.0.1:9999" }
    });
    expect(resolved.temporal.address).toBe("127.0.0.1:9999");
    // apiPort remains derived — explicit.address is a separate field.
    expect(resolved.temporal.apiPort).toBe(17706);
    expect(resolved.temporal.taskQueue).toBe("tychonic-abq-patch");
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/abq-patch`);
    expect(resolved.warnings).toEqual([]);
  });

  it("lets --temporal-task-queue beat the derived queue without affecting other fields", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { taskQueue: "tychonic-custom" }
    });
    expect(resolved.temporal.taskQueue).toBe("tychonic-custom");
    expect(resolved.temporal.apiPort).toBe(17706);
    expect(resolved.temporal.address).toBe("127.0.0.1:17706");
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/abq-patch`);
    expect(resolved.warnings).toEqual([]);
  });

  it("lets --temporal-namespace beat the Temporal namespace without touching anything else", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { namespace: "experimental" }
    });
    expect(resolved.temporal.namespace).toBe("experimental");
    expect(resolved.temporal.taskQueue).toBe("tychonic-abq-patch");
    expect(resolved.warnings).toEqual([]);
  });

  it("emits a warning when TYCHONIC_STATE_HOME overrides instance state dir", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { stateHome: "/tmp/override-state" }
    });
    expect(resolved.stateDir).toBe("/tmp/override-state");
    expect(resolved.warnings).toContain(
      "TYCHONIC_STATE_HOME overrides instance state dir"
    );
    // logDir stays on the instance-derived path.
    expect(resolved.logDir).toBe(`${DEFAULT_LOG}/instances/abq-patch`);
  });

  it("emits a warning when TYCHONIC_LOG_HOME overrides instance log dir", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { logHome: "/tmp/override-log" }
    });
    expect(resolved.logDir).toBe("/tmp/override-log");
    expect(resolved.warnings).toContain(
      "TYCHONIC_LOG_HOME overrides instance log dir"
    );
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/abq-patch`);
  });

  it("does not warn when explicit stateHome / logHome are given without an instance", () => {
    const resolved = resolveInstanceRuntime({
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: {
        stateHome: "/tmp/custom-state",
        logHome: "/tmp/custom-log"
      }
    });
    expect(resolved.stateDir).toBe("/tmp/custom-state");
    expect(resolved.logDir).toBe("/tmp/custom-log");
    expect(resolved.warnings).toEqual([]);
  });

  it("uses explicit apiPort to derive the default address when address is omitted", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { apiPort: 19000 }
    });
    expect(resolved.temporal.apiPort).toBe(19000);
    // Address defaults to 127.0.0.1:<explicit apiPort> when address
    // is omitted but apiPort is explicit.
    expect(resolved.temporal.address).toBe("127.0.0.1:19000");
  });

  it("keeps explicit address independent of apiPort resolution", () => {
    // Even when apiPort derives from the instance, an explicit
    // address wins for the address field alone.
    const resolved = resolveInstanceRuntime({
      instance: "dev",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG,
      explicit: { address: "example.invalid:1234" }
    });
    expect(resolved.temporal.address).toBe("example.invalid:1234");
    expect(resolved.temporal.apiPort).toBe(17556); // derived from "dev"
  });
});

describe("resolveInstanceRuntime — smoke reproduction (abq-patch)", () => {
  it("locks the exact values the smoke episode relied on", () => {
    const resolved = resolveInstanceRuntime({
      instance: "abq-patch",
      defaultStateDir: DEFAULT_STATE,
      defaultLogDir: DEFAULT_LOG
    });
    expect(resolved.instance).toBe("abq-patch");
    expect(resolved.temporal.apiPort).toBe(17706);
    expect(resolved.temporal.address).toBe("127.0.0.1:17706");
    expect(resolved.temporal.namespace).toBe("default");
    expect(resolved.temporal.taskQueue).toBe("tychonic-abq-patch");
    expect(resolved.stateDir).toBe(`${DEFAULT_STATE}/instances/abq-patch`);
    expect(resolved.logDir).toBe(`${DEFAULT_LOG}/instances/abq-patch`);
    expect(resolved.webPort).toBe(18706);
    expect(resolved.warnings).toEqual([]);
  });
});
