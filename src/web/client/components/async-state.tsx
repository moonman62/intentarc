import type { ReactNode } from "react";

export interface AsyncStateProps {
  state: "loading" | "error" | "empty" | "ready";
  children?: ReactNode;
  title?: string;
  message?: string;
  action?: ReactNode;
}

export function AsyncState({
  state,
  children,
  title,
  message,
  action,
}: AsyncStateProps) {
  if (state === "ready") return children;

  if (state === "loading") {
    return (
      <div className="async-state" role="status" aria-live="polite">
        <span className="async-state__pulse" aria-hidden="true" />
        <p>{message ?? "Loading…"}</p>
      </div>
    );
  }

  return (
    <div className="async-state" role={state === "error" ? "alert" : "status"}>
      <p className="async-state__eyebrow">
        {state === "error" ? "Needs attention" : "Ready when you are"}
      </p>
      <h2>{title ?? (state === "error" ? "Could not load this view" : "Nothing here yet")}</h2>
      {message ? <p>{message}</p> : null}
      {action ? <div className="async-state__action">{action}</div> : null}
    </div>
  );
}
