import { TychonicConfigSchema } from "../../catalog/types.js";
import type { ContractCheck } from "./types.js";
import { expectAccept, expectReject } from "./types.js";

export const configContractChecks: readonly ContractCheck[] = [
  {
    area: "config",
    name: "accepts a named agent work state with adapter settings",
    run() {
      expectAccept("agent work state", () =>
        TychonicConfigSchema.parse({
          version: "tychonic.config.v1",
          states: {
            work: {
              type: "work",
              agent: "claude",
              model: "opus",
              resume: 2,
              permission_mode: "acceptEdits",
              timeout: "30m"
            }
          },
          policies: {
            loop: { max_review_iterations: 2 }
          }
        })
      );
    }
  },
  {
    area: "config",
    name: "rejects verify states with adapter-only settings",
    run() {
      expectReject(
        "verify adapter setting",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              verify: {
                type: "verify",
                command: "npm test",
                sandbox: "workspace-write"
              }
            }
          }),
        /sandbox/
      );
    }
  },
  {
    area: "config",
    name: "rejects command work states with adapter-only settings",
    run() {
      expectReject(
        "command work adapter setting",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                command: "node worker.js",
                approval: "never"
              }
            }
          }),
        /approval is only valid with agent, not command/
      );
    }
  },
  {
    area: "config",
    name: "accepts resume as workflow-readable data on any state type",
    run() {
      expectAccept("state resume budget", () =>
        TychonicConfigSchema.parse({
          version: "tychonic.config.v1",
          states: {
            build_phase: {
              type: "work",
              command: "node worker.js",
              resume: 1
            },
            deterministic_gate: {
              type: "verify",
              command: "npm test",
              resume: 2
            },
            judgement_phase: {
              type: "review",
              agent: "claude",
              resume: 3
            }
          }
        })
      );
    }
  },
  {
    area: "config",
    name: "accepts opaque workflow policy values",
    run() {
      expectAccept("opaque policy values", () =>
        TychonicConfigSchema.parse({
          version: "tychonic.config.v1",
          policies: {
            loop: { max_review_iterations: 2 },
            "custom policy": "workflow-owned scalar",
            list_policy: ["workflow-owned", "array"]
          }
        })
      );
    }
  },
  {
    area: "config",
    name: "rejects negative resume",
    run() {
      expectReject(
        "negative resume",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                agent: "claude",
                resume: -1
              }
            }
          }),
        /resume/
      );
    }
  },
  {
    area: "config",
    name: "rejects non-object policies top-level",
    run() {
      expectReject(
        "non-object policies",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            policies: "auto"
          }),
        /policies|expected (record|object)/i
      );
    }
  }
] as const;
