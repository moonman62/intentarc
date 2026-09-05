import {
  type FormEvent,
  type MouseEvent,
  type Ref,
  useState,
} from "react";
import type {
  DesktopAiAdapterId,
  DesktopAiAvailabilityReason,
  DesktopManualConnectionSetup,
} from "../desktop-api.js";
import { validateManualClientLabel as validateSharedManualClientLabel } from
  "../../../domain/manual-client-label.js";

type ManualLabelValidation =
  | { readonly valid: true; readonly label: string }
  | { readonly valid: false; readonly message: string };

const validateManualClientLabel = (value: string): ManualLabelValidation => {
  const validation = validateSharedManualClientLabel(value);
  if (validation.valid) return validation;
  if (validation.reason === "empty") {
    return { valid: false, message: "Enter a client name." };
  }
  if (validation.reason === "no_visible_content") {
    return { valid: false, message: "Enter a visible client name." };
  }
  if (validation.reason === "too_long") {
    return { valid: false, message: "Use 80 characters or fewer." };
  }
  return {
    valid: false,
    message: "Use a visible client name without control characters.",
  };
};

type GuideReason = Exclude<
  DesktopAiAvailabilityReason,
  "connector_ready"
>;

interface ConnectionGuideContent {
  readonly title: string;
  readonly diagnostic: string;
  readonly steps: readonly string[];
}

const codexInstallSteps = [
  "Install or update the supported CLI with npm install -g @openai/codex.",
  "Run codex login and complete ChatGPT sign-in if Codex is not already signed in.",
  "You can confirm the account state with codex login status. IntentArc checks the local CLI and MCP setup, not your ChatGPT account.",
  "Return to IntentArc and choose Check again.",
] as const;

const claudeInstallSteps = [
  "Install the supported Claude Code CLI using Anthropic's maintained instructions.",
  "Confirm claude --version works.",
  "Then return to IntentArc and choose Check again.",
] as const;

const connectionGuides = {
  codex: {
    not_installed: {
      title: "Install the supported Codex CLI",
      diagnostic: "IntentArc did not detect Codex on this device.",
      steps: codexInstallSteps,
    },
    cli_missing: {
      title: "Finish setting up Codex",
      diagnostic:
        "The Codex desktop application is present, but IntentArc connects through the supported Codex CLI. Its protected internal executable is not used.",
      steps: codexInstallSteps,
    },
    access_blocked: {
      title: "Make the Codex CLI available",
      diagnostic:
        "IntentArc cannot access the Codex CLI from your user account.",
      steps: [
        "Confirm your user account can run codex --version.",
        "If access is still blocked, repair or reinstall the supported Codex CLI.",
        "Return to IntentArc and choose Check again.",
      ],
    },
    unsupported_version: {
      title: "Update the Codex CLI",
      diagnostic:
        "IntentArc found Codex, but could not confirm a supported CLI version.",
      steps: codexInstallSteps,
    },
    probe_failed: {
      title: "Check Codex again",
      diagnostic:
        "IntentArc could not finish checking Codex on this device.",
      steps: [
        "Confirm codex --version works from your user account.",
        "Return to IntentArc and choose Check again.",
      ],
    },
  },
  "claude-code": {
    not_installed: {
      title: "Install the supported Claude Code CLI",
      diagnostic: "IntentArc did not detect Claude Code on this device.",
      steps: claudeInstallSteps,
    },
    cli_missing: {
      title: "Finish setting up Claude Code",
      diagnostic:
        "IntentArc found Claude Code, but the supported CLI is not available to your user account.",
      steps: claudeInstallSteps,
    },
    access_blocked: {
      title: "Make the Claude Code CLI available",
      diagnostic:
        "IntentArc cannot access the Claude Code CLI from your user account.",
      steps: [
        "Confirm your user account can run claude --version.",
        "Return to IntentArc and choose Check again.",
      ],
    },
    unsupported_version: {
      title: "Update Claude Code",
      diagnostic:
        "IntentArc found Claude Code, but could not confirm a supported CLI version.",
      steps: [
        "Update the supported Claude Code CLI using Anthropic's maintained instructions.",
        "Confirm claude --version works.",
        "Return to IntentArc and choose Check again.",
      ],
    },
    probe_failed: {
      title: "Check Claude Code again",
      diagnostic:
        "IntentArc could not finish checking Claude Code on this device.",
      steps: [
        "Confirm claude --version works from your user account.",
        "Return to IntentArc and choose Check again.",
      ],
    },
  },
} as const satisfies Readonly<Record<
  DesktopAiAdapterId,
  Readonly<Record<GuideReason, ConnectionGuideContent>>
>>;

export interface AiConnectionGuideProps {
  readonly adapterId: DesktopAiAdapterId;
  readonly availabilityReason: DesktopAiAvailabilityReason;
  readonly label: string;
  readonly id: string;
}

export function AiConnectionGuide({
  adapterId,
  availabilityReason,
  label,
  id,
}: AiConnectionGuideProps) {
  const reason = availabilityReason === "connector_ready"
    ? "probe_failed"
    : availabilityReason;
  const guide = connectionGuides[adapterId][reason];

  return (
    <section
      id={id}
      className="connection-guide"
      role="region"
      aria-label={label}
    >
      <h3>{guide.title}</h3>
      <p>{guide.diagnostic}</p>
      <ol>
        {guide.steps.map((step) => <li key={step}>{step}</li>)}
      </ol>
    </section>
  );
}

export interface OtherAiConnectionGuideProps {
  readonly setup: DesktopManualConnectionSetup | null;
  readonly pending: boolean;
  readonly error: string | null;
  readonly copyStatus: string | null;
  readonly confirmationButtonRef: Ref<HTMLButtonElement>;
  readonly resultHeadingRef: Ref<HTMLHeadingElement>;
  readonly onCreate: (label: string) => void;
  readonly onCopyCommand: () => void;
  readonly onCopyArguments: () => void;
  readonly onContinueWithoutAi: (
    event: MouseEvent<HTMLAnchorElement>,
  ) => void;
}

export function OtherAiConnectionGuide({
  setup,
  pending,
  error,
  copyStatus,
  confirmationButtonRef,
  resultHeadingRef,
  onCreate,
  onCopyCommand,
  onCopyArguments,
  onContinueWithoutAi,
}: OtherAiConnectionGuideProps) {
  const [clientName, setClientName] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const validation = validateManualClientLabel(clientName);
    if (!validation.valid) {
      setValidationError(validation.message);
      return;
    }
    setValidationError(null);
    onCreate(validation.label);
  };

  const followContinueLink = (event: MouseEvent<HTMLAnchorElement>) => {
    if (pending) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    onContinueWithoutAi(event);
  };

  const blockPendingAuxiliaryNavigation = (
    event: MouseEvent<HTMLAnchorElement>,
  ) => {
    if (!pending) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const argumentsValue = setup?.args.join(" ") ?? "";

  return (
    <div className="other-ai-guide">
      <p className="other-ai-guide__requirement">
        Your AI tool must support a local MCP server that it can start as a
        command.
      </p>

      {setup
        ? (
            <section
              className="manual-setup-result"
              aria-labelledby="manual-setup-result-title"
            >
              <h3
                ref={resultHeadingRef}
                id="manual-setup-result-title"
                tabIndex={-1}
              >
                Setup details created
              </h3>
              <p>
                Add these exact values to {setup.label}. IntentArc cannot edit
                or verify settings in an unknown AI tool.
              </p>
              <div className="manual-setup-result__field">
                <label htmlFor="manual-setup-command">Command</label>
                <div>
                  <input
                    id="manual-setup-command"
                    type="text"
                    readOnly
                    value={setup.command}
                  />
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={onCopyCommand}
                  >
                    Copy command
                  </button>
                </div>
              </div>
              <div className="manual-setup-result__field">
                <label htmlFor="manual-setup-arguments">Arguments</label>
                <div>
                  <input
                    id="manual-setup-arguments"
                    type="text"
                    readOnly
                    value={argumentsValue}
                  />
                  <button
                    className="secondary-action"
                    type="button"
                    onClick={onCopyArguments}
                  >
                    Copy arguments
                  </button>
                </div>
              </div>
              {copyStatus
                ? (
                    <p
                      className={copyStatus.includes("could not")
                        ? "form-error"
                        : "field__hint"}
                      role="status"
                      aria-live="polite"
                    >
                      {copyStatus}
                    </p>
                  )
                : null}
            </section>
          )
        : (
            <form className="manual-setup-form" onSubmit={submit}>
              <div className="field">
                <label htmlFor="manual-client-name">AI client name</label>
                <input
                  id="manual-client-name"
                  type="text"
                  required
                  minLength={1}
                  aria-invalid={Boolean(validationError || error)}
                  aria-describedby={validationError || error
                    ? "manual-client-name-hint manual-client-name-error"
                    : "manual-client-name-hint"}
                  value={clientName}
                  disabled={pending}
                  onChange={(event) => {
                    setClientName(event.currentTarget.value);
                    setValidationError(null);
                  }}
                />
                <p id="manual-client-name-hint" className="field__hint">
                  IntentArc creates a revocable Safe profile. It cannot edit
                  settings for an unknown client, so you will add the details
                  yourself.
                </p>
              </div>
              {validationError || error
                ? (
                    <p
                      id="manual-client-name-error"
                      className="form-error"
                      role="alert"
                    >
                      {validationError ?? error}
                    </p>
                  )
                : null}
              <button
                ref={confirmationButtonRef}
                className="primary-action"
                type="submit"
                disabled={pending}
              >
                {pending ? "Creating setup details…" : "Set up an MCP client"}
              </button>
            </form>
          )}

      <section className="other-ai-guide__api" aria-labelledby="api-only-title">
        <h3 id="api-only-title">Using an API-only service?</h3>
        <p>
          An API-only account does not provide a local process that can start
          IntentArc's MCP server. IntentArc does not request or store your API
          key. API connections need a separate future design for credentials,
          usage, model selection, and cost controls.
        </p>
      </section>

      <a
        className="text-link"
        href="/"
        aria-disabled={pending}
        tabIndex={pending ? -1 : undefined}
        onClick={followContinueLink}
        onAuxClick={blockPendingAuxiliaryNavigation}
      >
        Continue without AI
      </a>
    </div>
  );
}
