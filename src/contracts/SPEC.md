# Contracts Checks Module SPEC

This file applies to contract checker code under `src/contracts/`.

## Checker Boundary

Contract checks verify permanent product contracts documented in root
`SPEC.md`, module `SPEC.md` files, README files, workflow bundle docs, and
public examples.

Checker code must not become a second implementation of product validation. If a
runtime validation rule exists, the checker should call or inspect the same
source where practical instead of carrying a divergent copy.

Checker failures are release/worker gate failures. They should identify the
file and contract that drifted so the operator can fix the source document or
the implementation.
