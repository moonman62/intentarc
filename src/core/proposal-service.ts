import { z } from "zod";
import {
  GovernanceError,
  createRepositoryRefreshProposalInputSchema,
  proposalFilterSchema,
  type ChangeProposal,
  type CreateRepositoryRefreshProposalInput,
  type ProposalFilter,
} from "../domain/index.js";
import {
  type ChangeProposalDetail,
  type ChangeProposalSummary,
  type GovernanceStore,
  type ProposalDecisionResult,
} from "../storage/governance-store.js";

export interface ProposalService {
  list(input: ProposalFilter): ChangeProposalSummary[];
  get(proposalId: string): ChangeProposalDetail;
  accept(proposalId: string): ProposalDecisionResult;
  reject(input: { proposalId: string; reason: string }): ChangeProposal;
  withdraw(input: { proposalId: string; reason: string }): ChangeProposal;
  createRepositoryRefresh(
    input: CreateRepositoryRefreshProposalInput,
  ): ChangeProposalDetail;
}

type ProposalGovernanceStore = Pick<
  GovernanceStore,
  | "listProposals"
  | "getProposal"
  | "acceptProposal"
  | "rejectProposal"
  | "withdrawProposal"
  | "createRepositoryRefreshProposal"
>;

export interface ProposalServiceDependencies {
  governanceStore: ProposalGovernanceStore;
  now: () => string;
}

const identifierSchema = z.string().trim().min(1);
const reasonedDecisionSchema = z
  .object({
    proposalId: identifierSchema,
    reason: z.string().trim().min(1),
  })
  .strict();

const proposalMissing = (): GovernanceError =>
  new GovernanceError("validation_failed", "Proposal not found");

export const createProposalService = ({
  governanceStore,
  now,
}: ProposalServiceDependencies): ProposalService => {
  const existingProposal = (rawProposalId: string): ChangeProposalDetail => {
    const proposalId = identifierSchema.parse(rawProposalId);
    const proposal = governanceStore.getProposal(proposalId);
    if (!proposal) throw proposalMissing();
    return proposal;
  };

  return {
    list(input: ProposalFilter): ChangeProposalSummary[] {
      const parsed = proposalFilterSchema.parse(input);
      return governanceStore.listProposals(parsed);
    },

    get(proposalId: string): ChangeProposalDetail {
      return existingProposal(proposalId);
    },

    createRepositoryRefresh(
      input: CreateRepositoryRefreshProposalInput,
    ): ChangeProposalDetail {
      const parsed = createRepositoryRefreshProposalInputSchema.parse(input);
      return governanceStore.createRepositoryRefreshProposal({
        input: parsed,
        createdAt: now(),
      });
    },

    accept(proposalId: string): ProposalDecisionResult {
      const proposal = existingProposal(proposalId);
      return governanceStore.acceptProposal({
        proposalId: proposal.id,
        reason: null,
        reviewedAt: now(),
      });
    },

    reject(input: {
      proposalId: string;
      reason: string;
    }): ChangeProposal {
      const parsed = reasonedDecisionSchema.parse(input);
      const proposal = existingProposal(parsed.proposalId);
      return governanceStore.rejectProposal({
        proposalId: proposal.id,
        reason: parsed.reason,
        reviewedAt: now(),
      });
    },

    withdraw(input: {
      proposalId: string;
      reason: string;
    }): ChangeProposal {
      const parsed = reasonedDecisionSchema.parse(input);
      const proposal = existingProposal(parsed.proposalId);
      return governanceStore.withdrawProposal({
        proposalId: proposal.id,
        reason: parsed.reason,
        reviewedAt: now(),
      });
    },
  };
};
