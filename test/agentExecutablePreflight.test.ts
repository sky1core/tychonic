import { describe, expect, it } from "vitest";
import {
  assertAgentExecutablesAvailable,
  checkAgentExecutables,
  requiredAgentExecutables
} from "../src/adapters/executablePreflight.js";
import type { TychonicConfig } from "../src/catalog/types.js";

describe("agent executable preflight", () => {
  it("collects built-in adapter executables from primary agents and normalizers", () => {
    const requirements = requiredAgentExecutables(profileWithAgents());

    expect(requirements).toEqual([
      { stateName: "architect", agent: "claude", executable: "openp", role: "primary" },
      { stateName: "review", agent: "kiro", executable: "openp", role: "primary" },
      { stateName: "review", agent: "codex", executable: "openp", role: "normalizer" }
    ]);
  });

  it("reports missing executable paths with state context", async () => {
    const result = await checkAgentExecutables(profileWithAgents(), {
      env: { HOME: "/tmp/no-such-home", PATH: "" },
      lookup: async (name) => (name === "openp" ? "/opt/bin/openp" : undefined)
    });

    expect(result.resolved.map((entry) => entry.executable)).toEqual(["openp", "openp", "openp"]);
    expect(result.missing).toEqual([]);
  });

  it("throws before workflow start when a required built-in executable is missing", async () => {
    await expect(
      assertAgentExecutablesAvailable(profileWithAgents(), {
        context: "tychonic run exampleWorkflow",
        env: { HOME: "/tmp/no-such-home", PATH: "" },
        lookup: async () => undefined
      })
    ).rejects.toThrow(/tychonic run exampleWorkflow: required agent executable not found.*openp/s);
  });

  it("reports lookup errors as missing executable paths", async () => {
    const result = await checkAgentExecutables(profileWithClaude(), {
      env: { HOME: "/tmp/no-such-home", PATH: "" },
      lookup: async () => {
        throw new Error("openp executable path is not a file: /missing/openp");
      }
    });

    expect(result.resolved).toEqual([]);
    expect(result.missing).toEqual([
      expect.objectContaining({
        stateName: "work",
        agent: "claude",
        executable: "openp",
        role: "primary",
        lookupError: "openp executable path is not a file: /missing/openp"
      })
    ]);
    await expect(
      assertAgentExecutablesAvailable(profileWithClaude(), {
        context: "work activity 'work' run",
        env: { HOME: "/tmp/no-such-home", PATH: "" },
        lookup: async () => {
          throw new Error("openp executable path is not a file: /missing/openp");
        }
      })
    ).rejects.toThrow(/reason=openp executable path is not a file: \/missing\/openp/);
  });
});

function profileWithAgents(): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      architect: {
        type: "work",
        agent: "claude"
      },
      verify: {
        type: "verify",
        command: "npm test"
      },
      review: {
        type: "review",
        on_fail_return_to: "architect",
        agent: "kiro",
        normalizer: "codex"
      }
    }
  };
}

function profileWithClaude(): TychonicConfig {
  return {
    version: "tychonic.config.v1",
    states: {
      work: {
        type: "work",
        agent: "claude"
      }
    }
  };
}
