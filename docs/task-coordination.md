# Task coordination

IntentArc coordinates authenticated human and AI profiles that share one local
archive. It records who may work on a task, the context they started from,
immutable progress checkpoints, bounded delegations, and governed results. It
does not start workers or perform repository work for them.

## Operating model

Every worker is an existing enabled profile with project authority. A profile
acts only as itself: a parent may offer work to a named child profile, but it
cannot claim, renew, checkpoint, or submit as that child. Coordination scope can
narrow existing authority and never grants new authority.

A task is ready when it is an active task, all of its `depends_on` task targets
are completed, and it has neither a blocking claim nor a live delegation.
Missing, cyclic, non-task, or unfinished dependencies remain visible as
blockers. Readiness uses deterministic priority and record-ID ordering; it does
not invent a score or assign work automatically.

Refreshing the ready list or task state may transactionally materialize an
elapsed claim or delegation as `expired` and append its expiry event. No
watcher, polling process, or background expiry job is required for correctness.

## Claims, leases, and checkpoints

A successful claim is exclusive for one task and atomically persists the exact
immutable context pack it returns. A failed context build or conflicting claim
leaves neither a claim nor a partial pack.

- The normal lease is 30 minutes.
- The absolute claim horizon is four hours from acquisition.
- Renewal never extends beyond that horizon.
- An immutable checkpoint also renews an active claim within the same horizon.
- At the horizon, checkpoint the work and obtain a fresh claim.

Checkpoint documents record a summary, completed and remaining work, blockers,
verification identifiers, and optional repository identifiers. This metadata
is untrusted evidence, not proof or authority. Checkpoints are limited to 64
KiB of canonical JSON and cannot be edited or deleted.

`switchTask` is the safe handoff operation. One immediate transaction creates
the current checkpoint, pauses or releases the old claim, builds a distinct
context pack, claims the next ready task, and appends ordered events. If any
step fails, the previous claim and lease remain unchanged and no partial switch
survives.

Pausing, releasing, expiry, and reconciliation preserve history. There is no
resume mutation for a paused claim; use its checkpoint as evidence when taking
a fresh eligible claim.

## Delegation

A parent with suitable authority can offer one ready task to one named child,
with a strict scope, sorted allowed outputs, and a deadline. `allowedOutputs`
is a closed list of governance operation types:

- `create_record` creates a new governed record, such as an evidence record.
- `update_record` patches an existing governed record at its exact revision.
- `create_relationship` adds one exact governed relationship.
- `remove_relationship` removes one exact governed relationship.

Delegation can only narrow the child's existing authority; listing an operation
does not grant new project authority. The canonical delegation document is
limited to 32 KiB. The child must authenticate, accept the offer, and then claim
the same task with the accepted delegation ID and exact project and task
revisions. A result containing an operation outside `allowedOutputs` fails with
`submission_invalid` and persists no partial submission or proposal. To recover,
refresh the project/task revisions, remove or replace the disallowed operation,
and submit the corrected result with a new idempotency key.

The parent can inspect coordination state allowed by its own authority. It
cannot impersonate the child or use the child's credential. Revoked or expired
offers cannot be claimed. Refresh state to materialize an elapsed deadline,
then issue a new delegation if the task is ready and continued delegation is
still appropriate.

## Submission and proposal reconciliation

Final submission requires the worker's current unexpired claim and latest
checkpoint. The result binds the exact claim, context pack, starting project
and task revisions, checkpoint, repository declarations, and verification
declarations. Submission JSON is limited to 256 KiB and must not embed secrets,
repository files, arbitrary artifacts, or raw command output.

Every submission creates a governed proposal. IntentArc adds the exact task
transition to `completed`; any worker-proposed semantic changes travel in the
same proposal. Nothing is applied automatically:

- acceptance applies the governed operations, marks the submission `accepted`,
  the claim `reconciled`, and a linked delegation `completed`;
- revision drift records `conflicted` rather than rebasing;
- rejection or withdrawal preserves the submitted evidence;
- after a conflict, rejection, or withdrawal, explicitly release the submitted
  claim before another worker claims the task.

Use the existing Proposals view or governance CLI to review the linked
proposal. A parent that synthesizes several child results creates its own
governed proposal when authorized; coordination never accepts one on the
parent's behalf.

## Work Queue

Open a project and choose **Work Queue**. The signed-out **Agent Work Queue**
first shows the selected project's task count and current task, followed by the
enabled profiles that already have access to that project. A profile ID is a
public, non-secret identifier. Choosing a listed profile only fills that ID and
opens **Advanced access**; it cannot authenticate the profile or recover its
separately held token.

**Advanced access** is closed by default and is the only browser entry point
for a Profile ID and Profile token. The token remains browser-memory-only: it
is not stored in the URL or browser storage, and the password field is removed
when Advanced access closes. Submitted credentials are cleared on sign-out,
project change, component teardown, credential failure, and ordinary load or
mutation errors. Only explicit project-revision recovery may retain the active
in-memory session so the user can refresh safely or sign out.

When IntentArc Desktop hosts the screen, **Set up AI connection** opens AI
Connections for creating or configuring access. A standalone browser states
that setup is unavailable. Neither host can reconstruct a configured profile's
one-time token: the operator or authenticated client must supply the separately
held token.

The queue groups ready and blocked work, keeps the selected task in the project
URL, and shows the current owner, lease countdown, delegation, checkpoint,
submission, and proposal state. Available controls include claim, renew,
checkpoint, pause, release, atomic switch, delegate, accept, revoke, and submit.
Confirmation dialogs protect destructive transitions, status meaning is not
color-only, and expiry/conflict states include a recovery action.

## Authenticated CLI

Build first and provide credentials only in the private environment of the CLI
process. This PowerShell example masks the token, passes both credentials only
to the child process, and clears the temporary references even when the command
fails:

```powershell
$profileId = Read-Host "Profile ID"
$secureToken = Read-Host "Profile token" -AsSecureString

function Invoke-IntentArcCoordination {
  param([Parameter(Mandatory)][string[]]$CommandArguments)

  $credential = $null
  $startInfo = $null
  $process = $null
  try {
    $credential = [System.Management.Automation.PSCredential]::new("IntentArc", $secureToken)
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = "node"
    $startInfo.UseShellExecute = $false
    foreach ($argument in @(
      "dist/cli/bin.js", "--db", "C:/absolute/path/project.intentarc.sqlite",
      "coordination"
    ) + $CommandArguments) {
      $startInfo.ArgumentList.Add($argument)
    }
    $startInfo.Environment["INTENTARC_PROFILE_ID"] = $profileId
    $startInfo.Environment["INTENTARC_PROFILE_TOKEN"] = $credential.GetNetworkCredential().Password
    $process = [System.Diagnostics.Process]::Start($startInfo)
    $process.WaitForExit()
    if ($process.ExitCode -ne 0) {
      throw "IntentArc CLI exited with code $($process.ExitCode)."
    }
  } finally {
    if ($null -ne $startInfo) {
      [void]$startInfo.Environment.Remove("INTENTARC_PROFILE_ID")
      [void]$startInfo.Environment.Remove("INTENTARC_PROFILE_TOKEN")
    }
    if ($null -ne $process) {
      $process.Dispose()
    }
    $credential = $null
  }
}

try {
  Invoke-IntentArcCoordination -CommandArguments @(
    "ready", "--project", "PROJECT_ID",
    "--expected-project-revision", "3", "--limit", "20"
  )
  Invoke-IntentArcCoordination -CommandArguments @(
    "claim", "--input", "C:/absolute/private/claim.json"
  )
} finally {
  $secureToken.Dispose()
  Remove-Variable secureToken -ErrorAction SilentlyContinue
}
```

Both credential variables must be present and non-empty. There are no
credential flags, and credentials do not belong in JSON input or source
control. The same helper above runs both reads and mutations; mutation commands
read one strict bounded UTF-8 document from an absolute path.

The mutation names are `claim`, `renew`, `checkpoint`, `transition`, `switch`,
`delegate`, `accept-delegation`, `revoke-delegation`, and `submit`. Release,
switch, revoke, and final submission follow the CLI confirmation convention.
See [client setup](client-setup.md#authenticated-coordination-cli) for the full
credential and exit-code contract.

## Authenticated MCP

An authenticated stdio server exposes these closed tools:

- `list_ready_tasks`
- `get_coordination_state`
- `claim_task`
- `renew_task_claim`
- `checkpoint_task`
- `transition_task_claim`
- `switch_task`
- `delegate_task`
- `accept_task_delegation`
- `revoke_task_delegation`
- `submit_task_result`

The MCP process uses `INTENTARC_DB_PATH`, `INTENTARC_PROFILE_ID`, and
`INTENTARC_PROFILE_TOKEN` as documented in [client setup](client-setup.md).
Anonymous MCP remains limited to existing project list and summary reads and
cannot coordinate work. MCP cannot create profiles, accept proposals, launch a
worker, or perform repository commands.

## Errors and recovery

Coordination rejects malformed, stale, unauthorized, or replayed operations
before mutation and returns a fixed public message with one stable code:

| Code | Operator action |
| --- | --- |
| `task_not_ready` | Inspect readiness blockers and authoritative task status. |
| `claim_conflict` | Refresh state; another live or submitted claim owns the task. |
| `claim_expired` | Preserve a checkpoint if possible, refresh expiry, and take a fresh claim. |
| `lease_horizon_reached` | Checkpoint and obtain a new claim. |
| `revision_conflict` | Refresh project/task revisions and reassess the work. |
| `delegation_conflict` | Refresh the task's live delegation before offering or claiming. |
| `delegation_expired` | Refresh expiry and create a new offer if appropriate. |
| `delegation_revoked` | Stop using the offer and coordinate a new one with the parent. |
| `checkpoint_invalid` | Correct the strict bounded checkpoint and exact lineage. |
| `submission_stale` | Refresh revisions; stale work cannot be silently rebased. |
| `submission_invalid` | Correct the strict result, evidence, and governed operations. |
| `coordination_authority_denied` | Recheck the enabled profile and existing project authority. |
| `coordination_idempotency_conflict` | Use the original bytes or a new idempotency key. |
| `coordination_unavailable` | Close competing maintenance work, verify the store, and retry later. |

Exact replay of the same canonical request and idempotency key returns the
stored closed result. Reusing that key with different bytes fails. Errors and
events exclude credentials, absolute paths, commands, raw child output, hidden
repository content, SQL, and exception stacks.

Coordination history is part of schema 10. Full integrity checks validate all
six coordination tables and their relationships. Verified backup and restore
preserve their ordered exact rows; see [data durability and
recovery](data-durability.md).

## Deliberate limits

IntentArc coordinates work; it does not:

- spawn, host, supervise, or terminate human or AI workers;
- execute Git, create branches or worktrees, run tests, or trust repository
  evidence supplied by a worker;
- provide hosted synchronization, team accounts, remote presence, or live
  collaborative editing;
- watch repositories, poll, assign tasks, or accept proposals automatically;
- widen profile authority through delegation;
- export browser chats, add cross-platform packaging, or remediate signed
  releases in this feature.
