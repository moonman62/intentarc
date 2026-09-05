import {
  Archive,
  Check,
  Clipboard,
  Eye,
  FileWarning,
  Link2,
  Plus,
  ShieldCheck,
  ShieldX,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  isHierarchyRecordKind,
  type OutboundFinding,
  type OutboundInspection,
  type OutboundRelease,
} from "../../../domain/index.js";
import type {
  BrowserChatExport,
  ContextRequestResponse,
  ReleasedContextResponse,
  TaskHandoffResponse,
} from "../../contracts.js";
import { apiPath } from "../../contracts.js";
import { ApiError, apiRequest } from "../api.js";
import { downloadBrowserChatExport } from "../browser-download.js";
import { AsyncState } from "../components/async-state.js";
import {
  ProfileSetupDialog,
} from "../components/profile-setup-dialog.js";
import { RecordPreview } from "../components/record-preview.js";
import {
  loadPreference,
  preferenceKeys,
  savePreference,
} from "../preferences.js";

type ProjectProfile = TaskHandoffResponse["profiles"][number];
type HandoffState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; handoff: TaskHandoffResponse };
type OutboundState =
  | { status: "brief" }
  | {
      status: "review";
      inspection: OutboundInspection;
      includeFindingIds: string[];
      rememberClean: boolean;
      revealedValues: Record<string, string>;
    }
  | {
      status: "released";
      release: OutboundRelease;
      export: BrowserChatExport;
    };

export interface HandoffDeskProps {
  projectId: string;
  taskId: string;
}

const compareProfiles = (
  left: ProjectProfile,
  right: ProjectProfile,
): number => {
  if (left.lastUsedAt !== right.lastUsedAt) {
    if (left.lastUsedAt === null) return 1;
    if (right.lastUsedAt === null) return -1;
    return right.lastUsedAt.localeCompare(left.lastUsedAt);
  }
  return left.name.localeCompare(right.name) ||
    left.profileId.localeCompare(right.profileId);
};

export const selectHandoffProfile = (
  profiles: ProjectProfile[],
  preferredProfileId: string | null,
): ProjectProfile | null =>
  profiles.find(({ profileId }) => profileId === preferredProfileId) ??
  [...profiles].sort(compareProfiles)[0] ??
  null;

const titleCase = (value: string): string => {
  const readable = value.replaceAll("_", " ");
  return readable.charAt(0).toUpperCase() + readable.slice(1);
};

const findingLabel = (finding: OutboundFinding): string =>
  finding.category === "api_token"
    ? "API token"
    : titleCase(finding.category);

const executionLabel = (
  mode: ProjectProfile["executionMode"],
): string => `${titleCase(mode)} execution`;

const authorityLabel = (
  mode: ProjectProfile["knowledgeAuthorityMode"],
): string => ({
  proposal: "Proposal only",
  scoped_direct: "Scoped direct",
  full_direct: "Full direct",
})[mode];

const boundaryLabel = (
  boundary: NonNullable<ProjectProfile["destination"]>["dataBoundary"],
): string => `${titleCase(boundary)} boundary`;

const nextRequestKey = (() => {
  let fallbackSequence = 0;
  return (): string => {
    const uuid = globalThis.crypto?.randomUUID?.();
    return uuid
      ? `web-handoff-${uuid}`
      : `web-handoff-${Date.now()}-${fallbackSequence += 1}`;
  };
})();

function LedgerSection({
  label,
  title,
  children,
  collapsible = false,
}: {
  label: string;
  title: string;
  children: ReactNode;
  collapsible?: boolean;
}) {
  return (
    <section className="handoff-ledger__section">
      <p className="handoff-ledger__index">{label}</p>
      <div>
        {collapsible
          ? (
              <details className="handoff-ledger__details">
                <summary>{title}</summary>
                {children}
              </details>
            )
          : (
              <>
                <h2>{title}</h2>
                {children}
              </>
            )}
      </div>
    </section>
  );
}

export function HandoffDesk({
  projectId,
  taskId,
}: HandoffDeskProps) {
  const routeScope = `${projectId}\u0000${taskId}`;
  const addDestinationRef = useRef<HTMLButtonElement>(null);
  const returnSetupFocusRef = useRef(false);
  const actionGenerationRef = useRef(0);
  const prepareAttemptRef = useRef<{
    scope: string;
    idempotencyKey: string;
  } | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [handoffState, setHandoffState] = useState<HandoffState>({
    status: "loading",
  });
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [outboundState, setOutboundState] = useState<OutboundState>({
    status: "brief",
  });
  const [setupScope, setSetupScope] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [downloadStatus, setDownloadStatus] = useState<string | null>(null);
  const setupOpen = setupScope === routeScope;

  useEffect(() => {
    const controller = new AbortController();
    setHandoffState({ status: "loading" });
    apiRequest<TaskHandoffResponse>(
      apiPath("projects", projectId, "tasks", taskId, "handoff"),
      { signal: controller.signal },
    ).then(
      (handoff) => {
        if (controller.signal.aborted) return;
        const preferred = loadPreference(
          `${preferenceKeys.preferredProfilePrefix}${projectId}`,
        );
        const selected = selectHandoffProfile(handoff.profiles, preferred);
        setSelectedProfileId(selected?.profileId ?? null);
        setHandoffState({ status: "ready", handoff });
      },
      (reason: unknown) => {
        if (controller.signal.aborted) return;
        setHandoffState({
          status: "error",
          message: reason instanceof Error
            ? reason.message
            : "Could not read the task handoff.",
        });
      },
    );
    return () => controller.abort();
  }, [projectId, reloadKey, taskId]);

  useEffect(() => {
    actionGenerationRef.current += 1;
    prepareAttemptRef.current = null;
    returnSetupFocusRef.current = false;
    setSetupScope(null);
    setOutboundState({ status: "brief" });
    setActionError(null);
    setCopyStatus(null);
    setDownloadStatus(null);
    setWorking(false);
  }, [projectId, taskId]);

  useEffect(() => {
    if (!setupOpen && returnSetupFocusRef.current) {
      returnSetupFocusRef.current = false;
      addDestinationRef.current?.focus();
    }
  }, [setupOpen]);

  const handoff = handoffState.status === "ready"
    ? handoffState.handoff
    : null;
  const selectedProfile = handoff?.profiles.find(
    ({ profileId }) => profileId === selectedProfileId,
  ) ?? null;

  const selectProfile = (profileId: string) => {
    actionGenerationRef.current += 1;
    prepareAttemptRef.current = null;
    setSelectedProfileId(profileId);
    savePreference(
      `${preferenceKeys.preferredProfilePrefix}${projectId}`,
      profileId,
    );
    setOutboundState({ status: "brief" });
    setActionError(null);
    setCopyStatus(null);
    setDownloadStatus(null);
    setWorking(false);
  };

  const prepare = async () => {
    if (!selectedProfile?.destination) return;
    const prepareScope = `${routeScope}\u0000${selectedProfile.profileId}`;
    const prepareAttempt = prepareAttemptRef.current?.scope === prepareScope
      ? prepareAttemptRef.current
      : {
          scope: prepareScope,
          idempotencyKey: nextRequestKey(),
        };
    prepareAttemptRef.current = prepareAttempt;
    const actionGeneration = ++actionGenerationRef.current;
    let requestAccepted = false;
    setWorking(true);
    setActionError(null);
    setCopyStatus(null);
    setDownloadStatus(null);
    try {
      const response = await apiRequest<ContextRequestResponse>(
        apiPath(
          "projects",
          projectId,
          "tasks",
          taskId,
          "context-requests",
        ),
        {
          method: "POST",
          body: JSON.stringify({
            profileId: selectedProfile.profileId,
            budgetTokens: 16_000,
            idempotencyKey: prepareAttempt.idempotencyKey,
          }),
        },
      );
      if (actionGeneration !== actionGenerationRef.current) return;
      requestAccepted = true;
      if (response.inspection) {
        prepareAttemptRef.current = null;
        setOutboundState({
          status: "review",
          inspection: response.inspection,
          includeFindingIds: [],
          rememberClean: false,
          revealedValues: {},
        });
        return;
      }
      if (response.release) {
        const released = await apiRequest<ReleasedContextResponse>(
          apiPath(
            "context-requests",
            response.request.requestId,
            "released",
          ),
        );
        if (actionGeneration !== actionGenerationRef.current) return;
        prepareAttemptRef.current = null;
        setOutboundState({ status: "released", ...released });
      }
    } catch (reason) {
      if (actionGeneration !== actionGenerationRef.current) return;
      if (!requestAccepted && reason instanceof ApiError) {
        prepareAttemptRef.current = null;
      }
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Could not prepare the task context.",
      );
    } finally {
      if (actionGeneration === actionGenerationRef.current) {
        setWorking(false);
      }
    }
  };

  const revealFinding = async (finding: OutboundFinding) => {
    if (outboundState.status !== "review") return;
    const actionGeneration = ++actionGenerationRef.current;
    setWorking(true);
    setActionError(null);
    try {
      const reveal = await apiRequest<{
        requestId: string;
        findingId: string;
        value: string;
      }>(
        apiPath(
          "context-requests",
          outboundState.inspection.request.requestId,
          "reveal",
        ),
        {
          method: "POST",
          body: JSON.stringify({ findingId: finding.id }),
        },
      );
      if (actionGeneration !== actionGenerationRef.current) return;
      setOutboundState((current) =>
        current.status === "review"
          ? {
              ...current,
              revealedValues: {
                ...current.revealedValues,
                [reveal.findingId]: reveal.value,
              },
            }
          : current
      );
    } catch (reason) {
      if (actionGeneration !== actionGenerationRef.current) return;
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Could not reveal this finding.",
      );
    } finally {
      if (actionGeneration === actionGenerationRef.current) {
        setWorking(false);
      }
    }
  };

  const toggleFinding = (findingId: string, included: boolean) => {
    setOutboundState((current) => {
      if (current.status !== "review") return current;
      return {
        ...current,
        includeFindingIds: included
          ? [...current.includeFindingIds, findingId]
          : current.includeFindingIds.filter((id) => id !== findingId),
      };
    });
  };

  const approve = async () => {
    if (outboundState.status !== "review") return;
    const actionGeneration = ++actionGenerationRef.current;
    setWorking(true);
    setActionError(null);
    try {
      const released = await apiRequest<ReleasedContextResponse>(
        apiPath(
          "context-requests",
          outboundState.inspection.request.requestId,
          "approve",
        ),
        {
          method: "POST",
          body: JSON.stringify({
            rememberClean: outboundState.rememberClean,
            includeFindingIds: outboundState.includeFindingIds,
          }),
        },
      );
      if (actionGeneration !== actionGenerationRef.current) return;
      setOutboundState({ status: "released", ...released });
    } catch (reason) {
      if (actionGeneration !== actionGenerationRef.current) return;
      try {
        const reconciled = await apiRequest<ReleasedContextResponse>(
          apiPath(
            "context-requests",
            outboundState.inspection.request.requestId,
            "released",
          ),
        );
        if (actionGeneration !== actionGenerationRef.current) return;
        setOutboundState({ status: "released", ...reconciled });
        return;
      } catch {
        if (actionGeneration !== actionGenerationRef.current) return;
      }
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Could not approve this release.",
      );
    } finally {
      if (actionGeneration === actionGenerationRef.current) {
        setWorking(false);
      }
    }
  };

  const deny = async () => {
    if (outboundState.status !== "review") return;
    const actionGeneration = ++actionGenerationRef.current;
    setWorking(true);
    setActionError(null);
    try {
      await apiRequest(
        apiPath(
          "context-requests",
          outboundState.inspection.request.requestId,
          "deny",
        ),
        {
          method: "POST",
          body: JSON.stringify({}),
        },
      );
      if (actionGeneration !== actionGenerationRef.current) return;
      prepareAttemptRef.current = null;
      setOutboundState({ status: "brief" });
    } catch (reason) {
      if (actionGeneration !== actionGenerationRef.current) return;
      setActionError(
        reason instanceof Error
          ? reason.message
          : "Could not deny this release.",
      );
    } finally {
      if (actionGeneration === actionGenerationRef.current) {
        setWorking(false);
      }
    }
  };

  const copyReleasedContext = async () => {
    if (outboundState.status !== "released") return;
    const actionGeneration = actionGenerationRef.current;
    try {
      await navigator.clipboard.writeText(outboundState.export.text);
      if (actionGeneration !== actionGenerationRef.current) return;
      setCopyStatus("Task context copied");
    } catch {
      if (actionGeneration !== actionGenerationRef.current) return;
      setCopyStatus(
        "Task context could not be copied. Select the released text manually.",
      );
    }
  };

  const downloadReleasedContext = () => {
    if (outboundState.status !== "released") return;
    try {
      downloadBrowserChatExport(outboundState.export);
      setDownloadStatus("Task context downloaded");
    } catch {
      setDownloadStatus("Task context could not be downloaded. Try again.");
    }
  };

  const closeSetup = useCallback(() => {
    returnSetupFocusRef.current = true;
    setSetupScope(null);
  }, []);

  const profileConfigured = useCallback((profileId: string) => {
    actionGenerationRef.current += 1;
    prepareAttemptRef.current = null;
    savePreference(
      `${preferenceKeys.preferredProfilePrefix}${projectId}`,
      profileId,
    );
    setWorking(false);
    setOutboundState({ status: "brief" });
    setReloadKey((key) => key + 1);
  }, [projectId]);

  if (handoffState.status === "loading") {
    return (
      <AsyncState
        state="loading"
        message="Reading the task brief and project destinations…"
      />
    );
  }
  if (handoffState.status === "error") {
    return (
      <AsyncState
        state="error"
        title="Handoff Desk is unavailable"
        message={handoffState.message}
        action={(
          <button
            className="secondary-action"
            type="button"
            onClick={() => setReloadKey((key) => key + 1)}
          >
            Try again
          </button>
        )}
      />
    );
  }

  const { task: currentTask, currentOutcome, relatedRecords } =
    handoffState.handoff;
  const omissions = outboundState.status === "review"
    ? outboundState.inspection.redactedPreview.omissions
    : outboundState.status === "released"
      ? outboundState.release.disclosure.omissions
      : [];
  const contextPackId = outboundState.status === "review"
    ? outboundState.inspection.redactedPreview.id
    : outboundState.status === "released"
      ? outboundState.release.sourcePackId
      : null;

  return (
    <article className="handoff-desk">
      <header className="handoff-desk__header">
        <div>
          <p className="stage__eyebrow">
            Handoff Desk · outbound review
          </p>
          <h1>{currentTask.title}</h1>
        </div>
        <span className="handoff-desk__seal" aria-hidden="true">
          <Archive size={23} strokeWidth={1.55} />
        </span>
      </header>

      <div className="handoff-ledger">
        <LedgerSection label="Objective" title="Objective">
          <p className="handoff-ledger__lead">{currentTask.title}</p>
        </LedgerSection>

        <LedgerSection label="Criteria" title="Completion criteria">
          <p className="handoff-ledger__body">{currentTask.body}</p>
        </LedgerSection>

        <section
          className="handoff-ledger__section handoff-ledger__action"
          aria-labelledby="handoff-action-title"
        >
          <p className="handoff-ledger__index">Action</p>
          <div className="handoff-action-desk">
            {outboundState.status === "review"
              ? (
                  <ReviewDesk
                    inspection={outboundState.inspection}
                    includeFindingIds={outboundState.includeFindingIds}
                    rememberClean={outboundState.rememberClean}
                    revealedValues={outboundState.revealedValues}
                    working={working}
                    actionError={actionError}
                    onReveal={revealFinding}
                    onToggleFinding={toggleFinding}
                    onRememberClean={(rememberClean) =>
                      setOutboundState((current) =>
                        current.status === "review"
                          ? { ...current, rememberClean }
                          : current
                      )}
                    onApprove={approve}
                    onDeny={deny}
                  />
                )
              : outboundState.status === "released"
                ? (
                    <ReleasedDesk
                      release={outboundState.release}
                      copyStatus={copyStatus}
                      downloadStatus={downloadStatus}
                      onCopy={copyReleasedContext}
                      onDownload={downloadReleasedContext}
                      onPrepareAgain={() => {
                        setOutboundState({ status: "brief" });
                        setCopyStatus(null);
                        setDownloadStatus(null);
                      }}
                    />
                  )
                : (
                    <>
                      <div className="handoff-action-desk__heading">
                        <div>
                          <p className="stage__eyebrow">Outbound destination</p>
                          <h2 id="handoff-action-title">Prepare task context</h2>
                        </div>
                        <ShieldCheck aria-hidden="true" size={22} />
                      </div>
                      {handoffState.handoff.profiles.length === 0
                        ? (
                            <div className="handoff-empty-destination">
                              <p>
                                Copy is unavailable until this project has a
                                destination.
                              </p>
                              <p>
                                Add a declared client profile before IntentArc
                                prepares or releases context.
                              </p>
                              <button
                                ref={addDestinationRef}
                                className="primary-action"
                                type="button"
                                onClick={() => setSetupScope(routeScope)}
                              >
                                <Plus aria-hidden="true" size={17} />
                                Add another destination
                              </button>
                            </div>
                          )
                        : (
                            <>
                              <fieldset className="handoff-profiles">
                                <legend>Project-enabled profiles</legend>
                                {handoffState.handoff.profiles.map((profile) => (
                                  <label
                                    className="handoff-profile"
                                    key={profile.profileId}
                                    data-selected={
                                      selectedProfileId === profile.profileId
                                        ? "true"
                                        : "false"
                                    }
                                  >
                                    <input
                                      type="radio"
                                      name="handoffProfile"
                                      value={profile.profileId}
                                      checked={
                                        selectedProfileId === profile.profileId
                                      }
                                      onChange={() =>
                                        selectProfile(profile.profileId)}
                                    />
                                    <span className="handoff-profile__check">
                                      <Check aria-hidden="true" size={15} />
                                    </span>
                                    <span>
                                      <strong>{profile.name}</strong>
                                      <small>
                                        {executionLabel(profile.executionMode)}
                                        {" · "}
                                        {authorityLabel(
                                          profile.knowledgeAuthorityMode,
                                        )}
                                      </small>
                                    </span>
                                  </label>
                                ))}
                              </fieldset>
                              {selectedProfile
                                ? <SelectedProfile profile={selectedProfile} />
                                : null}
                              {selectedProfile && !selectedProfile.destination
                                ? (
                                    <p className="handoff-ledger__muted">
                                      Preparation is unavailable until this
                                      authorized profile has an enabled
                                      destination.
                                    </p>
                                  )
                                : null}
                              {actionError
                                ? (
                                    <p className="form-error" role="alert">
                                      {actionError}
                                    </p>
                                  )
                                : null}
                              <div className="handoff-action-desk__actions">
                                <button
                                  ref={addDestinationRef}
                                  className="secondary-action"
                                  type="button"
                                  onClick={() => setSetupScope(routeScope)}
                                >
                                  <Plus aria-hidden="true" size={17} />
                                  {selectedProfile && !selectedProfile.destination
                                    ? "Repair destination"
                                    : "Add another destination"}
                                </button>
                                <button
                                  className="primary-action"
                                  type="button"
                                  disabled={working || !selectedProfile?.destination}
                                  onClick={prepare}
                                  aria-label={selectedProfile &&
                                      !selectedProfile.destination
                                    ? "Destination required before preparation"
                                    : undefined}
                                >
                                  {working
                                    ? "Preparing…"
                                    : selectedProfile?.destination
                                      ? `Prepare for ${
                                        selectedProfile.destination.clientLabel
                                      }`
                                      : "Destination required"}
                                </button>
                              </div>
                            </>
                          )}
                    </>
                  )}
          </div>
        </section>

        <LedgerSection label="Exclusions" title="Blockers and exclusions">
          {omissions.length === 0
            ? (
                <p className="handoff-ledger__muted">
                  {outboundState.status === "brief"
                    ? "Blockers and exclusions are recorded here after context preparation."
                    : "No blockers or exclusions were recorded for this release."}
                </p>
              )
            : (
                <ul className="omission-list">
                  {omissions.map((omission) => (
                    <li key={omission.recordId}>
                      <span>
                        {titleCase(omission.kind)} omitted for {omission.reason}.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
        </LedgerSection>

        <LedgerSection label="Records" title="Relevant records">
          {relatedRecords.length === 0
            ? (
                <p className="handoff-ledger__muted">
                  No directly linked records are part of this task brief.
                </p>
              )
            : (
                <ul className="record-preview-list">
                  {relatedRecords.map((related) => {
                    const hierarchyRelated = isHierarchyRecordKind(related.kind);
                    const mapFocusRecordId = hierarchyRelated
                      ? related.id
                      : currentTask.id;
                    return (
                      <li key={related.id}>
                        <RecordPreview
                          title={related.title}
                          kind={related.kind}
                          body={related.body}
                          href={`/projects/${encodeURIComponent(projectId)}/map?focusRecordId=${encodeURIComponent(mapFocusRecordId)}`}
                          linkLabel={hierarchyRelated ? "Open record" : "Open related task"}
                        />
                      </li>
                    );
                  })}
                </ul>
              )}
        </LedgerSection>

        <LedgerSection
          label="Details"
          title="Technical details"
          collapsible
        >
          <dl className="handoff-ledger__facts">
            <div>
              <dt>Project ID</dt>
              <dd>{handoffState.handoff.project.id}</dd>
            </div>
            <div>
              <dt>Project revision</dt>
              <dd>{handoffState.handoff.project.revision}</dd>
            </div>
            <div>
              <dt>Task ID</dt>
              <dd>{currentTask.id}</dd>
            </div>
            <div>
              <dt>Task revision</dt>
              <dd>{currentTask.revision}</dd>
            </div>
            {contextPackId
              ? (
                  <div>
                    <dt>Context pack ID</dt>
                    <dd>{contextPackId}</dd>
                  </div>
                )
              : null}
            <div>
              <dt>Status</dt>
              <dd>{titleCase(currentTask.status)}</dd>
            </div>
          </dl>
          <div className="ancestry-line">
            <span>{handoffState.handoff.project.name}</span>
            {currentOutcome
              ? (
                  <>
                    <Link2 aria-hidden="true" size={16} />
                    <strong>{currentOutcome.title}</strong>
                    <Link2 aria-hidden="true" size={16} />
                    <span>{currentTask.title}</span>
                  </>
                )
              : <span>No active outcome is recorded above this task.</span>}
          </div>
          {omissions.length === 0
            ? null
            : (
                <ul className="omission-list">
                  {omissions.map((omission) => (
                    <li key={omission.recordId}>
                      <code>{omission.recordId}</code>
                      <span>
                        {titleCase(omission.kind)} omitted for{" "}
                        {omission.reason}. Retrieval:{" "}
                        <code>{omission.retrievalRef}</code>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
        </LedgerSection>
      </div>

      {setupOpen
        ? (
            <ProfileSetupDialog
              key={routeScope}
              projectId={projectId}
              onClose={closeSetup}
              onProfileConfigured={profileConfigured}
            />
          )
        : null}
    </article>
  );
}

function SelectedProfile({ profile }: { profile: ProjectProfile }) {
  return (
    <section className="selected-profile" aria-label="Selected profile">
      <div>
        <p className="stage__eyebrow">Selected profile</p>
        <h3>{profile.name}</h3>
      </div>
      <dl>
        <div>
          <dt>Execution permission</dt>
          <dd>{executionLabel(profile.executionMode)}</dd>
        </div>
        <div>
          <dt>IntentArc knowledge authority</dt>
          <dd>{authorityLabel(profile.knowledgeAuthorityMode)}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{profile.destination?.providerLabel ?? "Not declared"}</dd>
        </div>
        <div>
          <dt>Data boundary</dt>
          <dd>
            {profile.destination
              ? boundaryLabel(profile.destination.dataBoundary)
              : "Not declared"}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function ReviewDesk({
  inspection,
  includeFindingIds,
  rememberClean,
  revealedValues,
  working,
  actionError,
  onReveal,
  onToggleFinding,
  onRememberClean,
  onApprove,
  onDeny,
}: {
  inspection: OutboundInspection;
  includeFindingIds: string[];
  rememberClean: boolean;
  revealedValues: Record<string, string>;
  working: boolean;
  actionError: string | null;
  onReveal: (finding: OutboundFinding) => void;
  onToggleFinding: (findingId: string, included: boolean) => void;
  onRememberClean: (rememberClean: boolean) => void;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <>
      <div className="handoff-action-desk__heading">
        <div>
          <p className="stage__eyebrow">Safety decision required</p>
          <h2 id="handoff-action-title">Outbound review</h2>
        </div>
        <FileWarning aria-hidden="true" size={22} />
      </div>
      <div className="review-summary">
        <p>
          Review the redacted preview and decide whether each eligible finding
          may be included in this release once.
        </p>
        <dl>
          <div>
            <dt>Findings</dt>
            <dd>{inspection.request.findingCounts.total}</dd>
          </div>
          <div>
            <dt>Forced redactions</dt>
            <dd>{inspection.request.findingCounts.forcedRedact}</dd>
          </div>
          <div>
            <dt>Release digest</dt>
            <dd>{inspection.prospectiveReleaseDigest.slice(0, 12)}…</dd>
          </div>
        </dl>
      </div>
      <div className="redacted-preview">
        <p className="stage__eyebrow">Redacted task preview</p>
        <p>{inspection.redactedPreview.task.record.body}</p>
      </div>
      {inspection.findings.length === 0
        ? (
            <label className="remember-clean">
              <input
                type="checkbox"
                checked={rememberClean}
                disabled={working}
                onChange={(event) => onRememberClean(event.target.checked)}
              />
              <span>
                <strong>Remember clean releases</strong>
                <small>
                  Apply only to this exact project, destination revision, and
                  safety-policy version.
                </small>
              </span>
            </label>
          )
        : (
            <ul className="finding-list">
              {inspection.findings.map((finding) => {
                const forced = finding.requiredAction === "forced_redact";
                const revealedValue = revealedValues[finding.id];
                return (
                  <li
                    key={finding.id}
                    aria-label={
                      `Finding ${findingLabel(finding)} at ${finding.path}`
                    }
                  >
                    <div className="finding-list__identity">
                      <span
                        className="finding-list__icon"
                        data-forced={forced ? "true" : "false"}
                        aria-hidden="true"
                      >
                        {forced
                          ? <ShieldX size={17} />
                          : <Eye size={17} />}
                      </span>
                      <div>
                        <strong>{findingLabel(finding)}</strong>
                        <code>{finding.path}</code>
                      </div>
                    </div>
                    <div className="finding-list__decision">
                      {forced
                        ? (
                            <span className="finding-list__forced">
                              Always redacted
                            </span>
                          )
                        : (
                            <label>
                              <input
                                type="checkbox"
                                checked={includeFindingIds.includes(finding.id)}
                                disabled={working}
                                onChange={(event) =>
                                  onToggleFinding(
                                    finding.id,
                                    event.target.checked,
                                  )}
                              />
                              Include once
                            </label>
                          )}
                      <button
                        className="text-link"
                        type="button"
                        disabled={working}
                        onClick={() => onReveal(finding)}
                      >
                        Reveal for review
                      </button>
                    </div>
                    {revealedValue
                      ? (
                          <p className="finding-list__reveal">
                            <span>Local review only</span>
                            <code>{revealedValue}</code>
                          </p>
                        )
                      : null}
                  </li>
                );
              })}
            </ul>
          )}
      {actionError
        ? <p className="form-error" role="alert">{actionError}</p>
        : null}
      <div className="handoff-action-desk__actions">
        <button
          className="secondary-action"
          type="button"
          disabled={working}
          onClick={onDeny}
        >
          Deny release
        </button>
        <button
          className="primary-action"
          type="button"
          disabled={working}
          onClick={onApprove}
        >
          {working ? "Recording decision…" : "Approve and release"}
        </button>
      </div>
    </>
  );
}

function ReleasedDesk({
  release,
  copyStatus,
  downloadStatus,
  onCopy,
  onDownload,
  onPrepareAgain,
}: {
  release: OutboundRelease;
  copyStatus: string | null;
  downloadStatus: string | null;
  onCopy: () => void;
  onDownload: () => void;
  onPrepareAgain: () => void;
}) {
  return (
    <>
      <div className="handoff-action-desk__heading">
        <div>
          <p className="stage__eyebrow">Safe release recorded</p>
          <h2 id="handoff-action-title">Task context is ready</h2>
        </div>
        <ShieldCheck aria-hidden="true" size={22} />
      </div>
      <dl className="release-ledger">
        <div>
          <dt>Release</dt>
          <dd>{release.releaseId}</dd>
        </div>
        <div>
          <dt>Redacted</dt>
          <dd>{release.disclosure.findingCounts.redacted}</dd>
        </div>
        <div>
          <dt>Included once</dt>
          <dd>{release.disclosure.findingCounts.includedOnce}</dd>
        </div>
        <div>
          <dt>Release digest</dt>
          <dd>{release.disclosure.releaseDigest.slice(0, 12)}…</dd>
        </div>
      </dl>
      <p
        className="release-note"
        role="note"
        aria-label="Destination control"
      >
        IntentArc does not open or control the destination.
      </p>
      <div className="handoff-action-desk__actions">
        <button
          className="secondary-action"
          type="button"
          onClick={onPrepareAgain}
        >
          Return to task brief
        </button>
        <button
          className="secondary-action"
          type="button"
          onClick={onDownload}
        >
          Download Markdown
        </button>
        <button
          className="primary-action"
          type="button"
          onClick={onCopy}
        >
          <Clipboard aria-hidden="true" size={17} />
          Copy task context
        </button>
      </div>
      {copyStatus
        ? (
            <p className="release-copy-status" role="status" aria-live="polite">
              {copyStatus}
            </p>
          )
        : null}
      {downloadStatus
        ? (
            <p className="release-copy-status" role="status" aria-live="polite">
              {downloadStatus}
            </p>
          )
        : null}
    </>
  );
}
