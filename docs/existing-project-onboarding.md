# Existing-project onboarding

IntentArc can create an initial governed project snapshot from an existing
local Git worktree. Discovery is read-only: it does not run repository code,
launch an editor, call an LLM, modify Git state, or write any marker into the
source repository. The reviewable JSON manifest is the boundary between
repository discovery and authoritative SQLite state.

## Scan, inspect, and apply

Build IntentArc first. Keep the manifest and database outside the repository
being onboarded, then run these exact packaged commands:

```powershell
node dist/cli/bin.js project import scan `
  --repository C:/absolute/path/to/repository `
  --canonical-subpath godot `
  --manifest C:/intentarc-data/project/onboarding.json

node dist/cli/bin.js project import inspect `
  --manifest C:/intentarc-data/project/onboarding.json

node dist/cli/bin.js --db C:/intentarc-data/project/project.intentarc.sqlite `
  project import apply `
  --manifest C:/intentarc-data/project/onboarding.json `
  --confirm-digest MANIFEST_SHA256_FROM_INSPECT
```

`scan` creates a new manifest exclusively and refuses to overwrite an existing
path. `inspect` needs no database. It strict-parses the complete manifest,
performs sensitive-content checks, and prints a safe summary with the semantic
digest required by `apply`. Non-interactive apply requires the exact
`--confirm-digest`; the confirmation does not bypass validation, source-drift
checks, or sensitive-content blocks.

The manifest has two different responsibilities:

- `discovery` records deterministic repository facts. Do not edit it.
- `proposal` is the review surface. A human or locally operated tool can add,
  remove, or revise proposed records and their manifest-local relationships
  before apply. Curated claims must retain honest `sourceKind` provenance and
  either source references or a nonblank `curationReason`.

The digest is derived by `inspect`; it is not a trusted or editable manifest
field. It covers discovery and proposal semantics but excludes `createdAt`.
Two unchanged scans can therefore have different creation timestamps and the
same digest. Editing the proposal changes the derived digest, so inspect again
and confirm that new exact value.

## Canonical subpath

`--canonical-subpath` is a normalized relative directory inside the repository,
not a second repository or an output path. It declares which subtree is the
canonical implementation. An explicit value outranks heuristics: eligible
content inside it can be canonical, while root documentation can support it
and source outside it can be classified as supporting or archived. Outside
content cannot silently replace the declared canonical implementation.

For a Godot repository whose release implementation lives under `godot/`, use
`--canonical-subpath godot`. The directory must exist, remain inside the Git
root, and contain the canonical project signals such as `project.godot`.

## Selection and exclusion rules

Selection is Git-aware and deliberately narrow:

- Eligible tracked UTF-8 text is selected according to its repository role.
  A tracked path does not override a hard exclusion.
- Untracked text is selected only in recognized documentation locations or for
  recognized project metadata such as `project.godot` and
  `export_presets.cfg`. Selected untracked documents are provisional.
  Untracked scripts and arbitrary art iterations are not selected.
- Ignored content is not read.
- Binary files are never copied into record bodies. They are represented only
  by grouped metadata such as directory, role, extension, count, and byte size.
- Symbolic links, junctions, and other links are not traversed, even when a
  target would remain inside the repository. Eligible link paths are recorded
  only as exclusion metadata.

Version 1 hard-excludes repository metadata and linked-worktree metadata
(`.git/` and `.worktrees/`), dependencies (`node_modules/`), Godot caches
(`.godot/`), build/export output (`build/` and `dist/`), and temporary or cache
directories (`tmp/`, `temp/`, `__pycache__/`, `.cache/`, and `staging/`).
Known secret files such as `.env`, `.env.local`, `.eleven_key`,
`credentials.json`, and `service-account.json` are excluded without retaining
their path or content in the manifest. These rules are versioned and cannot be
overridden in version 1.

Keep manifest and SQLite output paths outside the source repository. Besides
preventing output artifacts from entering later working-tree observations,
this keeps local migration data separate from project source.

## Sensitive content and manifest privacy

The scanner applies the local versioned detector before publishing its
generated manifest. `inspect` and `apply` repeat strict parsing and detection
over the entire edited proposal:

- Confirmed credentials block the operation. The error reports only safe
  category/count information and does not reveal the matched value.
- Possible-sensitive proposal values are replaced with deterministic
  `[REDACTED:CATEGORY:N]` placeholders before the digest is reported and before
  any project state is stored.
- Detection is defense in depth, not a complete secret scanner. Hard path
  exclusions and human review still matter.

Inspect and apply normalize an in-memory copy; they do not rewrite the
operator's JSON file. If a human manually adds possible-sensitive or credential
text, that raw text remains in the local manifest artifact until the operator
securely edits or removes it. Treat the manifest as private migration material.
It contains absolute local repository paths, file paths and hashes, proposal
bodies, provenance, warnings, and exclusion metadata. It does not contain
selected source-file bodies or binary bodies.

Local paths are needed to revalidate the first apply. They are not exposed by
anonymous MCP project metadata or copied into outbound audit events. Normal
outbound scanning and local approval still gate release of imported task
context to an authenticated client.

## First apply, replay, and the one-time boundary

On first apply, IntentArc validates the edited manifest and exact confirmation,
then re-reads the selected repository snapshot. A changed selected path, hash,
branch, HEAD, canonical subpath, or ruleset produces `source_drift` before the
transaction. Invalid records, dangling relationships, sensitive-content
blocks, drift, and transaction failures create no project, import receipt, or
success audit.

After a successful import, the immutable receipt lookup happens before drift
validation. Reapplying the same valid digest returns the same project ID with
`replayed: true`, even if the repository has changed since the original apply;
it does not duplicate state. A stale digest that has never been applied still
fails its first-apply drift check.

This manifest flow is a one-time initial import into a new IntentArc project.
A changed import proposal is not an update mechanism. After onboarding, Slice
2 can create a separate, read-only repository observation candidate through
the project's reviewed manual refresh screen. Accepting repository facts
updates only the derived index; selected semantic suggestions enter the normal
governed-proposal workflow. There is still no watcher, polling loop, automatic
refresh, merge, or synchronization. See
[structured knowledge and repository refresh](structured-knowledge.md).

Client profile tokens are also displayed only by profile creation or rotation.
Store the token in the authenticated MCP child's secret environment, never in
the manifest, command arguments, source repository, or logs. The first clean
outbound context request remains `review_required`; a local human must inspect
and approve it before that same authenticated profile can retrieve the
immutable release. See [outbound context safety](outbound-context-safety.md).

## Example Game example and trust boundary

Example Game is an example of the intended shape: `godot/` can be declared
canonical, root and selected `docs/` material can remain supporting evidence,
and an archived browser prototype or binary asset collections need not become
the release target or task context. This is an onboarding example, not a
provider integration. IntentArc does not contact, authenticate with, or execute
an AI/model provider.

Onboarding validates the repository knowledge selected for import; it does not
prove the repository itself is trustworthy or correct. It does not execute
scanned code, infer every decision or task, discover every secret, resolve
conflicting documentation, automatically observe later filesystem changes, or
verify provider and destination declarations. Later changes appear only after
a user starts the bounded reviewed refresh workflow.
