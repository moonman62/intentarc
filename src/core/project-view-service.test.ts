import { describe, expect, it } from "vitest";
import {
  InvalidTaskError,
  ProjectNotFoundError,
  RecordNotFoundError,
  softwareHierarchyVocabulary,
  type ClientProfileSummary,
  type OutboundDestination,
  type Project,
  type ProjectRecord,
  type RecordRelationship,
} from "../domain/index.js";
import type { GovernanceStore } from "../storage/governance-store.js";
import type { ProjectReadStore } from "../storage/project-store.js";
import type { DestinationService } from "./destination-service.js";
import type { ProfileService } from "./profile-service.js";
import { createProjectViewService } from "./project-view-service.js";

const project: Project = {
  id: "project-1",
  name: "IntentArc",
  revision: 8,
  primaryRepositoryPath: null,
  createdAt: "2026-07-29T08:00:00.000Z",
  updatedAt: "2026-07-29T08:00:00.000Z",
};

const record = (
  id: string,
  kind: ProjectRecord["kind"],
  status: ProjectRecord["status"],
  title: string,
  updatedAt: string,
): ProjectRecord => ({
  id,
  projectId: project.id,
  kind,
  status,
  title,
  body: `${title} body`,
  sourceKind: "human",
  sourceRef: null,
  revision: 1,
  createdAt: updatedAt,
  updatedAt,
});

const profile = (
  id: string,
  name: string,
  executionMode: "safe" | "trusted" | "custom",
  lastUsedAt: string | null,
  authorities: ClientProfileSummary["authorities"],
): ClientProfileSummary => ({
  profile: {
    id,
    name,
    status: "enabled",
    executionMode,
    createdAt: "2026-07-29T08:00:00.000Z",
    updatedAt: "2026-07-29T08:00:00.000Z",
    tokenRotatedAt: "2026-07-29T08:00:00.000Z",
    lastUsedAt,
  },
  authorities,
});

const authority = (
  id: string,
  profileId: string,
  projectId: string,
  mode: "proposal" | "scoped_direct" | "full_direct",
): ClientProfileSummary["authorities"][number] => ({
  authority: {
    id,
    profileId,
    projectId,
    mode,
    createdAt: "2026-07-29T08:00:00.000Z",
    updatedAt: "2026-07-29T08:00:00.000Z",
  },
  scopes: [],
});

const destination = (profileId: string): OutboundDestination => ({
  id: `destination-${profileId}`,
  profileId,
  revision: 1,
  clientLabel: "Codex",
  type: "ide_managed",
  providerLabel: "OpenAI",
  modelLabel: "GPT-5",
  accountBoundaryLabel: "work",
  dataBoundary: "remote",
  status: "enabled",
  current: true,
  createdAt: "2026-07-29T08:00:00.000Z",
  updatedAt: "2026-07-29T08:00:00.000Z",
});

const createService = (input: {
  records: ProjectRecord[];
  relationships?: RecordRelationship[];
  profiles?: ClientProfileSummary[];
  destinations?: OutboundDestination[];
  projects?: Project[];
}) => {
  const projects = input.projects ?? [project];
  const relationships = input.relationships ?? [];
  const profiles = input.profiles ?? [];
  const destinations = input.destinations ?? [];
  const projectStore: ProjectReadStore = {
    withReadSnapshot: (read) => read(),
    listProjects: () => projects,
    getProject: (projectId) => projects.find(({ id }) => id === projectId) ?? null,
    getHierarchyVocabulary: () => softwareHierarchyVocabulary,
    getRecord: (projectId, recordId) =>
      input.records.find(({ projectId: candidateProjectId, id }) =>
        candidateProjectId === projectId && id === recordId,
      ) ?? null,
    listRecords: (projectId) =>
      input.records.filter(({ projectId: candidateProjectId }) =>
        candidateProjectId === projectId,
      ),
    listRelationships: () => relationships,
    listRelationshipsForRecord: (projectId, recordId) => relationships.filter(
      (relationship) =>
        relationship.projectId === projectId &&
        (relationship.fromRecordId === recordId || relationship.toRecordId === recordId),
    ),
  };
  const governanceStore: Pick<GovernanceStore, "listProposals"> = {
    listProposals: ({ projectId, state }) =>
      projectId === project.id && state === "pending"
        ? [{ id: "proposal-1" }]
        : [],
  } as Pick<GovernanceStore, "listProposals">;
  const profileService: Pick<ProfileService, "listProfiles"> = {
    listProfiles: () => profiles,
  };
  const destinationService: Pick<DestinationService, "getCurrent"> = {
    getCurrent: (profileId) =>
      destinations.find((candidate) => candidate.profileId === profileId) ?? null,
  };

  return createProjectViewService({
    projectStore,
    governanceStore,
    profileService,
    destinationService,
  });
};

describe("project view service", () => {
  it("selects the hub's current records and pending proposals deterministically", () => {
    const service = createService({
      records: [
        record("outcome-accepted", "outcome", "accepted", "Accepted outcome", "2026-07-29T08:01:00.000Z"),
        record("outcome-active", "outcome", "active", "Stable combat loop", "2026-07-29T08:02:00.000Z"),
        record("task-blocked", "task", "blocked", "Reward ordering", "2026-07-29T08:03:00.000Z"),
        record("task-active", "task", "active", "Verify seeds", "2026-07-29T08:04:00.000Z"),
        record("risk-active", "risk", "active", "Slow frame pacing", "2026-07-29T08:05:00.000Z"),
        record("question-active", "question", "active", "Tune cadence", "2026-07-29T08:06:00.000Z"),
      ],
    });

    expect(service.listHubProjects()[0]).toMatchObject({
      currentOutcome: { title: "Stable combat loop", status: "active" },
      currentTask: { title: "Verify seeds", status: "active" },
      attention: { title: "Reward ordering", status: "blocked" },
      pendingProposalCount: 1,
      recordsByKind: { outcome: 2, task: 2, risk: 1, question: 1 },
    });
  });

  it("derives the current focus path from project-bound parent relationships without looping", () => {
    const otherProject: Project = { ...project, id: "project-2", name: "Other" };
    const outcome = record(
      "outcome-1",
      "outcome",
      "active",
      "Ship a dependable release",
      "2026-07-29T08:01:00.000Z",
    );
    const initiative = record(
      "initiative-1",
      "initiative",
      "active",
      "Guide the release",
      "2026-07-29T08:02:00.000Z",
    );
    const deliverable = record(
      "deliverable-1",
      "deliverable",
      "active",
      "Traceable overview",
      "2026-07-29T08:03:00.000Z",
    );
    const task = record(
      "task-1",
      "task",
      "active",
      "Verify the overview",
      "2026-07-29T08:04:00.000Z",
    );
    const outside = {
      ...record(
        "outside-outcome",
        "outcome",
        "active",
        "Outside project",
        "2026-07-29T08:05:00.000Z",
      ),
      projectId: otherProject.id,
    };
    const corruptBridge = record(
      "aaa-component",
      "component",
      "active",
      "Legacy non-hierarchy bridge",
      "2026-07-29T08:05:30.000Z",
    );
    const createdAt = "2026-07-29T08:06:00.000Z";
    const service = createService({
      projects: [project, otherProject],
      records: [outcome, initiative, deliverable, task, corruptBridge, outside],
      relationships: [
        { id: "parent-1", projectId: project.id, fromRecordId: outcome.id, toRecordId: initiative.id, kind: "parent_of", createdAt },
        { id: "parent-2", projectId: project.id, fromRecordId: initiative.id, toRecordId: deliverable.id, kind: "parent_of", createdAt },
        { id: "parent-3", projectId: project.id, fromRecordId: deliverable.id, toRecordId: task.id, kind: "parent_of", createdAt },
        { id: "corrupt-child", projectId: project.id, fromRecordId: outcome.id, toRecordId: corruptBridge.id, kind: "parent_of", createdAt },
        { id: "corrupt-parent", projectId: project.id, fromRecordId: corruptBridge.id, toRecordId: task.id, kind: "parent_of", createdAt },
        { id: "cycle", projectId: project.id, fromRecordId: task.id, toRecordId: outcome.id, kind: "parent_of", createdAt },
        { id: "outside", projectId: otherProject.id, fromRecordId: outside.id, toRecordId: outcome.id, kind: "parent_of", createdAt },
      ],
    });

    const currentFocusPath = service.getDashboard(project.id).currentFocusPath;
    expect(currentFocusPath.map(({ id }) => id))
      .toEqual(["outcome-1", "initiative-1", "deliverable-1", "task-1"]);
    for (const segment of currentFocusPath) {
      expect(segment).toEqual({
        id: segment.id,
        projectId: project.id,
        kind: segment.kind,
        status: segment.status,
        title: segment.title,
      });
    }
    expect(service.getDashboard(project.id)).toMatchObject({
      hierarchyVocabulary: softwareHierarchyVocabulary,
    });
  });

  it("projects primary hierarchy-parent kinds for every hierarchy record on the dashboard", () => {
    const outcome = record("outcome-1", "outcome", "active", "Ship", "2026-07-29T08:01:00.000Z");
    const currentTask = record("task-current", "task", "active", "Current work", "2026-07-29T08:05:00.000Z");
    const unrelatedParent = record("task-parent", "task", "archived", "Separate parent", "2026-07-29T08:02:00.000Z");
    const nestedAttention = record("task-nested", "task", "blocked", "Nested attention", "2026-07-29T08:04:00.000Z");
    const evidence = record("evidence-1", "evidence", "accepted", "Proof", "2026-07-29T08:03:00.000Z");
    const createdAt = "2026-07-29T08:06:00.000Z";
    const service = createService({
      records: [outcome, currentTask, unrelatedParent, nestedAttention, evidence],
      relationships: [
        { id: "current-parent", projectId: project.id, fromRecordId: outcome.id, toRecordId: currentTask.id, kind: "parent_of", createdAt },
        { id: "nested-parent", projectId: project.id, fromRecordId: unrelatedParent.id, toRecordId: nestedAttention.id, kind: "parent_of", createdAt },
        { id: "ignored-non-hierarchy", projectId: project.id, fromRecordId: evidence.id, toRecordId: nestedAttention.id, kind: "parent_of", createdAt },
      ],
    });

    expect(service.getDashboard(project.id).hierarchyParentContexts).toEqual([
      { recordId: "outcome-1", parentKind: null },
      { recordId: "task-current", parentKind: "outcome" },
      { recordId: "task-nested", parentKind: "task" },
    ]);
  });

  it("keeps profile execution mode independent from project authority in task handoffs", () => {
    const task = record("task-1", "task", "active", "Verify seeds", "2026-07-29T08:04:00.000Z");
    const service = createService({
      records: [task],
      profiles: [
        profile("profile-safe", "Codex Safe", "safe", "2026-07-29T09:00:00.000Z", [
          authority("authority-safe", "profile-safe", project.id, "proposal"),
        ]),
        profile("profile-trusted", "Trusted proposal", "trusted", "2026-07-29T08:30:00.000Z", [
          authority("authority-trusted", "profile-trusted", project.id, "proposal"),
        ]),
        profile("profile-full", "Safe full direct", "safe", "2026-07-29T08:00:00.000Z", [
          authority("authority-full", "profile-full", project.id, "full_direct"),
        ]),
        profile("profile-other", "No project authority", "custom", "2026-07-29T10:00:00.000Z", [
          authority("authority-other", "profile-other", "project-2", "full_direct"),
        ]),
      ],
      destinations: [destination("profile-safe")],
    });

    expect(service.getTaskHandoff(project.id, task.id).profiles).toEqual([
      expect.objectContaining({
        name: "Codex Safe",
        executionMode: "safe",
        knowledgeAuthorityMode: "proposal",
        destination: expect.objectContaining({ clientLabel: "Codex" }),
      }),
      expect.objectContaining({
        name: "Trusted proposal",
        executionMode: "trusted",
        knowledgeAuthorityMode: "proposal",
      }),
      expect.objectContaining({
        name: "Safe full direct",
        executionMode: "safe",
        knowledgeAuthorityMode: "full_direct",
      }),
    ]);
  });

  it("projects a disabled current destination as unavailable", () => {
    const task = record(
      "task-disabled-destination",
      "task",
      "active",
      "Use a current destination",
      "2026-07-29T08:04:00.000Z",
    );
    const disabledDestination: OutboundDestination = {
      ...destination("profile-retired"),
      revision: 2,
      status: "disabled",
    };
    const service = createService({
      records: [task],
      profiles: [
        profile(
          "profile-retired",
          "Retired client",
          "safe",
          null,
          [
            authority(
              "authority-retired",
              "profile-retired",
              project.id,
              "proposal",
            ),
          ],
        ),
      ],
      destinations: [disabledDestination],
    });

    expect(
      service.getTaskHandoff(project.id, task.id).profiles[0]?.destination,
    ).toBeNull();
  });

  it("builds task handoffs from directly connected records and rejects invalid tasks", () => {
    const task = record("task-1", "task", "active", "Build hub", "2026-07-29T08:04:00.000Z");
    const decision = record("decision-1", "decision", "accepted", "Use read models", "2026-07-29T08:03:00.000Z");
    const component = record("component-1", "component", "active", "View service", "2026-07-29T08:02:00.000Z");
    const nonTask = record("risk-1", "risk", "active", "Regression risk", "2026-07-29T08:01:00.000Z");
    const service = createService({
      records: [task, decision, component, nonTask],
      relationships: [
        { id: "relationship-1", projectId: project.id, fromRecordId: task.id, toRecordId: decision.id, kind: "decided_by", createdAt: task.createdAt },
        { id: "relationship-2", projectId: project.id, fromRecordId: component.id, toRecordId: task.id, kind: "implements", createdAt: task.createdAt },
        { id: "relationship-3", projectId: project.id, fromRecordId: task.id, toRecordId: decision.id, kind: "related_to", createdAt: task.createdAt },
      ],
    });

    expect(service.getTaskHandoff(project.id, task.id).relatedRecords.map(({ id }) => id)).toEqual([
      component.id,
      decision.id,
    ]);
    expect(() => service.getTaskHandoff(project.id, nonTask.id)).toThrow(
      new InvalidTaskError(nonTask.id),
    );
    expect(() => service.getTaskHandoff(project.id, "missing-record")).toThrow(
      new RecordNotFoundError("missing-record"),
    );
    expect(() => service.getDashboard("missing-project")).toThrow(
      new ProjectNotFoundError("missing-project"),
    );
  });
});
