import {
  Check,
  Clipboard,
  KeyRound,
  Plus,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  ProjectProfileSetupResponse,
  SanitizedProfileResponse,
} from "../../contracts.js";
import { apiPath } from "../../contracts.js";
import { apiRequest } from "../api.js";

type SanitizedProfile = SanitizedProfileResponse["profiles"][number];
type DialogMode = "existing" | "new";
type ProfilesState =
  | { status: "loading"; projectId: string }
  | { status: "error"; projectId: string; message: string }
  | { status: "ready"; projectId: string; profiles: SanitizedProfile[] };

interface DestinationInput {
  clientLabel: string;
  type:
    | "local_model"
    | "direct_provider"
    | "gateway"
    | "ide_managed"
    | "unknown";
  providerLabel: string;
  modelLabel: string | null;
  accountBoundaryLabel: string | null;
  dataBoundary: "local" | "remote" | "mixed" | "unknown";
}

export interface ProfileSetupDialogProps {
  projectId: string;
  onClose: () => void;
  onProfileConfigured: (profileId: string) => Promise<void> | void;
}

const trustedExplanation =
  "Trusted allows the AI client broad direct changes within its configured " +
  "repository scope when that client is configured accordingly. IntentArc " +
  "records this declared mode but does not grant the external tool permission. " +
  "Accepted IntentArc goals, scope, priorities, and decisions still follow the " +
  "separate knowledge-authority setting shown below.";

const optionalValue = (form: FormData, name: string): string | null => {
  const value = String(form.get(name) ?? "").trim();
  return value.length === 0 ? null : value;
};

const destinationFromForm = (
  form: FormData,
  prefix: string,
): DestinationInput => ({
  clientLabel: String(form.get(`${prefix}ClientLabel`) ?? "").trim(),
  type: String(
    form.get(`${prefix}DestinationType`) ?? "unknown",
  ) as DestinationInput["type"],
  providerLabel: String(form.get(`${prefix}ProviderLabel`) ?? "").trim(),
  modelLabel: optionalValue(form, `${prefix}ModelLabel`),
  accountBoundaryLabel: optionalValue(
    form,
    `${prefix}AccountBoundaryLabel`,
  ),
  dataBoundary: String(
    form.get(`${prefix}DataBoundary`) ?? "unknown",
  ) as DestinationInput["dataBoundary"],
});

function DestinationFields({
  idPrefix,
  namePrefix,
}: {
  idPrefix: string;
  namePrefix: string;
}) {
  return (
    <fieldset className="profile-setup__fieldset">
      <legend>Destination declaration</legend>
      <p className="field__hint">
        Describe where the copied task context will cross a data boundary.
      </p>
      <div className="profile-setup__field-grid">
        <div className="field">
          <label htmlFor={`${idPrefix}-client-label`}>Client label</label>
          <input
            id={`${idPrefix}-client-label`}
            name={`${namePrefix}ClientLabel`}
            required
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-destination-type`}>
            Destination type
          </label>
          <select
            id={`${idPrefix}-destination-type`}
            name={`${namePrefix}DestinationType`}
            defaultValue="local_model"
          >
            <option value="local_model">Local model</option>
            <option value="direct_provider">Direct provider</option>
            <option value="gateway">Gateway</option>
            <option value="ide_managed">IDE managed</option>
            <option value="unknown">Not yet known</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-provider-label`}>Provider label</label>
          <input
            id={`${idPrefix}-provider-label`}
            name={`${namePrefix}ProviderLabel`}
            required
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-model-label`}>
            Model label <span>(optional)</span>
          </label>
          <input
            id={`${idPrefix}-model-label`}
            name={`${namePrefix}ModelLabel`}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-account-label`}>
            Account boundary <span>(optional)</span>
          </label>
          <input
            id={`${idPrefix}-account-label`}
            name={`${namePrefix}AccountBoundaryLabel`}
            maxLength={200}
          />
        </div>
        <div className="field">
          <label htmlFor={`${idPrefix}-data-boundary`}>Data boundary</label>
          <select
            id={`${idPrefix}-data-boundary`}
            name={`${namePrefix}DataBoundary`}
            defaultValue="local"
          >
            <option value="local">Local</option>
            <option value="remote">Remote</option>
            <option value="mixed">Mixed</option>
            <option value="unknown">Not yet known</option>
          </select>
        </div>
      </div>
    </fieldset>
  );
}

export function ProfileSetupDialog({
  projectId,
  onClose,
  onProfileConfigured,
}: ProfileSetupDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const requestGenerationRef = useRef(0);
  const activeControllersRef = useRef(new Set<AbortController>());
  const [profilesState, setProfilesState] = useState<ProfilesState>({
    status: "loading",
    projectId,
  });
  const [mode, setMode] = useState<DialogMode>("new");
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(
    null,
  );
  const [executionMode, setExecutionMode] = useState<"safe" | "trusted">(
    "safe",
  );
  const [credential, setCredential] = useState<{
    projectId: string;
    profileId: string;
    token: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const activeCredential = credential?.projectId === projectId
    ? credential
    : null;
  const activeProfilesState = profilesState.projectId === projectId
    ? profilesState
    : { status: "loading" as const, projectId };

  const close = useCallback(() => {
    setCredential(null);
    setCopyStatus(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    const generation = ++requestGenerationRef.current;
    for (const activeController of activeControllersRef.current) {
      activeController.abort();
    }
    activeControllersRef.current.clear();
    setProfilesState({ status: "loading", projectId });
    setMode("new");
    setSelectedProfileId(null);
    setExecutionMode("safe");
    setCredential(null);
    setSubmitting(false);
    setError(null);
    setCopyStatus(null);
    const controller = new AbortController();
    activeControllersRef.current.add(controller);
    apiRequest<SanitizedProfileResponse>("/api/profiles", {
      signal: controller.signal,
    }).then(
      ({ profiles }) => {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) return;
        const available = profiles.filter(
          (profile) =>
            profile.status === "enabled" &&
            (
              !profile.projectIds.includes(projectId) ||
              !profile.hasDestination
            ),
        );
        setProfilesState({
          status: "ready",
          projectId,
          profiles: available,
        });
        if (available.length > 0) {
          setMode("existing");
          setSelectedProfileId(available[0]!.profileId);
        } else {
          setMode("new");
        }
      },
      (reason: unknown) => {
        if (
          controller.signal.aborted ||
          generation !== requestGenerationRef.current
        ) return;
        setProfilesState({
          status: "error",
          projectId,
          message: reason instanceof Error
            ? reason.message
            : "Could not load configured profiles.",
        });
      },
    ).finally(() => {
      activeControllersRef.current.delete(controller);
    });
    return () => {
      controller.abort();
      activeControllersRef.current.delete(controller);
      if (generation === requestGenerationRef.current) {
        requestGenerationRef.current += 1;
      }
      for (const activeController of activeControllersRef.current) {
        activeController.abort();
      }
      activeControllersRef.current.clear();
    };
  }, [projectId]);

  useEffect(() => {
    closeRef.current?.focus();
    const keepFocusInside = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!submitting) close();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      const controls = dialog?.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
    window.addEventListener("keydown", keepFocusInside);
    return () => window.removeEventListener("keydown", keepFocusInside);
  }, [close, submitting]);

  const selectedProfile = activeProfilesState.status === "ready"
    ? activeProfilesState.profiles.find(
        ({ profileId }) => profileId === selectedProfileId,
      ) ?? null
    : null;
  const selectedProfileNeedsRepair = selectedProfile !== null &&
    selectedProfile.projectIds.includes(projectId) &&
    !selectedProfile.hasDestination;

  const configure = async (
    input: Record<string, unknown>,
  ): Promise<{
    response: ProjectProfileSetupResponse;
    generation: number;
  } | null> => {
    const generation = requestGenerationRef.current;
    const controller = new AbortController();
    activeControllersRef.current.add(controller);
    setSubmitting(true);
    setError(null);
    try {
      const response = await apiRequest<ProjectProfileSetupResponse>(
        apiPath("projects", projectId, "profiles"),
        {
          method: "POST",
          body: JSON.stringify(input),
          signal: controller.signal,
        },
      );
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) return null;
      return { response, generation };
    } catch (reason) {
      if (
        controller.signal.aborted ||
        generation !== requestGenerationRef.current
      ) return null;
      setError(
        reason instanceof Error
          ? reason.message
          : "Could not configure the profile.",
      );
      return null;
    } finally {
      activeControllersRef.current.delete(controller);
      if (generation === requestGenerationRef.current) {
        setSubmitting(false);
      }
    }
  };

  const submitExisting = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!selectedProfile) {
      setError("Select a configured profile to continue.");
      return;
    }
    const form = new FormData(event.currentTarget);
    const configured = await configure({
      source: "existing",
      profileId: selectedProfile.profileId,
      executionMode: selectedProfile.executionMode,
      destination: selectedProfile.hasDestination
        ? null
        : destinationFromForm(form, "existing"),
    });
    if (!configured) return;
    if (configured.generation !== requestGenerationRef.current) return;
    await onProfileConfigured(configured.response.profileId);
    if (configured.generation !== requestGenerationRef.current) return;
    close();
  };

  const submitNew = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const name = String(form.get("profileName") ?? "").trim();
    if (!name) {
      setError("Enter a profile name to continue.");
      return;
    }
    const configured = await configure({
      source: "new",
      name,
      executionMode,
      destination: destinationFromForm(form, "new"),
    });
    if (!configured) return;
    if (configured.generation !== requestGenerationRef.current) return;
    const { response } = configured;
    await onProfileConfigured(response.profileId);
    if (configured.generation !== requestGenerationRef.current) return;
    if (response.tokenShownOnce && response.token !== null) {
      setCredential({
        projectId,
        profileId: response.profileId,
        token: response.token,
      });
      return;
    }
    close();
  };

  const copyToken = async () => {
    if (!activeCredential) return;
    try {
      await navigator.clipboard.writeText(activeCredential.token);
      setCopyStatus("Token copied");
    } catch {
      setCopyStatus("Token could not be copied. Select it and copy manually.");
    }
  };

  return (
    <div className="project-dialog-layer profile-setup-layer">
      <button
        className="project-dialog-scrim"
        type="button"
        aria-label="Dismiss destination setup"
        disabled={submitting}
        onClick={close}
      />
      <section
        ref={dialogRef}
        className="project-dialog profile-setup"
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-setup-title"
      >
        <header className="project-dialog__header">
          <div>
            <p className="stage__eyebrow">Project destination</p>
            <h2 id="profile-setup-title">Add another destination</h2>
          </div>
          <button
            ref={closeRef}
            className="icon-button"
            type="button"
            aria-label="Close destination setup"
            disabled={submitting}
            onClick={close}
          >
            <X aria-hidden="true" size={19} />
          </button>
        </header>

        {activeCredential
          ? (
              <section
                className="credential-panel"
                role="region"
                aria-label="One-time profile credential"
              >
                <span className="credential-panel__icon" aria-hidden="true">
                  <KeyRound size={20} />
                </span>
                <div>
                  <p className="stage__eyebrow">Shown once</p>
                  <h3>Store this profile token now</h3>
                  <p>
                    IntentArc does not keep a readable copy. Closing this panel
                    removes the token from this browser view.
                  </p>
                </div>
                <code>{activeCredential.token}</code>
                <div className="credential-panel__actions">
                  <button
                    className="primary-action"
                    type="button"
                    onClick={copyToken}
                  >
                    <Clipboard aria-hidden="true" size={17} />
                    Copy token
                  </button>
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={close}
                  >
                    Done
                  </button>
                </div>
                {copyStatus
                  ? (
                      <p
                        className="credential-panel__status"
                        role="status"
                        aria-live="polite"
                      >
                        {copyStatus}
                      </p>
                    )
                  : null}
              </section>
            )
          : activeProfilesState.status === "loading"
            ? (
                <div className="profile-setup__state" role="status">
                  Reading configured profiles…
                </div>
              )
            : activeProfilesState.status === "error"
              ? (
                  <div className="profile-setup__state">
                    <p className="form-error" role="alert">
                      {activeProfilesState.message}
                    </p>
                  </div>
                )
              : mode === "existing"
                ? (
                    <form
                      className="profile-setup__body"
                      aria-label="Enable configured profile"
                      onSubmit={submitExisting}
                    >
                      <div className="profile-setup__intro">
                        <h3>Configured profiles</h3>
                        <p>
                          Reuse a destination already declared in this archive.
                        </p>
                      </div>
                      <fieldset className="profile-options">
                        <legend className="sr-only">Configured profile</legend>
                        {activeProfilesState.profiles.map((profile) => (
                          <label
                            className="profile-option"
                            key={profile.profileId}
                          >
                            <input
                              type="radio"
                              name="configuredProfile"
                              value={profile.profileId}
                              checked={
                                selectedProfileId === profile.profileId
                              }
                              onChange={() =>
                                setSelectedProfileId(profile.profileId)}
                            />
                            <span className="profile-option__marker">
                              <Check aria-hidden="true" size={15} />
                            </span>
                            <span>
                              <strong>{profile.name}</strong>
                              <small>
                                {profile.executionMode === "custom"
                                  ? "Custom"
                                  : profile.executionMode === "trusted"
                                    ? "Trusted"
                                    : "Safe"}
                                {" · "}
                                {profile.hasDestination
                                  ? "Destination declared"
                                  : profile.projectIds.includes(projectId)
                                    ? "Already authorized · Destination repair required"
                                    : "Destination details required"}
                              </small>
                            </span>
                          </label>
                        ))}
                      </fieldset>
                      {selectedProfile && !selectedProfile.hasDestination
                        ? (
                            <DestinationFields
                              idPrefix="existing"
                              namePrefix="existing"
                            />
                          )
                        : null}
                      <div className="knowledge-note">
                        <ShieldCheck aria-hidden="true" size={18} />
                        <p>
                          <strong>
                            IntentArc knowledge authority · Proposal only
                          </strong>
                          New project enablement starts at Proposal only.
                          Existing authority is preserved and remains separate
                          from the declared execution mode.
                        </p>
                      </div>
                      {error
                        ? <p className="form-error" role="alert">{error}</p>
                        : null}
                      <div className="profile-setup__actions">
                        <button
                          className="secondary-action"
                          type="button"
                          onClick={() => {
                            setMode("new");
                            setError(null);
                          }}
                        >
                          <Plus aria-hidden="true" size={17} />
                          Create new profile
                        </button>
                        <button
                          className="primary-action"
                          type="submit"
                          disabled={submitting}
                        >
                          {submitting
                            ? selectedProfileNeedsRepair
                              ? "Repairing…"
                              : "Enabling…"
                            : selectedProfileNeedsRepair
                              ? "Repair selected profile"
                              : "Enable selected profile"}
                        </button>
                      </div>
                    </form>
                  )
                : (
                    <form
                      className="profile-setup__body"
                      aria-label="Create new profile"
                      onSubmit={submitNew}
                    >
                      <div className="profile-setup__intro">
                        <h3>Create new profile</h3>
                        <p>
                          Name the AI client boundary and declare how it may
                          operate. IntentArc will not open or control it.
                        </p>
                      </div>
                      <div className="field">
                        <label htmlFor="new-profile-name">Profile name</label>
                        <input
                          id="new-profile-name"
                          name="profileName"
                          required
                          maxLength={200}
                        />
                      </div>
                      <fieldset className="profile-setup__fieldset">
                        <legend>Declared execution mode</legend>
                        <div className="execution-options">
                          <label>
                            <input
                              type="radio"
                              name="executionMode"
                              value="safe"
                              aria-label="Safe"
                              checked={executionMode === "safe"}
                              onChange={() => setExecutionMode("safe")}
                            />
                            <span>
                              <strong>Safe</strong>
                              <small>
                                Conservative external-tool operation.
                              </small>
                            </span>
                          </label>
                          <label>
                            <input
                              type="radio"
                              name="executionMode"
                              value="trusted"
                              aria-label="Trusted"
                              checked={executionMode === "trusted"}
                              onChange={() => setExecutionMode("trusted")}
                            />
                            <span>
                              <strong>Trusted</strong>
                              <small>
                                Broad operation within the client’s configured
                                repository scope.
                              </small>
                            </span>
                          </label>
                        </div>
                        {executionMode === "trusted"
                          ? (
                              <p className="trusted-explanation">
                                {trustedExplanation}
                              </p>
                            )
                          : null}
                      </fieldset>
                      <div className="knowledge-note">
                        <ShieldCheck aria-hidden="true" size={18} />
                        <p>
                          <strong>
                            IntentArc knowledge authority · Proposal only
                          </strong>
                          Safe and Trusted both start at Proposal only for this
                          project. Change knowledge authority independently in
                          Safe Foundation.
                        </p>
                      </div>
                      <DestinationFields
                        idPrefix="new"
                        namePrefix="new"
                      />
                      {error
                        ? <p className="form-error" role="alert">{error}</p>
                        : null}
                      <div className="profile-setup__actions">
                        {activeProfilesState.profiles.length > 0
                          ? (
                              <button
                                className="secondary-action"
                                type="button"
                                onClick={() => {
                                  setMode("existing");
                                  setError(null);
                                }}
                              >
                                Use configured profile
                              </button>
                            )
                          : null}
                        <button
                          className="primary-action"
                          type="submit"
                          disabled={submitting}
                        >
                          {submitting ? "Creating…" : "Create profile"}
                        </button>
                      </div>
                    </form>
                  )}
      </section>
    </div>
  );
}
