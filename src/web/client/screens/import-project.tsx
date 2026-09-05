import {
  type FormEvent,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowLeft,
  ArrowRight,
  AlertTriangle,
  Check,
  FileWarning,
  FolderSearch,
  ShieldCheck,
} from "lucide-react";
import type { ImportInspection, RepositoryImportManifest } from "../../../domain/index.js";
import type {
  ImportApplyResponse,
  ImportScanResponse,
} from "../../contracts.js";
import { ApiError, apiRequest } from "../api.js";

export type ProjectAppliedHandler = (
  projectId: string,
  signal: AbortSignal,
) => Promise<void>;

interface ImportProjectScreenProps {
  onProjectApplied: ProjectAppliedHandler;
}

type ImportState =
  | { status: "select"; error: string | null }
  | { status: "scanning" }
  | {
      status: "review";
      manifest: RepositoryImportManifest;
      inspection: ImportInspection;
      phase: "inspection" | "confirmation";
      reviewed: boolean;
      applying: boolean;
      error: string | null;
    };

const readableToken = (value: string): string =>
  value.replaceAll("_", " ");

const recordCountLabel = (value: string, count: number): string =>
  `${count} ${readableToken(value)}${count === 1 ? "" : "s"}`;

const scanErrorMessage =
  "Repository inspection could not be completed. Check the repository path and canonical subpath, then scan again.";

const browseErrorMessage =
  "Browse could not open. Enter the repository path manually.";

const importErrorMessage = (reason: unknown): string => {
  if (reason instanceof ApiError) {
    if (reason.code === "import_rescan_required") {
      return "The inspected baseline is no longer current. Scan again to review the latest baseline.";
    }
    return reason.message;
  }
  return reason instanceof Error
    ? reason.message
    : "The repository import could not be completed.";
};

function StageRail({ stage }: { stage: 1 | 2 | 3 }) {
  const steps = [
    "Select repository",
    "Review inspection",
    "Confirm and apply",
  ];
  return (
    <ol className="import-stages" aria-label="Import progress">
      {steps.map((label, index) => {
        const number = index + 1;
        const complete = number < stage;
        return (
          <li
            key={label}
            data-state={complete
              ? "complete"
              : number === stage
                ? "current"
                : "upcoming"}
            aria-current={number === stage ? "step" : undefined}
          >
            <span aria-hidden="true">
              {complete ? <Check size={13} strokeWidth={2.3} /> : number}
            </span>
            <strong>{label}</strong>
          </li>
        );
      })}
    </ol>
  );
}

function LedgerHeading({
  icon,
  title,
  detail,
}: {
  icon: React.ReactNode;
  title: string;
  detail?: string;
}) {
  return (
    <header className="import-ledger__heading">
      <span aria-hidden="true">{icon}</span>
      <div>
        <h2>{title}</h2>
        {detail ? <p>{detail}</p> : null}
      </div>
    </header>
  );
}

function ReviewSummary({
  inspection,
  onContinue,
  headingRef,
}: {
  inspection: ImportInspection;
  onContinue: () => void;
  headingRef: RefObject<HTMLHeadingElement | null>;
}) {
  return (
    <div className="import-summary-ledger">
      <h2 className="import-summary-ledger__title" ref={headingRef} tabIndex={-1}>
        Review scan summary
      </h2>
      <section className="import-ledger__section">
        <LedgerHeading
          icon={<FolderSearch size={17} />}
          title="Project"
          detail="The project this scan will create or update."
        />
        <dl className="import-summary">
          <div><dt>Name</dt><dd>{inspection.project.name}</dd></div>
        </dl>
      </section>
      <section className="import-ledger__section">
        <LedgerHeading
          icon={<FolderSearch size={17} />}
          title="Repository"
          detail="The source selected for this scan."
        />
        <dl className="import-summary">
          <div><dt>Path</dt><dd>{inspection.repository.root}</dd></div>
          <div className="import-summary__secondary">
            <dt>Canonical subpath</dt>
            <dd>{inspection.repository.canonicalSubpath ?? "Repository root"}</dd>
          </div>
        </dl>
      </section>
      <section className="import-ledger__section">
        <LedgerHeading
          icon={<Check size={17} />}
          title="Detected records"
          detail="A compact inventory of the records proposed by this scan."
        />
        <div className="import-count-groups">
          <div>
            <h3>By record type</h3>
            <ul>
              {inspection.counts.recordsByKind.map(({ kind, count }) => (
                <li key={kind}>{recordCountLabel(kind, count)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>By status</h3>
            <ul>
              {inspection.counts.recordsByStatus.map(({ status, count }) => (
                <li key={status}>{count} {readableToken(status)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>By source</h3>
            <ul>
              {inspection.counts.recordsBySourceKind.map(({ sourceKind, count }) => (
                <li key={sourceKind}>{count} {readableToken(sourceKind)}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>
      <section className="import-ledger__section">
        <LedgerHeading icon={<AlertTriangle size={17} />} title="Warnings" />
        <ul className="import-count-list">
          {inspection.warnings.length > 0
            ? inspection.warnings.map((warning) => (
                <li key={warning.code}>
                  <span>{readableToken(warning.code)}</span>
                  <strong>{warning.count}</strong>
                </li>
              ))
            : <li><span>No warnings</span><strong>0</strong></li>}
        </ul>
      </section>
      <section className="import-ledger__section import-apply">
        <LedgerHeading
          icon={<ShieldCheck size={17} />}
          title="Apply"
          detail="Continue when this summary is ready for confirmation."
        />
        <div className="import-apply__action">
          <button className="primary-action" type="button" onClick={onContinue}>
            Continue to confirmation
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </div>
      </section>
    </div>
  );
}

function RecordLedger({
  inspection,
}: {
  inspection: ImportInspection;
}) {
  return (
    <div className="import-ledger">
      <section className="import-ledger__section">
        <LedgerHeading
          icon={<FolderSearch size={17} />}
          title="Repository identity"
          detail="The source snapshot this baseline represents."
        />
        <dl className="import-identity">
          <div><dt>Branch</dt><dd>{inspection.repository.branch ?? "Detached"}</dd></div>
          <div><dt>HEAD</dt><dd>{inspection.repository.head ?? "Unavailable"}</dd></div>
          <div><dt>Repository fingerprint</dt><dd>{inspection.repository.fingerprint}</dd></div>
          <div><dt>Inspection digest</dt><dd>{inspection.manifestDigest}</dd></div>
        </dl>
      </section>

      <section className="import-ledger__section">
        <LedgerHeading
          icon={<Check size={17} />}
          title="Baseline counts"
          detail="A compact inventory of the records proposed by this scan."
        />
        <div className="import-count-groups">
          <div>
            <h3>By record type</h3>
            <ul>
              {inspection.counts.recordsByKind.map(({ kind, count }) => (
                <li key={kind}>{recordCountLabel(kind, count)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>By status</h3>
            <ul>
              {inspection.counts.recordsByStatus.map(({ status, count }) => (
                <li key={status}>{count} {readableToken(status)}</li>
              ))}
            </ul>
          </div>
          <div>
            <h3>By source</h3>
            <ul>
              {inspection.counts.recordsBySourceKind.map(
                ({ sourceKind, count }) => (
                  <li key={sourceKind}>
                    {count} {readableToken(sourceKind)}
                  </li>
                ),
              )}
            </ul>
          </div>
        </div>
      </section>

      <section className="import-ledger__section">
        <LedgerHeading
          icon={<ShieldCheck size={17} />}
          title="Stable frame"
          detail="Outcomes, constraints, and accepted decisions found in the repository."
        />
        <ul className="import-records">
          {inspection.stableFrame.length > 0
            ? inspection.stableFrame.map((record) => (
                <li key={record.key}>
                  <div>
                    <span>{readableToken(record.kind)}</span>
                    <strong>{record.title}</strong>
                  </div>
                  <p>{record.sourceRef ?? "No source path"}</p>
                </li>
              ))
            : <li className="import-records__empty">No stable-frame records found.</li>}
        </ul>
      </section>

      <section className="import-ledger__section">
        <LedgerHeading
          icon={<Check size={17} />}
          title="Active tasks"
          detail="Work presented as active in the scanned baseline."
        />
        <ul className="import-records">
          {inspection.activeTasks.length > 0
            ? inspection.activeTasks.map((task) => (
                <li className="import-active-task" key={task.key}>
                  <div>
                    <span>{task.kind}</span>
                    <strong>{task.title}</strong>
                  </div>
                  <p>{task.sourceRef ?? "No source path"}</p>
                  {task.directLinks.length > 0
                    ? (
                        <div
                          className="import-relationships"
                          aria-label={`Relationships for ${task.title}`}
                        >
                          <p>Related records</p>
                          <dl>
                            {task.directLinks.map((relationship, index) => {
                              const relatedKey =
                                relationship.fromKey === task.key
                                  ? relationship.toKey
                                  : relationship.fromKey;
                              return (
                                <div
                                  key={[
                                    relationship.fromKey,
                                    relationship.kind,
                                    relationship.toKey,
                                    index,
                                  ].join("-")}
                                >
                                  <dt>{readableToken(relationship.kind)}</dt>
                                  <dd>{relatedKey}</dd>
                                </div>
                              );
                            })}
                          </dl>
                        </div>
                      )
                    : <span className="import-relationships__empty">No direct relationships</span>}
                </li>
              ))
            : <li className="import-records__empty">No active tasks found.</li>}
        </ul>
      </section>

      <div className="import-ledger__split">
        <section className="import-ledger__section">
          <LedgerHeading
            icon={<AlertTriangle size={17} />}
            title="Warning details"
          />
          <ul className="import-count-list">
            {inspection.warnings.length > 0
              ? inspection.warnings.map((warning) => (
                  <li key={warning.code}>
                    <span>{readableToken(warning.code)}</span>
                    <strong>{warning.count}</strong>
                  </li>
                ))
              : <li><span>No warnings</span><strong>0</strong></li>}
          </ul>
        </section>

        <section className="import-ledger__section">
          <LedgerHeading icon={<FileWarning size={17} />} title="Exclusions" />
          <ul className="import-count-list">
            {inspection.exclusions.length > 0
              ? inspection.exclusions.map((exclusion, index) => (
                  <li key={`${exclusion.reason}-${exclusion.path ?? index}`}>
                    <span>
                      {exclusion.path ?? readableToken(exclusion.reason)}
                      {exclusion.path
                        ? <small>{readableToken(exclusion.reason)}</small>
                        : null}
                    </span>
                    <strong>{exclusion.count}</strong>
                  </li>
                ))
              : <li><span>No exclusions</span><strong>0</strong></li>}
          </ul>
        </section>
      </div>

      <div className="import-ledger__split">
        <section className="import-ledger__section">
          <LedgerHeading
            icon={<ShieldCheck size={17} />}
            title="Sensitive findings"
            detail="Counts only; sensitive content is not displayed."
          />
          <ul className="import-count-list">
            {inspection.sensitiveFindings.length > 0
              ? inspection.sensitiveFindings.map((finding) => (
                  <li key={`${finding.category}-${finding.severity}`}>
                    <span>
                      {finding.count} {readableToken(finding.category)} findings
                      <small>{readableToken(finding.severity)}</small>
                    </span>
                    <strong>{finding.count}</strong>
                  </li>
                ))
              : <li><span>No sensitive findings</span><strong>0</strong></li>}
          </ul>
        </section>

        <section className="import-ledger__section">
          <LedgerHeading
            icon={<FileWarning size={17} />}
            title="Provisional claims"
            detail="Review these inferences before they enter the project archive."
          />
          <ul className="import-records">
            {inspection.curatedOrProvisionalClaims.length > 0
              ? inspection.curatedOrProvisionalClaims.map((claim) => (
                  <li key={claim.key}>
                    <div>
                      <span>{readableToken(claim.status)}</span>
                      <strong>{claim.title}</strong>
                    </div>
                    <p>{claim.curationReason ?? "Repository-derived claim"}</p>
                  </li>
                ))
              : <li className="import-records__empty">No provisional claims.</li>}
          </ul>
        </section>
      </div>
    </div>
  );
}

export function ImportProjectScreen({
  onProjectApplied,
}: ImportProjectScreenProps) {
  const [repositoryPath, setRepositoryPath] = useState("");
  const [canonicalSubpath, setCanonicalSubpath] = useState("");
  const [browseError, setBrowseError] = useState<string | null>(null);
  const [state, setState] = useState<ImportState>({
    status: "select",
    error: null,
  });
  const controllerRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const inspectionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const confirmationHeadingRef = useRef<HTMLHeadingElement | null>(null);

  useEffect(() => () => {
    generationRef.current += 1;
    controllerRef.current?.abort();
  }, []);

  const scan = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!repositoryPath.trim()) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    setState({ status: "scanning" });
    try {
      const response = await apiRequest<ImportScanResponse>(
        "/api/imports/scan",
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            repositoryPath: repositoryPath.trim(),
            canonicalSubpath: canonicalSubpath.trim() || null,
          }),
        },
      );
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      setState({
        status: "review",
        manifest: response.manifest,
        inspection: response.inspection,
        phase: "inspection",
        reviewed: false,
        applying: false,
        error: null,
      });
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      setState({ status: "select", error: scanErrorMessage });
    }
  }, [canonicalSubpath, repositoryPath]);

  const changeRepositoryPath = useCallback((value: string) => {
    setRepositoryPath(value);
    setBrowseError(null);
    setState((current) =>
      current.status === "review" || current.status === "select"
        ? { status: "select", error: null }
        : current
    );
  }, []);

  const changeCanonicalSubpath = useCallback((value: string) => {
    setCanonicalSubpath(value);
    setState((current) =>
      current.status === "review" || current.status === "select"
        ? { status: "select", error: null }
        : current
    );
  }, []);

  const chooseRepository = useCallback(async () => {
    try {
      const path = await window.intentArcDesktop?.repository.chooseRepositoryDirectory();
      if (path) changeRepositoryPath(path);
    } catch {
      setBrowseError(browseErrorMessage);
    }
  }, [changeRepositoryPath]);

  const apply = useCallback(async () => {
    if (
      state.status !== "review" ||
      state.phase !== "confirmation" ||
      !state.reviewed ||
      state.applying
    ) return;
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    const generation = ++generationRef.current;
    setState((current) => current.status === "review"
      ? { ...current, applying: true, error: null }
      : current);
    try {
      const { result } = await apiRequest<ImportApplyResponse>(
        "/api/imports/apply",
        {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            manifest: state.manifest,
            confirmedDigest: state.inspection.manifestDigest,
          }),
        },
      );
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      await onProjectApplied(result.projectId, controller.signal);
    } catch (reason) {
      if (controller.signal.aborted || generation !== generationRef.current) {
        return;
      }
      setState((current) => current.status === "review"
        ? {
            ...current,
            applying: false,
            error: importErrorMessage(reason),
          }
        : current);
    }
  }, [onProjectApplied, state]);

  const showingInspection = state.status === "review" &&
    state.phase === "inspection";
  const showingConfirmation = state.status === "review" &&
    state.phase === "confirmation";

  useEffect(() => {
    if (showingInspection) inspectionHeadingRef.current?.focus();
  }, [showingInspection]);

  useEffect(() => {
    if (showingConfirmation) confirmationHeadingRef.current?.focus();
  }, [showingConfirmation]);

  const stage: 1 | 2 | 3 = state.status === "review"
    ? state.phase === "confirmation" ? 3 : 2
    : 1;

  return (
    <div className="import-dossier">
      <StageRail stage={stage} />
      <form className="import-source" onSubmit={scan}>
        <div className="import-source__fields">
          <div className="field">
            <label htmlFor="import-repository-path">Repository path</label>
            <div className="import-path-picker">
              <input
                id="import-repository-path"
                required
                maxLength={4_096}
                value={repositoryPath}
                onChange={(event) => changeRepositoryPath(event.target.value)}
                placeholder="C:\projects\your-project"
                disabled={state.status === "scanning" ||
                  (state.status === "review" && state.applying)}
              />
              {window.intentArcDesktop
                ? (
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={chooseRepository}
                      disabled={state.status === "scanning" ||
                        (state.status === "review" && state.applying)}
                    >
                      Browse…
                    </button>
                  )
                : null}
            </div>
          </div>
          <div className="field import-source__canonical">
            <label htmlFor="import-canonical-subpath">
              Canonical subpath <span>optional</span>
            </label>
            <input
              id="import-canonical-subpath"
              maxLength={1_024}
              value={canonicalSubpath}
              onChange={(event) => changeCanonicalSubpath(event.target.value)}
              placeholder="app"
              disabled={state.status === "scanning" ||
                (state.status === "review" && state.applying)}
            />
          </div>
        </div>
        <button
          className="secondary-action"
          type="submit"
          disabled={state.status === "scanning" ||
            (state.status === "review" && state.applying)}
        >
          <FolderSearch size={16} aria-hidden="true" />
          {state.status === "review" ? "Scan again" : "Scan repository"}
        </button>
        <p
          className="import-source__safety"
          role="note"
          aria-label="Import safety"
        >
          IntentArc does not run repository code. You review the scan before
          anything is applied.
        </p>
      </form>

      {state.status === "scanning"
        ? (
            <p className="import-scan-status" aria-live="polite">
              <span aria-hidden="true" />
              Scanning repository…
            </p>
          )
        : null}

      {state.status === "select" && state.error
        ? <p className="form-error import-scan-error" role="alert">{state.error}</p>
        : null}
      {browseError
        ? <p className="form-error import-scan-error" role="alert">{browseError}</p>
        : null}

      {state.status === "review"
        ? (
            <>
              {state.phase === "inspection"
                ? (
                    <>
                      <ReviewSummary
                        inspection={state.inspection}
                        headingRef={inspectionHeadingRef}
                        onContinue={() => setState((current) =>
                          current.status === "review"
                            ? {
                                ...current,
                                phase: "confirmation",
                                reviewed: false,
                                error: null,
                              }
                            : current
                        )}
                      />
                      <details className="import-technical-details">
                        <summary>Review technical details</summary>
                        <RecordLedger inspection={state.inspection} />
                      </details>
                    </>
                  )
                : (
                    <section
                      className="import-confirm"
                      aria-labelledby="import-confirm-title"
                    >
                      <div>
                        <p className="import-source__kicker">Confirmation</p>
                        <h2
                          id="import-confirm-title"
                          ref={confirmationHeadingRef}
                          tabIndex={-1}
                        >
                          Apply this baseline
                        </h2>
                        <p>
                          Imported knowledge remains provisional where the
                          inspection says so. Repository files are never modified.
                        </p>
                      </div>
                      <label className="import-review-check">
                        <input
                          type="checkbox"
                          aria-label="I reviewed this baseline"
                          checked={state.reviewed}
                          disabled={state.applying}
                          onChange={(event) => setState((current) =>
                            current.status === "review"
                              ? {
                                  ...current,
                                  reviewed: event.target.checked,
                                  error: null,
                                }
                              : current
                          )}
                        />
                        <span>
                          <strong>I reviewed this baseline</strong>
                          <small>
                            Confirm the stable frame, active tasks, warnings,
                            exclusions, and provisional claims from the inspection.
                          </small>
                        </span>
                      </label>
                      {state.error
                        ? <p className="form-error" role="alert">{state.error}</p>
                        : null}
                      <div className="import-confirm__actions">
                        <button
                          className="secondary-action"
                          type="button"
                          disabled={state.applying}
                          onClick={() => setState((current) =>
                            current.status === "review"
                              ? {
                                  ...current,
                                  phase: "inspection",
                                  reviewed: false,
                                  error: null,
                                }
                              : current
                          )}
                        >
                          <ArrowLeft size={16} aria-hidden="true" />
                          Back to inspection
                        </button>
                        <button
                          className="primary-action"
                          type="button"
                          disabled={!state.reviewed || state.applying}
                          onClick={apply}
                        >
                          <ShieldCheck size={16} aria-hidden="true" />
                          {state.applying
                            ? "Applying baseline…"
                            : "Apply imported baseline"}
                        </button>
                      </div>
                    </section>
                  )}
            </>
          )
        : null}
    </div>
  );
}
