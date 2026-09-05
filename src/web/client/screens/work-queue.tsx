import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { z } from "zod";
import {
  coordinationAcceptDelegationBodySchema,
  coordinationCheckpointBodySchema,
  coordinationCheckpointResponseSchema,
  coordinationClaimBodySchema,
  coordinationClaimResponseSchema,
  coordinationCreateDelegationBodySchema,
  coordinationDelegationResponseSchema,
  coordinationReadyResponseSchema,
  coordinationRenewBodySchema,
  coordinationRenewResponseSchema,
  coordinationRevokeDelegationBodySchema,
  coordinationStateResponseSchema,
  coordinationSubmissionBodySchema,
  coordinationSubmissionResponseSchema,
  coordinationSwitchBodySchema,
  coordinationSwitchResponseSchema,
  coordinationTransitionBodySchema,
  coordinationTransitionResponseSchema,
  type CoordinationReadyResponse,
  type CoordinationStateResponse,
  type ProjectHubResponse,
  type SanitizedProfileResponse,
  apiPath,
} from "../../contracts.js";
import { ApiError, apiRequest, type ApiProfileCredentials } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { StatusChip } from "../components/status-chip.js";
import { navigate, replaceRoute } from "../router.js";

type ProfileCredentials = ApiProfileCredentials;

type WorkQueueState =
  | { status: "signed-out" }
  | { status: "loading"; credentials: ProfileCredentials }
  | { status: "empty"; credentials: ProfileCredentials }
  | {
      status: "ready";
      credentials: ProfileCredentials;
      data: CoordinationStateResponse;
    }
  | {
      status: "error";
      credentials: ProfileCredentials | null;
      message: string;
    };

type ActionKind =
  | "claim"
  | "renew"
  | "checkpoint"
  | "pause"
  | "release"
  | "switch"
  | "delegate"
  | "accept"
  | "revoke"
  | "submit";

interface ActionDialogState {
  kind: ActionKind;
  idempotencyKey: string;
}

interface WorkQueueProps {
  projectId: string;
  projectRevision: number;
  initialTaskId?: string | null;
  desktopAiAvailable?: boolean;
  ownerSummary?: {
    projectName: string;
    taskCount: number;
    currentTask: {
      title: string;
      status: string;
    } | null;
  };
}

type ProfileSummary = SanitizedProfileResponse["profiles"][number];

type ProfileListState =
  | { status: "loading" }
  | { status: "ready"; profiles: ProfileSummary[] }
  | { status: "error" };

const authenticationCodes = new Set([
  "profile_required",
  "invalid_profile_credentials",
  "profile_disabled",
]);

const isAuthenticationFailure = (reason: unknown): reason is ApiError =>
  reason instanceof ApiError && authenticationCodes.has(reason.code);

const isRevisionConflict = (reason: unknown): reason is ApiError =>
  reason instanceof ApiError &&
  (reason.code === "revision_conflict" || reason.code === "project_revision_conflict");

const isAbortFailure = (reason: unknown): boolean =>
  reason instanceof DOMException
    ? reason.name === "AbortError"
    : reason instanceof Error && reason.name === "AbortError";

const actionLabels: Record<ActionKind, string> = {
  claim: "Claim task",
  renew: "Renew claim",
  checkpoint: "Add checkpoint",
  pause: "Pause claim",
  release: "Release claim",
  switch: "Switch task",
  delegate: "Delegate task",
  accept: "Accept delegation",
  revoke: "Revoke delegation",
  submit: "Submit result",
};

const dialogVerbs: Record<ActionKind, string> = {
  claim: "Claim",
  renew: "Renew claim for",
  checkpoint: "Checkpoint",
  pause: "Pause",
  release: "Release",
  switch: "Switch from",
  delegate: "Delegate",
  accept: "Accept delegation for",
  revoke: "Revoke delegation for",
  submit: "Submit",
};

const confirmationLabels: Record<ActionKind, string> = {
  claim: "Confirm claim",
  renew: "Confirm renewal",
  checkpoint: "Save checkpoint",
  pause: "Confirm pause",
  release: "Confirm release",
  switch: "Confirm switch",
  delegate: "Offer delegation",
  accept: "Confirm acceptance",
  revoke: "Confirm revocation",
  submit: "Confirm submission",
};

const parseLines = (value: FormDataEntryValue | null): string[] => [
  ...new Set(
    String(value ?? "")
      .split(/\r?\n/)
      .map((entry) => entry.trim())
      .filter(Boolean),
  ),
].sort();

const checkpointFromForm = (form: FormData) => ({
  summary: String(form.get("summary") ?? "").trim(),
  completedWork: parseLines(form.get("completedWork")),
  remainingWork: parseLines(form.get("remainingWork")),
  blockers: parseLines(form.get("blockers")),
  verificationEvidence: {
    tests: parseLines(form.get("tests")),
    artifacts: parseLines(form.get("artifacts")),
  },
  repositoryEvidence: null,
});

const idempotencyKey = (): string => {
  const suffix = typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `work-queue-${suffix}`;
};

const safeErrorMessage = (
  reason: unknown,
  credentials: ProfileCredentials,
  fallback: string,
): string => {
  if (!(reason instanceof ApiError)) return fallback;
  if (
    reason.message.includes(credentials.token) ||
    reason.message.includes(credentials.profileId)
  ) return fallback;
  return reason.message;
};

const leaseText = (expiresAt: string, now: number): string => {
  const remaining = Date.parse(expiresAt) - now;
  if (remaining <= 0) return "Lease expired · refresh to recover";
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"} remaining`;
};

const blockerExplanation = (blocker: string): string => {
  const separator = blocker.indexOf(":");
  if (separator < 0) return blocker;
  const code = blocker.slice(0, separator);
  const reference = blocker.slice(separator + 1);
  const explanations: Record<string, string> = {
    dependency_cycle: `Dependency cycle includes ${reference}.`,
    dependency_missing: `Dependency ${reference} is missing.`,
    dependency_not_task: `Dependency ${reference} is not a task.`,
    dependency_incomplete: `Dependency ${reference} is not completed.`,
    claim_active: `Active claim ${reference} currently owns this task.`,
    claim_submitted: `Submitted claim ${reference} is awaiting reconciliation.`,
    delegation_live: `Delegation ${reference} is active for this task.`,
  };
  return explanations[code] ?? blocker;
};

type ParsedMutationResult = {
  claim?: NonNullable<CoordinationStateResponse["claim"]>;
  nextClaim?: NonNullable<CoordinationStateResponse["claim"]>;
  delegation?: NonNullable<CoordinationStateResponse["delegation"]>;
  checkpoint?: NonNullable<CoordinationStateResponse["latestCheckpoint"]>;
  submission?: NonNullable<CoordinationStateResponse["submission"]>;
};

const stateReadConcurrency = 4;
const maximumReadyPages = 100;
const maximumReadyTasks = 10_000;
const delegationOutputOptions = [
  ["create_record", "Create records"],
  ["create_relationship", "Create relationships"],
  ["remove_relationship", "Remove relationships"],
  ["update_record", "Update records"],
] as const;

const mapWithConcurrency = async <Item, Result>(
  items: readonly Item[],
  limit: number,
  controller: AbortController,
  map: (item: Item) => Promise<Result>,
): Promise<Result[]> => {
  const results = new Array<Result>(items.length);
  let nextIndex = 0;
  const failures: unknown[] = [];
  const worker = async () => {
    while (!controller.signal.aborted && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = await map(items[index]!);
      } catch (reason) {
        if (failures.length === 0) {
          failures.push(reason);
          controller.abort();
        }
        return;
      }
    }
  };
  await Promise.allSettled(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  if (failures.length > 0) throw failures[0];
  if (controller.signal.aborted) {
    throw new DOMException("The work queue load was aborted.", "AbortError");
  }
  return results;
};

const reconcileParsedMutationResult = (
  state: CoordinationStateResponse,
  parsed: unknown,
): CoordinationStateResponse => {
  const result = parsed as ParsedMutationResult;
  const overlaidClaim = result.nextClaim ?? result.claim;
  if (
    overlaidClaim !== undefined &&
    (overlaidClaim.taskId !== state.task.id || overlaidClaim.projectId !== state.task.projectId)
  ) {
    throw new Error("Mutation result claim does not match the selected task.");
  }
  if (overlaidClaim === undefined) {
    return coordinationStateResponseSchema.parse({
      ...state,
      delegation: result.delegation?.taskId === state.task.id
        ? result.delegation
        : state.delegation,
      latestCheckpoint: result.checkpoint ?? state.latestCheckpoint,
      submission: result.submission?.taskId === state.task.id
        ? result.submission
        : state.submission,
    });
  }
  const exactClaim = overlaidClaim;

  const checkpointCandidates = result.nextClaim === undefined && result.checkpoint !== undefined
    ? [result.checkpoint, state.latestCheckpoint]
    : [state.latestCheckpoint];
  const exactCheckpoint = checkpointCandidates.find((candidate) =>
    candidate?.claimId === exactClaim.id &&
    exactClaim.latestCheckpointId === candidate.id
  ) ?? null;
  if (
    result.nextClaim === undefined && result.checkpoint !== undefined &&
    exactCheckpoint !== result.checkpoint
  ) {
    throw new Error("Mutation result checkpoint does not match its claim.");
  }

  const delegationCandidates = [result.delegation, state.delegation];
  const exactDelegation = exactClaim.delegationId === null
    ? null
    : delegationCandidates.find((candidate) =>
        candidate?.taskId === state.task.id &&
        candidate.projectId === state.task.projectId &&
        candidate.id === exactClaim.delegationId &&
        candidate.claimId === exactClaim.id
      ) ?? null;

  const submissionCandidates = [result.submission, state.submission];
  const exactSubmission = submissionCandidates.find((candidate) =>
    candidate?.taskId === state.task.id &&
    candidate.projectId === state.task.projectId &&
    candidate.claimId === exactClaim.id &&
    candidate.profileId === exactClaim.profileId &&
    candidate.contextPackId === exactClaim.contextPackId &&
    candidate.checkpointId === exactCheckpoint?.id
  ) ?? null;
  if (result.submission !== undefined && exactSubmission !== result.submission) {
    throw new Error("Mutation result submission does not match its claim lineage.");
  }

  return coordinationStateResponseSchema.parse({
    ...state,
    claim: exactClaim,
    delegation: exactDelegation,
    latestCheckpoint: exactCheckpoint,
    submission: exactSubmission,
  });
};

function TextLinesField({
  label,
  name,
  required = false,
}: {
  label: string;
  name: string;
  required?: boolean;
}) {
  return (
    <div className="field">
      <label htmlFor={`work-${name}`}>{label}</label>
      <textarea
        id={`work-${name}`}
        name={name}
        required={required}
        rows={2}
        placeholder="One item per line"
      />
    </div>
  );
}

function CheckpointFields() {
  return (
    <fieldset className="work-dialog__fieldset">
      <legend>Checkpoint evidence</legend>
      <div className="field">
        <label htmlFor="work-summary">Summary</label>
        <textarea id="work-summary" name="summary" required rows={3} />
      </div>
      <TextLinesField label="Completed work" name="completedWork" />
      <TextLinesField label="Remaining work" name="remainingWork" />
      <TextLinesField label="Blockers" name="blockers" />
      <TextLinesField label="Tests" name="tests" />
      <TextLinesField label="Artifacts" name="artifacts" />
    </fieldset>
  );
}

function WorkDialog({
  dialog,
  state,
  queue,
  busy,
  error,
  acceptedDelegationIds,
  onClose,
  onSubmit,
}: {
  dialog: ActionDialogState;
  state: CoordinationStateResponse;
  queue: CoordinationReadyResponse;
  busy: boolean;
  error: string | null;
  acceptedDelegationIds: Readonly<Record<string, string>>;
  onClose: () => void;
  onSubmit: (form: FormData) => void;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const taskTitle = state.task.title;
  const title = `${dialogVerbs[dialog.kind]} ${taskTitle}`;

  useEffect(() => {
    cancelRef.current?.focus();
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialogElement = dialogRef.current;
      const controls = dialogElement?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!dialogElement || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialogElement.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", keepFocusInside);
    return () => window.removeEventListener("keydown", keepFocusInside);
  }, [busy, onClose]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(new FormData(event.currentTarget));
  };

  const otherTasks = queue.tasks.filter(({ task, blockers }) => {
    if (task.id === state.task.id) return false;
    const acceptedDelegationId = acceptedDelegationIds[task.id];
    return blockers.length === 0 || (
      acceptedDelegationId !== undefined &&
      blockers.every((blocker) => blocker === `delegation_live:${acceptedDelegationId}`)
    );
  });

  return (
    <div className="project-dialog-layer work-dialog-layer">
      <button
        className="project-dialog-scrim"
        type="button"
        aria-label="Cancel"
        disabled={busy}
        onClick={onClose}
      />
      <section
        ref={dialogRef}
        className="project-dialog work-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <header className="project-dialog__header">
          <div>
            <p className="stage__eyebrow">Coordinated action</p>
            <h2 id={titleId}>{title}</h2>
          </div>
        </header>
        <form className="project-dialog__form" onSubmit={submit}>
          {dialog.kind === "claim"
            ? (
                <div className="field">
                  <label htmlFor="work-context-budget">Context budget (tokens)</label>
                  <input
                    id="work-context-budget"
                    name="contextBudgetTokens"
                    type="number"
                    min="1"
                    defaultValue="4096"
                    required
                  />
                </div>
              )
            : null}
          {dialog.kind === "checkpoint" || dialog.kind === "switch"
            ? <CheckpointFields />
            : null}
          {dialog.kind === "switch"
            ? (
                <>
                  <div className="field">
                    <label htmlFor="work-next-task">Next task</label>
                    <select id="work-next-task" name="nextTaskId" required>
                      {otherTasks.map(({ task: candidate }) => (
                        <option key={candidate.id} value={candidate.id}>
                          {candidate.title}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="work-terminal-action">Current claim outcome</label>
                    <select id="work-terminal-action" name="terminalAction">
                      <option value="pause">Pause current claim</option>
                      <option value="release">Release current claim</option>
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor="work-next-budget">Next context budget (tokens)</label>
                    <input
                      id="work-next-budget"
                      name="nextContextBudgetTokens"
                      type="number"
                      min="1"
                      defaultValue="4096"
                      required
                    />
                  </div>
                  <p className="work-dialog__warning">
                    Confirming atomically checkpoints this task, changes its claim,
                    and claims the selected next task.
                  </p>
                </>
              )
            : null}
          {dialog.kind === "delegate"
            ? (
                <>
                  <div className="field">
                    <label htmlFor="work-child-profile">Child profile ID</label>
                    <input id="work-child-profile" name="childProfileId" required />
                  </div>
                  <div className="field">
                    <label htmlFor="work-scope-summary">Delegation scope</label>
                    <textarea id="work-scope-summary" name="scopeSummary" required />
                  </div>
                  <TextLinesField label="Constraints" name="constraints" />
                  <fieldset className="work-dialog__fieldset">
                    <legend>Allowed outputs</legend>
                    {delegationOutputOptions.map(([value, label]) => (
                      <label key={value}>
                        <input type="checkbox" name="allowedOutputs" value={value} />
                        {label} ({value})
                      </label>
                    ))}
                  </fieldset>
                  <div className="field">
                    <label htmlFor="work-deadline">Deadline</label>
                    <input id="work-deadline" name="deadline" type="datetime-local" required />
                  </div>
                </>
              )
            : null}
          {dialog.kind === "submit"
            ? (
                <>
                  <div className="field">
                    <label htmlFor="work-submission-summary">Result summary</label>
                    <textarea id="work-submission-summary" name="summary" required />
                  </div>
                  <TextLinesField label="Tests" name="tests" />
                  <TextLinesField label="Artifacts" name="artifacts" />
                  <div className="field">
                    <label htmlFor="work-rationale">Change rationale</label>
                    <textarea id="work-rationale" name="rationale" required />
                  </div>
                  <div className="field">
                    <label htmlFor="work-operations">Additional operations (JSON array)</label>
                    <textarea id="work-operations" name="operations" defaultValue="[]" required />
                  </div>
                  <p className="work-dialog__warning">
                    Confirming submits immutable evidence and creates a governed proposal.
                    It does not accept or apply the proposal.
                  </p>
                </>
              )
            : null}
          {dialog.kind === "release"
            ? (
                <p className="work-dialog__warning">
                  Releasing ends this claim and makes eligible work available to another profile.
                </p>
              )
            : null}
          {dialog.kind === "revoke"
            ? (
                <p className="work-dialog__warning">
                  Revoking ends this delegation. The child cannot accept or claim it afterward.
                </p>
              )
            : null}
          {error ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="project-dialog__actions">
            <button
              ref={cancelRef}
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="primary-action" type="submit" disabled={busy}>
              {busy ? "Working…" : confirmationLabels[dialog.kind]}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}

function QueueGroup({
  title,
  items,
  selectedTaskId,
  onSelect,
}: {
  title: string;
  items: CoordinationReadyResponse["tasks"];
  selectedTaskId: string | null;
  onSelect: (taskId: string) => void;
}) {
  return (
    <section className="work-queue__group" aria-label={title}>
      <h2>{title}</h2>
      {items.length === 0
        ? <p className="work-queue__muted">No tasks in this group.</p>
        : (
            <ul className="work-list">
              {items.map((item) => (
                <li key={item.task.id} data-selected={selectedTaskId === item.task.id}>
                  <button type="button" onClick={() => onSelect(item.task.id)}>
                    <span>
                      <strong>{item.task.title}</strong>
                      <small>Revision {item.task.revision}</small>
                    </span>
                    <StatusChip tone={item.blockers.length === 0 ? "active" : "attention"}>
                      {item.blockers.length === 0 ? "Ready" : "Blocked"}
                    </StatusChip>
                  </button>
                  {item.blockers.length > 0
                    ? (
                        <ul className="work-list__blockers" aria-label={`Blockers for ${item.task.title}`}>
                          {item.blockers.map((blocker) => (
                            <li key={blocker}>{blockerExplanation(blocker)}</li>
                          ))}
                        </ul>
                      )
                    : null}
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

export function WorkQueue({
  projectId,
  projectRevision,
  initialTaskId = null,
  desktopAiAvailable = false,
  ownerSummary,
}: WorkQueueProps) {
  const [workState, setWorkState] = useState<WorkQueueState>({ status: "signed-out" });
  const [queue, setQueue] = useState<CoordinationReadyResponse | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(initialTaskId);
  const [dialog, setDialog] = useState<ActionDialogState | null>(null);
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [advancedAccessOpen, setAdvancedAccessOpen] = useState(false);
  const [profileIdDraft, setProfileIdDraft] = useState("");
  const [profileListState, setProfileListState] = useState<ProfileListState>({
    status: "loading",
  });
  const profileDiscoveryEnabled = ownerSummary !== undefined;
  const [now, setNow] = useState(() => Date.now());
  const [acceptedDelegationIds, setAcceptedDelegationIds] = useState<
    Readonly<Record<string, string>>
  >({});
  const credentialsRef = useRef<ProfileCredentials | null>(null);
  const controllersRef = useRef(new Set<AbortController>());
  const mountedRef = useRef(false);
  const requestGenerationRef = useRef(0);
  const loadGenerationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const loadControllerRef = useRef<AbortController | null>(null);
  const preferredTaskIdRef = useRef<string | null>(initialTaskId);
  const openerRef = useRef<HTMLElement | null>(null);
  const successOpenerRef = useRef<HTMLElement | null>(null);
  const successActionKindRef = useRef<ActionKind | null>(null);
  const noticeRef = useRef<HTMLParagraphElement | null>(null);
  const selectedHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const expectedProjectRevisionRef = useRef(projectRevision);
  const revisionRecoveryRef = useRef(false);
  const tokenInputRef = useRef<HTMLInputElement>(null);

  const request = async <Result,>(
    path: string,
    credentials: ProfileCredentials,
    init: RequestInit = {},
    suppliedController?: AbortController,
  ): Promise<Result> => {
    const controller = suppliedController ?? new AbortController();
    const ownsController = suppliedController === undefined;
    if (ownsController) controllersRef.current.add(controller);
    try {
      return await apiRequest<Result>(path, { ...init, signal: controller.signal }, credentials);
    } finally {
      if (ownsController) controllersRef.current.delete(controller);
    }
  };

  const clearCredentials = () => {
    credentialsRef.current = null;
  };

  const abortRequests = () => {
    loadControllerRef.current?.abort();
    for (const controller of controllersRef.current) controller.abort();
  };

  const invalidateRequests = () => {
    requestGenerationRef.current += 1;
    loadGenerationRef.current += 1;
    mutationGenerationRef.current += 1;
    abortRequests();
  };

  const isCurrentRequest = (generation: number): boolean =>
    mountedRef.current && requestGenerationRef.current === generation;

  const beginLoad = () => {
    loadControllerRef.current?.abort();
    const controller = new AbortController();
    const generation = loadGenerationRef.current + 1;
    loadGenerationRef.current = generation;
    loadControllerRef.current = controller;
    controllersRef.current.add(controller);
    return { controller, generation };
  };

  const ownsCurrentLoad = (
    requestGeneration: number,
    loadGeneration: number,
    controller: AbortController,
  ): boolean =>
    isCurrentRequest(requestGeneration) &&
    loadGenerationRef.current === loadGeneration &&
    loadControllerRef.current === controller;

  const isCurrentLoad = (
    requestGeneration: number,
    loadGeneration: number,
    controller: AbortController,
  ): boolean =>
    ownsCurrentLoad(requestGeneration, loadGeneration, controller) &&
    !controller.signal.aborted;

  const queryState = async (
    credentials: ProfileCredentials,
    taskId: string,
    expectedProjectRevision: number,
    controller?: AbortController,
  ): Promise<CoordinationStateResponse> => {
    const query = new URLSearchParams({
      taskId,
      expectedProjectRevision: String(expectedProjectRevision),
    });
    const raw = await request<unknown>(
      `${apiPath("projects", projectId, "coordination", "state")}?${query}`,
      credentials,
      {},
      controller,
    );
    return coordinationStateResponseSchema.parse(raw);
  };

  const loadQueue = async (
    credentials: ProfileCredentials,
    preferredTaskId: string | null = preferredTaskIdRef.current,
  ): Promise<CoordinationStateResponse | null> => {
    const requestGeneration = requestGenerationRef.current;
    if (!isCurrentRequest(requestGeneration)) return null;
    const { controller, generation: loadGeneration } = beginLoad();
    credentialsRef.current = credentials;
    setWorkState({ status: "loading", credentials });
    try {
      const tasks: CoordinationReadyResponse["tasks"] = [];
      const seenTaskIds = new Set<string>();
      const seenCursors = new Set<string>();
      let cursor: string | null = null;
      let queueRevision: number | null = null;
      let pageCount = 0;
      const expectedRevision = expectedProjectRevisionRef.current;
      do {
        if (pageCount >= maximumReadyPages) {
          throw new Error("Ready-task pagination exceeded its page limit.");
        }
        pageCount += 1;
        const query = new URLSearchParams({
          expectedProjectRevision: String(expectedRevision),
          limit: "100",
          ...(cursor === null ? {} : { cursor }),
        });
        const rawPage = await request<unknown>(
          `${apiPath("projects", projectId, "coordination", "ready")}?${query}`,
          credentials,
          {},
          controller,
        );
        const page = coordinationReadyResponseSchema.parse(rawPage);
        if (!isCurrentLoad(requestGeneration, loadGeneration, controller)) return null;
        if (queueRevision !== null && page.projectRevision !== queueRevision) {
          throw new Error("Ready-task pages changed project revision.");
        }
        queueRevision = page.projectRevision;
        if (tasks.length + page.tasks.length > maximumReadyTasks) {
          throw new Error("Ready-task pagination exceeded its task limit.");
        }
        for (const item of page.tasks) {
          if (seenTaskIds.has(item.task.id)) {
            throw new Error("Ready-task pages repeated a task.");
          }
          seenTaskIds.add(item.task.id);
          tasks.push(item);
        }
        cursor = page.nextCursor;
        if (cursor !== null) {
          if (seenCursors.has(cursor)) throw new Error("Ready-task pagination repeated a cursor.");
          seenCursors.add(cursor);
        }
      } while (cursor !== null);
      const nextQueue: CoordinationReadyResponse = {
        projectRevision: queueRevision ?? expectedRevision,
        tasks,
        nextCursor: null,
      };
      if (!isCurrentLoad(requestGeneration, loadGeneration, controller)) return null;
      const delegationStates = new Map<string, CoordinationStateResponse>();
      const nextAcceptedDelegationIds: Record<string, string> = {};
      const delegationCandidates = await mapWithConcurrency(
        nextQueue.tasks.filter((item) => item.liveDelegationId !== null),
        stateReadConcurrency,
        controller,
        async (item) => ({
          item,
          state: await queryState(
            credentials,
            item.task.id,
            nextQueue.projectRevision,
            controller,
          ),
        }),
      );
      for (const { item, state: candidateState } of delegationCandidates) {
        if (!isCurrentLoad(requestGeneration, loadGeneration, controller)) return null;
        delegationStates.set(item.task.id, candidateState);
        if (
          candidateState.delegation?.id === item.liveDelegationId &&
          candidateState.delegation.state === "accepted" &&
          candidateState.delegation.childProfileId === credentials.profileId
        ) {
          nextAcceptedDelegationIds[item.task.id] = item.liveDelegationId;
        }
      }
      setAcceptedDelegationIds(nextAcceptedDelegationIds);
      setQueue(nextQueue);
      if (nextQueue.tasks.length === 0) {
        setWorkState({ status: "empty", credentials });
        return null;
      }
      const latestPreferredTaskId = preferredTaskIdRef.current ?? preferredTaskId;
      const taskId = nextQueue.tasks.some(({ task }) => task.id === latestPreferredTaskId)
        ? latestPreferredTaskId!
        : nextQueue.tasks[0]!.task.id;
      preferredTaskIdRef.current = taskId;
      setSelectedTaskId(taskId);
      if (taskId !== latestPreferredTaskId) {
        replaceRoute(
          `/projects/${encodeURIComponent(projectId)}/work?taskId=${encodeURIComponent(taskId)}`,
        );
      }
      const data = delegationStates.get(taskId) ?? await queryState(
        credentials,
        taskId,
        nextQueue.projectRevision,
        controller,
      );
      if (!isCurrentLoad(requestGeneration, loadGeneration, controller)) return null;
      setWorkState({ status: "ready", credentials, data });
      return data;
    } catch (reason) {
      if (
        isAbortFailure(reason) ||
        !ownsCurrentLoad(requestGeneration, loadGeneration, controller)
      ) return null;
      const authenticationFailed = isAuthenticationFailure(reason);
      const revisionConflict = isRevisionConflict(reason);
      revisionRecoveryRef.current = revisionConflict;
      if (!revisionConflict) {
        clearCredentials();
        setAdvancedAccessOpen(true);
      }
      setWorkState({
        status: "error",
        credentials: revisionConflict ? credentials : null,
        message: safeErrorMessage(
          reason,
          credentials,
          authenticationFailed
            ? "Authentication failed. Enter profile credentials again."
            : "Could not load the Work Queue. Enter profile credentials again to retry.",
        ),
      });
      return null;
    } finally {
      controllersRef.current.delete(controller);
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    }
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      invalidateRequests();
      clearCredentials();
    };
  }, []);

  useEffect(() => {
    if (!profileDiscoveryEnabled) {
      setProfileListState({ status: "ready", profiles: [] });
      return;
    }
    const controller = new AbortController();
    setProfileListState({ status: "loading" });
    apiRequest<SanitizedProfileResponse>("/api/profiles", {
      signal: controller.signal,
    }).then(
      (response) => {
        if (controller.signal.aborted || !mountedRef.current) return;
        const profiles = Array.isArray(response.profiles)
          ? response.profiles.filter((profile) =>
              profile.status === "enabled" &&
              Array.isArray(profile.projectIds) &&
              profile.projectIds.includes(projectId)
            )
          : [];
        setProfileListState({ status: "ready", profiles });
      },
      () => {
        if (controller.signal.aborted || !mountedRef.current) return;
        setProfileListState({ status: "error" });
      },
    );
    return () => controller.abort();
  }, [profileDiscoveryEnabled, projectId]);

  useEffect(() => {
    invalidateRequests();
    clearCredentials();
    setAdvancedAccessOpen(false);
    setProfileIdDraft("");
    setWorkState({ status: "signed-out" });
    expectedProjectRevisionRef.current = projectRevision;
    revisionRecoveryRef.current = false;
    setQueue(null);
    setAcceptedDelegationIds({});
    preferredTaskIdRef.current = initialTaskId;
    setSelectedTaskId(initialTaskId);
    setDialog(null);
    setNotice(null);
  }, [projectId]);

  useEffect(() => {
    expectedProjectRevisionRef.current = projectRevision;
  }, [projectRevision]);

  const activeClaimExpiry = workState.status === "ready" &&
      workState.data.claim?.state === "active"
    ? workState.data.claim.expiresAt
    : null;
  useEffect(() => {
    if (activeClaimExpiry === null) return;
    const remaining = Date.parse(activeClaimExpiry) - Date.now();
    if (remaining <= 0) return;
    const untilMinuteChanges = remaining % 60_000 || 60_000;
    const timer = window.setTimeout(
      () => setNow(Date.now()),
      Math.min(remaining, untilMinuteChanges) + 1,
    );
    return () => window.clearTimeout(timer);
  }, [activeClaimExpiry, now]);

  useEffect(() => {
    if (notice === null) return;
    const opener = successOpenerRef.current;
    const actionKind = successActionKindRef.current;
    successOpenerRef.current = null;
    successActionKindRef.current = null;
    queueMicrotask(() => {
      if (
        opener?.isConnected && !opener.hasAttribute("disabled") &&
        opener.dataset.workActionKind === actionKind
      ) {
        opener.focus();
        return;
      }
      (noticeRef.current ?? selectedHeadingRef.current)?.focus();
    });
  }, [notice]);

  const signIn = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const credentials = {
      profileId: String(form.get("profileId") ?? "").trim(),
      token: String(form.get("token") ?? ""),
    };
    event.currentTarget.reset();
    setProfileIdDraft("");
    invalidateRequests();
    void loadQueue(credentials, preferredTaskIdRef.current);
  };

  const authenticateAs = (profileId: string) => {
    setProfileIdDraft(profileId);
    setAdvancedAccessOpen(true);
    queueMicrotask(() => tokenInputRef.current?.focus());
  };

  const recoverProjectRevision = async (credentials: ProfileCredentials) => {
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    controllersRef.current.add(controller);
    setWorkState({ status: "loading", credentials });
    try {
      const { projects } = await apiRequest<ProjectHubResponse>(
        "/api/projects",
        { signal: controller.signal },
      );
      if (!isCurrentRequest(generation)) return;
      const project = projects.find(({ project: candidate }) => candidate.id === projectId)?.project;
      if (!project || !Number.isSafeInteger(project.revision) || project.revision < 0) {
        throw new Error("Current project state is unavailable.");
      }
      expectedProjectRevisionRef.current = project.revision;
      revisionRecoveryRef.current = false;
      await loadQueue(credentials, preferredTaskIdRef.current);
    } catch (reason) {
      if (isAbortFailure(reason) || !isCurrentRequest(generation)) return;
      invalidateRequests();
      clearCredentials();
      setAdvancedAccessOpen(true);
      setWorkState({
        status: "error",
        credentials: null,
        message: safeErrorMessage(
          reason,
          credentials,
          isAuthenticationFailure(reason)
            ? "Authentication failed. Enter profile credentials again."
            : "Could not recover current project state. Enter profile credentials again or return to the project home.",
        ),
      });
    } finally {
      controllersRef.current.delete(controller);
    }
  };

  const selectTask = (taskId: string, updateRoute = true) => {
    preferredTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
    const credentials = credentialsRef.current;
    if (!credentials || !queue) return;
    const requestGeneration = requestGenerationRef.current;
    const { controller, generation: loadGeneration } = beginLoad();
    if (updateRoute) {
      navigate(
        `/projects/${encodeURIComponent(projectId)}/work?taskId=${encodeURIComponent(taskId)}`,
      );
    }
    setWorkState({ status: "loading", credentials });
    void queryState(credentials, taskId, queue.projectRevision, controller).then(
      (data) => {
        if (
          !isCurrentLoad(requestGeneration, loadGeneration, controller)
        ) return;
        setWorkState({ status: "ready", credentials, data });
      },
      (reason: unknown) => {
        if (
          isAbortFailure(reason) || !isCurrentRequest(requestGeneration) ||
          !isCurrentLoad(requestGeneration, loadGeneration, controller)
        ) return;
        invalidateRequests();
        clearCredentials();
        setAdvancedAccessOpen(true);
        setWorkState({
          status: "error",
          credentials: null,
          message: safeErrorMessage(
            reason,
            credentials,
            isAuthenticationFailure(reason)
              ? "Authentication failed. Enter profile credentials again."
              : "Could not load the selected task. Enter profile credentials again to retry.",
          ),
        });
      },
    ).finally(() => {
      controllersRef.current.delete(controller);
      if (loadControllerRef.current === controller) loadControllerRef.current = null;
    });
  };

  useEffect(() => {
    if (initialTaskId === preferredTaskIdRef.current) return;
    preferredTaskIdRef.current = initialTaskId;
    setSelectedTaskId(initialTaskId);
    const credentials = credentialsRef.current;
    if (credentials === null) return;
    if (queue === null) {
      void loadQueue(credentials, initialTaskId);
      return;
    }
    if (initialTaskId === null) {
      void loadQueue(credentials, null);
      return;
    }
    selectTask(initialTaskId, false);
  }, [initialTaskId]);

  const openDialog = (kind: ActionKind, opener: HTMLElement) => {
    const currentTask = workState.status === "ready" ? workState.data.task.id : "unknown";
    openerRef.current = opener;
    setDialog({
      kind,
      idempotencyKey: idempotencyKey(),
    });
    setDialogBusy(false);
    setDialogError(null);
    setNotice(null);
    opener.dataset.workActionTask = currentTask;
  };

  const closeDialog = () => {
    if (dialogBusy) return;
    setDialog(null);
    setDialogError(null);
    const opener = openerRef.current;
    openerRef.current = null;
    queueMicrotask(() => opener?.isConnected && opener.focus());
  };

  const refreshAfterMutation = async (
    credentials: ProfileCredentials,
    preferredTask: string,
  ): Promise<CoordinationStateResponse | null> => loadQueue(credentials, preferredTask);

  const commitMutationSelection = (kind: ActionKind, taskId: string) => {
    if (kind !== "switch") return;
    preferredTaskIdRef.current = taskId;
    setSelectedTaskId(taskId);
    navigate(
      `/projects/${encodeURIComponent(projectId)}/work?taskId=${encodeURIComponent(taskId)}`,
    );
  };

  const performMutation = async (form: FormData) => {
    if (workState.status !== "ready" || !dialog || !queue) return;
    const requestGeneration = requestGenerationRef.current;
    const mutationGeneration = mutationGenerationRef.current + 1;
    mutationGenerationRef.current = mutationGeneration;
    const credentials = workState.credentials;
    const current = workState.data;
    const claim = current.claim;
    const delegation = current.delegation;
    const attempt = dialog;
    let path = "";
    let body: unknown;
    let responseSchema: z.ZodType;
    let preferredTask = current.task.id;
    try {
      switch (attempt.kind) {
        case "claim":
          path = apiPath("projects", projectId, "coordination", "claims");
          body = coordinationClaimBodySchema.parse({
            projectId,
            taskId: current.task.id,
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            contextBudgetTokens: Number(form.get("contextBudgetTokens")),
            acceptedDelegationId: delegation?.state === "accepted" ? delegation.id : null,
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationClaimResponseSchema;
          break;
        case "renew":
          if (!claim) return;
          path = apiPath("projects", projectId, "coordination", "claims", claim.id, "renew");
          body = coordinationRenewBodySchema.parse({
            claimId: claim.id,
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationRenewResponseSchema;
          break;
        case "checkpoint":
          if (!claim) return;
          path = apiPath("projects", projectId, "coordination", "claims", claim.id, "checkpoints");
          body = coordinationCheckpointBodySchema.parse({
            claimId: claim.id,
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            checkpoint: checkpointFromForm(form),
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationCheckpointResponseSchema;
          break;
        case "pause":
        case "release":
          {
            const transitionClaimId = attempt.kind === "release" &&
                current.submission?.profileId === credentials.profileId &&
                ["conflicted", "rejected", "withdrawn"].includes(current.submission.state)
              ? current.submission.claimId
              : claim?.id;
            if (transitionClaimId === undefined) return;
            path = apiPath(
              "projects",
              projectId,
              "coordination",
              "claims",
              transitionClaimId,
              "transition",
            );
          body = coordinationTransitionBodySchema.parse({
            claimId: transitionClaimId,
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            action: attempt.kind,
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationTransitionResponseSchema;
          break;
          }
        case "switch": {
          if (!claim) return;
          const nextTaskId = String(form.get("nextTaskId") ?? "");
          const next = queue.tasks.find(({ task }) => task.id === nextTaskId)?.task;
          if (!next) throw new Error("Select another task before switching.");
          preferredTask = nextTaskId;
          path = apiPath("projects", projectId, "coordination", "switch");
          body = coordinationSwitchBodySchema.parse({
            currentClaimId: claim.id,
            projectId,
            currentTaskId: current.task.id,
            expectedCurrentProjectRevision: queue.projectRevision,
            expectedCurrentTaskRevision: current.task.revision,
            checkpoint: checkpointFromForm(form),
            terminalAction: String(form.get("terminalAction")),
            nextTaskId,
            expectedNextProjectRevision: queue.projectRevision,
            expectedNextTaskRevision: next.revision,
            nextContextBudgetTokens: Number(form.get("nextContextBudgetTokens")),
            acceptedDelegationId: acceptedDelegationIds[nextTaskId] ?? null,
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationSwitchResponseSchema;
          break;
        }
        case "delegate":
          path = apiPath("projects", projectId, "coordination", "delegations");
          body = coordinationCreateDelegationBodySchema.parse({
            projectId,
            taskId: current.task.id,
            childProfileId: String(form.get("childProfileId") ?? "").trim(),
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            scope: {
              summary: String(form.get("scopeSummary") ?? "").trim(),
              constraints: parseLines(form.get("constraints")),
            },
            allowedOutputs: form.getAll("allowedOutputs").map(String),
            deadline: new Date(String(form.get("deadline") ?? "")).toISOString(),
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationDelegationResponseSchema;
          break;
        case "accept":
        case "revoke":
          if (!delegation) return;
          path = apiPath(
            "projects",
            projectId,
            "coordination",
            "delegations",
            delegation.id,
            attempt.kind,
          );
          body = (attempt.kind === "accept"
            ? coordinationAcceptDelegationBodySchema
            : coordinationRevokeDelegationBodySchema).parse({
              delegationId: delegation.id,
              projectId,
              taskId: current.task.id,
              expectedProjectRevision: queue.projectRevision,
              expectedTaskRevision: current.task.revision,
              idempotencyKey: attempt.idempotencyKey,
            });
          responseSchema = coordinationDelegationResponseSchema;
          break;
        case "submit": {
          if (!claim || !current.latestCheckpoint) return;
          let operations: unknown;
          try {
            operations = JSON.parse(String(form.get("operations") ?? "[]"));
          } catch {
            throw new Error("Additional operations must be a JSON array.");
          }
          path = apiPath("projects", projectId, "coordination", "claims", claim.id, "submissions");
          body = coordinationSubmissionBodySchema.parse({
            claimId: claim.id,
            checkpointId: current.latestCheckpoint.id,
            expectedProjectRevision: queue.projectRevision,
            expectedTaskRevision: current.task.revision,
            submission: {
              summary: String(form.get("summary") ?? "").trim(),
              verificationEvidence: {
                tests: parseLines(form.get("tests")),
                artifacts: parseLines(form.get("artifacts")),
              },
              repositoryEvidence: null,
              changes: {
                rationale: String(form.get("rationale") ?? "").trim(),
                operations,
              },
            },
            idempotencyKey: attempt.idempotencyKey,
          });
          responseSchema = coordinationSubmissionResponseSchema;
          break;
        }
      }
    } catch (reason) {
      setDialogError(reason instanceof Error
        ? reason.message
        : "Review the action fields and try again.");
      return;
    }

    const serializedBody = JSON.stringify(body);
    setDialogBusy(true);
    setDialogError(null);
    try {
      const raw = await request<unknown>(path, credentials, {
        method: "POST",
        body: serializedBody,
      });
      if (
        !isCurrentRequest(requestGeneration) ||
        mutationGenerationRef.current !== mutationGeneration
      ) return;
      const parsedResult = responseSchema.parse(raw);
      commitMutationSelection(attempt.kind, preferredTask);
      const refreshed = await refreshAfterMutation(credentials, preferredTask);
      if (
        !isCurrentRequest(requestGeneration) ||
        mutationGenerationRef.current !== mutationGeneration
      ) return;
      if (refreshed !== null) {
        setWorkState({
          status: "ready",
          credentials,
          data: reconcileParsedMutationResult(refreshed, parsedResult),
        });
      }
      setDialogBusy(false);
      setDialog(null);
      successOpenerRef.current = openerRef.current;
      successActionKindRef.current = attempt.kind;
      openerRef.current = null;
      setNotice(`${actionLabels[attempt.kind]} completed. Coordination state refreshed.`);
    } catch (reason) {
      if (
        isAbortFailure(reason) || !isCurrentRequest(requestGeneration) ||
        mutationGenerationRef.current !== mutationGeneration
      ) return;
      if (isAuthenticationFailure(reason)) {
        invalidateRequests();
        clearCredentials();
        setAdvancedAccessOpen(true);
        setDialog(null);
        setDialogBusy(false);
        setWorkState({
          status: "error",
          credentials: null,
          message: safeErrorMessage(reason, credentials, "Authentication failed."),
        });
        return;
      }
      const ambiguous = !(reason instanceof ApiError) || reason.status >= 500;
      if (!ambiguous) {
        setDialogBusy(false);
        setDialogError(safeErrorMessage(reason, credentials, "The action was rejected."));
        return;
      }
      try {
        const replayed = await request<unknown>(path, credentials, {
          method: "POST",
          body: serializedBody,
        });
        if (
          !isCurrentRequest(requestGeneration) ||
          mutationGenerationRef.current !== mutationGeneration
        ) return;
        const parsedReplay = responseSchema.parse(replayed);
        commitMutationSelection(attempt.kind, preferredTask);
        const refreshed = await refreshAfterMutation(credentials, preferredTask);
        if (
          !isCurrentRequest(requestGeneration) ||
          mutationGenerationRef.current !== mutationGeneration
        ) return;
        if (refreshed !== null) {
          setWorkState({
            status: "ready",
            credentials,
            data: reconcileParsedMutationResult(refreshed, parsedReplay),
          });
        }
        setDialogBusy(false);
        setDialog(null);
        successOpenerRef.current = openerRef.current;
        successActionKindRef.current = attempt.kind;
        openerRef.current = null;
        setNotice(`${actionLabels[attempt.kind]} completed after an idempotent replay.`);
        return;
      } catch (replayReason) {
        if (
          isAbortFailure(replayReason) || !isCurrentRequest(requestGeneration) ||
          mutationGenerationRef.current !== mutationGeneration
        ) return;
        if (isAuthenticationFailure(replayReason)) {
          invalidateRequests();
          clearCredentials();
          setAdvancedAccessOpen(true);
          setDialog(null);
          setDialogBusy(false);
          setWorkState({
            status: "error",
            credentials: null,
            message: safeErrorMessage(replayReason, credentials, "Authentication failed."),
          });
          return;
        }
        setDialogBusy(false);
        setDialogError(
          `${actionLabels[attempt.kind]} could not be confirmed. ` +
            `${safeErrorMessage(replayReason, credentials, "The replay result was unavailable or invalid.")} ` +
            "You can retry this same request safely.",
        );
      }
    }
  };

  const signedOutError = workState.status === "error" && workState.credentials === null
    ? workState.message
    : null;
  if (workState.status === "signed-out" || signedOutError) {
    return (
      <article className="work-queue-screen work-queue-signin">
        <header className="work-queue__header">
          <div>
            <p className="stage__eyebrow">Project coordination · Profile bound</p>
            <h1>Agent Work Queue</h1>
            <p className="stage__lede">
              Review project work here. AI setup and profile access stay separate.
            </p>
          </div>
        </header>
        {ownerSummary
          ? (
              <section className="work-entry__summary" aria-labelledby="work-project-summary">
                <h2 id="work-project-summary">Project work</h2>
                <strong>{ownerSummary.projectName}</strong>
                <p>
                  {ownerSummary.taskCount} {ownerSummary.taskCount === 1 ? "task" : "tasks"}
                  {ownerSummary.currentTask
                    ? ` · Current: ${ownerSummary.currentTask.title} (${ownerSummary.currentTask.status})`
                    : " · No current task"}
                </p>
              </section>
            )
          : null}
        <section className="work-entry__profiles" aria-labelledby="work-profile-options">
          <h2 id="work-profile-options">Profiles</h2>
          {profileListState.status === "loading"
            ? <p role="status">Loading project profiles…</p>
            : profileListState.status === "error"
              ? <p className="work-queue__muted">Project profiles are unavailable.</p>
              : profileListState.profiles.length === 0
                ? <p className="work-queue__muted">No enabled profiles have access to this project.</p>
                : (
                    <ul className="work-entry__profile-list">
                      {profileListState.profiles.map((profile) => (
                        <li key={profile.profileId}>
                          <div>
                            <strong>{profile.name}</strong>
                            <small>
                              {`${profile.executionMode[0]!.toUpperCase()}${profile.executionMode.slice(1)} mode · Project access`}
                            </small>
                            <code>{profile.profileId}</code>
                          </div>
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => authenticateAs(profile.profileId)}
                          >Authenticate as {profile.name} ({profile.profileId})</button>
                        </li>
                      ))}
                    </ul>
                  )}
        </section>
        <div className="work-entry__setup">
          {desktopAiAvailable
            ? (
                <a
                  className="secondary-action"
                  href="/settings/ai"
                  onClick={(event) => {
                    if (
                      event.button !== 0 || event.metaKey || event.ctrlKey ||
                      event.shiftKey || event.altKey
                    ) return;
                    event.preventDefault();
                    navigate("/settings/ai");
                  }}
                >Set up AI connection</a>
              )
            : <p className="work-queue__muted">AI setup is unavailable in this browser session.</p>}
          <p className="work-queue__muted">
            An existing configured profile cannot be authenticated here without its separately held
            token.
          </p>
        </div>
        <details
          className="work-signin"
          open={advancedAccessOpen}
          onToggle={(event) => setAdvancedAccessOpen(event.currentTarget.open)}
        >
          <summary>Advanced access</summary>
          {advancedAccessOpen
            ? (
                <form aria-label="Profile credentials" onSubmit={signIn}>
                  <div className="field">
                    <label htmlFor="work-profile-id">Profile ID</label>
                    <input
                      id="work-profile-id"
                      name="profileId"
                      autoComplete="off"
                      value={profileIdDraft}
                      onChange={(event) => setProfileIdDraft(event.currentTarget.value)}
                      required
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="work-profile-token">Profile token</label>
                    <input
                      id="work-profile-token"
                      name="token"
                      ref={tokenInputRef}
                      type="password"
                      autoComplete="off"
                      required
                    />
                  </div>
                  {signedOutError ? <p className="form-error" role="alert">{signedOutError}</p> : null}
                  <button className="primary-action" type="submit">Open Work Queue</button>
                </form>
              )
            : null}
        </details>
      </article>
    );
  }

  if (workState.status === "loading" && queue === null) {
    return <AsyncState state="loading" message="Loading work queue…" />;
  }

  if (workState.status === "error") {
    const keepsRevisionRecoverySession = revisionRecoveryRef.current &&
      workState.credentials !== null;
    return (
      <AsyncState
        state="error"
        title="Could not load the Work Queue"
        message={keepsRevisionRecoverySession
          ? `${workState.message} Recovery reuses the current in-memory profile session. Sign out to discard it.`
          : workState.message}
        action={(
          keepsRevisionRecoverySession
            ? (
                <div className="work-actions">
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => workState.credentials &&
                      void recoverProjectRevision(workState.credentials)}
                  >Recover current project revision</button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={() => {
                      invalidateRequests();
                      clearCredentials();
                      revisionRecoveryRef.current = false;
                      setAdvancedAccessOpen(false);
                      setQueue(null);
                      setWorkState({ status: "signed-out" });
                    }}
                  >Sign out</button>
                </div>
              )
            : null
        )}
      />
    );
  }

  if (workState.status === "empty") {
    return (
      <article className="work-queue-screen">
        <header className="work-queue__header">
          <h1>Agent Work Queue</h1>
          <button
            className="secondary-action"
            type="button"
            onClick={() => {
              invalidateRequests();
              clearCredentials();
              setAdvancedAccessOpen(false);
              setQueue(null);
              setWorkState({ status: "signed-out" });
            }}
          >Sign out</button>
        </header>
        <AsyncState
          state="empty"
          title="No coordinated work"
          message="No active tasks are available to this profile at the current project revision."
          action={(
            <button
              className="secondary-action"
              type="button"
              onClick={() => void loadQueue(workState.credentials)}
            >Refresh work queue</button>
          )}
        />
      </article>
    );
  }

  const readyItems = queue?.tasks.filter(({ blockers }) => blockers.length === 0) ?? [];
  const dependencyBlockedItems = queue?.tasks.filter(({ blockers }) =>
    blockers.some((blocker) => blocker.startsWith("dependency_"))
  ) ?? [];
  const claimBlockedItems = queue?.tasks.filter(({ blockers }) =>
    !blockers.some((blocker) => blocker.startsWith("dependency_")) &&
    blockers.some((blocker) => blocker.startsWith("claim_"))
  ) ?? [];
  const delegationBlockedItems = queue?.tasks.filter(({ blockers }) =>
    !blockers.some((blocker) => blocker.startsWith("dependency_") || blocker.startsWith("claim_")) &&
    blockers.some((blocker) => blocker.startsWith("delegation_"))
  ) ?? [];
  const otherBlockedItems = queue?.tasks.filter(({ blockers }) => blockers.length > 0 &&
    !blockers.some((blocker) => blocker.startsWith("dependency_") ||
      blocker.startsWith("claim_") || blocker.startsWith("delegation_"))) ?? [];
  const data = workState.status === "ready" ? workState.data : null;
  const liveClaim = data?.claim !== null && data?.claim !== undefined &&
    (data.claim.state === "active" || data.claim.state === "submitted");
  const liveDelegation = data?.delegation !== null && data?.delegation !== undefined &&
    ["offered", "accepted", "claimed"].includes(data.delegation.state);
  const acceptedChildDelegation = data?.delegation?.childProfileId ===
    workState.credentials.profileId && data.delegation.state === "accepted";
  const selectedQueueItem = queue?.tasks.find(({ task }) => task.id === data?.task.id);
  const claimBlockers = selectedQueueItem?.blockers.filter((blocker) =>
    !acceptedChildDelegation || blocker !== `delegation_live:${data?.delegation?.id}`
  ) ?? [];
  const canClaim = selectedQueueItem !== undefined && claimBlockers.length === 0 &&
    !liveClaim && (!liveDelegation || acceptedChildDelegation);
  const canDelegate = selectedQueueItem?.blockers.length === 0 &&
    !liveClaim && !liveDelegation;
  const hasReadySwitchTarget = queue?.tasks.some(({ task, blockers }) =>
    task.id !== data?.task.id && (
      blockers.length === 0 || (
        acceptedDelegationIds[task.id] !== undefined &&
        blockers.every((blocker) =>
          blocker === `delegation_live:${acceptedDelegationIds[task.id]}`
        )
      )
    )
  ) ?? false;
  const activeClaimExpired = data?.claim?.state === "active" &&
    Date.parse(data.claim.expiresAt) <= now;
  const ownedActiveClaim = data?.claim?.profileId === workState.credentials.profileId &&
    data.claim.state === "active" && !activeClaimExpired;
  const ownedReleasableSubmission = data?.submission?.profileId ===
      workState.credentials.profileId &&
    ["conflicted", "rejected", "withdrawn"].includes(data.submission.state);
  const childOffer = data?.delegation?.childProfileId === workState.credentials.profileId &&
    data.delegation.state === "offered";
  const parentOffer = data?.delegation?.parentProfileId === workState.credentials.profileId &&
    (data.delegation.state === "offered" || data.delegation.state === "accepted");

  const actionButton = (kind: ActionKind): ReactNode => (
    <button
      className={kind === "submit" ? "primary-action" : "secondary-action"}
      data-work-action-kind={kind}
      type="button"
      onClick={(event) => openDialog(kind, event.currentTarget)}
    >
      {actionLabels[kind]}
    </button>
  );

  return (
    <article className="work-queue-screen">
      <header className="work-queue__header">
        <div>
          <p className="stage__eyebrow">Project coordination · Revision {queue?.projectRevision}</p>
          <h1>Agent Work Queue</h1>
          <p className="stage__lede">
            Claim, checkpoint, delegate, and submit bounded work. Authoritative
            changes still require proposal review.
          </p>
        </div>
        <button
          className="secondary-action"
          type="button"
          onClick={() => {
            invalidateRequests();
            clearCredentials();
            setAdvancedAccessOpen(false);
            setQueue(null);
            setWorkState({ status: "signed-out" });
          }}
        >
          Sign out
        </button>
      </header>
      {notice ? (
        <p
          className="work-queue__notice"
          role="status"
          aria-live="polite"
          ref={noticeRef}
          tabIndex={-1}
        >{notice}</p>
      ) : null}
      <div className="work-queue__layout">
        <nav className="work-queue__groups" aria-label="Work Queue tasks">
          <QueueGroup
            title="Ready now"
            items={readyItems}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
          <QueueGroup
            title="Blocked by dependencies"
            items={dependencyBlockedItems}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
          <QueueGroup
            title="Blocked by active claims"
            items={claimBlockedItems}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
          <QueueGroup
            title="Blocked by delegations"
            items={delegationBlockedItems}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
          <QueueGroup
            title="Other coordination blockers"
            items={otherBlockedItems}
            selectedTaskId={selectedTaskId}
            onSelect={selectTask}
          />
        </nav>
        <section className="work-details" aria-label="Selected work">
          {data === null
            ? <AsyncState state="loading" message="Loading selected task…" />
            : (
                <>
                  <header className="work-details__header">
                    <div>
                      <p className="stage__eyebrow">Selected task</p>
                      <h2 ref={selectedHeadingRef} tabIndex={-1}>{data.task.title}</h2>
                    </div>
                    <StatusChip tone={data.claim?.state === "active" ? "active" : "neutral"}>
                      {data.claim?.state ?? "unclaimed"}
                    </StatusChip>
                  </header>
                  <p>{data.task.body}</p>
                  <dl className="work-facts">
                    <div><dt>Task revision</dt><dd>{data.task.revision}</dd></div>
                    <div>
                      <dt>Ownership</dt>
                      <dd>{liveClaim ? `Owned by ${data.claim!.profileId}` : "No active owner"}</dd>
                    </div>
                    <div>
                      <dt>Lease</dt>
                      <dd>{liveClaim ? leaseText(data.claim!.expiresAt, now) : "No active lease"}</dd>
                    </div>
                    {data.claim !== null && !liveClaim
                      ? (
                          <div>
                            <dt>Claim history</dt>
                            <dd>
                              {`${data.claim.state[0]!.toUpperCase()}${data.claim.state.slice(1)} claim by ${data.claim.profileId}`}
                            </dd>
                          </div>
                        )
                      : null}
                  </dl>
                  {data.latestCheckpoint
                    ? (
                        <section className="work-evidence" aria-labelledby="latest-checkpoint">
                          <h3 id="latest-checkpoint">Latest checkpoint</h3>
                          <p>{data.latestCheckpoint.summary}</p>
                          <p>
                            Verification: {data.latestCheckpoint.verificationEvidence.tests.length > 0
                              ? data.latestCheckpoint.verificationEvidence.tests.join(", ")
                              : "No tests declared"}
                          </p>
                          {data.latestCheckpoint.blockers.length > 0
                            ? <p>Blockers: {data.latestCheckpoint.blockers.join(", ")}</p>
                            : <p>No checkpoint blockers declared.</p>}
                        </section>
                      )
                    : <p className="work-queue__muted">No checkpoint recorded.</p>}
                  {data.delegation
                    ? (
                        <section className="work-evidence" aria-labelledby="delegation-scope">
                          <h3 id="delegation-scope">Delegation scope</h3>
                          <p>{data.delegation.scope.summary}</p>
                          <p>State: {data.delegation.state}</p>
                          <p>Parent: {data.delegation.parentProfileId}</p>
                          <p>Child: {data.delegation.childProfileId}</p>
                          <p>Deadline: {data.delegation.deadline}</p>
                          <p>
                            Allowed outputs: {data.delegation.allowedOutputs.length > 0
                              ? data.delegation.allowedOutputs.join(", ")
                              : "None"}
                          </p>
                          {data.delegation.scope.constraints.map((constraint) => (
                            <p key={constraint}>Constraint: {constraint}</p>
                          ))}
                          {data.delegation.state === "expired" || data.delegation.state === "revoked"
                            ? (
                                <p>
                                  This delegation is {data.delegation.state}. Refresh coordination
                                  before taking further action.
                                </p>
                              )
                            : null}
                        </section>
                      )
                    : null}
                  {data.submission
                    ? (
                        <section className="work-evidence" aria-labelledby="submission-state">
                          <h3 id="submission-state">Submission</h3>
                          <p>
                            {data.submission.state === "submitted"
                              ? "Submitted · awaiting proposal review"
                              : `${data.submission.state} · proposal reconciliation recorded`}
                          </p>
                          <a
                            href={`/projects/${encodeURIComponent(projectId)}/proposals`}
                            onClick={(event) => {
                              if (
                                event.button !== 0 || event.metaKey || event.ctrlKey ||
                                event.shiftKey || event.altKey
                              ) return;
                              event.preventDefault();
                              navigate(`/projects/${encodeURIComponent(projectId)}/proposals`);
                            }}
                          >
                            Review proposal
                          </a>
                        </section>
                      )
                    : null}
                  <div className="work-actions" aria-label="Authorized actions">
                    {activeClaimExpired
                      ? (
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => void loadQueue(workState.credentials, data.task.id)}
                          >Refresh expired claim</button>
                        )
                      : null}
                    {data.delegation?.state === "expired" || data.delegation?.state === "revoked"
                      ? (
                          <button
                            className="secondary-action"
                            type="button"
                            onClick={() => void loadQueue(workState.credentials, data.task.id)}
                          >Refresh coordination</button>
                        )
                      : null}
                    {canClaim ? actionButton("claim") : null}
                    {ownedActiveClaim ? actionButton("renew") : null}
                    {ownedActiveClaim ? actionButton("checkpoint") : null}
                    {ownedActiveClaim ? actionButton("pause") : null}
                    {ownedActiveClaim || ownedReleasableSubmission
                      ? actionButton("release")
                      : null}
                    {ownedActiveClaim && hasReadySwitchTarget
                      ? actionButton("switch")
                      : null}
                    {canDelegate ? actionButton("delegate") : null}
                    {childOffer ? actionButton("accept") : null}
                    {parentOffer ? actionButton("revoke") : null}
                    {ownedActiveClaim && data.latestCheckpoint ? actionButton("submit") : null}
                  </div>
                </>
              )}
        </section>
      </div>
      {dialog && data && queue
        ? (
            <WorkDialog
              dialog={dialog}
              state={data}
              queue={queue}
              busy={dialogBusy}
              error={dialogError}
              acceptedDelegationIds={acceptedDelegationIds}
              onClose={closeDialog}
              onSubmit={(form) => void performMutation(form)}
            />
          )
        : null}
    </article>
  );
}
