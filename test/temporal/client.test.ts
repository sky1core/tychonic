/**
 * P2 instance-isolation contract: `normalizeTemporalConfig` (re-exported
 * and used throughout `src/temporal/client.ts`) must honor the active
 * instance without losing the field-level explicit-override precedence
 * (§9). These tests target the resolver wiring that client calls rely on.
 */

import { afterEach, describe, expect, it } from "vitest";
import { normalizeTemporalConfig } from "../../src/temporal/manager.js";
import {
  deriveInstancePort,
  getActiveInstance,
  setActiveInstance
} from "../../src/runtime/instance.js";

afterEach(() => {
  setActiveInstance(undefined);
  expect(getActiveInstance()).toBeUndefined();
});

describe("normalizeTemporalConfig + active instance", () => {
  it("keeps the legacy defaults when no instance is active", () => {
    const cfg = normalizeTemporalConfig({});
    expect(cfg.address).toBe("127.0.0.1:7233");
    expect(cfg.taskQueue).toBe("tychonic");
    expect(cfg.namespace).toBe("default");
    expect(cfg.apiPort).toBe(7233);
    expect(cfg.devUiPort).toBe(8233);
  });

  it("derives address, ports, and task queue when an instance is active", () => {
    setActiveInstance("p2net");
    const cfg = normalizeTemporalConfig({});
    const port = deriveInstancePort("p2net");
    expect(cfg.apiPort).toBe(port);
    expect(cfg.devUiPort).toBe(port + 1);
    expect(cfg.address).toBe(`127.0.0.1:${port}`);
    expect(cfg.taskQueue).toBe("tychonic-p2net");
    // Instance must not change the Temporal namespace.
    expect(cfg.namespace).toBe("default");
  });

  it("honors per-field explicit overrides over instance-derived values", () => {
    setActiveInstance("p2net");
    const cfg = normalizeTemporalConfig({ address: "127.0.0.1:9999" });
    // address is explicit → wins.
    expect(cfg.address).toBe("127.0.0.1:9999");
    // taskQueue was not explicit → still derived.
    expect(cfg.taskQueue).toBe("tychonic-p2net");
  });

  it("honors explicit taskQueue while leaving address/port instance-derived", () => {
    setActiveInstance("p2net");
    const cfg = normalizeTemporalConfig({ taskQueue: "custom-queue" });
    expect(cfg.taskQueue).toBe("custom-queue");
    const port = deriveInstancePort("p2net");
    expect(cfg.address).toBe(`127.0.0.1:${port}`);
    expect(cfg.apiPort).toBe(port);
  });

  it("leaves every field at operational defaults when no instance is active and no explicit values are supplied", () => {
    // Regression guard: byte-identical legacy behavior when instance is unset.
    const cfg = normalizeTemporalConfig({});
    expect(cfg).toMatchObject({
      address: "127.0.0.1:7233",
      apiPort: 7233,
      devUiPort: 8233,
      taskQueue: "tychonic",
      namespace: "default"
    });
  });
});
