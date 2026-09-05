import {
  BookOpen,
  Cable,
  CheckCircle2,
  CircleOff,
  RotateCw,
  ShieldCheck,
  Unplug,
  X,
} from "lucide-react";
import {
  type MouseEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  DesktopAiAdapterId,
  DesktopAiApi,
  DesktopAiCatalog,
  DesktopAiConnectionState,
  DesktopManualConnectionSetup,
  DesktopManualConnectionSummary,
} from "../desktop-api.js";
import { AsyncState } from "../components/async-state.js";
import { StatusChip, type StatusTone } from "../components/status-chip.js";
import { navigate } from "../router.js";
import {
  AiConnectionGuide,
  OtherAiConnectionGuide,
} from "./ai-connection-guides.js";

type ConnectionListState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      catalog: DesktopAiCatalog;
      refreshing: boolean;
      refreshError: string | null;
    };

type ReviewState = {
  adapterId: DesktopAiAdapterId;
  action: "connect" | "remove";
};

type AutomaticCatalogOverlay = {
  readonly status: DesktopAiConnectionState["status"];
  readonly profileId: string | null;
  readonly fallback: DesktopAiConnectionState;
};

type ManualDialogState =
  | { readonly kind: "setup"; readonly setup: DesktopManualConnectionSetup | null }
  | {
      readonly kind: "remove";
      readonly connection: DesktopManualConnectionSummary;
    };

type CatalogRefreshFocusTarget =
  | { readonly kind: "card-heading"; readonly adapterId: DesktopAiAdapterId }
  | { readonly kind: "recovery-heading" }
  | { readonly kind: "manual-heading" };

const adapterDetails: Readonly<Record<DesktopAiAdapterId, {
  label: string;
  accountName: string;
}>> = {
  codex: {
    label: "Codex",
    accountName: "ChatGPT",
  },
  "claude-code": {
    label: "Claude Code",
    accountName: "Anthropic",
  },
};

const messageFrom = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback;

const normalizeCatalog = (catalog: DesktopAiCatalog): DesktopAiCatalog => ({
  automatic: catalog.automatic,
  manual: catalog.manual ?? [],
});

const emptyCatalog: DesktopAiCatalog = { automatic: [], manual: [] };

const downgradeConnectedClaims = (
  catalog: DesktopAiCatalog,
): DesktopAiCatalog => ({
  ...catalog,
  automatic: catalog.automatic.map((connection) =>
    connection.status === "connected"
      ? { ...connection, status: "unknown" }
      : connection
  ),
});

const displayStatus = (
  connection: DesktopAiConnectionState,
  restartRequired: boolean,
): { label: string; tone: StatusTone } => {
  if (connection.availability === "not_detected") {
    return { label: "Not detected", tone: "neutral" };
  }
  if (connection.availability === "setup_required") {
    return { label: "Additional setup needed", tone: "attention" };
  }
  if (connection.status === "unknown") {
    return { label: "Connection needs attention", tone: "attention" };
  }
  if (restartRequired) {
    return { label: "Restart required", tone: "attention" };
  }
  if (connection.status === "connected") {
    return { label: "Connected", tone: "active" };
  }
  return { label: "Ready to connect", tone: "active" };
};

const followInternalLink = (
  event: MouseEvent<HTMLAnchorElement>,
  path: string,
) => {
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

export interface AiConnectionsProps {
  readonly ai: DesktopAiApi;
}

export function AiConnections({ ai }: AiConnectionsProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [listState, setListState] = useState<ConnectionListState>({
    status: "loading",
  });
  const [review, setReview] = useState<ReviewState | null>(null);
  const [manualDialog, setManualDialog] = useState<ManualDialogState | null>(
    null,
  );
  const [openGuide, setOpenGuide] = useState<DesktopAiAdapterId | null>(null);
  const [pendingAdapter, setPendingAdapter] =
    useState<DesktopAiAdapterId | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [manualError, setManualError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [manualPending, setManualPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [restartRequired, setRestartRequired] = useState<
    Partial<Record<DesktopAiAdapterId, boolean>>
  >({});
  const dialogRef = useRef<HTMLElement>(null);
  const recoveryHeadingRef = useRef<HTMLHeadingElement>(null);
  const manualHeadingRef = useRef<HTMLHeadingElement>(null);
  const manualDialogRef = useRef<HTMLElement>(null);
  const manualCloseButtonRef = useRef<HTMLButtonElement>(null);
  const manualConfirmationButtonRef = useRef<HTMLButtonElement>(null);
  const manualResultHeadingRef = useRef<HTMLHeadingElement>(null);
  const manualTriggerRef = useRef<HTMLButtonElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const confirmationButtonRef = useRef<HTMLButtonElement>(null);
  const reviewTriggerRef = useRef<HTMLButtonElement | null>(null);
  const connectionHeadingRefs = useRef<
    Partial<Record<DesktopAiAdapterId, HTMLHeadingElement | null>>
  >({});
  const postMutationFocusRef = useRef<DesktopAiAdapterId | null>(null);
  const catalogRefreshFocusRef = useRef<CatalogRefreshFocusTarget | null>(
    null,
  );
  const restoreFailureFocusRef = useRef(false);
  const restoreReviewFocusRef = useRef(false);
  const restoreManualFocusRef = useRef(false);
  const restoreManualFailureFocusRef = useRef(false);
  const latestListRequestRef = useRef(0);
  const catalogMutationGenerationRef = useRef(0);
  const automaticCatalogOverlaysRef = useRef(
    new Map<DesktopAiAdapterId, AutomaticCatalogOverlay>(),
  );
  const failedHealthAdaptersRef = useRef(new Set<DesktopAiAdapterId>());
  const manualCatalogUpsertsRef = useRef(
    new Map<string, DesktopManualConnectionSummary>(),
  );
  const manualCatalogRemovalsRef = useRef(new Set<string>());

  const reconcileCatalogSnapshot = useCallback((snapshot: DesktopAiCatalog) => {
    const normalized = normalizeCatalog(snapshot);
    const seenAutomatic = new Set<DesktopAiAdapterId>();
    const automatic = normalized.automatic.map((connection) => {
      seenAutomatic.add(connection.adapterId);
      const overlay = automaticCatalogOverlaysRef.current.get(
        connection.adapterId,
      );
      let reconciled = connection;
      if (overlay && !(
        connection.status === overlay.status &&
        connection.profileId === overlay.profileId
      )) {
        reconciled = {
          ...connection,
          status: overlay.status,
          profileId: overlay.profileId,
        };
      }
      return failedHealthAdaptersRef.current.has(connection.adapterId) &&
          reconciled.status === "connected"
        ? { ...reconciled, status: "unknown" as const }
        : reconciled;
    });
    for (const [adapterId, overlay] of automaticCatalogOverlaysRef.current) {
      if (!seenAutomatic.has(adapterId)) {
        automatic.push(
          failedHealthAdaptersRef.current.has(adapterId) &&
              overlay.fallback.status === "connected"
            ? { ...overlay.fallback, status: "unknown" as const }
            : overlay.fallback,
        );
      }
    }
    automaticCatalogOverlaysRef.current.clear();

    const manual = normalized.manual.filter((connection) => {
      if (!manualCatalogRemovalsRef.current.has(connection.id)) return true;
      return false;
    });
    manualCatalogRemovalsRef.current.clear();
    for (const [id, overlay] of manualCatalogUpsertsRef.current) {
      const index = manual.findIndex((connection) => connection.id === id);
      if (index < 0) manual.push(overlay);
    }
    manualCatalogUpsertsRef.current.clear();
    return { automatic, manual };
  }, []);

  useEffect(() => {
    let active = true;
    const requestId = latestListRequestRef.current + 1;
    latestListRequestRef.current = requestId;
    const mutationGeneration = catalogMutationGenerationRef.current;
    setListState((current) => current.status === "ready"
      ? { ...current, refreshing: true, refreshError: null }
      : { status: "loading" });
    ai.list().then(
      (catalog) => {
        if (
          !active ||
          requestId !== latestListRequestRef.current ||
          mutationGeneration !== catalogMutationGenerationRef.current
        ) return;
        setListState({
          status: "ready",
          catalog: reconcileCatalogSnapshot(catalog),
          refreshing: false,
          refreshError: null,
        });
      },
      (reason: unknown) => {
        if (
          !active ||
          requestId !== latestListRequestRef.current ||
          mutationGeneration !== catalogMutationGenerationRef.current
        ) return;
        for (const [adapterId, overlay] of automaticCatalogOverlaysRef.current) {
          if (
            overlay.status === "connected" ||
            overlay.fallback.status === "connected"
          ) {
            automaticCatalogOverlaysRef.current.delete(adapterId);
          }
        }
        const message = messageFrom(reason, "Could not check AI clients.");
        setListState((current) => current.status === "ready"
          ? {
              ...current,
              catalog: downgradeConnectedClaims(current.catalog),
              refreshing: false,
              refreshError: message,
            }
          : { status: "error", message });
      },
    );
    return () => {
      active = false;
    };
  }, [ai, reconcileCatalogSnapshot, reloadKey]);

  const closeReview = useCallback(() => {
    if (pendingAdapter) return;
    restoreReviewFocusRef.current = true;
    setOperationError(null);
    setReview(null);
  }, [pendingAdapter]);

  useLayoutEffect(() => {
    if (review) {
      closeButtonRef.current?.focus();
      return;
    }
    const postMutationAdapter = postMutationFocusRef.current;
    if (postMutationAdapter) {
      postMutationFocusRef.current = null;
      connectionHeadingRefs.current[postMutationAdapter]?.focus();
      return;
    }
    if (!restoreReviewFocusRef.current) return;
    restoreReviewFocusRef.current = false;
    reviewTriggerRef.current?.focus();
  }, [review]);

  useLayoutEffect(() => {
    if (listState.status !== "ready") return;
    const focusTarget = catalogRefreshFocusRef.current;
    if (!focusTarget) return;
    if (listState.refreshing) return;
    if (listState.refreshError && focusTarget.kind !== "manual-heading") return;
    const firstAdapterId = listState.catalog.automatic[0]?.adapterId;
    const element = focusTarget.kind === "card-heading"
      ? connectionHeadingRefs.current[focusTarget.adapterId]
      : focusTarget.kind === "manual-heading"
        ? manualHeadingRef.current
        : recoveryHeadingRef.current ?? (firstAdapterId
          ? connectionHeadingRefs.current[firstAdapterId]
          : null);
    if (!element) return;
    catalogRefreshFocusRef.current = null;
    element.focus();
  }, [listState]);

  useLayoutEffect(() => {
    if (!review || pendingAdapter || !restoreFailureFocusRef.current) return;
    restoreFailureFocusRef.current = false;
    confirmationButtonRef.current?.focus();
  }, [pendingAdapter, review]);

  const closeManualDialog = useCallback(() => {
    if (manualPending) return;
    restoreManualFocusRef.current = true;
    setManualError(null);
    setCopyStatus(null);
    setManualDialog(null);
  }, [manualPending]);

  const manualDialogOpen = manualDialog !== null;
  const manualSetupCreated = manualDialog?.kind === "setup" &&
    manualDialog.setup !== null;

  useLayoutEffect(() => {
    if (manualDialogOpen) {
      manualCloseButtonRef.current?.focus();
      return;
    }
    if (!restoreManualFocusRef.current) return;
    restoreManualFocusRef.current = false;
    manualTriggerRef.current?.focus();
  }, [manualDialogOpen]);

  useLayoutEffect(() => {
    if (!manualSetupCreated) return;
    manualResultHeadingRef.current?.focus();
  }, [manualSetupCreated]);

  useLayoutEffect(() => {
    if (
      !manualDialog ||
      manualPending ||
      !restoreManualFailureFocusRef.current
    ) return;
    restoreManualFailureFocusRef.current = false;
    manualConfirmationButtonRef.current?.focus();
  }, [manualDialog, manualPending]);

  useEffect(() => {
    if (!manualDialog) return;
    const containDialogFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeManualDialog();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = manualDialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href], input:not(:disabled)",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!dialog || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", containDialogFocus);
    return () => window.removeEventListener("keydown", containDialogFocus);
  }, [closeManualDialog, manualDialog]);

  useEffect(() => {
    if (!review) return;
    const containDialogFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        closeReview();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), a[href]",
      );
      const first = controls?.[0];
      const last = controls?.[controls.length - 1];
      if (!dialog || !first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!dialog.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", containDialogFocus);
    return () => window.removeEventListener("keydown", containDialogFocus);
  }, [closeReview, review]);

  const replaceConnection = useCallback((
    adapterId: DesktopAiAdapterId,
    update: (
      current: DesktopAiConnectionState,
    ) => DesktopAiConnectionState,
  ) => {
    setListState((current) =>
      current.status === "ready"
        ? {
            ...current,
            catalog: {
              ...current.catalog,
              automatic: current.catalog.automatic.map((connection) =>
                connection.adapterId === adapterId
                  ? update(connection)
                  : connection
              ),
            },
          }
        : current
    );
  }, []);

  const refreshCatalog = (focusTarget: CatalogRefreshFocusTarget) => {
    catalogRefreshFocusRef.current = focusTarget;
    setOpenGuide(null);
    setNotice(null);
    setListState((current) => current.status === "ready"
      ? { ...current, refreshing: true, refreshError: null }
      : { status: "loading" });
    setReloadKey((key) => key + 1);
  };

  const retryCatalog = () => {
    setListState((current) => current.status === "ready"
      ? { ...current, refreshing: true, refreshError: null }
      : { status: "loading" });
    setReloadKey((key) => key + 1);
  };

  const reconcileAfterMutation = () => {
    catalogMutationGenerationRef.current += 1;
    setReloadKey((key) => key + 1);
  };

  const rememberAutomaticMutation = (
    adapterId: DesktopAiAdapterId,
    status: DesktopAiConnectionState["status"],
    profileId: string | null,
    replacement?: DesktopAiConnectionState,
  ) => {
    const current = listState.status === "ready"
      ? listState.catalog.automatic.find((connection) =>
          connection.adapterId === adapterId
        )
      : null;
    const fallback = replacement ?? (current
      ? { ...current, status, profileId }
      : {
          adapterId,
          status,
          profileId,
          availability: "ready",
          availabilityReason: "connector_ready",
          version: null,
        });
    automaticCatalogOverlaysRef.current.set(adapterId, {
      status,
      profileId,
      fallback,
    });
  };

  const openReview = (
    event: MouseEvent<HTMLButtonElement>,
    next: ReviewState,
  ) => {
    reviewTriggerRef.current = event.currentTarget;
    setOperationError(null);
    setReview(next);
  };

  const openManualSetup = (event: MouseEvent<HTMLButtonElement>) => {
    manualTriggerRef.current = event.currentTarget;
    setManualError(null);
    setCopyStatus(null);
    setManualDialog({ kind: "setup", setup: null });
  };

  const openManualRemoval = (
    event: MouseEvent<HTMLButtonElement>,
    connection: DesktopManualConnectionSummary,
  ) => {
    manualTriggerRef.current = event.currentTarget;
    setManualError(null);
    setCopyStatus(null);
    setManualDialog({ kind: "remove", connection });
  };

  const createManualSetup = async (label: string) => {
    if (manualPending) return;
    setManualPending(true);
    setManualError(null);
    setCopyStatus(null);
    try {
      const setup = await ai.createManual({ label });
      const summary: DesktopManualConnectionSummary = {
        id: setup.id,
        label: setup.label,
        profileId: setup.profileId,
        state: setup.state,
        createdAt: setup.createdAt,
      };
      manualCatalogRemovalsRef.current.delete(setup.id);
      manualCatalogUpsertsRef.current.set(setup.id, summary);
      reconcileAfterMutation();
      setListState((current) => current.status === "ready"
        ? {
            ...current,
            catalog: {
              ...current.catalog,
              manual: [
                ...current.catalog.manual.filter(({ id }) => id !== setup.id),
                summary,
              ],
            },
          }
        : current);
      setManualDialog({ kind: "setup", setup });
    } catch (reason) {
      restoreManualFailureFocusRef.current = true;
      setManualError(messageFrom(
        reason,
        "Could not create MCP setup details.",
      ));
    } finally {
      setManualPending(false);
    }
  };

  const removeManualSetup = async () => {
    if (manualDialog?.kind !== "remove" || manualPending) return;
    const { connection } = manualDialog;
    setManualPending(true);
    setManualError(null);
    setNotice(null);
    try {
      await ai.removeManual(connection.id);
      manualCatalogUpsertsRef.current.delete(connection.id);
      manualCatalogRemovalsRef.current.add(connection.id);
      reconcileAfterMutation();
      catalogRefreshFocusRef.current = { kind: "manual-heading" };
      restoreManualFocusRef.current = false;
      setListState((current) => current.status === "ready"
        ? {
            ...current,
            refreshing: true,
            refreshError: null,
            catalog: {
              ...current.catalog,
              manual: current.catalog.manual.filter(({ id }) =>
                id !== connection.id
              ),
            },
          }
        : current);
      setManualDialog(null);
      setNotice(
        `${connection.label} setup was removed from IntentArc. Remove its MCP server from the external tool separately.`,
      );
    } catch (reason) {
      restoreManualFailureFocusRef.current = true;
      setManualError(messageFrom(reason, "Could not remove MCP setup."));
    } finally {
      setManualPending(false);
    }
  };

  const copySetupValue = async (value: string, label: string) => {
    try {
      if (!navigator.clipboard?.writeText) {
        throw new Error("Clipboard unavailable.");
      }
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus(
        `${label} could not be copied. Select the value and copy it manually.`,
      );
    }
  };

  const confirmReview = async () => {
    if (!review || pendingAdapter) return;
    const { adapterId, action } = review;
    const label = adapterDetails[adapterId].label;
    setPendingAdapter(adapterId);
    setOperationError(null);
    setNotice(null);
    try {
      if (action === "connect") {
        const result = await ai.connect(adapterId);
        failedHealthAdaptersRef.current.delete(adapterId);
        rememberAutomaticMutation(
          adapterId,
          result.status,
          result.profileId,
        );
        reconcileAfterMutation();
        replaceConnection(adapterId, (current) => ({
          ...current,
          status: result.status,
          profileId: result.profileId,
        }));
        setRestartRequired((current) => ({
          ...current,
          [adapterId]: result.restartRequired,
        }));
        setNotice(
          result.restartRequired
            ? `Restart ${label} to finish the connection.`
            : `${label} is connected to IntentArc.`,
        );
      } else {
        const result = await ai.remove(adapterId);
        failedHealthAdaptersRef.current.delete(adapterId);
        rememberAutomaticMutation(
          adapterId,
          result.status,
          result.profileId,
        );
        reconcileAfterMutation();
        replaceConnection(adapterId, (current) => ({
          ...current,
          status: result.status,
          profileId: result.profileId,
        }));
        setRestartRequired((current) => ({
          ...current,
          [adapterId]: false,
        }));
        setNotice(`${label} is no longer connected to IntentArc.`);
      }
      postMutationFocusRef.current = adapterId;
      setReview(null);
    } catch (reason) {
      restoreFailureFocusRef.current = true;
      setOperationError(messageFrom(
        reason,
        `Could not ${action} ${label}.`,
      ));
    } finally {
      setPendingAdapter(null);
    }
  };

  const testConnection = async (adapterId: DesktopAiAdapterId) => {
    if (pendingAdapter) return;
    const label = adapterDetails[adapterId].label;
    setPendingAdapter(adapterId);
    setNotice(null);
    try {
      const result = await ai.test(adapterId);
      if (result.status === "connected") {
        failedHealthAdaptersRef.current.delete(adapterId);
      }
      rememberAutomaticMutation(
        adapterId,
        result.status,
        result.profileId,
        result,
      );
      reconcileAfterMutation();
      replaceConnection(adapterId, () => result);
      if (result.status === "connected") {
        setRestartRequired((current) => ({
          ...current,
          [adapterId]: false,
        }));
      }
      setNotice(
        result.status === "connected"
          ? `${label} connection is ready.`
          : `${label} connection needs attention. Try connecting it again.`,
      );
    } catch (reason) {
      failedHealthAdaptersRef.current.add(adapterId);
      replaceConnection(adapterId, (current) => ({
        ...current,
        status: "unknown",
      }));
      setRestartRequired((currentRestartRequired) => ({
        ...currentRestartRequired,
        [adapterId]: false,
      }));
      setNotice(messageFrom(reason, `Could not test ${label}.`));
    } finally {
      setPendingAdapter(null);
    }
  };

  const catalog = listState.status === "ready"
    ? listState.catalog
    : emptyCatalog;
  const reviewedConnection = review
    ? catalog.automatic.find(({ adapterId }) =>
        adapterId === review.adapterId
      ) ?? null
    : null;
  const manualSetup = manualDialog?.kind === "setup"
    ? manualDialog.setup
    : null;
  const manualConnections = catalog.manual;
  const noAutomaticConnectorReady = !catalog.automatic.some(
    ({ availability }) => availability === "ready",
  );
  const showRecovery = listState.status === "ready" &&
    noAutomaticConnectorReady;

  return (
    <div className="ai-connections">
      {listState.status === "loading"
        ? (
            <AsyncState
              state="loading"
              message="Looking for supported AI clients…"
            />
          )
        : listState.status === "error"
          ? (
              <AsyncState
                state="error"
                title="Could not check AI clients"
                message={listState.message}
                action={
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={retryCatalog}
                  >
                    Try again
                  </button>
                }
              />
            )
          : listState.refreshError
            ? (
                <AsyncState
                  state="error"
                  title="Could not refresh AI clients"
                  message={listState.refreshError}
                  action={
                    <button
                      className="secondary-action"
                      type="button"
                      onClick={retryCatalog}
                    >
                      Try again
                    </button>
                  }
                />
              )
            : null}
      <section
        className={showRecovery
          ? "connection-recovery"
          : "connection-recovery connection-other-tool"}
        aria-labelledby="connection-entry-title"
      >
        <div className="connection-recovery__mark" aria-hidden="true">
          {showRecovery ? <CircleOff size={21} /> : <Cable size={21} />}
        </div>
        <div className="connection-recovery__copy">
          <p className="connection-card__kind">
            {showRecovery ? "Keep moving" : "Local MCP client"}
          </p>
          <h2
            ref={showRecovery ? recoveryHeadingRef : undefined}
            id="connection-entry-title"
            tabIndex={showRecovery ? -1 : undefined}
          >
            {showRecovery
              ? "No automatic AI connection is ready"
              : "Use another AI tool"}
          </h2>
          {showRecovery
            ? (
                <p>
                  Install or finish setting up a preferred supported client,
                  then check again. You can also use another AI tool or
                  continue without AI.
                </p>
              )
            : (
                <p>
                  Create setup details for another AI client that can start a
                  local MCP server, or continue using IntentArc without AI.
                </p>
              )}
        </div>
        <div className="connection-recovery__actions">
          {showRecovery
            ? (
                <button
                  key="check-again"
                  className="secondary-action"
                  type="button"
                  onClick={() =>
                    refreshCatalog({ kind: "recovery-heading" })}
                >
                  <RotateCw aria-hidden="true" size={16} />
                  Check again
                </button>
              )
            : null}
          <button
            key="other-ai-tool"
            className={showRecovery ? "text-link" : "secondary-action"}
            type="button"
            onClick={openManualSetup}
          >
            Use another AI tool
          </button>
          <a
            key="continue-without-ai"
            className="text-link"
            href="/"
            onClick={(event) => followInternalLink(event, "/")}
          >
            Continue without AI
          </a>
        </div>
      </section>
      <div className="connection-ledger">
        {catalog.automatic.map((connection) => {
          const detail = adapterDetails[connection.adapterId];
          const status = displayStatus(
            connection,
            Boolean(restartRequired[connection.adapterId]),
          );
          const busy = pendingAdapter === connection.adapterId;
          const connectorReady = connection.availability === "ready";
          const connected = connectorReady && connection.status === "connected";
          const readyToConnect = connectorReady &&
            connection.status === "not_connected";
          const needsReview = connectorReady && connection.status === "unknown";
          const guideOpen = openGuide === connection.adapterId;
          const guideId = `${connection.adapterId}-connection-guide`;
          const guideActionLabel = connection.availability === "not_detected"
            ? `Installation guide for ${detail.label}`
            : `How to connect ${detail.label}`;
          return (
            <article
              key={connection.adapterId}
              className="connection-card"
              aria-label={detail.label}
            >
              <div className="connection-card__rail" aria-hidden="true">
                {connected
                  ? <CheckCircle2 size={19} />
                  : !readyToConnect
                    ? <CircleOff size={19} />
                    : <Cable size={19} />}
              </div>
              <div className="connection-card__main">
                <header className="connection-card__header">
                  <div>
                    <p className="connection-card__kind">AI client</p>
                    <h2
                      ref={(element) => {
                        connectionHeadingRefs.current[connection.adapterId] =
                          element;
                      }}
                      tabIndex={-1}
                    >
                      {detail.label}
                    </h2>
                  </div>
                  <StatusChip tone={status.tone}>{status.label}</StatusChip>
                </header>
                <dl className="connection-card__facts">
                  <div>
                    <dt>Availability</dt>
                    <dd>{
                      connection.availability === "ready"
                        ? "Ready"
                        : connection.availability === "not_detected"
                          ? "Not detected"
                          : "Setup required"
                    }</dd>
                  </div>
                  <div>
                    <dt>Version</dt>
                    <dd>{connection.version ?? "Not available"}</dd>
                  </div>
                  <div>
                    <dt>IntentArc profile</dt>
                    <dd>{
                      connected
                        ? "Safe"
                        : connection.profileId
                          ? "Safe profile found"
                          : "Not set up"
                    }</dd>
                  </div>
                </dl>
                {connection.availability === "ready"
                  ? (
                      <details className="connection-manual">
                        <summary>What Connect does</summary>
                        <p>
                          IntentArc uses {detail.label}'s supported command to
                          add the local bridge for your user account and creates
                          a revocable Safe profile. You do not need to copy
                          configuration manually.
                        </p>
                      </details>
                    )
                  : guideOpen
                    ? (
                        <AiConnectionGuide
                          adapterId={connection.adapterId}
                          availabilityReason={connection.availabilityReason}
                          label={guideActionLabel}
                          id={guideId}
                        />
                      )
                    : null}
              </div>
              <div className="connection-card__actions">
                {connected
                  ? (
                      <>
                        <button
                          className="secondary-action"
                          type="button"
                          disabled={Boolean(pendingAdapter)}
                          onClick={() =>
                            void testConnection(connection.adapterId)}
                        >
                          <RotateCw aria-hidden="true" size={16} />
                          {busy ? "Testing…" : `Test ${detail.label}`}
                        </button>
                        <button
                          className="text-link"
                          type="button"
                          disabled={Boolean(pendingAdapter)}
                          onClick={(event) =>
                            openReview(event, {
                              adapterId: connection.adapterId,
                              action: "remove",
                            })}
                        >
                          <Unplug aria-hidden="true" size={16} />
                          Remove {detail.label}
                        </button>
                      </>
                    )
                  : readyToConnect
                    ? (
                        <button
                          className="primary-action"
                          type="button"
                          disabled={Boolean(pendingAdapter)}
                          onClick={(event) =>
                            openReview(event, {
                              adapterId: connection.adapterId,
                              action: "connect",
                            })}
                        >
                          <Cable aria-hidden="true" size={16} />
                          Connect {detail.label}
                        </button>
                      )
                    : needsReview
                      ? (
                          <>
                            <button
                              className="primary-action"
                              type="button"
                              disabled={Boolean(pendingAdapter)}
                              onClick={(event) =>
                                openReview(event, {
                                  adapterId: connection.adapterId,
                                  action: "connect",
                                })}
                            >
                              <Cable aria-hidden="true" size={16} />
                              Review connection
                            </button>
                            <button
                              className="secondary-action"
                              type="button"
                              disabled={Boolean(pendingAdapter)}
                              onClick={() =>
                                refreshCatalog({
                                  kind: "card-heading",
                                  adapterId: connection.adapterId,
                                })}
                            >
                              <RotateCw aria-hidden="true" size={16} />
                              Check again
                            </button>
                            {connection.profileId
                              ? (
                                  <button
                                    className="text-link"
                                    type="button"
                                    disabled={Boolean(pendingAdapter)}
                                    onClick={(event) =>
                                      openReview(event, {
                                        adapterId: connection.adapterId,
                                        action: "remove",
                                      })}
                                  >
                                    <Unplug aria-hidden="true" size={16} />
                                    Remove {detail.label}
                                  </button>
                                )
                              : null}
                          </>
                        )
                      : (
                          <>
                            <button
                              className="primary-action"
                              type="button"
                              aria-label={guideActionLabel}
                              aria-expanded={guideOpen}
                              aria-controls={guideId}
                              onClick={() =>
                                setOpenGuide((current) =>
                                  current === connection.adapterId
                                    ? null
                                    : connection.adapterId
                                )}
                            >
                              <BookOpen aria-hidden="true" size={16} />
                              <span aria-hidden="true">
                                {connection.availability === "not_detected"
                                  ? "Installation guide"
                                  : "How to connect"}
                              </span>
                            </button>
                            <button
                              className="secondary-action"
                              type="button"
                              disabled={Boolean(pendingAdapter)}
                              onClick={() =>
                                refreshCatalog({
                                  kind: "card-heading",
                                  adapterId: connection.adapterId,
                                })}
                            >
                              <RotateCw aria-hidden="true" size={16} />
                              Check again
                            </button>
                            {connection.profileId
                              ? (
                                  <button
                                    className="text-link"
                                    type="button"
                                    disabled={Boolean(pendingAdapter)}
                                    onClick={(event) =>
                                      openReview(event, {
                                        adapterId: connection.adapterId,
                                        action: "remove",
                                      })}
                                  >
                                    <Unplug aria-hidden="true" size={16} />
                                    Remove {detail.label}
                                  </button>
                                )
                              : null}
                          </>
                        )}
              </div>
            </article>
          );
        })}
      </div>

      <section
        className="manual-connection-catalog"
        aria-labelledby="manual-connections-title"
      >
        <header className="manual-connection-catalog__header">
          <div>
            <p className="connection-card__kind">User-configured clients</p>
            <h2
              ref={manualHeadingRef}
              id="manual-connections-title"
              tabIndex={-1}
            >
              Manual MCP connections
            </h2>
          </div>
          <p>
            These records hold revocable IntentArc Safe profiles. IntentArc
            cannot inspect or edit the external AI tool's settings.
          </p>
        </header>
        {manualConnections.length > 0
          ? (
              <div className="manual-connection-catalog__list">
                {manualConnections.map((connection) => (
                  <article
                    key={connection.id}
                    className="manual-connection-card"
                    aria-label={connection.label}
                  >
                    <div>
                      <h3>{connection.label}</h3>
                      <StatusChip tone="attention">
                        Setup details created
                      </StatusChip>
                    </div>
                    <p>
                      IntentArc created the setup record but cannot verify the
                      external client configuration.
                    </p>
                    <button
                      className="text-link manual-connection-card__remove"
                      type="button"
                      disabled={manualPending}
                      onClick={(event) =>
                        openManualRemoval(event, connection)}
                    >
                      <Unplug aria-hidden="true" size={16} />
                      Remove {connection.label} setup
                    </button>
                  </article>
                ))}
              </div>
            )
          : (
              <p className="manual-connection-catalog__empty">
                {listState.status === "loading"
                  ? "Checking for saved manual MCP setups\u2026"
                  : listState.status === "error"
                    ? "Saved manual MCP setups are unavailable until this check succeeds."
                    : "No manual MCP setup details have been created."}
              </p>
            )}
      </section>

      {notice
        ? (
            <p className="connection-notice" role="status" aria-live="polite">
              {notice}
            </p>
          )
        : null}

      {review && reviewedConnection
        ? (
            <div className="project-dialog-layer">
              <button
                className="project-dialog-scrim"
                type="button"
                aria-label="Close connection review"
                disabled={Boolean(pendingAdapter)}
                onClick={closeReview}
              />
              <section
                ref={dialogRef}
                className="project-dialog connection-review"
                role="dialog"
                aria-modal="true"
                aria-labelledby="connection-review-title"
              >
                <div className="project-dialog__header">
                  <div>
                    <p className="stage__eyebrow">
                      {review.action === "connect"
                        ? "Review connection"
                        : "Review removal"}
                    </p>
                    <h2 id="connection-review-title">
                      {review.action === "connect"
                        ? `Connect ${adapterDetails[review.adapterId].label}`
                        : `Remove ${adapterDetails[review.adapterId].label} connection`}
                    </h2>
                  </div>
                  <button
                    ref={closeButtonRef}
                    className="icon-button"
                    type="button"
                    aria-label="Close connection review"
                    disabled={Boolean(pendingAdapter)}
                    onClick={closeReview}
                  >
                    <X aria-hidden="true" size={19} />
                  </button>
                </div>
                <div className="connection-review__body">
                  {review.action === "connect"
                    ? (
                        <>
                          <p>
                            IntentArc will add IntentArc Bridge.exe to{" "}
                            {adapterDetails[review.adapterId].label} for your
                            user account and create an IntentArc Safe profile.
                          </p>
                          <p>
                            {adapterDetails[review.adapterId].label} keeps its
                            own repository and terminal permission mode. The
                            IntentArc Safe profile governs only IntentArc tools
                            and project mutations.
                          </p>
                          <div className="connection-review__trust">
                            <ShieldCheck aria-hidden="true" size={20} />
                            <p>
                              {adapterDetails[review.adapterId].label} is a
                              third-party app. Continue only if you trust it to
                              start the local bridge. You may need to restart{" "}
                              {adapterDetails[review.adapterId].label} before
                              the connection appears.
                            </p>
                          </div>
                          <p>
                            This does not connect your{" "}
                            {adapterDetails[review.adapterId].accountName}{" "}
                            account.
                          </p>
                        </>
                      )
                    : (
                        <p>
                          This removes only the IntentArc connection from{" "}
                          {adapterDetails[review.adapterId].label}. Your project
                          archive and the reviewed profile history stay in
                          IntentArc.
                        </p>
                      )}
                  {operationError
                    ? (
                        <p className="form-error" role="alert">
                          {operationError}
                        </p>
                      )
                    : null}
                  <div className="project-dialog__actions">
                    <button
                      className="secondary-action"
                      type="button"
                      disabled={Boolean(pendingAdapter)}
                      onClick={closeReview}
                    >
                      Cancel
                    </button>
                    <button
                      ref={confirmationButtonRef}
                      className={review.action === "connect"
                        ? "primary-action"
                        : "secondary-action connection-review__remove"}
                      type="button"
                      disabled={Boolean(pendingAdapter)}
                      onClick={() => void confirmReview()}
                    >
                      {pendingAdapter
                        ? review.action === "connect"
                          ? "Connecting…"
                          : "Removing…"
                        : review.action === "connect"
                          ? `Connect ${adapterDetails[review.adapterId].label}`
                          : "Remove connection"}
                    </button>
                  </div>
                </div>
              </section>
            </div>
          )
        : null}

      {manualDialog
        ? (
            <div className="project-dialog-layer">
              <button
                className="project-dialog-scrim"
                type="button"
                aria-label="Close manual AI setup"
                disabled={manualPending}
                onClick={closeManualDialog}
              />
              <section
                ref={manualDialogRef}
                className={`project-dialog connection-review manual-ai-dialog${
                  manualDialog.kind === "remove"
                    ? " manual-ai-dialog--remove"
                    : ""
                }`}
                role="dialog"
                aria-modal="true"
                aria-busy={manualPending}
                aria-labelledby="manual-ai-dialog-title"
              >
                <div className="project-dialog__header">
                  <div>
                    <p className="stage__eyebrow">
                      {manualDialog.kind === "setup"
                        ? "Generic MCP setup"
                        : "Review removal"}
                    </p>
                    <h2 id="manual-ai-dialog-title">
                      {manualDialog.kind === "setup"
                        ? "Use another AI tool"
                        : `Remove ${manualDialog.connection.label} setup`}
                    </h2>
                  </div>
                  <button
                    ref={manualCloseButtonRef}
                    className="icon-button"
                    type="button"
                    aria-label="Close manual AI setup"
                    disabled={manualPending}
                    onClick={closeManualDialog}
                  >
                    <X aria-hidden="true" size={19} />
                  </button>
                </div>
                {manualDialog.kind === "setup"
                  ? (
                      <div className="connection-review__body">
                        <OtherAiConnectionGuide
                          setup={manualSetup}
                          pending={manualPending}
                          error={manualError}
                          copyStatus={copyStatus}
                          confirmationButtonRef={manualConfirmationButtonRef}
                          resultHeadingRef={manualResultHeadingRef}
                          onCreate={(label) => void createManualSetup(label)}
                          onCopyCommand={() => {
                            if (manualSetup) {
                              void copySetupValue(
                                manualSetup.command,
                                "Command",
                              );
                            }
                          }}
                          onCopyArguments={() => {
                            if (manualSetup) {
                              void copySetupValue(
                                manualSetup.args.join(" "),
                                "Arguments",
                              );
                            }
                          }}
                          onContinueWithoutAi={(event) =>
                            followInternalLink(event, "/")}
                        />
                      </div>
                    )
                  : (
                      <div className="connection-review__body">
                        <p>
                          Removing this setup revokes IntentArc access by
                          disabling its Safe profile and invalidating the saved
                          connection reference.
                        </p>
                        <p>
                          IntentArc cannot edit {manualDialog.connection.label}.
                          Remove the MCP server from that external tool
                          separately.
                        </p>
                        {manualError
                          ? (
                              <p className="form-error" role="alert">
                                {manualError}
                              </p>
                            )
                          : null}
                        <div className="project-dialog__actions">
                          <button
                            className="secondary-action"
                            type="button"
                            disabled={manualPending}
                            onClick={closeManualDialog}
                          >
                            Cancel
                          </button>
                          <button
                            ref={manualConfirmationButtonRef}
                            className="secondary-action connection-review__remove"
                            type="button"
                            disabled={manualPending}
                            onClick={() => void removeManualSetup()}
                          >
                            {manualPending ? "Removing…" : "Remove setup"}
                          </button>
                        </div>
                      </div>
                    )}
              </section>
            </div>
          )
        : null}
    </div>
  );
}
