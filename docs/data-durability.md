# Data durability and recovery

IntentArc stores project and governance state in one local SQLite database.
Its durability commands verify that store, create portable backup bundles, and
restore a verified bundle without exposing maintenance controls to MCP
clients.

Schema 8 also stores repository source registrations, immutable accepted and
candidate snapshots, stable nodes and observations, labelled links, refresh
reviews, and repository-origin proposal lineage. Full integrity checks validate
those relationships. Verified backup and restore preserve them exactly, but
the index contains metadata rather than repository file bodies: restored
documentation still requires the same available repository and accepted hash.

Schema 10 adds append-preserved task claims, checkpoints, delegations,
submissions, coordination events, and coordination idempotency results. Full
integrity checks validate their exact schema, strict stored JSON, task/project,
profile, context, checkpoint, delegation, submission, and proposal lineage,
append-only triggers, exclusive indexes, and replay references. Verified
backup, staged migration, and restore preserve the ordered exact rows of all
six coordination tables. No coordination history is merged or regenerated.

## Backup bundles

Unless `--output` or `--root` selects another directory, backups are kept in a
sibling directory named after the database:

```text
project.intentarc.sqlite.backups/
  2026-07-27T12-00-00.000Z-manual-<backup-id>.intentarc-backup/
    database.sqlite
    manifest.json
```

A completed `.intentarc-backup` directory contains only the standalone SQLite
snapshot and its manifest. The manifest records a random backup ID, timestamp,
reason, store identity, schema version, IntentArc version, byte size, and
SHA-256 checksum. It does not record the source database path, project names,
record or proposal content, profile names, tokens, or token hashes.

Bundles are portable files, not encrypted containers. Their SQLite snapshot
contains the project data being protected, so give moved or copied bundles the
same filesystem protection as the primary database.

IntentArc keeps every completed backup until you move or delete it outside
IntentArc. It never overwrites a completed bundle.

## Check, create, list, and verify

Build IntentArc first, then run durability commands through the human CLI:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite integrity check
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup create
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup create --output D:/intentarc-backups
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup list
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup list --root D:/intentarc-backups
node dist/cli/bin.js backup verify --backup D:/intentarc-backups/<name>.intentarc-backup
```

`backup create --output` selects a parent directory; IntentArc generates a
unique bundle name inside it. `backup verify` needs no `--db` argument and
does not open a primary store. Listing reads bundle manifests and reports
completed bundles; verification additionally checks the layout, size,
checksum, SQLite integrity, schema, store identity, and IntentArc invariants.
Verification copies the snapshot once into a private workspace, then performs
its size, checksum, and integrity checks against that same copy.

Do not select the primary filename, its SQLite `-wal`, `-shm`, or `-journal`
paths, or its `.intentarc-lock` tree as a backup root. IntentArc rejects those
paths and their filesystem aliases before creating a root.

IntentArc creates an automatic backup only when an existing supported database
needs migration. The verified bundle has reason `pre-migration` and is
completed before the migration transaction begins. New databases,
already-current databases, normal startup, shutdown, and ordinary MCP or CLI
use do not create automatic backups.

## Restore

Restore replaces a complete store; it never merges stores or restores one
project:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup restore --backup D:/intentarc-backups/<name>.intentarc-backup
```

Replacing an existing database requires interactive confirmation. In a
non-interactive shell, pass `--yes`:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite backup restore --backup D:/intentarc-backups/<name>.intentarc-backup --yes
```

The target and backup normally must share one store identity. Replacing a
different or unreadable store requires the additional
`--allow-different-store` flag and the same confirmation:

```powershell
node dist/cli/bin.js --db C:/data/other.intentarc.sqlite backup restore --backup D:/intentarc-backups/<name>.intentarc-backup --allow-different-store --yes
```

For a healthy target, IntentArc creates and verifies a retained `pre-restore`
bundle before replacement. It verifies and stages the source, acquires
exclusive maintenance access, replaces the primary database and SQLite
sidecars, and checks the installed store. If replacement verification fails,
IntentArc attempts to reinstate the exact original target.

This rollback includes coordination history. An interrupted replacement
reinstates the previous claims, checkpoints, delegations, submissions, events,
and idempotency results together and removes owned staging and rollback
residue. A live application lease blocks restore before target mutation; stop
the owning CLI, web, desktop, or MCP process rather than editing the lease.

Restore returns `maintenance_conflict` while an IntentArc CLI application or
MCP server is actively using the target. Stop every MCP client configured with
that database, wait for its server process to exit cleanly, and run restore
again. Do not delete or edit lease files to bypass a live process.

For a stale same-host lease on Windows, IntentArc also checks when the process
currently using the recorded PID started. It checks `Get-Process.StartTime`
first and falls back to CIM `Win32_Process.CreationDate` when protected process
metadata makes that value unavailable. Even when the initial PID liveness
check is denied, CIM first distinguishes a missing process from a live one. A
missing process is reclaimable; a live process is reclaimable only when the
process-start probe proves it started after the lease's last heartbeat. If CIM
or process timing cannot establish either condition, maintenance continues to
fail safely. Never delete lease files to override an unresolved conflict.

## Diagnostic captures

An unreadable or unhealthy target cannot become a verified pre-restore
backup. Replacing it always requires confirmation. The
`--allow-different-store` flag is additionally required when its identity is
different or cannot be read. IntentArc moves the original primary file and
existing `-wal` and `-shm` sidecars into one sibling
`.intentarc-diagnostic` directory before installing the healthy source.

The capture manifest labels it `unverified_diagnostic` and lists only stable
integrity issue codes and captured filenames. `backup list` deliberately
excludes diagnostic captures. Keep a capture while investigating or seeking
specialist recovery help, but never treat it as a verified backup or restore
source.

## Failure codes and recovery

Durability failures use stable codes:

| Code | Meaning |
| --- | --- |
| `integrity_failed` | A readable store failed a declared integrity invariant. |
| `backup_failed` | A backup could not be completed or verified. |
| `backup_invalid` | A bundle layout, manifest, checksum, schema, identity, or snapshot check failed. |
| `backup_destination_invalid` | The selected backup root is unsafe or collides with protected output. |
| `maintenance_conflict` | Another IntentArc process is using or maintaining the store. |
| `unsupported_schema` | The database schema cannot be opened or migrated by this version. |
| `migration_failed` | The migration transaction or post-commit reopening failed. |
| `restore_failed` | Replacement or rollback did not complete as required. |
| `store_identity_mismatch` | Source and target are different store lineages. |
| `confirmation_required` | Destructive replacement was not explicitly confirmed. |

Use this recovery sequence:

1. Stop applications and MCP clients using the target.
2. Preserve the reported backup bundle or diagnostic capture.
3. Run `backup verify` on the intended source bundle.
4. Run `integrity check` on a readable target.
5. Retry only after resolving a destination or maintenance conflict.
6. Restore a verified bundle with the required confirmation and, only when
   intentional, the cross-store override.
7. Restart IntentArc and run `integrity check` again.

IntentArc reports whether a failed migration preserved its original
transaction and identifies its pre-migration bundle. A failed restore reports
whether the original target was reinstated and retains recovery artifacts when
needed. Human CLI output includes these strictly typed recovery details after
the stable code and canonical message. MCP startup emits the code only. Error
output excludes record and proposal content, credentials, source database
paths, raw SQL, environment variables, nested causes, and exception stacks.

Database aliases resolve to one lease and SQLite identity. Primary database
files with multiple hard links are refused because a hard-linked spelling
cannot safely identify one set of SQLite sidecars and lease controls.

## Deliberate limits

This milestone does not repair or salvage corrupt SQLite content. It also does
not provide pruning or retention policies, scheduled or background backups,
incremental backups, compression, encryption, cloud sync, project-level
restore, or store merging. MCP exposes no integrity, backup, migration, restore,
or other maintenance tools.

Repository refresh does not alter this maintenance boundary. Stop IntentArc
and MCP processes before restore; never delete a lock directory, lease, WAL, or
SHM file to bypass a live process. See
[structured knowledge and repository refresh](structured-knowledge.md) for
repository-specific stale, locate, detach, and restart behavior.
Task coordination does not alter it either; see
[task coordination](task-coordination.md) for lease expiry and proposal
reconciliation, which are separate from store-maintenance leases.
