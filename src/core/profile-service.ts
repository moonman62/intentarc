import { z } from "zod";
import {
  GovernanceError,
  addScopeInputSchema,
  clientExecutionModeSchema,
  createProfileInputSchema,
  setAuthorityInputSchema,
  type AddScopeInput,
  type AuthenticatedProfile,
  type ClientProfile,
  type ClientExecutionMode,
  type ClientProfileSummary,
  type ProfileCredentials,
  type ProfileProjectAuthority,
  type ProfileScope,
  type SetAuthorityInput,
} from "../domain/index.js";
import {
  type AdministrativeAudit,
  type ProfileStore,
} from "../storage/profile-store.js";
import {
  credentialMatches,
  generateCredential,
  hashCredential,
} from "../system/credential-hash.js";

export interface ProfileService {
  createProfile(input: {
    name: string;
    projectId?: string;
    executionMode?: ClientExecutionMode;
  }): { profile: ClientProfile; token: string };
  listProfiles(): ClientProfileSummary[];
  authenticate(credentials: ProfileCredentials | null): AuthenticatedProfile | null;
  revalidatePrincipal(principal: AuthenticatedProfile): AuthenticatedProfile;
  setAuthority(input: SetAuthorityInput): ProfileProjectAuthority;
  addScope(input: AddScopeInput): ProfileScope;
  removeScope(scopeId: string): void;
  rotateToken(profileId: string): { profileId: string; token: string };
  setEnabled(profileId: string, enabled: boolean): ClientProfile;
  setExecutionMode(
    profileId: string,
    executionMode: ClientExecutionMode,
  ): ClientProfile;
}

export type ProfileIdPrefix = "profile" | "authority" | "scope" | "audit";

export interface ProfileServiceDependencies {
  profileStore: ProfileStore;
  now: () => string;
  newId: (prefix: ProfileIdPrefix) => string;
  generateToken?: () => string;
}

const identifierSchema = z.string().trim().min(1);
const createProfileServiceInputSchema = z
  .object({
    name: z.unknown(),
    projectId: identifierSchema.optional(),
    executionMode: z.unknown().optional(),
  })
  .strict();

const governanceError = (
  code: "profile_required" | "invalid_profile_credentials" | "profile_disabled",
  message: string,
): GovernanceError => new GovernanceError(code, message);

export const createProfileService = ({
  profileStore,
  now,
  newId,
  generateToken = generateCredential,
}: ProfileServiceDependencies): ProfileService => {
  const audit = (
    actionCategory: AdministrativeAudit["actionCategory"],
    targetId: string,
    projectId: string | null,
    createdAt: string,
  ): AdministrativeAudit => ({
    id: newId("audit"),
    projectId,
    actionCategory,
    targetId,
    createdAt,
  });

  const projectForAuthority = (authorityId: string): string => {
    for (const summary of profileStore.listProfiles()) {
      const match = summary.authorities.find(
        ({ authority }) => authority.id === authorityId,
      );
      if (match) return match.authority.projectId;
    }
    throw new Error(`Authority not found: ${authorityId}`);
  };

  const projectForScope = (scopeId: string): string => {
    for (const summary of profileStore.listProfiles()) {
      const match = summary.authorities.find(({ scopes }) =>
        scopes.some((scope) => scope.id === scopeId),
      );
      if (match) return match.authority.projectId;
    }
    throw new Error(`Scope not found: ${scopeId}`);
  };

  return {
    createProfile(input): { profile: ClientProfile; token: string } {
      const boundary = createProfileServiceInputSchema.parse(input);
      const { name } = createProfileInputSchema.parse({ name: boundary.name });
      const executionMode = boundary.executionMode === undefined
        ? "safe"
        : clientExecutionModeSchema.parse(boundary.executionMode);
      const timestamp = now();
      const profileId = newId("profile");
      const token = generateToken();
      const authority = boundary.projectId
        ? {
            id: newId("authority"),
            profileId,
            projectId: boundary.projectId,
            mode: "proposal" as const,
            createdAt: timestamp,
            updatedAt: timestamp,
          }
        : null;
      const created = profileStore.createProfile({
        profile: {
          id: profileId,
          name,
          status: "enabled",
          executionMode,
          tokenHash: hashCredential(token),
          createdAt: timestamp,
          updatedAt: timestamp,
          tokenRotatedAt: timestamp,
          lastUsedAt: null,
        },
        authority,
        audit: audit(
          "profile_created",
          profileId,
          boundary.projectId ?? null,
          timestamp,
        ),
      });

      return { profile: created.profile, token };
    },

    listProfiles(): ClientProfileSummary[] {
      return profileStore.listProfiles();
    },

    authenticate(
      credentials: ProfileCredentials | null,
    ): AuthenticatedProfile | null {
      if (credentials === null) return null;
      if (!credentials.profileId || !credentials.token) {
        throw governanceError(
          "profile_required",
          "Complete profile credentials are required",
        );
      }

      const stored = profileStore.findProfileForAuthentication(
        credentials.profileId,
      );
      if (!stored) {
        throw governanceError(
          "invalid_profile_credentials",
          "Invalid profile credentials",
        );
      }
      if (!credentialMatches(credentials.token, stored.tokenHash)) {
        throw governanceError(
          "invalid_profile_credentials",
          "Invalid profile credentials",
        );
      }
      if (stored.status === "disabled") {
        throw governanceError("profile_disabled", "Profile is disabled");
      }

      profileStore.touchLastUsed(stored.id, now());
      return {
        id: stored.id,
        name: stored.name,
        status: "enabled",
        credentialGeneration: stored.tokenRotatedAt,
      };
    },

    revalidatePrincipal(principal: AuthenticatedProfile): AuthenticatedProfile {
      return profileStore.revalidatePrincipal(principal);
    },

    setAuthority(input: SetAuthorityInput): ProfileProjectAuthority {
      const parsed = setAuthorityInputSchema.parse(input);
      const timestamp = now();
      const authority = profileStore.setAuthority({
        authority: {
          id: newId("authority"),
          ...parsed,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        audit: audit(
          "profile_authority_set",
          parsed.profileId,
          parsed.projectId,
          timestamp,
        ),
      });
      return authority;
    },

    addScope(input: AddScopeInput): ProfileScope {
      const parsed = addScopeInputSchema.parse(input);
      const timestamp = now();
      const scopeId = newId("scope");
      return profileStore.addScope({
        scope: {
          id: scopeId,
          ...parsed,
          createdAt: timestamp,
        },
        audit: audit(
          "profile_scope_added",
          scopeId,
          projectForAuthority(parsed.authorityId),
          timestamp,
        ),
      });
    },

    removeScope(scopeId: string): void {
      const parsedScopeId = identifierSchema.parse(scopeId);
      const projectId = projectForScope(parsedScopeId);
      const timestamp = now();
      profileStore.removeScope({
        scopeId: parsedScopeId,
        audit: audit(
          "profile_scope_removed",
          parsedScopeId,
          projectId,
          timestamp,
        ),
      });
    },

    rotateToken(profileId: string): { profileId: string; token: string } {
      const parsedProfileId = identifierSchema.parse(profileId);
      const token = generateToken();
      const timestamp = now();
      profileStore.rotateToken({
        profileId: parsedProfileId,
        tokenHash: hashCredential(token),
        timestamp,
        audit: audit(
          "profile_token_rotated",
          parsedProfileId,
          null,
          timestamp,
        ),
      });
      return { profileId: parsedProfileId, token };
    },

    setEnabled(profileId: string, enabled: boolean): ClientProfile {
      const parsedProfileId = identifierSchema.parse(profileId);
      const timestamp = now();
      return profileStore.setStatus({
        profileId: parsedProfileId,
        status: enabled ? "enabled" : "disabled",
        timestamp,
        audit: audit(
          enabled ? "profile_enabled" : "profile_disabled",
          parsedProfileId,
          null,
          timestamp,
        ),
      });
    },

    setExecutionMode(
      profileId: string,
      executionMode: ClientExecutionMode,
    ): ClientProfile {
      const parsedProfileId = identifierSchema.parse(profileId);
      const parsedExecutionMode = clientExecutionModeSchema.parse(executionMode);
      const timestamp = now();
      return profileStore.setExecutionMode({
        profileId: parsedProfileId,
        executionMode: parsedExecutionMode,
        timestamp,
        audit: audit(
          "profile_execution_mode_set",
          parsedProfileId,
          null,
          timestamp,
        ),
      });
    },
  };
};
