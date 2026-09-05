import type {
  AuthenticatedProfile,
  AuthorityWithScopes,
  ClientExecutionMode,
  ClientProfile,
  ClientProfileSummary,
  ProfileProjectAuthority,
  ProfileScope,
  StoredClientProfile,
} from "../domain/index.js";
import {
  GovernanceError,
  clientProfileSchema,
  credentialHashSchema,
  profileScopeSchema,
} from "../domain/index.js";
import type { IntentArcDatabase } from "./database.js";
import {
  mapClientProfileRow,
  mapProfileProjectAuthorityRow,
  mapProfileScopeRow,
  mapStoredClientProfileRow,
  type ClientProfileRow,
  type ProfileProjectAuthorityRow,
  type ProfileScopeRow,
} from "./governance-mappers.js";

export type AdministrativeAudit = {
  id: string;
  projectId: string | null;
  actionCategory:
    | "profile_created"
    | "profile_authority_set"
    | "profile_scope_added"
    | "profile_scope_removed"
    | "profile_token_rotated"
    | "profile_execution_mode_set"
    | "profile_enabled"
    | "profile_disabled";
  targetId: string | null;
  createdAt: string;
};

export interface CreateProfileCommand {
  profile: StoredClientProfile;
  authority: ProfileProjectAuthority | null;
  audit: AdministrativeAudit;
}

export interface CreatedProfile {
  profile: ClientProfile;
  authority: ProfileProjectAuthority | null;
}

export interface SetAuthorityCommand {
  authority: ProfileProjectAuthority;
  audit: AdministrativeAudit;
}

export interface AddScopeCommand {
  scope: ProfileScope;
  audit: AdministrativeAudit;
}

export interface RemoveScopeCommand {
  scopeId: string;
  audit: AdministrativeAudit;
}

export interface RotateTokenCommand {
  profileId: string;
  tokenHash: string;
  timestamp: string;
  audit: AdministrativeAudit;
}

export interface SetProfileStatusCommand {
  profileId: string;
  status: "enabled" | "disabled";
  timestamp: string;
  audit: AdministrativeAudit;
}

export interface SetProfileExecutionModeCommand {
  profileId: string;
  executionMode: ClientExecutionMode;
  timestamp: string;
  audit: AdministrativeAudit;
}

export interface ProfileStore {
  createProfile(command: CreateProfileCommand): CreatedProfile;
  getProfile(profileId: string): ClientProfile | null;
  findProfileForAuthentication(profileId: string): StoredClientProfile | null;
  revalidatePrincipal(principal: AuthenticatedProfile): AuthenticatedProfile;
  touchLastUsed(profileId: string, at: string): void;
  listProfiles(): ClientProfileSummary[];
  setAuthority(command: SetAuthorityCommand): ProfileProjectAuthority;
  getAuthority(profileId: string, projectId: string): AuthorityWithScopes | null;
  listScopes(authorityId: string): ProfileScope[];
  addScope(command: AddScopeCommand): ProfileScope;
  removeScope(command: RemoveScopeCommand): void;
  rotateToken(command: RotateTokenCommand): void;
  setStatus(command: SetProfileStatusCommand): ClientProfile;
  setExecutionMode(command: SetProfileExecutionModeCommand): ClientProfile;
}

const profileColumns = `
  id, name, status, execution_mode, token_hash, created_at, updated_at, token_rotated_at,
  last_used_at
`;
const publicProfileColumns = `
  id, name, status, execution_mode, created_at, updated_at, token_rotated_at, last_used_at
`;
const authorityColumns = `
  id, profile_id, project_id, mode, created_at, updated_at
`;
const scopeColumns = `
  id, authority_id, operation_type, record_kind, from_record_kind,
  to_record_kind, relationship_kind, created_at
`;

const validateScopeShape = (scope: ProfileScope): ProfileScope => {
  const parsed = profileScopeSchema.parse(scope);
  const isRecordOperation =
    parsed.operationType === "create_record" ||
    parsed.operationType === "update_record";

  if (
    isRecordOperation &&
    (parsed.fromRecordKind !== null ||
      parsed.toRecordKind !== null ||
      parsed.relationshipKind !== null)
  ) {
    throw new Error("Record operation scopes may use only recordKind");
  }

  if (!isRecordOperation && parsed.recordKind !== null) {
    throw new Error("Relationship operation scopes may not use recordKind");
  }

  return parsed;
};

const nextCredentialGeneration = (
  requestedAt: string,
  currentGeneration: string,
): string => {
  const requestedTime = Date.parse(requestedAt);
  const currentTime = Date.parse(currentGeneration);
  if (!Number.isFinite(requestedTime) || !Number.isFinite(currentTime)) {
    if (requestedAt === currentGeneration) {
      throw new Error("Profile token rotation timestamps must advance");
    }
    return requestedAt;
  }
  return new Date(Math.max(requestedTime, currentTime + 1)).toISOString();
};

export const createProfileStore = (
  database: IntentArcDatabase,
): ProfileStore => {
  const insertProfile = database.prepare(`
    INSERT INTO client_profiles (
      id, name, status, execution_mode, token_hash, created_at, updated_at, token_rotated_at,
      last_used_at
    ) VALUES (
      @id, @name, @status, @executionMode, @tokenHash, @createdAt, @updatedAt,
      @tokenRotatedAt, @lastUsedAt
    )
  `);
  const selectProfile = database.prepare(
    `SELECT ${profileColumns} FROM client_profiles WHERE id = ?`,
  );
  const selectPublicProfile = database.prepare(
    `SELECT ${publicProfileColumns} FROM client_profiles WHERE id = ?`,
  );
  const selectPrincipalProfile = database.prepare(`
    SELECT id, name, status, token_rotated_at
    FROM client_profiles
    WHERE id = ?
  `);
  const selectProfiles = database.prepare(
    `SELECT ${profileColumns} FROM client_profiles ORDER BY created_at, id`,
  );
  const insertAuthority = database.prepare(`
    INSERT INTO profile_project_authorities (
      id, profile_id, project_id, mode, created_at, updated_at
    ) VALUES (
      @id, @profileId, @projectId, @mode, @createdAt, @updatedAt
    )
  `);
  const upsertAuthority = database.prepare(`
    INSERT INTO profile_project_authorities (
      id, profile_id, project_id, mode, created_at, updated_at
    ) VALUES (
      @id, @profileId, @projectId, @mode, @createdAt, @updatedAt
    )
    ON CONFLICT (profile_id, project_id) DO UPDATE SET
      mode = excluded.mode,
      updated_at = excluded.updated_at
  `);
  const selectAuthorityByProfileProject = database.prepare(`
    SELECT ${authorityColumns}
    FROM profile_project_authorities
    WHERE profile_id = ? AND project_id = ?
  `);
  const selectAuthoritiesByProfile = database.prepare(`
    SELECT ${authorityColumns}
    FROM profile_project_authorities
    WHERE profile_id = ?
    ORDER BY project_id, id
  `);
  const insertScope = database.prepare(`
    INSERT INTO profile_scopes (
      id, authority_id, operation_type, record_kind, from_record_kind,
      to_record_kind, relationship_kind, created_at
    ) VALUES (
      @id, @authorityId, @operationType, @recordKind, @fromRecordKind,
      @toRecordKind, @relationshipKind, @createdAt
    )
  `);
  const selectScopes = database.prepare(`
    SELECT ${scopeColumns}
    FROM profile_scopes
    WHERE authority_id = ?
    ORDER BY operation_type, id
  `);
  const deleteScope = database.prepare(
    "DELETE FROM profile_scopes WHERE id = ?",
  );
  const insertAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_admin',
      @actionCategory, @targetId, NULL, NULL, NULL, 'applied', NULL, @createdAt
    )
  `);
  const updateLastUsed = database.prepare(`
    UPDATE client_profiles SET last_used_at = ? WHERE id = ?
  `);
  const updateToken = database.prepare(`
    UPDATE client_profiles
    SET token_hash = @tokenHash, token_rotated_at = @timestamp,
        updated_at = @timestamp
    WHERE id = @profileId
  `);
  const updateStatus = database.prepare(`
    UPDATE client_profiles
    SET status = @status, updated_at = @timestamp
    WHERE id = @profileId
  `);
  const updateExecutionMode = database.prepare(`
    UPDATE client_profiles
    SET execution_mode = @executionMode, updated_at = @timestamp
    WHERE id = @profileId
  `);

  const profileOrThrow = (profileId: string): ClientProfile => {
    const row = selectProfile.get(profileId) as ClientProfileRow | undefined;
    if (!row) throw new Error(`Profile not found: ${profileId}`);
    return mapClientProfileRow(row);
  };

  const listScopes = (authorityId: string): ProfileScope[] =>
    (selectScopes.all(authorityId) as ProfileScopeRow[]).map(mapProfileScopeRow);

  const createProfileTransaction = database.transaction(
    (command: CreateProfileCommand): CreatedProfile => {
      insertProfile.run(command.profile);
      if (command.authority) insertAuthority.run(command.authority);
      insertAudit.run(command.audit);
      return {
        profile: profileOrThrow(command.profile.id),
        authority: command.authority,
      };
    },
  );

  const setAuthorityTransaction = database.transaction(
    (command: SetAuthorityCommand): ProfileProjectAuthority => {
      upsertAuthority.run(command.authority);
      const row = selectAuthorityByProfileProject.get(
        command.authority.profileId,
        command.authority.projectId,
      ) as ProfileProjectAuthorityRow | undefined;
      if (!row) throw new Error("Authority upsert could not be read");
      const authority = mapProfileProjectAuthorityRow(row);
      insertAudit.run({ ...command.audit, targetId: authority.id });
      return authority;
    },
  );

  const addScopeTransaction = database.transaction(
    (command: AddScopeCommand): ProfileScope => {
      const scope = validateScopeShape(command.scope);
      insertScope.run(scope);
      insertAudit.run(command.audit);
      return scope;
    },
  );

  const removeScopeTransaction = database.transaction(
    (command: RemoveScopeCommand): void => {
      const result = deleteScope.run(command.scopeId);
      if (result.changes === 0) throw new Error(`Scope not found: ${command.scopeId}`);
      insertAudit.run(command.audit);
    },
  );

  const rotateTokenTransaction = database.transaction(
    (command: RotateTokenCommand): void => {
      const current = profileOrThrow(command.profileId);
      const result = updateToken.run({
        ...command,
        timestamp: nextCredentialGeneration(
          command.timestamp,
          current.tokenRotatedAt,
        ),
      });
      if (result.changes === 0) throw new Error(`Profile not found: ${command.profileId}`);
      insertAudit.run(command.audit);
    },
  );

  const setStatusTransaction = database.transaction(
    (command: SetProfileStatusCommand): ClientProfile => {
      const result = updateStatus.run(command);
      if (result.changes === 0) throw new Error(`Profile not found: ${command.profileId}`);
      insertAudit.run(command.audit);
      return profileOrThrow(command.profileId);
    },
  );

  const setExecutionModeTransaction = database.transaction(
    (command: SetProfileExecutionModeCommand): ClientProfile => {
      const result = updateExecutionMode.run(command);
      if (result.changes === 0) throw new Error(`Profile not found: ${command.profileId}`);
      insertAudit.run(command.audit);
      return profileOrThrow(command.profileId);
    },
  );

  return {
    createProfile(command: CreateProfileCommand): CreatedProfile {
      credentialHashSchema.parse(command.profile.tokenHash);
      return createProfileTransaction(command);
    },

    getProfile(profileId: string): ClientProfile | null {
      const row = selectPublicProfile.get(profileId) as
        | Omit<ClientProfileRow, "token_hash">
        | undefined;
      if (!row) return null;
      return clientProfileSchema.parse({
        id: row.id,
        name: row.name,
        status: row.status,
        executionMode: row.execution_mode,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        tokenRotatedAt: row.token_rotated_at,
        lastUsedAt: row.last_used_at,
      });
    },

    findProfileForAuthentication(profileId: string): StoredClientProfile | null {
      const row = selectProfile.get(profileId) as ClientProfileRow | undefined;
      return row ? mapStoredClientProfileRow(row) : null;
    },

    revalidatePrincipal(
      principal: AuthenticatedProfile,
    ): AuthenticatedProfile {
      const row = selectPrincipalProfile.get(principal.id) as
        | Pick<ClientProfileRow, "id" | "name" | "status" | "token_rotated_at">
        | undefined;
      if (
        !row ||
        row.token_rotated_at !== principal.credentialGeneration
      ) {
        throw new GovernanceError(
          "invalid_profile_credentials",
          "invalid_profile_credentials",
        );
      }
      if (row.status === "disabled") {
        throw new GovernanceError("profile_disabled", "profile_disabled");
      }
      return {
        id: row.id,
        name: row.name,
        status: "enabled",
        credentialGeneration: row.token_rotated_at,
      };
    },

    touchLastUsed(profileId: string, at: string): void {
      updateLastUsed.run(at, profileId);
    },

    listProfiles(): ClientProfileSummary[] {
      return (selectProfiles.all() as ClientProfileRow[]).map((profileRow) => ({
        profile: mapClientProfileRow(profileRow),
        authorities: (
          selectAuthoritiesByProfile.all(profileRow.id) as ProfileProjectAuthorityRow[]
        ).map((authorityRow) => {
          const authority = mapProfileProjectAuthorityRow(authorityRow);
          return { authority, scopes: listScopes(authority.id) };
        }),
      }));
    },

    setAuthority: setAuthorityTransaction,

    getAuthority(
      profileId: string,
      projectId: string,
    ): AuthorityWithScopes | null {
      const row = selectAuthorityByProfileProject.get(
        profileId,
        projectId,
      ) as ProfileProjectAuthorityRow | undefined;
      if (!row) return null;
      const authority = mapProfileProjectAuthorityRow(row);
      return { authority, scopes: listScopes(authority.id) };
    },

    listScopes,
    addScope: addScopeTransaction,
    removeScope: removeScopeTransaction,
    rotateToken(command: RotateTokenCommand): void {
      credentialHashSchema.parse(command.tokenHash);
      rotateTokenTransaction.immediate(command);
    },
    setStatus: setStatusTransaction,
    setExecutionMode: setExecutionModeTransaction,
  };
};
