import type { z } from "zod";
import type {
  approveOutboundRequestInputSchema,
  outboundRequestFilterSchema,
  setOutboundDestinationInputSchema,
} from "./outbound-schemas.js";
import type { ContextOmission, RecordKind, SourceKind, TaskContextPack } from "./model.js";

export type OutboundDestinationType =
  | "local_model"
  | "direct_provider"
  | "gateway"
  | "ide_managed"
  | "unknown";

export type OutboundDataBoundary = "local" | "remote" | "mixed" | "unknown";
export type OutboundRequestStatus = "review_required" | "released" | "denied";
export type OutboundFindingAction = "forced_redact" | "redact_by_default";
export type OutboundFindingDecision = "redact" | "include_once";

export interface OutboundDestination {
  id: string;
  profileId: string;
  revision: number;
  clientLabel: string;
  type: OutboundDestinationType;
  providerLabel: string;
  modelLabel: string | null;
  accountBoundaryLabel: string | null;
  dataBoundary: OutboundDataBoundary;
  status: "enabled" | "disabled";
  current: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OutboundDestinationSnapshot {
  id: string;
  revision: number;
  clientLabel: string;
  type: OutboundDestinationType;
  providerLabel: string;
  modelLabel: string | null;
  accountBoundaryLabel: string | null;
  dataBoundary: OutboundDataBoundary;
}

export interface OutboundFinding {
  id: string;
  ordinal: number;
  detectorId: string;
  detectorVersion: string;
  category:
    | "private_key"
    | "api_token"
    | "authorization"
    | "credential_uri"
    | "secret_assignment"
    | "high_entropy"
    | "email"
    | "phone"
    | "network_address"
    | "local_user_path";
  confidence: "high" | "possible";
  severity: "credential" | "sensitive";
  path: string;
  start: number;
  end: number;
  findingKey: string;
  requiredAction: OutboundFindingAction;
  decision: OutboundFindingDecision | null;
}

export interface OutboundFindingCounts {
  total: number;
  credential: number;
  sensitive: number;
  forcedRedact: number;
  redactByDefault: number;
  redacted: number;
  includedOnce: number;
}

export interface OutboundDisclosure {
  destination: OutboundDestinationSnapshot;
  sourcePackId: string;
  projectId: string;
  taskId: string;
  projectRevision: number;
  sourceRecords: Array<{
    recordId: string;
    kind: RecordKind;
    revision: number;
    sourceKind: SourceKind;
    sourceRef: string | null;
  }>;
  omissions: ContextOmission[];
  requestedBudgetTokens: number;
  originalEstimatedTokens: number;
  releasedEstimatedTokens: number;
  findingCounts: OutboundFindingCounts;
  detectorVersion: string;
  safetyPolicyVersion: string;
  releaseDigest: string;
  releasedAt: string;
}

export interface OutboundRelease {
  releaseId: string;
  requestId: string;
  sourcePackId: string;
  releasedAt: string;
  sha256: string;
  disclosure: OutboundDisclosure;
  pack: TaskContextPack;
}

export interface OutboundRequestSummary {
  requestId: string;
  profileId: string;
  projectId: string;
  taskId: string;
  sourcePackId: string;
  destination: OutboundDestinationSnapshot;
  status: OutboundRequestStatus;
  projectRevision: number;
  budgetTokens: number;
  originalEstimatedTokens: number;
  findingCounts: OutboundFindingCounts;
  detectorVersion: string;
  safetyPolicyVersion: string;
  releaseId: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface OutboundInspection {
  request: OutboundRequestSummary;
  findings: OutboundFinding[];
  redactedPreview: TaskContextPack;
  prospectiveReleaseDigest: string;
}

export interface RequestTaskContextInput {
  projectId: string;
  taskId: string;
  budgetTokens: number;
  idempotencyKey: string;
}

export type RequestTaskContextResult = OutboundRequestSummary;
export type GetReleasedContextResult =
  | { status: "released"; release: OutboundRelease }
  | { status: "review_required" | "denied"; request: OutboundRequestSummary };

export type SetOutboundDestinationInput = z.infer<typeof setOutboundDestinationInputSchema>;
export type ApproveOutboundRequestInput = z.infer<typeof approveOutboundRequestInputSchema>;
export type OutboundRequestFilter = z.infer<typeof outboundRequestFilterSchema>;
