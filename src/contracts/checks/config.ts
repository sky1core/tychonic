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
    name: "rejects command work states with resume",
    run() {
      expectReject(
        "command work resume",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              work: {
                type: "work",
                command: "node worker.js",
                resume: 1
              }
            }
          }),
        /resume is only valid on work states that select a built-in agent/
      );
    }
  },
  {
    area: "config",
    name: "rejects review states with resume",
    run() {
      expectReject(
        "review resume",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            states: {
              review: {
                type: "review",
                agent: "claude",
                resume: 1
              }
            }
          }),
        /resume/
      );
    }
  },
  {
    area: "config",
    name: "rejects blank policy names",
    run() {
      expectReject(
        "blank policy name",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            policies: {
              "": { max_review_iterations: 1 }
            }
          }),
        /Invalid key/
      );
    }
  },
  {
    area: "config",
    name: "rejects non-object policy blocks",
    run() {
      expectReject(
        "non-object policy block",
        () =>
          TychonicConfigSchema.parse({
            version: "tychonic.config.v1",
            policies: {
              loop: "auto"
            }
          }),
        /expected (record|object)/i
      );
    }
  }
] as const;
