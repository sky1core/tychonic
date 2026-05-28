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
              model: "claude-opus-4-8",
              resume: 2,
              permission_mode: "bypassPermissions",
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
              on_fail_return_to: "build_phase",
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
    name: "rejects review states without failure return target",
    run() {
      expectReject(
        "missing review failure return target",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                agent: "claude"
              },
              review: {
                type: "review",
                agent: "codex"
              }
            }
          }),
        /on_fail_return_to is required for type review/
      );
    }
  },
  {
    area: "config",
    name: "rejects review failure return target outside configured states",
    run() {
      expectReject(
        "unknown review failure return target",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              review: {
                type: "review",
                on_fail_return_to: "missing_work",
                agent: "codex"
              }
            }
          }),
        /on_fail_return_to must name an existing state/
      );
    }
  },
  {
    area: "config",
    name: "rejects review failure return targets that point to review states",
    run() {
      expectReject(
        "review failure return target is review",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                agent: "claude"
              },
              review: {
                type: "review",
                on_fail_return_to: "review_fix",
                agent: "codex"
              },
              review_fix: {
                type: "review",
                on_fail_return_to: "work",
                agent: "claude"
              }
            }
          }),
        /on_fail_return_to must name a non-review state/
      );
    }
  },
  {
    area: "config",
    name: "rejects failure return targets on non-review states",
    run() {
      expectReject(
        "non-review failure return target",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                on_fail_return_to: "verify",
                agent: "claude"
              },
              verify: {
                type: "verify",
                command: "npm test"
              }
            }
          }),
        /on_fail_return_to is not allowed for type work/
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
