# Structured knowledge and repository refresh

IntentArc Slice 2 keeps repository evidence useful without making it project
authority. Repository access is local, bounded, read-only, and manual. IntentArc
does not run repository code, invoke hooks or package managers, edit files, stage
changes, commit, or change Git configuration.

## Three authority layers

The product presents three deliberately separate layers:

1. **Authoritative project knowledge** consists of governed records and
   relationships: outcomes, milestones, tasks, decisions, constraints,
   evidence, and explicit `parent_of` links. Only a human action or an accepted
   governed proposal changes this layer or advances its revision.
2. **Derived repository index** consists of accepted observations: stable node
   IDs, relative paths, hashes, sizes, classifications, Git facts, exclusions,
   warnings, and labelled attachments. It is replaceable evidence, not project
   intent. Accepting an index-only refresh does not advance the project
   revision.
3. **Governed reconciliation** turns selected repository-derived suggestions
   into ordinary pending proposals. An inference begins unselected and never
   becomes accepted merely because its repository facts were accepted.

The Project Map derives hierarchy only from authoritative `parent_of`
relationships. Repository paths, file names, visual position, and inferred
links never create a parent relationship.

## Documentation is read-only

Documentation lists files from the current accepted repository snapshot.
Markdown and plain text are reopened from the repository only after containment,
file type, size, and SHA-256 checks reproduce that accepted observation. Raw
HTML and scripts do not execute. Remote images, embeds, styles, and other
automatic network requests are not loaded. Plain text remains literal.

Native text rendering is limited to 1 MiB. Explicit image and PDF previews are
limited to 8 MiB, accept only allow-listed file signatures, use local object
URLs, and put PDFs in a sandboxed frame. Unsupported or oversized files retain
metadata and relationships. **Open externally** requires an explicit gesture
and is available only through the desktop boundary; it never turns the web
server into an arbitrary-path opener.

A changed, missing, replaced, linked, blocked, or unavailable file is not shown
as accepted content. Its registry entry remains visible with a recovery state.
Choose **Refresh repository** to review current facts. If the repository moved,
use **Locate** in Desktop only for the same verified repository identity. Use
**Retry** after restoring access, or reviewed **Detach** to retain accepted
provenance while removing the live source registration.

## Manual refresh workflow

Choose **Review repository refresh**, then **Scan repository**. The scan streams
bounded, monotonic progress without polling and can be cancelled. Cancellation
never changes the accepted snapshot and never stores a partial candidate.

A completed scan persists one deterministic candidate and groups added,
changed, moved, removed, unchanged, excluded, and conflicted facts. Exact Git
rename evidence can preserve node identity; ambiguous or hash-only similarity
remains removal plus addition. Dirty worktree facts are visible but are not
modified.

The review has two sections:

- **Repository facts** are the non-selectable index delta.
- **Proposed project meaning** contains optional semantic operations. They start
  unselected and create a governed proposal only when selected.

**Accept repository refresh** promotes facts only. **Accept refresh and create
proposal** atomically promotes the candidate and creates the selected proposal.
Repository identity, source registration, base snapshot, candidate fingerprint,
and project revision are checked again before apply. Drift produces a visible
conflict rather than a silent merge.

Leaving the page preserves the candidate. A renderer or application restart
reopens the same pending review without rescanning. **Discard candidate**
requires confirmation and changes no accepted state. Scanning remains manual:
Slice 2 has no watcher, polling loop, scheduled scan, or automatic refresh.

## Project Map and Repository Explorer

The Map opens in **Whole Project** scope with the Project itself selected and
current, so every root Outcome is represented before a branch is chosen. It is
one accessible, project-rooted semantic tree using the project's Neutral,
Software, or Simple vocabulary. Breadcrumbs, arbitrary-depth ancestry,
expandable children, summarized alternate branches, bounded visible-depth
controls, status/evidence rollups, and selected detail preserve orientation
without pretending that every descendant fits on screen at once.

Selecting a record changes the current detail and route, but does not narrow
the map. **Focus here** is the explicit action that scopes the tree to a branch;
selecting a descendant keeps that branch scope, and **Show whole project**
restores the project context while preserving the selected record. Wide layouts
use layered columns and an SVG relationship overlay. Narrow layouts stack the
same semantic tree; their authoritative text remains complete even when the
SVG overlay is absent.

The **Direct cross-links** ledger lists the selected record's direct,
non-hierarchy relationships, including bounded related detail outside the
hierarchy projection; it does not imply transitive links. Selected detail
also groups canonical repository attachments as accepted, observed, inferred,
or conflicting and shows the recorded basis, kind, and relative path. Its Map,
Documentation, and Repository destinations use stable project and node IDs.
Vocabulary changes labels, not authority. Parent curation is explicit,
revision-checked, audited, and rejects cycles, multiple accepted parents,
invalid endpoint kinds, and cross-project links.

The Repository Explorer is read-only and reads only the current accepted
snapshot. It expands incrementally, defaults to at most 200 children per
request, rejects page sizes above 1,000, and provides stable pagination. Filters
cover current-task relevance, latest-refresh change, documentation, tests,
roles, document kinds, unlinked nodes, current-context inclusion, freshness,
and exclusions. Selection links to Documentation and selected Map detail by
stable ID; it does not load the whole repository or file bodies on entry and
never edits, stages, commits, configures, or executes repository content.

The standalone browser can inspect the Map, accepted repository index, and
bounded Documentation previews. It supports validated manual repository paths
for import and attachment, but it cannot open a native folder picker, locate a
moved repository, or open a file in an operating-system application. IntentArc
Desktop adds the native repository-folder chooser used by import, attachment,
and same-identity **Locate**, plus explicit **Open externally**. These desktop
bridges do not weaken the same containment, identity, review, or read-only
rules.

## Durability, privacy, and recovery

Schema 8 stores repository sources, immutable snapshots, node observations,
links, refresh reviews, and repository-origin proposals. Full integrity checks
validate their cross-table state. Verified backups include this state and
restore it with the same migration, maintenance lease, checksum, and store
identity protections as other IntentArc knowledge. File bodies are not copied
into the repository index; a backup cannot substitute for an unavailable source
when rendering a document.

Ordinary APIs return project IDs, stable repository node IDs, normalized
relative paths, bounded counts, and reviewed content. They do not return source
roots, credentials, raw Git configuration, or arbitrary local paths. Indexed
knowledge is not outbound context automatically; context selection, safety
review, disclosure, and immutable release still apply.

For store recovery, stop IntentArc and its MCP processes before maintenance:

```powershell
node dist/cli/bin.js --db C:/intentarc-data/project.intentarc.sqlite integrity check
node dist/cli/bin.js --db C:/intentarc-data/project.intentarc.sqlite backup create
node dist/cli/bin.js backup verify --backup C:/intentarc-backups/example.intentarc-backup
```

Restore only a verified bundle, following [data durability and recovery](data-durability.md).
Do not delete application locks or SQLite sidecars to bypass a live process.

For implementation verification:

```powershell
pnpm test src/scenarios/structured-knowledge.e2e.test.ts
pnpm test:e2e -- --grep "structured knowledge"
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
pnpm desktop:package
pnpm test src/desktop/e2e/packaged-bridge.test.ts src/test-support/desktop-package-contract.test.ts
```

## Slice 3 boundary

Slice 3 may add an explicitly enabled local detector that debounces relevant
filesystem or Git changes and prepares a candidate through this same pipeline.
That future boundary is **detect and propose**, never detect and silently apply.
Automatic observation acceptance, continuity signals, and inconsistency policy
require separate design and approval. They are not implemented in Slice 2.
