import { describe, expect, it } from "vitest";
import { assertLoopbackHost, isLoopbackHost } from "../src/net/loopback.js";

describe("loopback web bind guard", () => {
  it("accepts loopback hosts", () => {
    for (const host of ["127.0.0.1", "127.1", "localhost", "::1", "[::1]"]) {
      expect(isLoopbackHost(host)).toBe(true);
      expect(() => assertLoopbackHost(host, false)).not.toThrow();
    }
  });

  it("rejects network hosts unless explicitly allowed", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.1.10")).toBe(false);
    expect(() => assertLoopbackHost("0.0.0.0", false)).toThrow(/refusing to bind/);
    expect(() => assertLoopbackHost("0.0.0.0", true)).not.toThrow();
  });
});
