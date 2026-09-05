# Outbound context safety

IntentArc separates raw task-context selection from release to an AI client.
An authenticated MCP client can request a pack, but it receives only request
metadata until the pack is released. Detection, review, redaction, persistence,
and digest validation run locally; IntentArc does not send the release to a
provider.

## Configure a destination

Create a client profile, retain its one-time token in the client's secret
configuration, and declare the destination that profile represents:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile create --name "Codex workstation" --project PROJECT_ID

node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile destination set --profile PROFILE_ID --client-label "Codex workstation" --type ide_managed --provider "OpenAI" --model "Declared Codex model" --account-boundary "Personal account" --data-boundary remote

node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile destination set --profile PROFILE_ID --client-label "Claude Code terminal" --type direct_provider --provider "Anthropic" --model "Declared Claude model" --account-boundary "Team account" --data-boundary remote

node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile destination set --profile PROFILE_ID --client-label "Cursor editor" --type ide_managed --provider "Cursor-managed provider" --model "Editor-selected model" --account-boundary "Workspace account" --data-boundary mixed

node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile destination set --profile PROFILE_ID --client-label "OpenRouter gateway" --type gateway --provider "OpenRouter" --model "Gateway-selected model" --account-boundary "Gateway account" --data-boundary remote
```

These are configuration examples, not verified integrations. Every client,
provider, model, account-boundary, and data-boundary value is declared by the
local human. IntentArc neither contacts a provider nor verifies that a label or
claimed boundary is true. Destination strings are still included in the local
safety scan. A matched destination field is masked in AI-facing request
summaries and release disclosures, while its raw human-declared revision remains
available only in the local destination history. Setting the destination again
creates a new revision; disabling it also creates a retained disabled revision:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite profile destination disable --profile PROFILE_ID
```

## Request, review, and retrieve

An authenticated MCP client calls `request_task_context`:

```json
{
  "projectId": "PROJECT_ID",
  "taskId": "TASK_ID",
  "budgetTokens": 4000,
  "idempotencyKey": "client-stable-request-key"
}
```

The result is a strict request summary with status, IDs, a safe destination
view, project revision, estimate, and finding counts. It never contains the task
pack or a matched destination value. On first clean use, `status` is
`review_required`.

The local human reviews with the packaged CLI:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound list --project PROJECT_ID --status review_required
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound inspect --request REQUEST_ID
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound reveal --request REQUEST_ID --finding FINDING_ID
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound approve --request REQUEST_ID
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound approve --request REQUEST_ID --remember-clean
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound approve --request REQUEST_ID --include-finding FINDING_ID
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound deny --request REQUEST_ID
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context outbound policy disable --profile PROFILE_ID --project PROJECT_ID
```

`inspect` prints a masked preview, a masked destination view, and finding
metadata. Destination findings use `/destination/...` paths so the local human
can identify the affected field without persisting an excerpt. `reveal` prints
one matched value locally and only when both input and output are attached to an
interactive terminal.

> Warning: reveal may expose sensitive content in terminal output, scrollback,
> recordings, or logs controlled by the terminal. It has no non-interactive
> bypass.

After approval, the same authenticated profile calls
`get_released_context` with `{"requestId":"REQUEST_ID"}`. A released result is
the exact stored immutable release. Pending and denied results contain only a
request summary. Retrieval revalidates the enabled profile, ownership, current
destination revision, raw-pack linkage, strict stored schemas, supported
detector/policy versions, and release digest. A changed destination makes old
releases unavailable through MCP; create and review a new request.

## Portable browser-chat export

The released web response contains one canonical browser-chat export. Handoff
Desk's **Copy task context** and **Download Markdown** actions both consume the
same `export.text`; the renderer does not construct or reformat the context.
The file uses media type `text/markdown;charset=utf-8`, LF line endings, and a
filename derived only from the validated opaque release ID.

The Markdown records the release, request, source pack, project, task, project
revision, release time, full release digest and SHA-256, redacted destination
label and data boundary, detector and policy versions, original and released
token estimates, requested budget, every finding count, explicit omissions and
retrieval references, and the already-released task context. This is disclosure
metadata, not a new safety scan or a second independently formatted pack.

Copy and download become available only after current-destination, ownership,
stored-schema, pack-linkage, and digest validation succeed. A pending, denied,
stale-destination, malformed, or invalid release receives no export. Download
creates a local Blob from the released bytes; IntentArc does not open a browser
chat, upload the file, capture the conversation, or make a provider/model
request.

## Clean automation and findings

`--remember-clean` is accepted only while approving a request with zero
findings. It stores `auto_release_clean` for the exact combination of profile,
project, destination ID and revision, detector version, and safety-policy
version. A later clean request in that scope can be released immediately. The
first clean request still pauses, and changing the destination, detector
version, or policy version returns the flow to manual review.

Any finding pauses automation:

- Confirmed credential findings use `forced_redact`. They cannot be included
  by CLI approval and are rechecked before release.
- Possible-sensitive findings use `redact_by_default`. A human may name an
  eligible finding with repeatable `--include-finding`; that inclusion applies
  only to that request and is counted in its disclosure.
- Findings not explicitly included are replaced by deterministic placeholders.
  Authoritative records and the immutable raw pack are never rewritten.
- Findings in destination metadata always use forced redaction for release, so
  a matched destination field cannot be included once.

Detection is defense in depth, not a guarantee that content is safe. The
versioned local detectors recognize selected credential and possible-sensitive
patterns. They can produce false positives and false negatives and do not
understand every credential format or privacy context.

## Disclosure and audit

Each release carries:

- its release, request, and source-pack IDs and release timestamp;
- the human-declared destination snapshot;
- project, task, project revision, and included source-record provenance;
- selection omissions;
- requested budget plus original and released estimates;
- total, credential, sensitive, forced, default-redaction, redacted, and
  one-time-inclusion counts;
- detector and safety-policy versions;
- one SHA-256 release digest repeated in the disclosure.

The disclosure contains no finding excerpts or matched plaintext. Successful
retrieval records a new append-only local audit event. Audits also cover
destination changes, request creation, scan completion with safe counts,
human approval or denial, and policy enable/disable. Request creation and scan
events commit together; remembered policy state and its enable event commit
together. They retain safe identifiers, revisions, versions, outcomes, and
fixed reason codes—not raw idempotency keys, pack content, labels, source
references, previews, revealed values, credentials, database paths, raw SQL,
environment data, stacks, or nested causes.

## Error recovery

CLI failures print a stable code and canonical message. Authenticated MCP tool
failures return the stable code without sensitive details.

| Code | Recovery |
| --- | --- |
| `outbound_destination_required` | Configure and enable the profile's destination, then make a new request. |
| `outbound_destination_changed` | The request used an older destination revision. Inspect the current declaration and make a new request. |
| `outbound_request_conflict` | Do not reuse an idempotency key for different input and do not decide a terminal request; inspect or create a new request. |
| `outbound_safety_failed` | The operation failed closed. Inspect the request locally, run `integrity check`, and retry only after the local state is healthy. |
| `outbound_release_invalid` | Treat the release as unavailable. Run `integrity check`; restore a verified backup if integrity fails. |
| `outbound_reveal_requires_tty` | Run reveal directly in an interactive local terminal. There is no `--yes` or piped-output override. |

`review_required`, `released`, and `denied` are normal typed states, not
internal errors.

## Trust boundary and deliberate limits

Only task-context release is gated. Anonymous `list_projects` and
`get_project_summary` still disclose project list/summary metadata, including
active task titles, outside this gate.

The local-human command below is a trusted administrative escape hatch:

```powershell
node dist/cli/bin.js --db C:/data/project.intentarc.sqlite context get --project PROJECT_ID --task TASK_ID --budget 4000
```

It prints and persists a raw pack locally. It is not an approved outbound
release and must not be presented as one. A process with the same operating
system access can also read or alter local files, so this workflow is a
cooperative guardrail rather than an adversarial sandbox.

IntentArc scans only the generated task-context pack and the configured
destination snapshot used for that request. It does not scan a repository, obey
ignore files, observe filesystem changes, maintain sensitive value allowlists,
upload browser-chat exports, capture browser-chat history, or execute a
model/provider request. Provider credentials and delivery remain entirely
outside IntentArc.
