# Authoritative change governance

IntentArc governs AI-originated changes to its authoritative project knowledge.
It does not grant or restrict filesystem, shell, repository, network, or
operating-system access.

These are two independent permission layers:

- Platform permissions determine what the AI client process can do on the
  machine.
- IntentArc authority determines how a configured client may change IntentArc
  records and relationships through the supported application, CLI, and MCP
  interfaces.

An unrestricted process running as the same operating-system user may bypass
this cooperative policy by invoking human CLI commands or modifying local
files. IntentArc is therefore a workflow guardrail, not an adversarial sandbox
or a hard security boundary.

## Profiles and project authority

A client profile is a persistent identity for one configured AI connection.
Each profile has a stable ID, enabled or disabled state, hashed token, and
separate authority assignment for each project. Profiles and assignments
survive application and client restarts.

Creating a profile with a project assignment defaults that assignment to
`proposal`. A human may later choose:

| Mode | Routing |
| --- | --- |
| `proposal` | Every valid change set becomes a proposal. |
| `scoped_direct` | The complete set applies directly only if every operation matches a stored scope. One unmatched operation routes the whole set to one proposal. |
| `full_direct` | Supported record and relationship operations apply directly, subject to validation, revision checks, idempotency, transactions, and audit. |

Scoped authority is deny-by-default. A scope always names an operation type
and may narrow it by record kind or by relationship endpoint and relationship
kind. For example, a scope for `update_record` and `task` permits task updates;
it does not permit decision creation.

Only local-human administration may create, rotate, enable, disable, or change
profiles and scopes. Proposal acceptance, rejection, and withdrawal are also
human-only. MCP exposes none of these administrative operations.

## Structured, atomic change sets

Authenticated clients submit one structured envelope through
`submit_change_set`. It contains the project ID, base project revision,
idempotency key, rationale, optional source task and predecessor proposal, and
one or more ordered operations.

Supported operations are:

- `create_record`
- `update_record`
- `create_relationship`
- `remove_relationship`

A created record may declare a client-local `localRef`. A later relationship
operation in the same set may refer to that local value; IntentArc resolves it
to the new authoritative record ID inside the transaction. Forward, duplicate,
cross-project, missing, and self references are rejected.

An applied set is one semantic project revision:

- the project revision increments exactly once;
- created records start at record revision `1`;
- updated records require the expected current record revision and increment
  once;
- each create or update stores an immutable record-revision snapshot;
- relationships, idempotency result, and success audit commit in the same
  transaction.

Validation or conflict failure leaves no partial record, revision,
relationship, result, or success audit. In `scoped_direct`, IntentArc never
applies the permitted subset and proposes the rest.

## Proposals and conflicts

Proposal creation does not change the project revision. A proposal preserves
its base revision, expected record revisions, ordered operations, rationale,
originating profile, and provenance.

Human acceptance rechecks the stored project and record bases and uses the same
transactional write kernel as direct application. If current state has moved,
the proposal becomes `conflicted` and none of its operations apply. There is no
force-apply option.

Conflicted proposals remain available for traceability. Recovery is explicit:
inspect current authoritative state, prepare a new change set against the new
base, and optionally identify the conflicted proposal as its predecessor.
IntentArc does not automatically merge or semantically rebase proposals.

## Idempotency and retries

Idempotency keys are unique per profile and project. IntentArc hashes the
normalized request and stores the completed result.

- The same key and same request return the stored result with `replayed: true`
  and do not create another proposal or project revision.
- The same key with a different request returns `idempotency_conflict`.
- Concurrent identical submissions serialize to one stored result.
- If a pending proposal is later accepted or becomes conflicted, a retry
  returns that updated stored outcome rather than the earlier pending result.

Clients should preserve an idempotency key until the final response is known
and safely retry the identical envelope after a transport interruption.

## Audit and credentials

Audit events cover profile lifecycle and authority changes, proposal lifecycle,
direct and human applications, conflicts, valid denials, idempotent replays,
idempotency conflicts, outbound destinations, requests, completed scans,
decisions, policy enable/disable, and successful release retrieval. Required
audit writes are transactionally coupled to state changes, and SQLite rejects
ordinary audit update or deletion. Outbound audit rows store safe identifiers,
counts, versions, outcomes, revisions, and fixed reason codes; they do not store
raw idempotency keys, pack content, destination labels, source references,
masked previews, finding excerpts, revealed values, or release bodies.

Profile creation and token rotation display a new plaintext token once.
IntentArc stores only its SHA-256 digest and authenticates the presented
high-entropy token without persisting it. Plaintext tokens, raw environment
credentials, exception stacks, SQL, and filesystem details are excluded from
audit events, stored results, normal service errors, and MCP errors.

For MCP startup, `INTENTARC_PROFILE_ID` and `INTENTARC_PROFILE_TOKEN` are
optional together:

- both absent: anonymous server with `list_projects` and
  `get_project_summary`, both carrying read-only MCP annotations;
- both present and valid for an enabled profile: authenticated server with
  governed mutation, profile-private history, and outbound request/retrieval
  tools;
- only one present, invalid credentials, or a disabled profile: startup fails
  closed and does not fall back to anonymous or human authority.

See [local MCP client setup](client-setup.md) for synthetic configuration
examples.

## Durability and disclosure limits

Verified backup, migration rollback, integrity inspection, restore, and
diagnostic workflows are documented in
[data durability and recovery](data-durability.md).

Authenticated task context uses the two-phase release workflow documented in
[outbound context safety](outbound-context-safety.md). Request responses never
contain the pack. Release requires a current human-declared destination and
either a local decision or an exact-scope clean policy; destination labels are
not provider-verified. Confirmed credentials are forcibly redacted, while an
eligible possible-sensitive finding may be included only once for one
explicitly approved request.

This context gate does not govern anonymous project list/summary metadata,
including active task titles. It also does not turn local human CLI access into
client authority: `context get` is a trusted administrative raw-context escape
hatch, not an approved release. Detection does not scan repositories, and
IntentArc does not execute provider requests. These cooperative boundaries do
not restrict a process that can read or alter the local database or files
through other operating-system access.
