import {
  Archive,
  Check,
  FolderOpen,
  MapPin,
  RotateCcw,
} from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useState,
} from "react";
import type {
  DesktopLifecycleApi,
  DesktopLifecycleState,
} from "../desktop-api.js";
import { AsyncState } from "../components/async-state.js";

type WelcomeState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "onboarding";
      lifecycle: DesktopLifecycleState;
      pending: "choose" | "complete" | null;
      error: string | null;
    }
  | {
      status: "restart";
      archivePath: string;
      pending: boolean;
      error: string | null;
    }
  | { status: "ready" };

export interface DesktopWelcomeProps {
  readonly lifecycle: DesktopLifecycleApi;
  readonly children: ReactNode;
  readonly closeManually?: () => void;
}

const errorMessage = (reason: unknown, fallback: string): string =>
  reason instanceof Error ? reason.message : fallback;

const restartState = (archivePath: string): WelcomeState => ({
  status: "restart",
  archivePath,
  pending: false,
  error: null,
});

export function DesktopWelcome({
  lifecycle,
  children,
  closeManually = () => window.close(),
}: DesktopWelcomeProps) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<WelcomeState>({ status: "loading" });

  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    lifecycle.getState().then(
      (result) => {
        if (!active) return;
        setState(
          result.onboardingCompleted && result.restartRequired
            ? restartState(result.archivePath)
            : result.onboardingCompleted
            ? { status: "ready" }
            : {
                status: "onboarding",
                lifecycle: result,
                pending: null,
                error: null,
              },
        );
      },
      (reason: unknown) => {
        if (!active) return;
        setState({
          status: "error",
          message: errorMessage(
            reason,
            "Could not read desktop setup.",
          ),
        });
      },
    );
    return () => {
      active = false;
    };
  }, [lifecycle, reloadKey]);

  const chooseArchive = useCallback(async () => {
    if (state.status !== "onboarding" || state.pending) return;
    setState({ ...state, pending: "choose", error: null });
    try {
      const selection = await lifecycle.chooseArchive();
      setState({
        status: "onboarding",
        lifecycle: selection,
        pending: null,
        error: null,
      });
    } catch (reason) {
      setState({
        ...state,
        pending: null,
        error: errorMessage(
          reason,
          "Could not choose another archive location.",
        ),
      });
    }
  }, [lifecycle, state]);

  const completeOnboarding = useCallback(async () => {
    if (state.status !== "onboarding" || state.pending) return;
    setState({ ...state, pending: "complete", error: null });
    try {
      const completed = await lifecycle.completeOnboarding();
      setState(
        completed.restartRequired
          ? restartState(completed.archivePath)
          : { status: "ready" },
      );
    } catch (reason) {
      setState({
        ...state,
        pending: null,
        error: errorMessage(
          reason,
          "Could not finish archive setup.",
        ),
      });
    }
  }, [lifecycle, state]);

  const restart = useCallback(async () => {
    if (state.status !== "restart" || state.pending) return;
    setState({ ...state, pending: true, error: null });
    try {
      await lifecycle.restart();
    } catch (reason) {
      setState({
        ...state,
        pending: false,
        error: errorMessage(reason, "Could not restart IntentArc."),
      });
    }
  }, [lifecycle, state]);

  if (state.status === "ready") return children;

  if (state.status === "loading") {
    return (
      <main className="desktop-welcome desktop-welcome--centered">
        <AsyncState
          state="loading"
          message="Opening your project archive…"
        />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className="desktop-welcome desktop-welcome--centered">
        <AsyncState
          state="error"
          title="Could not open desktop setup"
          message={state.message}
          action={
            <button
              className="secondary-action"
              type="button"
              onClick={() => setReloadKey((key) => key + 1)}
            >
              Try again
            </button>
          }
        />
      </main>
    );
  }

  if (state.status === "restart") {
    return (
      <main className="desktop-welcome desktop-welcome--centered">
        <section
          className="desktop-restart"
          aria-labelledby="desktop-restart-title"
        >
          <span className="desktop-restart__seal" aria-hidden="true">
            <RotateCcw size={24} strokeWidth={1.6} />
          </span>
          <p className="stage__eyebrow">Archive location saved</p>
          <h1 id="desktop-restart-title">Open the selected archive</h1>
          <p>
            Restart IntentArc to open the archive at the selected location.
          </p>
          <p className="archive-location__path">{state.archivePath}</p>
          <button
            className="primary-action"
            type="button"
            disabled={state.pending}
            onClick={restart}
          >
            {state.pending ? "Restarting IntentArc..." : "Restart IntentArc"}
          </button>
          {state.pending ? (
            <p role="status">Restarting IntentArc...</p>
          ) : null}
          {state.error ? (
            <>
              <p className="form-error" role="alert">{state.error}</p>
              <button
                className="secondary-action"
                type="button"
                onClick={closeManually}
              >
                Close and reopen manually
              </button>
            </>
          ) : null}
        </section>
      </main>
    );
  }

  const busy = state.pending !== null;
  return (
    <main className="desktop-welcome">
      <div className="desktop-welcome__frame">
        <header className="desktop-welcome__header">
          <a className="brand" href="/" aria-label="IntentArc">
            <span className="brand__seal" aria-hidden="true">
              <Archive size={19} strokeWidth={1.7} />
            </span>
            <span className="brand__wordmark">IntentArc</span>
          </a>
          <span>Local-first project continuity</span>
        </header>

        <section className="desktop-welcome__intro">
          <div>
            <p className="stage__eyebrow">First run · project archive</p>
            <h1>Choose where your archive lives</h1>
            <p>
              IntentArc keeps project intent, decisions, work, and evidence
              together. Your archive stays on this device unless you choose a
              location that another service syncs.
            </p>
          </div>
          <ol
            className="archive-setup-path"
            aria-label="Archive setup progress"
          >
            <li data-state="complete">
              <Check aria-hidden="true" size={16} />
              <span>
                <strong>Open locally</strong>
                <small>The default archive is ready</small>
              </span>
            </li>
            <li data-state="current">
              <MapPin aria-hidden="true" size={16} />
              <span>
                <strong>Confirm location</strong>
                <small>Keep it or choose another</small>
              </span>
            </li>
            <li>
              <Archive aria-hidden="true" size={16} />
              <span>
                <strong>Start the archive</strong>
                <small>Create or import a project</small>
              </span>
            </li>
          </ol>
        </section>

        <section
          className="archive-location"
          aria-labelledby="archive-location-title"
        >
          <div className="archive-location__marker" aria-hidden="true">
            <FolderOpen size={21} strokeWidth={1.6} />
          </div>
          <div className="archive-location__body">
            <p className="archive-location__label">Archive location</p>
            <h2 id="archive-location-title">Keep your work together</h2>
            <p className="archive-location__path">
              {state.lifecycle.archivePath}
            </p>
            <p className="archive-location__note">
              You can move to another local or synced folder now. IntentArc
              will use one archive at a time.
            </p>
          </div>
          <div className="archive-location__actions">
            <button
              className="secondary-action"
              type="button"
              disabled={busy}
              onClick={chooseArchive}
            >
              {state.pending === "choose"
                ? "Choosing…"
                : "Choose another location"}
            </button>
            <button
              className="primary-action"
              type="button"
              disabled={busy}
              onClick={completeOnboarding}
            >
              {state.pending === "complete"
                ? "Opening…"
                : "Use this archive"}
            </button>
          </div>
          {state.error
            ? (
                <p className="form-error archive-location__error" role="alert">
                  {state.error}
                </p>
              )
            : null}
        </section>
      </div>
    </main>
  );
}
