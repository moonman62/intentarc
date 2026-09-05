# Context selection

The context selector builds and persists an immutable raw context pack from
the current authoritative SQLite state. Selection receives a project ID, a
record ID whose kind must be `task`, and a positive integer token budget.

## Mandatory records

The stable frame contains every accepted record of these kinds, in this exact
kind order:

1. `vision`
2. `outcome`
3. `constraint`
4. `non_goal`

Records within one stable-frame kind are ordered by record ID. The selected
task follows the stable frame. Stable-frame records and the selected task are
mandatory and remain in the pack even when their combined estimate exceeds
the requested budget. Consequently, `estimatedTokens` can be greater than
`budgetTokens`.

## One-hop related records

Only records connected directly to the selected task by an incoming or
outgoing relationship are candidates. A linked record is eligible when its
status is `accepted`, `active`, `provisional`, `blocked`, or `completed`.
Records with `rejected`, `superseded`, or `archived` status are not candidates.

When the same record has multiple direct links, selection keeps its
highest-priority relationship. Related candidates use this exact relationship
priority:

1. `decided_by`
2. `evidenced_by`
3. `implements`
4. `depends_on`
5. `constrained_by`
6. `related_to`

Ties are ordered by record kind, then record ID. A record already present as
the task or stable frame is not duplicated as related context. Unlinked
records are excluded, even when accepted.

## Estimate and budget

For this slice, an item's estimate is JavaScript `text.length` for:

```text
title
body
```

The newline counts as one character. This is a deterministic string-length
estimate, not a provider tokenizer or a promise about model tokens.

The estimate starts with all mandatory items. Related records are then
considered in the order above. A candidate is included only when adding its
estimate does not exceed `budgetTokens`. If one candidate does not fit, it is
omitted and selection continues, so a smaller later candidate can still be
included.

## Omissions, versions, and provenance

Each eligible linked record dropped for budget produces an omission with:

- its `recordId` and `kind`;
- `reason: "budget"`;
- `retrievalRef` in the form
  `intentarc://projects/{projectId}/records/{recordId}`.

Ineligible or unrelated records are exclusions, not budget omissions. The
retrieval reference identifies the omitted authoritative record, although
this foundation's public CLI and MCP surface does not yet provide a
direct-record retrieval command.

Every pack has its own ID and generation time, the selected project revision,
and the revision of every included source record sorted by record ID. Included
records retain their `sourceKind` and optional `sourceRef` provenance fields.
Saving the derived pack does not increment the authoritative project revision.

## Two-phase lifecycle

Selection and outbound release are separate phases:

1. An authenticated MCP client calls `request_task_context`. IntentArc builds
   and persists the immutable raw pack, scans it together with the current
   destination snapshot locally, and returns only a content-free summary with a
   masked destination view when needed.
2. The first clean request and every request with findings pauses at
   `review_required`. A local human inspects the masked preview and approves or
   denies it. Approval creates a separate immutable redacted release.
3. The same authenticated profile calls `get_released_context`. Only a valid
   released request returns the exact stored pack and disclosure.

A remembered clean policy can make step 2 automatic only for a later
zero-finding request with the same profile, project, destination revision, and
detector and safety-policy versions. Findings always pause. Destination or
version changes invalidate that policy, and destination changes prevent
retrieval of releases tied to the old revision.

The local-human `context get` command remains a trusted administrative escape
hatch that prints the raw selected pack. Its output is not an outbound release,
does not carry release approval, and must not be treated as one. See
[outbound context safety](outbound-context-safety.md) for review, forced
redaction, one-time inclusion, disclosure, and retrieval rules.

## Coordination context packs

Task coordination uses this same selector when claiming a task. Claim creation
and raw-pack persistence occur in one immediate transaction, so a successful
claim always names its exact immutable pack and a failed build leaves no
claim. Atomic task switching creates a distinct pack for the next task while
checkpointing and ending the previous claim in the same transaction.

The pack is starting context, not a lock on project knowledge. Claims and
submissions bind its ID plus exact project and task revisions. Later revision
drift conflicts instead of silently rebasing worker results. Repository and
verification identifiers recorded in checkpoints or submissions remain
untrusted evidence. See [task coordination](task-coordination.md) for leases,
switching, delegation, and reconciliation.

## Current limitations

- Selection uses explicit one-hop links only; there is no graph traversal,
  semantic search, repository observation, recency ranking, or LLM call.
- The selector requires record kind `task` but does not require the task to
  have `active` status.
- Generated raw packs are persisted internally, but there is no public pack
  history or direct-record retrieval command.
- Pattern detection is defense in depth and does not scan repository files.
  Project list/summary metadata remains outside the outbound task-pack gate.
- A validated immutable outbound release can be copied or downloaded as
  canonical browser-chat Markdown; selection itself still performs no provider
  execution or delivery.
- The Work Queue and coordination transports can create packs as part of an
  exclusive claim, but they do not add semantic search, graph traversal,
  provider execution, hosted team sync, or agent launching.
