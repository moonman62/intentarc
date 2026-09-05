import { z } from "zod";
import {
  GovernanceError,
  approveOutboundRequestInputSchema,
  outboundRequestFilterSchema,
  outboundRequestSummarySchema,
  requestTaskContextInputSchema,
  type ApproveOutboundRequestInput,
  type AuthenticatedProfile,
  type GetReleasedContextResult,
  type OutboundDestination,
  type OutboundDestinationSnapshot,
  type OutboundFinding,
  type OutboundFindingCounts,
  type OutboundInspection,
  type OutboundRelease,
  type OutboundRequestFilter,
  type OutboundRequestSummary,
  type RequestTaskContextInput,
  type RequestTaskContextResult,
  type TaskContextPack,
} from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import {
  computeOutboundRequestHash,
  computeOutboundReleaseDigest,
  OUTBOUND_DETECTOR_VERSION,
  OUTBOUND_SAFETY_POLICY_VERSION,
  type OutboundSafetyEngine,
  type OutboundScan,
} from "../outbound/safety-engine.js";
import type {
  ContextPackStore,
  StoredContextPack,
} from "../storage/context-pack-store.js";
import type {
  OutboundContextStore,
  OutboundPolicyScope,
  StoredOutboundRequest,
} from "../storage/outbound-context-store.js";
import type { ContextService } from "./context-service.js";
import type { DestinationService } from "./destination-service.js";
import type { ProfileService } from "./profile-service.js";

export interface OutboundContextService {
  request(
    principal: AuthenticatedProfile,
    input: RequestTaskContextInput,
  ): RequestTaskContextResult;
  requestAsLocalHuman(
    profileId: string,
    input: RequestTaskContextInput,
  ): RequestTaskContextResult;
  getReleased(
    principal: AuthenticatedProfile,
    requestId: string,
  ): GetReleasedContextResult;
  getReleasedAsLocalHuman(
    profileId: string,
    requestId: string,
  ): GetReleasedContextResult;
  list(filter: OutboundRequestFilter): OutboundRequestSummary[];
  inspect(requestId: string): OutboundInspection;
  reveal(requestId: string, findingId: string): {
    requestId: string;
    findingId: string;
    value: string;
  };
  approve(input: ApproveOutboundRequestInput): OutboundRelease;
  deny(requestId: string): OutboundRequestSummary;
  disablePolicy(profileId: string, projectId: string): void;
}

export type OutboundContextServiceIdPrefix =
  | "outbound-request"
  | "outbound-release"
  | "audit";

export interface OutboundContextServiceDependencies {
  contextService: ContextService;
  contextPackStore: ContextPackStore;
  profileService: ProfileService;
  destinationService: DestinationService;
  outboundStore: OutboundContextStore;
  safetyEngine: OutboundSafetyEngine;
  now: () => string;
  newId: (prefix: OutboundContextServiceIdPrefix) => string;
}

type RequestActor =
  | { type: "profile"; principal: AuthenticatedProfile }
  | { type: "local_human"; profileId: string };

const identifierSchema = z.string().trim().min(1).max(200);

const sameJson = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

const destinationSnapshot = (
  destination: OutboundDestination,
): OutboundDestinationSnapshot => ({
  id: destination.id,
  revision: destination.revision,
  clientLabel: destination.clientLabel,
  type: destination.type,
  providerLabel: destination.providerLabel,
  modelLabel: destination.modelLabel,
  accountBoundaryLabel: destination.accountBoundaryLabel,
  dataBoundary: destination.dataBoundary,
});

const findingCounts = (
  findings: readonly OutboundFinding[],
): OutboundFindingCounts => ({
  total: findings.length,
  credential: findings.filter(({ severity }) => severity === "credential").length,
  sensitive: findings.filter(({ severity }) => severity === "sensitive").length,
  forcedRedact: findings.filter(
    ({ requiredAction }) => requiredAction === "forced_redact",
  ).length,
  redactByDefault: findings.filter(
    ({ requiredAction }) => requiredAction === "redact_by_default",
  ).length,
  redacted: findings.length,
  includedOnce: 0,
});

const toSummary = (
  request: StoredOutboundRequest,
  destination: OutboundDestinationSnapshot = request.destination,
): OutboundRequestSummary => outboundRequestSummarySchema.parse({
  requestId: request.requestId,
  profileId: request.profileId,
  projectId: request.projectId,
  taskId: request.taskId,
  sourcePackId: request.sourcePackId,
  destination,
  status: request.status,
  projectRevision: request.projectRevision,
  budgetTokens: request.budgetTokens,
  originalEstimatedTokens: request.originalEstimatedTokens,
  findingCounts: request.findingCounts,
  detectorVersion: request.detectorVersion,
  safetyPolicyVersion: request.safetyPolicyVersion,
  releaseId: request.releaseId,
  createdAt: request.createdAt,
  decidedAt: request.decidedAt,
});

const safetyFailed = (): OutboundSafetyError<"outbound_safety_failed"> =>
  new OutboundSafetyError("outbound_safety_failed", {});

const releaseInvalid = (
  requestId: string,
): OutboundSafetyError<"outbound_release_invalid"> =>
  new OutboundSafetyError("outbound_release_invalid", { requestId });

export const createOutboundContextService = ({
  contextService,
  contextPackStore,
  profileService,
  destinationService,
  outboundStore,
  safetyEngine,
  now,
  newId,
}: OutboundContextServiceDependencies): OutboundContextService => {
  const requireRequest = (requestId: string): StoredOutboundRequest => {
    const request = outboundStore.getRequest(requestId);
    if (!request) throw safetyFailed();
    return request;
  };

  const requireOwnedRequest = (
    profileId: string,
    requestId: string,
  ): StoredOutboundRequest => {
    const request = outboundStore.getRequest(requestId);
    if (!request || request.profileId !== profileId) {
      throw releaseInvalid(requestId);
    }
    return request;
  };

  const requireEnabledDestination = (
    profileId: string,
  ): OutboundDestination => {
    const destination = destinationService.getCurrent(profileId);
    if (!destination || destination.status !== "enabled") {
      throw new OutboundSafetyError("outbound_destination_required", {
        profileId,
      });
    }
    return destination;
  };

  const currentProfileForActor = (
    actor: RequestActor,
    projectId: string,
  ): AuthenticatedProfile => {
    if (actor.type === "profile") {
      return profileService.revalidatePrincipal(actor.principal);
    }
    const summary = profileService.listProfiles().find(
      ({ profile }) => profile.id === actor.profileId,
    );
    const authority = summary?.authorities.find(
      ({ authority: candidate }) => candidate.projectId === projectId,
    );
    if (!summary || summary.profile.status !== "enabled" || !authority) {
      throw new GovernanceError(
        "validation_failed",
        "Profile is not enabled for this project",
      );
    }
    return profileService.revalidatePrincipal({
      id: summary.profile.id,
      name: summary.profile.name,
      status: "enabled",
      credentialGeneration: summary.profile.tokenRotatedAt,
    });
  };

  const assertCurrentDestination = (
    request: StoredOutboundRequest,
  ): OutboundDestination => {
    const current = destinationService.getCurrent(request.profileId);
    if (!current) {
      throw new OutboundSafetyError("outbound_destination_required", {
        profileId: request.profileId,
      });
    }
    if (
      current.id !== request.destination.id ||
      current.revision !== request.destination.revision ||
      current.status !== "enabled" ||
      !sameJson(destinationSnapshot(current), request.destination)
    ) {
      throw new OutboundSafetyError("outbound_destination_changed", {
        requestId: request.requestId,
        expectedRevision: request.destination.revision,
        currentRevision: current.revision,
      });
    }
    return current;
  };

  const revalidateRequestProfile = (
    request: StoredOutboundRequest,
  ): AuthenticatedProfile => {
    const profile = profileService.listProfiles().find(
      ({ profile: candidate }) => candidate.id === request.profileId,
    )?.profile;
    if (!profile) throw safetyFailed();
    return profileService.revalidatePrincipal({
      id: profile.id,
      name: profile.name,
      status: "enabled",
      credentialGeneration: profile.tokenRotatedAt,
    });
  };

  const requireRawPack = (
    request: StoredOutboundRequest,
    retrieval: boolean,
  ): StoredContextPack => {
    try {
      const storedPack = contextPackStore.getWithStoredShape(
        request.sourcePackId,
      );
      const pack = storedPack?.pack;
      if (
        !pack ||
        pack.id !== request.sourcePackId ||
        pack.projectId !== request.projectId ||
        pack.taskId !== request.taskId ||
        pack.projectRevision !== request.projectRevision ||
        pack.budgetTokens !== request.budgetTokens ||
        pack.estimatedTokens !== request.originalEstimatedTokens
      ) {
        throw new Error("Raw pack linkage is invalid");
      }
      return storedPack;
    } catch {
      throw retrieval ? releaseInvalid(request.requestId) : safetyFailed();
    }
  };

  const validatedScan = (
    request: StoredOutboundRequest,
    storedPack: StoredContextPack,
  ): OutboundScan => {
    try {
      const scan = safetyEngine.scanStoredPack(
        storedPack.pack,
        request.destination,
        {
          hierarchyVocabularyPresent:
            storedPack.hierarchyVocabularyPresent,
        },
      );
      const storedFindings = outboundStore.getFindings(request.requestId).map(
        (finding) => ({ ...finding, decision: null }),
      );
      if (
        scan.candidateDigest !== request.candidateDigest ||
        scan.detectorVersion !== request.detectorVersion ||
        scan.safetyPolicyVersion !== request.safetyPolicyVersion ||
        !sameJson(scan.findings, storedFindings)
      ) {
        throw new Error("Stored scan does not match the raw pack");
      }
      return scan;
    } catch (error) {
      if (error instanceof OutboundSafetyError) throw error;
      throw safetyFailed();
    }
  };

  const policyScope = (
    request: Pick<
      StoredOutboundRequest,
      | "profileId"
      | "projectId"
      | "destination"
      | "detectorVersion"
      | "safetyPolicyVersion"
    >,
  ): OutboundPolicyScope => ({
    profileId: request.profileId,
    projectId: request.projectId,
    destinationId: request.destination.id,
    destinationRevision: request.destination.revision,
    detectorVersion: request.detectorVersion,
    safetyPolicyVersion: request.safetyPolicyVersion,
  });

  const assertSupportedVersions = (request: StoredOutboundRequest): void => {
    if (
      request.detectorVersion !== OUTBOUND_DETECTOR_VERSION ||
      request.safetyPolicyVersion !== OUTBOUND_SAFETY_POLICY_VERSION
    ) {
      throw safetyFailed();
    }
  };

  const requireValidStoredRelease = (
    request: StoredOutboundRequest,
    expectedDestination: OutboundDestinationSnapshot,
  ): OutboundRelease => {
    let release: OutboundRelease | null;
    try {
      release = outboundStore.getReleaseForRequest(request.requestId);
    } catch {
      throw releaseInvalid(request.requestId);
    }
    if (!release) throw releaseInvalid(request.requestId);

    const expectedSources = [
      ...release.pack.stableFrame,
      release.pack.task,
      ...release.pack.related,
    ].map(({ record }) => ({
      recordId: record.id,
      kind: record.kind,
      revision: record.revision,
      sourceKind: record.sourceKind,
      sourceRef: record.sourceRef,
    }));
    const digest = computeOutboundReleaseDigest(release);
    if (
      request.status !== "released" ||
      request.releaseId !== release.releaseId ||
      release.requestId !== request.requestId ||
      release.sourcePackId !== request.sourcePackId ||
      release.pack.id !== request.sourcePackId ||
      release.pack.projectId !== request.projectId ||
      release.pack.taskId !== request.taskId ||
      release.pack.projectRevision !== request.projectRevision ||
      release.pack.budgetTokens !== request.budgetTokens ||
      release.disclosure.sourcePackId !== request.sourcePackId ||
      release.disclosure.projectId !== request.projectId ||
      release.disclosure.taskId !== request.taskId ||
      release.disclosure.projectRevision !== request.projectRevision ||
      release.disclosure.requestedBudgetTokens !== request.budgetTokens ||
      release.disclosure.originalEstimatedTokens !==
        request.originalEstimatedTokens ||
      release.disclosure.releasedAt !== release.releasedAt ||
      release.disclosure.detectorVersion !== request.detectorVersion ||
      release.disclosure.safetyPolicyVersion !== request.safetyPolicyVersion ||
      !sameJson(release.disclosure.destination, expectedDestination) ||
      !sameJson(release.disclosure.findingCounts, request.findingCounts) ||
      !sameJson(release.disclosure.sourceRecords, expectedSources) ||
      !sameJson(release.disclosure.omissions, release.pack.omissions) ||
      release.sha256 !== digest ||
      release.disclosure.releaseDigest !== digest
    ) {
      throw releaseInvalid(request.requestId);
    }
    return release;
  };

  const requestForActor = (
    actor: RequestActor,
    input: RequestTaskContextInput,
  ): RequestTaskContextResult => {
    const parsed = requestTaskContextInputSchema.parse(input);
    const current = currentProfileForActor(actor, parsed.projectId);
    const destination = requireEnabledDestination(current.id);
    const snapshot = destinationSnapshot(destination);
    const requestHash = computeOutboundRequestHash({
      projectId: parsed.projectId,
      taskId: parsed.taskId,
      budgetTokens: parsed.budgetTokens,
      destinationId: snapshot.id,
      destinationRevision: snapshot.revision,
      detectorVersion: OUTBOUND_DETECTOR_VERSION,
      safetyPolicyVersion: OUTBOUND_SAFETY_POLICY_VERSION,
    });
    const replay = outboundStore.resolveIdempotency(
      current.id,
      parsed.idempotencyKey,
    );
    if (replay) {
      if (replay.requestHash !== requestHash) {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: replay.requestId,
        });
      }
      const replayPack = requireRawPack(replay, false);
      const replayScan = validatedScan(replay, replayPack);
      return toSummary(replay, replayScan.redactedDestination);
    }

    const pack = contextService.getTaskContext(parsed);
    let scan: OutboundScan;
    try {
      scan = safetyEngine.scan(pack, snapshot);
    } catch (error) {
      if (error instanceof OutboundSafetyError) throw error;
      throw safetyFailed();
    }
    const scope: OutboundPolicyScope = {
      profileId: current.id,
      projectId: parsed.projectId,
      destinationId: snapshot.id,
      destinationRevision: snapshot.revision,
      detectorVersion: scan.detectorVersion,
      safetyPolicyVersion: scan.safetyPolicyVersion,
    };
    const policy = scan.findings.length === 0 &&
        scan.detectorVersion === OUTBOUND_DETECTOR_VERSION &&
        scan.safetyPolicyVersion === OUTBOUND_SAFETY_POLICY_VERSION
      ? outboundStore.getPolicy(scope)
      : null;
    const automatic = policy?.mode === "auto_release_clean";
    const createdAt = now();
    const requestId = newId("outbound-request");
    const release = automatic
      ? safetyEngine.createRelease({
        requestId,
        releaseId: newId("outbound-release"),
        pack,
        destination: snapshot,
        scan,
        includeFindingIds: [],
        releasedAt: createdAt,
      })
      : null;
    const stored = outboundStore.createRequest({
      request: {
        requestId,
        profileId: current.id,
        projectId: pack.projectId,
        taskId: pack.taskId,
        sourcePackId: pack.id,
        destination: snapshot,
        status: automatic ? "released" : "review_required",
        projectRevision: pack.projectRevision,
        budgetTokens: pack.budgetTokens,
        originalEstimatedTokens: pack.estimatedTokens,
        findingCounts: release?.disclosure.findingCounts ??
          findingCounts(scan.findings),
        detectorVersion: scan.detectorVersion,
        safetyPolicyVersion: scan.safetyPolicyVersion,
        releaseId: release?.releaseId ?? null,
        createdAt,
        decidedAt: automatic ? createdAt : null,
        idempotencyKey: parsed.idempotencyKey,
        requestHash,
        candidateDigest: scan.candidateDigest,
        decisionActor: automatic ? "policy" : null,
        decisionReason: automatic ? "auto_release_clean" : null,
      },
      findings: scan.findings,
      release,
      audit: {
        id: newId("audit"),
        createdAt,
      },
      scanAudit: {
        id: newId("audit"),
        createdAt,
      },
      auditActor: actor.type === "profile"
        ? { actorType: "profile", profileId: current.id }
        : { actorType: "local_human", profileId: null },
    });
    return toSummary(stored, scan.redactedDestination);
  };

  const releasedForProfile = (
    current: AuthenticatedProfile,
    request: StoredOutboundRequest,
    recordRetrieval: boolean,
  ): GetReleasedContextResult => {
    assertCurrentDestination(request);
    assertSupportedVersions(request);
    const storedPack = requireRawPack(request, true);
    const scan = validatedScan(request, storedPack);
    if (request.status !== "released") {
      return {
        status: request.status,
        request: toSummary(request, scan.redactedDestination),
      };
    }
    const release = requireValidStoredRelease(
      request,
      scan.redactedDestination,
    );
    if (recordRetrieval) {
      outboundStore.recordRetrieval({
        requestId: request.requestId,
        releaseId: release.releaseId,
        profileId: current.id,
        destination: request.destination,
        audit: {
          id: newId("audit"),
          createdAt: now(),
        },
      });
    }
    return { status: "released", release };
  };

  return {
    request(principal, input) {
      return requestForActor({ type: "profile", principal }, input);
    },

    requestAsLocalHuman(profileId, input) {
      return requestForActor({
        type: "local_human",
        profileId: identifierSchema.parse(profileId),
      }, input);
    },

    getReleased(principal, requestId) {
      const parsedRequestId = identifierSchema.parse(requestId);
      const current = profileService.revalidatePrincipal(principal);
      const request = requireOwnedRequest(current.id, parsedRequestId);
      return releasedForProfile(current, request, true);
    },

    getReleasedAsLocalHuman(profileId, requestId) {
      const parsedProfileId = identifierSchema.parse(profileId);
      const parsedRequestId = identifierSchema.parse(requestId);
      const request = requireOwnedRequest(parsedProfileId, parsedRequestId);
      const current = currentProfileForActor(
        { type: "local_human", profileId: parsedProfileId },
        request.projectId,
      );
      return releasedForProfile(current, request, false);
    },

    list(filter) {
      return outboundStore.listRequests(outboundRequestFilterSchema.parse(filter));
    },

    inspect(requestId) {
      const request = requireRequest(identifierSchema.parse(requestId));
      const storedPack = requireRawPack(request, false);
      const scan = validatedScan(request, storedPack);
      const prospective = safetyEngine.createRelease({
        requestId: request.requestId,
        releaseId: request.releaseId ?? request.requestId,
        pack: storedPack.pack,
        sourcePackShape: {
          hierarchyVocabularyPresent:
            storedPack.hierarchyVocabularyPresent,
        },
        destination: request.destination,
        scan,
        includeFindingIds: [],
        releasedAt: request.decidedAt ?? request.createdAt,
      });
      return {
        request: toSummary(request, scan.redactedDestination),
        findings: outboundStore.getFindings(request.requestId),
        redactedPreview: scan.redactedPreview,
        prospectiveReleaseDigest: prospective.sha256,
      };
    },

    reveal(requestId, findingId) {
      const parsedRequestId = identifierSchema.parse(requestId);
      const parsedFindingId = identifierSchema.parse(findingId);
      const request = requireRequest(parsedRequestId);
      const storedPack = requireRawPack(request, false);
      const scan = validatedScan(request, storedPack);
      const finding = scan.findings.find(({ id }) => id === parsedFindingId);
      if (
        !finding ||
        finding.id !== `finding-${finding.findingKey}`
      ) {
        throw safetyFailed();
      }
      return {
        requestId: parsedRequestId,
        findingId: parsedFindingId,
        value: safetyEngine.reveal(
          storedPack.pack,
          request.destination,
          finding,
        ),
      };
    },

    approve(input) {
      const parsed = approveOutboundRequestInputSchema.parse(input);
      const request = requireRequest(parsed.requestId);
      if (request.status !== "review_required") {
        throw new OutboundSafetyError("outbound_request_conflict", {
          requestId: request.requestId,
        });
      }
      revalidateRequestProfile(request);
      assertCurrentDestination(request);
      assertSupportedVersions(request);
      const storedPack = requireRawPack(request, false);
      const scan = validatedScan(request, storedPack);
      if (parsed.rememberClean && scan.findings.length !== 0) {
        throw safetyFailed();
      }
      const included = new Set(parsed.includeFindingIds);
      const decidedAt = now();
      let release: OutboundRelease;
      try {
        release = safetyEngine.createRelease({
          requestId: request.requestId,
          releaseId: newId("outbound-release"),
          pack: storedPack.pack,
          sourcePackShape: {
            hierarchyVocabularyPresent:
              storedPack.hierarchyVocabularyPresent,
          },
          destination: request.destination,
          scan,
          includeFindingIds: parsed.includeFindingIds,
          releasedAt: decidedAt,
        });
      } catch (error) {
        if (error instanceof OutboundSafetyError) throw error;
        throw safetyFailed();
      }
      return outboundStore.approve({
        requestId: request.requestId,
        decisions: scan.findings.map(({ id }) => ({
          findingId: id,
          decision: included.has(id) ? "include_once" : "redact",
        })),
        release,
        policy: parsed.rememberClean
          ? {
            ...policyScope(request),
            mode: "auto_release_clean",
            createdAt: decidedAt,
            updatedAt: decidedAt,
          }
          : null,
        decisionActor: "local_human",
        decisionReason: "approved",
        decidedAt,
        audit: {
          id: newId("audit"),
          createdAt: decidedAt,
        },
        policyAudit: parsed.rememberClean
          ? {
            id: newId("audit"),
            createdAt: decidedAt,
          }
          : null,
      });
    },

    deny(requestId) {
      const parsedRequestId = identifierSchema.parse(requestId);
      const decidedAt = now();
      return toSummary(outboundStore.deny({
        requestId: parsedRequestId,
        decisionActor: "local_human",
        decisionReason: "denied",
        decidedAt,
        audit: {
          id: newId("audit"),
          createdAt: decidedAt,
        },
      }));
    },

    disablePolicy(profileId, projectId) {
      const parsedProfileId = identifierSchema.parse(profileId);
      const parsedProjectId = identifierSchema.parse(projectId);
      const destination = requireEnabledDestination(parsedProfileId);
      const disabledAt = now();
      outboundStore.disablePolicy({
        scope: {
          profileId: parsedProfileId,
          projectId: parsedProjectId,
          destinationId: destination.id,
          destinationRevision: destination.revision,
          detectorVersion: OUTBOUND_DETECTOR_VERSION,
          safetyPolicyVersion: OUTBOUND_SAFETY_POLICY_VERSION,
        },
        disabledAt,
        audit: {
          id: newId("audit"),
          createdAt: disabledAt,
        },
      });
    },
  };
};
