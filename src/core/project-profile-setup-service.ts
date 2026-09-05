import { z } from "zod";
import {
  GovernanceError,
  clientExecutionModeSchema,
  setOutboundDestinationInputSchema,
} from "../domain/index.js";
import type { DestinationService } from "./destination-service.js";
import type { ProfileService } from "./profile-service.js";
import type { ProjectViewService } from "./project-view-service.js";

const identifierSchema = z.string().trim().min(1).max(200);
const destinationSchema = setOutboundDestinationInputSchema.omit({
  profileId: true,
});

export const projectProfileSetupInputSchema = z.discriminatedUnion("source", [
  z.object({
    source: z.literal("existing"),
    profileId: identifierSchema,
    executionMode: clientExecutionModeSchema,
    destination: destinationSchema.nullable(),
  }).strict(),
  z.object({
    source: z.literal("new"),
    name: z.string().trim().min(1).max(200),
    executionMode: z.enum(["safe", "trusted"]),
    destination: destinationSchema,
  }).strict(),
]);

export type ProjectProfileSetupInput = z.infer<
  typeof projectProfileSetupInputSchema
>;

export interface ProjectProfileSetupResult {
  profileId: string;
  token: string | null;
  tokenShownOnce: boolean;
}

export interface TransactionRunner {
  run<Result>(operation: () => Result): Result;
}

export interface ProjectProfileSetupService {
  configure(
    projectId: string,
    input: ProjectProfileSetupInput,
  ): ProjectProfileSetupResult;
}

export interface ProjectProfileSetupServiceDependencies {
  transaction: TransactionRunner;
  profileService: Pick<
    ProfileService,
    "createProfile" | "listProfiles" | "setAuthority" | "setExecutionMode"
  >;
  destinationService: Pick<DestinationService, "getCurrent" | "set">;
  viewService: Pick<ProjectViewService, "getDashboard">;
}

const validationFailure = (message: string): GovernanceError =>
  new GovernanceError("validation_failed", message);

export const createProjectProfileSetupService = ({
  transaction,
  profileService,
  destinationService,
  viewService,
}: ProjectProfileSetupServiceDependencies): ProjectProfileSetupService => ({
  configure(projectId, input): ProjectProfileSetupResult {
    const parsedProjectId = identifierSchema.parse(projectId);
    const parsed = projectProfileSetupInputSchema.parse(input);

    return transaction.run(() => {
      viewService.getDashboard(parsedProjectId);

      if (parsed.source === "new") {
        const created = profileService.createProfile({
          name: parsed.name,
          executionMode: parsed.executionMode,
        });
        profileService.setExecutionMode(
          created.profile.id,
          parsed.executionMode,
        );
        profileService.setAuthority({
          profileId: created.profile.id,
          projectId: parsedProjectId,
          mode: "proposal",
        });
        destinationService.set({
          profileId: created.profile.id,
          ...parsed.destination,
        });
        return {
          profileId: created.profile.id,
          token: created.token,
          tokenShownOnce: true,
        };
      }

      const summary = profileService.listProfiles().find(
        ({ profile }) =>
          profile.id === parsed.profileId && profile.status === "enabled",
      );
      if (!summary) {
        throw validationFailure("Enabled profile not found");
      }
      const currentDestination = destinationService.getCurrent(
        parsed.profileId,
      );
      if (
        parsed.destination === null &&
        currentDestination?.status !== "enabled"
      ) {
        throw validationFailure("Destination configuration is required");
      }
      const existingAuthority = summary.authorities.some(
        ({ authority }) => authority.projectId === parsedProjectId,
      );

      profileService.setExecutionMode(
        parsed.profileId,
        parsed.executionMode,
      );
      if (!existingAuthority) {
        profileService.setAuthority({
          profileId: parsed.profileId,
          projectId: parsedProjectId,
          mode: "proposal",
        });
      }
      if (parsed.destination !== null) {
        destinationService.set({
          profileId: parsed.profileId,
          ...parsed.destination,
        });
      }
      return {
        profileId: parsed.profileId,
        token: null,
        tokenShownOnce: false,
      };
    });
  },
});
