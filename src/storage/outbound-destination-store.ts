import { z } from "zod";
import type { OutboundDestination } from "../domain/index.js";
import { outboundDestinationSchema } from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import type { IntentArcDatabase } from "./database.js";

export interface OutboundDestinationAudit {
  id: string;
  createdAt: string;
}

export interface SetDestinationCommand {
  destination: Omit<
    OutboundDestination,
    "revision" | "status" | "current"
  >;
  audit: OutboundDestinationAudit;
}

export interface DisableDestinationCommand {
  profileId: string;
  createdAt: string;
  updatedAt: string;
  audit: OutboundDestinationAudit;
}

export interface OutboundDestinationStore {
  getCurrent(profileId: string): OutboundDestination | null;
  set(command: SetDestinationCommand): OutboundDestination;
  disable(command: DisableDestinationCommand): OutboundDestination;
}

type OutboundDestinationRow = {
  destination_id: string;
  revision: number;
  profile_id: string;
  client_label: string;
  destination_type: OutboundDestination["type"];
  provider_label: string;
  model_label: string | null;
  account_boundary_label: string | null;
  data_boundary: OutboundDestination["dataBoundary"];
  status: OutboundDestination["status"];
  is_current: number;
  created_at: string;
  updated_at: string;
};

const destinationColumns = `
  destination_id, revision, profile_id, client_label, destination_type,
  provider_label, model_label, account_boundary_label, data_boundary,
  status, is_current, created_at, updated_at
`;

const outboundDestinationAuditSchema: z.ZodType<OutboundDestinationAudit> =
  z.object({
    id: z.string().trim().min(1).max(200),
    createdAt: z.iso.datetime(),
  }).strict();

const mapDestinationRow = (
  row: OutboundDestinationRow,
): OutboundDestination => outboundDestinationSchema.parse({
  id: row.destination_id,
  profileId: row.profile_id,
  revision: row.revision,
  clientLabel: row.client_label,
  type: row.destination_type,
  providerLabel: row.provider_label,
  modelLabel: row.model_label,
  accountBoundaryLabel: row.account_boundary_label,
  dataBoundary: row.data_boundary,
  status: row.status,
  current: row.is_current === 1
    ? true
    : row.is_current === 0
    ? false
    : row.is_current,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const normalizeStoreFailure = <Result>(operation: () => Result): Result => {
  try {
    return operation();
  } catch (error) {
    if (error instanceof OutboundSafetyError) throw error;
    throw new OutboundSafetyError("outbound_safety_failed", {});
  }
};

export const createOutboundDestinationStore = (
  database: IntentArcDatabase,
): OutboundDestinationStore => {
  const selectCurrent = database.prepare(`
    SELECT ${destinationColumns}
    FROM outbound_destinations
    WHERE profile_id = ? AND is_current = 1
  `);
  const selectRevision = database.prepare(`
    SELECT ${destinationColumns}
    FROM outbound_destinations
    WHERE profile_id = ? AND revision = ?
  `);
  const clearCurrent = database.prepare(`
    UPDATE outbound_destinations SET is_current = 0
    WHERE profile_id = ? AND is_current = 1
  `);
  const deletePolicies = database.prepare(`
    DELETE FROM outbound_policies WHERE profile_id = ?
  `);
  const insertDestination = database.prepare(`
    INSERT INTO outbound_destinations (
      destination_id, revision, profile_id, client_label, destination_type,
      provider_label, model_label, account_boundary_label, data_boundary,
      status, is_current, created_at, updated_at
    ) VALUES (
      @id, @revision, @profileId, @clientLabel, @type,
      @providerLabel, @modelLabel, @accountBoundaryLabel, @dataBoundary,
      @status, 1, @createdAt, @updatedAt
    )
  `);
  const insertAudit = database.prepare(`
    INSERT INTO audit_events (
      id, project_id, actor_type, profile_id, authority_mode, scope_decision,
      action_category, target_id, idempotency_key, revision_before,
      revision_after, outcome, reason, created_at
    ) VALUES (
      @id, @projectId, 'local_human', NULL, 'human', 'human_admin',
      @actionCategory, @targetId, NULL, @revisionBefore,
      @revisionAfter, 'applied', @reason, @createdAt
    )
  `);

  const currentRow = (profileId: string): OutboundDestination | null => {
    const row = selectCurrent.get(profileId) as
      | OutboundDestinationRow
      | undefined;
    return row ? mapDestinationRow(row) : null;
  };

  const revisionRow = (
    profileId: string,
    revision: number,
  ): OutboundDestination => {
    const row = selectRevision.get(profileId, revision) as
      | OutboundDestinationRow
      | undefined;
    if (!row) throw new Error("Inserted destination revision was not found");
    return mapDestinationRow(row);
  };

  const setTransaction = database.transaction(
    (command: SetDestinationCommand): OutboundDestination => {
      const audit = outboundDestinationAuditSchema.parse(command.audit);
      const current = currentRow(command.destination.profileId);
      if (current && current.id !== command.destination.id) {
        throw new Error("Destination identity cannot change");
      }
      const revision = (current?.revision ?? 0) + 1;
      const destination = outboundDestinationSchema.parse({
        ...command.destination,
        revision,
        status: "enabled",
        current: true,
      });
      if (current) {
        clearCurrent.run(destination.profileId);
        deletePolicies.run(destination.profileId);
      }
      insertDestination.run(destination);
      insertAudit.run({
        id: audit.id,
        projectId: null,
        actionCategory: "outbound_destination_set",
        targetId: destination.id,
        reason: `destination_revision:${revision}`,
        createdAt: audit.createdAt,
        revisionBefore: current?.revision ?? null,
        revisionAfter: revision,
      });
      return revisionRow(destination.profileId, revision);
    },
  );

  const disableTransaction = database.transaction(
    (command: DisableDestinationCommand): OutboundDestination => {
      const audit = outboundDestinationAuditSchema.parse(command.audit);
      const current = currentRow(command.profileId);
      if (!current) {
        throw new OutboundSafetyError("outbound_destination_required", {
          profileId: command.profileId,
        });
      }
      const revision = current.revision + 1;
      const destination = outboundDestinationSchema.parse({
        ...current,
        revision,
        status: "disabled",
        current: true,
        createdAt: command.createdAt,
        updatedAt: command.updatedAt,
      });
      clearCurrent.run(command.profileId);
      deletePolicies.run(command.profileId);
      insertDestination.run(destination);
      insertAudit.run({
        id: audit.id,
        projectId: null,
        actionCategory: "outbound_destination_disabled",
        targetId: destination.id,
        reason: `destination_revision:${revision}`,
        createdAt: audit.createdAt,
        revisionBefore: current.revision,
        revisionAfter: revision,
      });
      return revisionRow(command.profileId, revision);
    },
  );

  return {
    getCurrent(profileId: string): OutboundDestination | null {
      return normalizeStoreFailure(() => currentRow(profileId));
    },
    set(command: SetDestinationCommand): OutboundDestination {
      return normalizeStoreFailure(() => setTransaction.immediate(command));
    },
    disable(command: DisableDestinationCommand): OutboundDestination {
      return normalizeStoreFailure(() => disableTransaction.immediate(command));
    },
  };
};
