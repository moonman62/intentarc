import {
  type FormEvent,
  type MouseEvent,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type {
  ChangeOperation,
  RecordReference,
} from "../../../domain/index.js";
import {
  apiPath,
  type ProposalAcceptResponse,
  type ProposalDetailDto,
  type ProposalDetailResponse,
  type ProposalListResponse,
  type ProposalRejectResponse,
  type ProposalSummaryDto,
} from "../../contracts.js";
import { apiRequest } from "../api.js";
import { AsyncState } from "../components/async-state.js";
import { StatusChip } from "../components/status-chip.js";
import { navigate } from "../router.js";

type ListState =
  | { status: "loading"; projectId: string }
  | { status: "error"; projectId: string; message: string }
  | { status: "ready"; projectId: string; proposals: ProposalSummaryDto[] };

type DetailState =
  | { status: "idle"; projectId: string }
  | { status: "loading"; projectId: string; proposalId: string }
  | {
      status: "error";
      projectId: string;
      proposalId: string;
      message: string;
    }
  | { status: "ready"; projectId: string; proposal: ProposalDetailDto };

type ReviewMode = "idle" | "accept" | "reject";

type DecisionNotice =
  | { tone: "status"; message: string }
  | { tone: "conflict"; message: string }
  | null;

const newestFirst = (
  left: ProposalSummaryDto,
  right: ProposalSummaryDto,
): number =>
  right.createdAt.localeCompare(left.createdAt) ||
  right.id.localeCompare(left.id);

const displayLabel = (value: string): string =>
  value.replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());

const proposalOriginPresentation = (
  origin: ProposalSummaryDto["origin"],
): { term: string; label: string } => {
  switch (origin.type) {
    case "profile":
      return { term: "Source profile", label: origin.profileId };
    case "repository_refresh":
      return { term: "Source", label: "Repository refresh" };
  }
};

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const formattedDate = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : dateTimeFormatter.format(date);
};

const followLink = (
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
): void => {
  if (
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) return;
  event.preventDefault();
  navigate(path);
};

const referenceLabel = (reference: RecordReference): string =>
  "localRef" in reference
    ? `Local reference ${reference.localRef}`
    : `Record ${reference.recordId}`;

function OperationField({
  label,
  children,
}: {
  label: string;
  children: string | number;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function OperationCard({
  operation,
  index,
}: {
  operation: ChangeOperation;
  index: number;
}) {
  const headingId = useId();

  return (
    <article
      className="operation-card"
      aria-labelledby={headingId}
      data-operation-kind={operation.type}
    >
      <header className="operation-card__header">
        <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div>
          <p>Proposed operation</p>
          <h3 id={headingId}>{displayLabel(operation.type)}</h3>
        </div>
      </header>
      <dl className="operation-fields">
        {operation.type === "create_record"
          ? (
              <>
                <OperationField label="Kind">
                  {displayLabel(operation.kind)}
                </OperationField>
                <OperationField label="Status">
                  {displayLabel(operation.status)}
                </OperationField>
                <OperationField label="Title">{operation.title}</OperationField>
                <OperationField label="Body">{operation.body}</OperationField>
                {operation.localRef
                  ? (
                      <OperationField label="Reference">
                        {`Local reference ${operation.localRef}`}
                      </OperationField>
                    )
                  : null}
              </>
            )
          : operation.type === "update_record"
            ? (
                <>
                  <OperationField label="Record">
                    {operation.recordId}
                  </OperationField>
                  <OperationField label="Expected revision">
                    {operation.expectedRecordRevision}
                  </OperationField>
                  {operation.patch.title
                    ? (
                        <OperationField label="New title">
                          {operation.patch.title}
                        </OperationField>
                      )
                    : null}
                  {operation.patch.status
                    ? (
                        <OperationField label="New status">
                          {displayLabel(operation.patch.status)}
                        </OperationField>
                      )
                    : null}
                  {operation.patch.body
                    ? (
                        <OperationField label="New body">
                          {operation.patch.body}
                        </OperationField>
                      )
                    : null}
                </>
              )
            : operation.type === "create_relationship"
              ? (
                  <>
                    <OperationField label="Relationship">
                      {displayLabel(operation.kind)}
                    </OperationField>
                    <OperationField label="From">
                      {referenceLabel(operation.from)}
                    </OperationField>
                    <OperationField label="To">
                      {referenceLabel(operation.to)}
                    </OperationField>
                  </>
                )
              : (
                  <OperationField label="Relationship">
                    {operation.relationshipId}
                  </OperationField>
                )}
      </dl>
    </article>
  );
}

function ProposalDetail({
  detail,
  mode,
  submitting,
  validationMessage,
  notice,
  actionError,
  onChooseMode,
  onCancelMode,
  onAccept,
  onReject,
}: {
  detail: ProposalDetailDto;
  mode: ReviewMode;
  submitting: boolean;
  validationMessage: string | null;
  notice: DecisionNotice;
  actionError: string | null;
  onChooseMode: (mode: Exclude<ReviewMode, "idle">) => void;
  onCancelMode: () => void;
  onAccept: () => void;
  onReject: (reason: string) => void;
}) {
  const rejectReasonId = useId();
  const rejectErrorId = useId();
  const acceptTriggerRef = useRef<HTMLButtonElement>(null);
  const rejectTriggerRef = useRef<HTMLButtonElement>(null);
  const acceptConfirmRef = useRef<HTMLButtonElement>(null);
  const rejectReasonRef = useRef<HTMLTextAreaElement>(null);
  const decisionNoticeRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<Exclude<ReviewMode, "idle"> | null>(null);

  useEffect(() => {
    if (mode === "accept") {
      acceptConfirmRef.current?.focus();
      return;
    }
    if (mode === "reject") {
      rejectReasonRef.current?.focus();
      return;
    }
    const restore = restoreFocusRef.current;
    if (!restore) return;
    restoreFocusRef.current = null;
    (restore === "accept"
      ? acceptTriggerRef.current
      : rejectTriggerRef.current)?.focus();
  }, [mode]);

  useEffect(() => {
    if (notice) {
      decisionNoticeRef.current?.focus();
      return;
    }
    if (validationMessage && mode === "reject") {
      rejectReasonRef.current?.focus();
      return;
    }
    if (!actionError) return;
    if (mode === "accept") {
      acceptConfirmRef.current?.focus();
    } else if (mode === "reject") {
      rejectReasonRef.current?.focus();
    }
  }, [actionError, mode, notice, validationMessage]);

  const chooseMode = (nextMode: Exclude<ReviewMode, "idle">) => {
    onChooseMode(nextMode);
  };

  const cancelMode = () => {
    restoreFocusRef.current = mode === "idle" ? null : mode;
    onCancelMode();
  };

  const reject = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const reason = String(
      new FormData(event.currentTarget).get("reason") ?? "",
    );
    onReject(reason);
  };

  return (
    <section
      className="proposal-detail"
      aria-labelledby="proposal-detail-heading"
    >
      <header className="proposal-detail__header">
        <div>
          <p className="proposal-detail__kicker">Review rationale</p>
          <h2 id="proposal-detail-heading">{detail.rationale}</h2>
        </div>
        <StatusChip tone={detail.state === "pending" ? "attention" : "neutral"}>
          {displayLabel(detail.state)}
        </StatusChip>
      </header>

      <dl className="proposal-facts">
        <div>
          <dt>{proposalOriginPresentation(detail.origin).term}</dt>
          <dd>{proposalOriginPresentation(detail.origin).label}</dd>
        </div>
        <div>
          <dt>Base revision</dt>
          <dd>Revision {detail.baseProjectRevision}</dd>
        </div>
        <div>
          <dt>Source task</dt>
          <dd>{detail.sourceTaskId ?? "Not linked"}</dd>
        </div>
        <div>
          <dt>Proposed</dt>
          <dd>{formattedDate(detail.createdAt)}</dd>
        </div>
      </dl>

      <section
        className="proposal-operations"
        aria-labelledby="proposal-operations-heading"
      >
        <div className="proposal-operations__heading">
          <p>Changes to inspect</p>
          <h2 id="proposal-operations-heading">Proposed operations</h2>
        </div>
        <div className="operation-list">
          {detail.operations.map((operation, index) => (
            <OperationCard
              key={operation.operationId}
              operation={operation}
              index={index}
            />
          ))}
        </div>
      </section>

      {notice
        ? (
            <div
              ref={decisionNoticeRef}
              className="proposal-decision-notice"
              role={notice.tone === "conflict" ? "alert" : "status"}
              data-tone={notice.tone}
              tabIndex={-1}
            >
              <strong>
                {notice.tone === "conflict"
                  ? "Proposal conflicted"
                  : "Review recorded"}
              </strong>
              <p>{notice.message}</p>
            </div>
          )
        : null}

      {detail.state === "pending" && !notice
        ? (
            <div className="proposal-review">
              {actionError
                ? (
                    <div className="proposal-action-error" role="alert">
                      <strong>Review not recorded</strong>
                      <p>{actionError}</p>
                    </div>
                  )
                : null}
              {mode === "idle"
                ? (
                    <>
                      <div>
                        <p className="proposal-review__label">Human decision</p>
                        <p>
                          Accept applies every operation together. Reject keeps
                          project knowledge unchanged.
                        </p>
                      </div>
                      <div className="proposal-review__choices">
                        <button
                          ref={acceptTriggerRef}
                          className="primary-action"
                          type="button"
                          onClick={() => chooseMode("accept")}
                        >
                          Accept proposal
                        </button>
                        <button
                          ref={rejectTriggerRef}
                          className="secondary-action"
                          type="button"
                          onClick={() => chooseMode("reject")}
                        >
                          Reject proposal
                        </button>
                      </div>
                    </>
                  )
                : mode === "accept"
                  ? (
                      <div className="proposal-confirmation">
                        <div>
                          <p className="proposal-review__label">
                            Human decision
                          </p>
                          <h3>Confirm acceptance</h3>
                          <p>
                            Apply all proposed operations to the current project
                            archive?
                          </p>
                        </div>
                        <div className="proposal-confirmation__actions">
                          <button
                            ref={acceptConfirmRef}
                            className="primary-action"
                            type="button"
                            disabled={submitting}
                            onClick={onAccept}
                          >
                            {submitting ? "Accepting…" : "Confirm accept"}
                          </button>
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={submitting}
                            onClick={cancelMode}
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )
                  : (
                      <form
                        className="proposal-rejection"
                        noValidate
                        onSubmit={reject}
                      >
                        <div className="field">
                          <label htmlFor={rejectReasonId}>
                            Reason for rejection
                          </label>
                          <textarea
                            ref={rejectReasonRef}
                            id={rejectReasonId}
                            name="reason"
                            maxLength={2_000}
                            disabled={submitting}
                            aria-invalid={validationMessage
                              ? true
                              : undefined}
                            aria-describedby={validationMessage
                              ? rejectErrorId
                              : undefined}
                          />
                          <p className="field__hint">
                            This reason is retained with the proposal review.
                          </p>
                        </div>
                        {validationMessage
                          ? (
                              <p
                                id={rejectErrorId}
                                className="form-error"
                                role="alert"
                              >
                                {validationMessage}
                              </p>
                            )
                          : null}
                        <div className="proposal-confirmation__actions">
                          <button
                            className="primary-action"
                            type="submit"
                            disabled={submitting}
                          >
                            {submitting
                              ? "Rejecting…"
                              : "Confirm rejection"}
                          </button>
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={submitting}
                            onClick={cancelMode}
                          >
                            Cancel
                          </button>
                        </div>
                      </form>
                    )}
            </div>
          )
        : null}
    </section>
  );
}

export function ProposalsScreen({ projectId }: { projectId: string }) {
  const [listState, setListState] = useState<ListState>({
    status: "loading",
    projectId,
  });
  const [selectedProposalId, setSelectedProposalId] = useState<string | null>(
    null,
  );
  const [detailState, setDetailState] = useState<DetailState>({
    status: "idle",
    projectId,
  });
  const [mode, setMode] = useState<ReviewMode>("idle");
  const [submitting, setSubmitting] = useState(false);
  const [validationMessage, setValidationMessage] = useState<string | null>(
    null,
  );
  const [notice, setNotice] = useState<DecisionNotice>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const listGenerationRef = useRef(0);
  const detailGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const actionControllerRef = useRef<AbortController | null>(null);
  const selectedProposalIdRef = useRef<string | null>(null);
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;

  useEffect(() => {
    selectedProposalIdRef.current = selectedProposalId;
  }, [selectedProposalId]);

  useEffect(() => () => {
    actionControllerRef.current?.abort();
    actionControllerRef.current = null;
    actionGenerationRef.current += 1;
  }, []);

  useEffect(() => {
    const generation = ++listGenerationRef.current;
    const controller = new AbortController();
    actionControllerRef.current?.abort();
    ++actionGenerationRef.current;
    setListState({ status: "loading", projectId });
    setSelectedProposalId(null);
    selectedProposalIdRef.current = null;
    setDetailState({ status: "idle", projectId });
    setMode("idle");
    setNotice(null);
    setActionError(null);
    setValidationMessage(null);

    apiRequest<ProposalListResponse>(
      `${apiPath("projects", projectId, "proposals")}?state=pending`,
      { signal: controller.signal },
    ).then(
      ({ proposals }) => {
        if (
          controller.signal.aborted ||
          generation !== listGenerationRef.current ||
          projectIdRef.current !== projectId
        ) return;
        if (proposals.some((proposal) => proposal.projectId !== projectId)) {
          setListState({
            status: "error",
            projectId,
            message: "The proposal list did not match the current project.",
          });
          setSelectedProposalId(null);
          selectedProposalIdRef.current = null;
          return;
        }
        const ordered = [...proposals].sort(newestFirst);
        const nextProposalId = ordered[0]?.id ?? null;
        setListState({ status: "ready", projectId, proposals: ordered });
        setSelectedProposalId(nextProposalId);
        selectedProposalIdRef.current = nextProposalId;
      },
      (reason: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== listGenerationRef.current ||
          projectIdRef.current !== projectId
        ) return;
        setListState({
          status: "error",
          projectId,
          message: reason instanceof Error
            ? reason.message
            : "Could not read pending proposals.",
        });
      },
    );

    return () => controller.abort();
  }, [projectId]);

  useEffect(() => {
    actionControllerRef.current?.abort();
    ++actionGenerationRef.current;
    setMode("idle");
    setSubmitting(false);
    setValidationMessage(null);
    setNotice(null);
    setActionError(null);

    if (!selectedProposalId) {
      setDetailState({ status: "idle", projectId });
      return;
    }

    const proposalId = selectedProposalId;
    const generation = ++detailGenerationRef.current;
    const controller = new AbortController();
    setDetailState({ status: "loading", projectId, proposalId });

    apiRequest<ProposalDetailResponse>(
      apiPath("proposals", proposalId),
      { signal: controller.signal },
    ).then(
      ({ proposal }) => {
        if (
          controller.signal.aborted ||
          generation !== detailGenerationRef.current ||
          selectedProposalIdRef.current !== proposalId ||
          projectIdRef.current !== projectId
        ) return;
        if (
          proposal.id !== proposalId ||
          proposal.projectId !== projectId
        ) {
          setDetailState({
            status: "error",
            projectId,
            proposalId,
            message: proposal.projectId !== projectId
              ? "The proposal detail did not match the current project."
              : "The proposal detail did not match the selected proposal.",
          });
          return;
        }
        setDetailState({ status: "ready", projectId, proposal });
      },
      (reason: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== detailGenerationRef.current ||
          selectedProposalIdRef.current !== proposalId ||
          projectIdRef.current !== projectId
        ) return;
        setDetailState({
          status: "error",
          projectId,
          proposalId,
          message: reason instanceof Error
            ? reason.message
            : "Could not read this proposal.",
        });
      },
    );

    return () => controller.abort();
  }, [projectId, selectedProposalId]);

  const chooseProposal = (proposalId: string) => {
    if (proposalId === selectedProposalId) return;
    actionControllerRef.current?.abort();
    ++actionGenerationRef.current;
    selectedProposalIdRef.current = proposalId;
    setSelectedProposalId(proposalId);
    setActionError(null);
  };

  const beginAction = <
    Response extends ProposalAcceptResponse | ProposalRejectResponse,
  >(
    actionKind: "accept" | "reject",
    action: (
      proposalId: string,
      signal: AbortSignal,
    ) => Promise<Response>,
    apply: (response: Response) => DecisionNotice,
  ) => {
    const proposalId = selectedProposalId;
    if (
      !proposalId ||
      detailState.status !== "ready" ||
      detailState.projectId !== projectId ||
      detailState.proposal.id !== proposalId ||
      detailState.proposal.projectId !== projectId
    ) return;
    const actionProjectId = projectId;
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    const generation = ++actionGenerationRef.current;
    setSubmitting(true);
    setValidationMessage(null);
    setActionError(null);
    setNotice(null);

    const actionIsCurrent = (): boolean =>
      !controller.signal.aborted &&
      generation === actionGenerationRef.current &&
      selectedProposalIdRef.current === proposalId &&
      projectIdRef.current === actionProjectId;

    const reconcileAfterFailure = async (
      reason: unknown,
    ): Promise<boolean> => {
      try {
        const [{ proposal }, { proposals }] = await Promise.all([
          apiRequest<ProposalDetailResponse>(
            apiPath("proposals", proposalId),
            { signal: controller.signal },
          ),
          apiRequest<ProposalListResponse>(
            `${
              apiPath("projects", actionProjectId, "proposals")
            }?state=pending`,
            { signal: controller.signal },
          ),
        ]);
        if (!actionIsCurrent()) return true;
        if (
          proposal.id !== proposalId ||
          proposal.projectId !== actionProjectId ||
          proposals.some(
            (candidate) => candidate.projectId !== actionProjectId,
          )
        ) {
          setSubmitting(false);
          setActionError(
            "The authoritative review state did not match the reviewed " +
              "proposal. No result was applied to this screen.",
          );
          return true;
        }

        setDetailState({
          status: "ready",
          projectId: actionProjectId,
          proposal,
        });
        setListState({
          status: "ready",
          projectId: actionProjectId,
          proposals: [...proposals].sort(newestFirst),
        });

        if (proposal.state === "pending") return false;

        setSubmitting(false);
        setMode("idle");
        setActionError(null);
        setNotice(
          proposal.state === "conflicted"
            ? {
                tone: "conflict",
                message: `${
                  reason instanceof Error
                    ? reason.message
                    : "The proposal conflicts with the current project."
                } Project knowledge was unchanged by this review request.`,
              }
            : {
                tone: "status",
                message: proposal.state === "accepted"
                  ? "Proposal accepted."
                  : proposal.state === "rejected"
                    ? "Proposal rejected."
                    : "Proposal withdrawn.",
              },
        );
        return true;
      } catch {
        return !actionIsCurrent();
      }
    };

    action(proposalId, controller.signal).then(
      (response) => {
        if (!actionIsCurrent()) return;
        const proposal = response.proposal;
        if (
          proposal.id !== proposalId ||
          proposal.projectId !== actionProjectId
        ) {
          setSubmitting(false);
          setActionError(
            "The review response did not match the reviewed proposal. " +
              "No result was applied to this screen; you can try again.",
          );
          return;
        }
        setSubmitting(false);
        setMode("idle");
        setActionError(null);
        setNotice(apply(response));
        setDetailState((current) =>
          current.status === "ready" &&
            current.projectId === actionProjectId &&
            current.proposal.id === proposalId
            ? {
                status: "ready",
                projectId: actionProjectId,
                proposal: { ...current.proposal, ...proposal },
              }
            : current
        );
        setListState((current) =>
          current.status === "ready" &&
              current.projectId === actionProjectId
            ? {
                status: "ready",
                projectId: actionProjectId,
                proposals: current.proposals.filter(
                  (candidate) => candidate.id !== proposalId,
                ),
              }
            : current
        );
      },
      async (reason: unknown) => {
        if (!actionIsCurrent()) return;
        if (await reconcileAfterFailure(reason)) return;
        if (!actionIsCurrent()) return;
        setSubmitting(false);
        const message = reason instanceof Error
          ? reason.message
          : "The review service did not return a response.";
        setActionError(
          `Could not ${actionKind} this proposal. ${message} ` +
            "You can try again without reopening it.",
        );
      },
    );
  };

  const accept = () => {
    beginAction(
      "accept",
      (proposalId, signal) =>
        apiRequest<ProposalAcceptResponse>(
          apiPath("proposals", proposalId, "accept"),
          { method: "POST", signal },
        ),
      (response) => {
        return response.outcome === "applied"
          ? {
              tone: "status",
              message:
                `Accepted at project revision ${response.projectRevision}.`,
            }
          : {
              tone: "conflict",
              message:
                `${response.explanation} Current project revision: ` +
                `${response.currentProjectRevision}.`,
            };
      },
    );
  };

  const reject = (rawReason: string) => {
    const reason = rawReason.trim();
    if (!reason) {
      setValidationMessage("Enter a reason for rejecting this proposal.");
      return;
    }
    beginAction(
      "reject",
      (proposalId, signal) =>
        apiRequest<ProposalRejectResponse>(
          apiPath("proposals", proposalId, "reject"),
          {
            method: "POST",
            signal,
            body: JSON.stringify({ reason }),
          },
        ),
      () => ({
        tone: "status",
        message: "Proposal rejected.",
      }),
    );
  };

  const projectHomePath = `/projects/${encodeURIComponent(projectId)}`;
  const renderedListState: ListState = listState.projectId === projectId
    ? listState
    : { status: "loading", projectId };
  const renderedDetailState: DetailState =
    detailState.projectId === projectId
      ? detailState
      : { status: "idle", projectId };

  return (
    <div className="proposals-screen">
      <header className="proposal-page-header">
        <div>
          <p className="stage__eyebrow">Governance ledger · Pending</p>
          <h1>Review proposed knowledge</h1>
          <p className="stage__lede">
            Inspect the rationale and every operation before deciding whether
            this proposal belongs in the project archive.
          </p>
        </div>
      </header>

      {renderedListState.status === "loading"
        ? (
            <AsyncState
              state="loading"
              message="Reading pending proposals…"
            />
          )
        : renderedListState.status === "error"
          ? (
              <AsyncState
                state="error"
                title="Could not open the review ledger"
                message={renderedListState.message}
              />
            )
          : renderedListState.proposals.length === 0 &&
              renderedDetailState.status !== "ready"
            ? (
                <AsyncState
                  state="empty"
                  title="No proposals await review"
                  message="Project knowledge is current with every recorded review."
                  action={(
                    <a
                      className="text-link"
                      href={projectHomePath}
                      onClick={(event) => followLink(event, projectHomePath)}
                    >
                      Return to Home
                    </a>
                  )}
                />
              )
            : (
                <div className="proposal-ledger">
                  <aside className="proposal-queue">
                    <div className="proposal-queue__heading">
                      <p>Awaiting review</p>
                      <h2>Pending proposals</h2>
                    </div>
                    <ol aria-label="Pending proposals">
                      {renderedListState.proposals.map((proposal) => (
                        <li key={proposal.id}>
                          <button
                            type="button"
                            aria-current={proposal.id === selectedProposalId
                              ? "true"
                              : undefined}
                            aria-label={`Review proposal ${proposal.rationale}`}
                            onClick={() => chooseProposal(proposal.id)}
                          >
                            <span className="proposal-queue__date">
                              {formattedDate(proposal.createdAt)}
                            </span>
                            <strong>{proposal.rationale}</strong>
                            <span>
                              Revision {proposal.baseProjectRevision} ·{" "}
                              {proposalOriginPresentation(proposal.origin).label}
                            </span>
                          </button>
                        </li>
                      ))}
                    </ol>
                  </aside>

                  <div className="proposal-ledger__detail">
                    {renderedDetailState.status === "loading"
                      ? (
                          <AsyncState
                            state="loading"
                            message="Opening proposal detail…"
                          />
                        )
                      : renderedDetailState.status === "error"
                        ? (
                            <AsyncState
                              state="error"
                              title="Could not open this proposal"
                              message={renderedDetailState.message}
                            />
                          )
                        : renderedDetailState.status === "ready"
                          ? (
                              <ProposalDetail
                                detail={renderedDetailState.proposal}
                                mode={mode}
                                submitting={submitting}
                                validationMessage={validationMessage}
                                notice={notice}
                                actionError={actionError}
                                onChooseMode={(nextMode) => {
                                  setMode(nextMode);
                                  setValidationMessage(null);
                                  setActionError(null);
                                }}
                                onCancelMode={() => {
                                  setMode("idle");
                                  setValidationMessage(null);
                                  setActionError(null);
                                }}
                                onAccept={accept}
                                onReject={reject}
                              />
                            )
                          : null}
                  </div>
                </div>
              )}
    </div>
  );
}
