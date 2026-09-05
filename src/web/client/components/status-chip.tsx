import type { ReactNode } from "react";

export type StatusTone = "neutral" | "active" | "attention";

export interface StatusChipProps {
  children: ReactNode;
  tone?: StatusTone;
}

export function StatusChip({
  children,
  tone = "neutral",
}: StatusChipProps) {
  return (
    <span className="status-chip" data-tone={tone}>
      {children}
    </span>
  );
}
