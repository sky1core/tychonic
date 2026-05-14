# Storage Module SPEC

This file applies to artifact file storage under `src/storage/`.

## Evidence Storage Only

Local storage is evidence storage, not product state authority.

Allowed local files include logs, artifacts, live output, patches, temporary
worktrees, and Temporal managed-local runtime files. These files may support
inspection and recovery, but workflow state remains in Temporal workflow history
and Temporal APIs.

The storage module may write artifact files and reproducibility snapshots such
as `profile_snapshot.yaml`. It must not create repo-local state databases, lock
files, local inbox/session registries, or stale-run recovery stores.

Run evidence storage belongs under the Tychonic user-home run evidence root:
`~/.tychonic/runs/operational/<run-id>/` for operational runs and
`~/.tychonic/runs/instances/<name>/<run-id>/` for isolated instances. Artifact
and live-output paths recorded in `WorkflowRunRecord` are relative to the run's
recorded `artifact_root`, and `artifact_root` is required for artifact storage
and workflow result snapshots. The storage layer must reject paths that escape
the run root. New writes must not create a target-repository `.tychonic/`
directory.
