import { createHash } from "node:crypto";
import {
  CoordinationError,
  GovernanceError,
  acceptDelegationInputSchema,
  checkpointClaimInputSchema,
  claimTaskInputSchema,
  coordinationStateInputSchema,
  createDelegationInputSchema,
  listReadyTasksInputSchema,
  renewClaimInputSchema,
  revokeDelegationInputSchema,
  submitTaskResultInputSchema,
  switchTaskInputSchema,
  transitionClaimInputSchema,
  type AuthenticatedProfile,
  type CoordinationErrorCode,
  type CoordinationService,
  type TaskClaim,
  type TaskDelegation,
} from "../domain/index.js";
import type { CoordinationStore } from "../storage/coordination-store.js";
import type { ProfileStore } from "../storage/profile-store.js";
import type { ContextService } from "./context-service.js";
import type { ChangeService } from "./change-service.js";
import type { ProfileService } from "./profile-service.js";

type CoordinationProfileService = Pick<ProfileService, "revalidatePrincipal">;
type CoordinationProfileStore = Pick<ProfileStore, "getAuthority" | "getProfile">;

export interface CoordinationProjectConstraint {
  expectedProjectId: string;
}

type ClaimScopedMethod =
  | "renewClaim"
  | "checkpointClaim"
  | "transitionClaim"
  | "submitTaskResult";

export type ProjectConstrainedCoordinationService = Omit<
  CoordinationService,
  ClaimScopedMethod
> & {
  [Method in ClaimScopedMethod]: (
    input: Parameters<CoordinationService[Method]>[0],
    principal: Parameters<CoordinationService[Method]>[1],
    constraint?: CoordinationProjectConstraint,
  ) => ReturnType<CoordinationService[Method]>;
} & {
  resolveOwnedClaimSnapshot(
    claimId: string,
    principal: AuthenticatedProfile,
  ): TaskClaim;
  resolveAuthorizedDelegation(
    input: { delegationId: string; projectId: string; taskId: string },
    principal: AuthenticatedProfile,
    requiredRole: "parent" | "child",
  ): TaskDelegation;
};

export type CoordinationIdPrefix =
  | "coordination-claim"
  | "coordination-checkpoint"
  | "coordination-delegation"
  | "coordination-event"
  | "coordination-submission";

export interface CoordinationServiceDependencies {
  coordinationStore: CoordinationStore;
  changeService: Pick<ChangeService, "submitProfileProposal">;
  contextService: ContextService;
  profileService: CoordinationProfileService;
  profileStore: CoordinationProfileStore;
  now: () => string;
  newId: (prefix: CoordinationIdPrefix) => string;
}

const requestHash = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(input)).digest("hex");

const denied = (): never => {
  throw new CoordinationError("coordination_authority_denied");
};

const coordinationErrorCodes = new Set<CoordinationErrorCode>([
  "task_not_ready",
  "claim_conflict",
  "claim_expired",
  "lease_horizon_reached",
  "revision_conflict",
  "delegation_conflict",
  "delegation_expired",
  "delegation_revoked",
  "checkpoint_invalid",
  "submission_stale",
  "submission_invalid",
  "coordination_authority_denied",
  "coordination_idempotency_conflict",
  "coordination_unavailable",
]);

const publicOperation = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    let code: CoordinationErrorCode = "coordination_unavailable";
    try {
      if (error instanceof CoordinationError) {
        const candidate: unknown = error.code;
        if (typeof candidate === "string" &&
          coordinationErrorCodes.has(candidate as CoordinationErrorCode)) {
          code = candidate as CoordinationErrorCode;
        }
      } else if (error instanceof GovernanceError &&
        (error.code === "invalid_profile_credentials" || error.code === "profile_disabled")) {
        code = "coordination_authority_denied";
      }
    } catch {
      code = "coordination_unavailable";
    }
    throw new CoordinationError(code);
  }
};

export const createCoordinationService = ({
  coordinationStore,
  changeService,
  contextService,
  profileService,
  profileStore,
  now,
  newId,
}: CoordinationServiceDependencies): ProjectConstrainedCoordinationService => {
  const currentPrincipal = (principal: AuthenticatedProfile): AuthenticatedProfile =>
    profileService.revalidatePrincipal(principal);

  const authorizeProject = (
    principal: AuthenticatedProfile,
    projectId: string,
  ): AuthenticatedProfile => {
    const current = currentPrincipal(principal);
    if (!profileStore.getAuthority(current.id, projectId)) denied();
    return current;
  };

  const authorizeClaim = (
    principal: AuthenticatedProfile,
    claimId: string,
    constraint?: CoordinationProjectConstraint,
  ): { current: AuthenticatedProfile; claim: TaskClaim; projectId: string; taskId: string } => {
    const current = currentPrincipal(principal);
    const claim = coordinationStore.getOwnedClaimSnapshot(claimId, current.id);
    if (!claim) return denied();
    if (constraint && claim.projectId !== constraint.expectedProjectId) denied();
    if (!profileStore.getAuthority(current.id, claim.projectId)) denied();
    return { current, claim, projectId: claim.projectId, taskId: claim.taskId };
  };

  const authorizeDelegation = (
    principal: AuthenticatedProfile,
    delegationId: string,
    projectId: string,
    taskId: string,
    requiredRole: "parent" | "child",
  ): AuthenticatedProfile => {
    const current = currentPrincipal(principal);
    const scope = coordinationStore.getDelegationScope(delegationId, current.id);
    if (!scope || scope.role !== requiredRole || scope.projectId !== projectId || scope.taskId !== taskId) {
      return denied();
    }
    if (!profileStore.getAuthority(current.id, scope.projectId)) denied();
    return current;
  };

  const authorizedDelegation = (
    principal: AuthenticatedProfile,
    input: { delegationId: string; projectId: string; taskId: string },
    requiredRole: "parent" | "child",
  ): { current: AuthenticatedProfile; delegation: TaskDelegation } => {
    const current = currentPrincipal(principal);
    const resolved = coordinationStore.getDelegationForActor(input.delegationId, current.id);
    if (!resolved || resolved.role !== requiredRole ||
      resolved.delegation.projectId !== input.projectId ||
      resolved.delegation.taskId !== input.taskId) return denied();
    if (!profileStore.getAuthority(current.id, resolved.delegation.projectId)) denied();
    return { current, delegation: resolved.delegation };
  };

  return {
    resolveOwnedClaimSnapshot(claimId, principal) {
      return publicOperation(() => {
        const { claim } = authorizeClaim(principal, claimId);
        return claim;
      });
    },

    resolveAuthorizedDelegation(input, principal, requiredRole) {
      return publicOperation(() =>
        authorizedDelegation(principal, input, requiredRole).delegation);
    },

    listReadyTasks(input, principal) {
      return publicOperation(() => {
        const parsed = listReadyTasksInputSchema.parse(input);
        const current = authorizeProject(principal, parsed.projectId);
        return coordinationStore.listReadyTasks(parsed, current.id);
      });
    },

    getCoordinationState(input, principal) {
      return publicOperation(() => {
        const parsed = coordinationStateInputSchema.parse(input);
        const current = authorizeProject(principal, parsed.projectId);
        return coordinationStore.getCoordinationState(parsed, current.id);
      });
    },

    claimTask(input, principal) {
      return publicOperation(() => {
        const parsed = claimTaskInputSchema.parse(input);
        const current = currentPrincipal(principal);
        if (parsed.acceptedDelegationId) {
          const scope = coordinationStore.getDelegationScope(parsed.acceptedDelegationId, current.id);
          if (!scope || scope.role !== "child" || scope.projectId !== parsed.projectId ||
            scope.taskId !== parsed.taskId) denied();
        }
        if (!profileStore.getAuthority(current.id, parsed.projectId)) denied();
        return coordinationStore.claim({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: {
            claimId: newId("coordination-claim"),
            eventId: newId("coordination-event"),
          },
        }, () => contextService.getTaskContext({
          projectId: parsed.projectId,
          taskId: parsed.taskId,
          budgetTokens: parsed.contextBudgetTokens,
        }));
      });
    },

    renewClaim(input, principal, constraint) {
      return publicOperation(() => {
        const parsed = renewClaimInputSchema.parse(input);
        const { current } = authorizeClaim(principal, parsed.claimId, constraint);
        return coordinationStore.renew({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: { eventId: newId("coordination-event") },
        });
      });
    },

    checkpointClaim(input, principal, constraint) {
      return publicOperation(() => {
        const parsed = checkpointClaimInputSchema.parse(input);
        const { current } = authorizeClaim(principal, parsed.claimId, constraint);
        return coordinationStore.checkpoint({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: {
            checkpointId: newId("coordination-checkpoint"),
            checkpointEventId: newId("coordination-event"),
            renewalEventId: newId("coordination-event"),
          },
        });
      });
    },

    transitionClaim(input, principal, constraint) {
      return publicOperation(() => {
        const parsed = transitionClaimInputSchema.parse(input);
        const { current } = authorizeClaim(principal, parsed.claimId, constraint);
        return coordinationStore.transition({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: { eventId: newId("coordination-event") },
        });
      });
    },

    switchTask(input, principal) {
      return publicOperation(() => {
        const parsed = switchTaskInputSchema.parse(input);
        const current = currentPrincipal(principal);
        const claimSnapshot = coordinationStore.getOwnedClaimSnapshot(parsed.currentClaimId, current.id);
        if (!claimSnapshot) return denied();
        if (parsed.acceptedDelegationId) {
          const delegationScope = coordinationStore.getDelegationScope(
            parsed.acceptedDelegationId,
            current.id,
          );
          if (!delegationScope || delegationScope.role !== "child" ||
            delegationScope.projectId !== parsed.projectId ||
            delegationScope.taskId !== parsed.nextTaskId) denied();
        }
        if (!profileStore.getAuthority(current.id, claimSnapshot.projectId)) denied();
        if (claimSnapshot.projectId !== parsed.projectId ||
          claimSnapshot.taskId !== parsed.currentTaskId) denied();
        return coordinationStore.switchTask({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: {
            checkpointId: newId("coordination-checkpoint"),
            nextClaimId: newId("coordination-claim"),
            checkpointEventId: newId("coordination-event"),
            transitionEventId: newId("coordination-event"),
            claimEventId: newId("coordination-event"),
          },
        }, () => contextService.getTaskContext({
          projectId: parsed.projectId,
          taskId: parsed.nextTaskId,
          budgetTokens: parsed.nextContextBudgetTokens,
        }));
      });
    },

    createDelegation(input, principal) {
      return publicOperation(() => {
        const parsed = createDelegationInputSchema.parse(input);
        const current = currentPrincipal(principal);
        if (current.id === parsed.childProfileId) denied();
        if (!profileStore.getAuthority(current.id, parsed.projectId)) denied();
        const child = profileStore.getProfile(parsed.childProfileId);
        if (!child || child.status !== "enabled" ||
          !profileStore.getAuthority(child.id, parsed.projectId)) denied();
        return coordinationStore.createDelegation({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: {
            delegationId: newId("coordination-delegation"),
            eventId: newId("coordination-event"),
          },
        });
      });
    },

    acceptDelegation(input, principal) {
      return publicOperation(() => {
        const parsed = acceptDelegationInputSchema.parse(input);
        const current = authorizeDelegation(
          principal, parsed.delegationId, parsed.projectId, parsed.taskId, "child",
        );
        return coordinationStore.acceptDelegation({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: { eventId: newId("coordination-event") },
        });
      });
    },

    revokeDelegation(input, principal) {
      return publicOperation(() => {
        const parsed = revokeDelegationInputSchema.parse(input);
        const current = authorizeDelegation(
          principal, parsed.delegationId, parsed.projectId, parsed.taskId, "parent",
        );
        return coordinationStore.revokeDelegation({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: { eventId: newId("coordination-event") },
        });
      });
    },

    submitTaskResult(input, principal, constraint) {
      return publicOperation(() => {
        const parsed = submitTaskResultInputSchema.parse(input);
        const { current } = authorizeClaim(principal, parsed.claimId, constraint);
        return coordinationStore.submit({
          profileId: current.id,
          credentialGeneration: current.credentialGeneration,
          requestHash: requestHash(parsed),
          now: now(),
          input: parsed,
          ids: {
            submissionId: newId("coordination-submission"),
            eventId: newId("coordination-event"),
          },
        }, (proposalInput, forceConflict) => changeService.submitProfileProposal(
          current,
          proposalInput,
          { forceConflict },
        ));
      });
    },
  };
};
