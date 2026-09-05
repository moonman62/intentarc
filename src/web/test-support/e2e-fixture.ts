import { mkdirSync } from "node:fs";
import path from "node:path";
import {
  createApplication,
  type IntentArcApplication,
} from "../../app/create-application.js";
import {
  softwareHierarchyVocabulary,
  type ProposedImportRecord,
  type RepositoryImportManifest,
} from "../../domain/index.js";
import {
  createRepositoryFixture,
  type RepositoryFixture,
} from "../../test-support/repository-fixture.js";
import {
  createRepositoryObservationScanner,
  type RepositoryObservationScanner,
} from "../../repository/observation-scanner.js";
import {
  captureRepositorySource,
  withReadOnlyRepositorySource,
  withReadOnlyRepositorySourceAsync,
} from "../../test-support/repository-source-snapshot.js";

const E2E_TIMESTAMP = "2026-07-29T12:00:00.000Z";
const PROJECT_MAP_ADVERSARIAL_TITLE = `NarrowViewport${"UnbrokenHierarchyTitle".repeat(18)}`;
const adversarialIdentityToken = `Identity${"UnbrokenMapId".repeat(18)}`;

export const structuredKnowledgeAdversarialFixture = {
  documentPath: `adversarial-${"LongPathSegment".repeat(4)}.md`,
  acceptedBody: `# Bounded accepted document\n\n${"😀UnbrokenAcceptedContent".repeat(240)}TAIL-CONTENT-SENTINEL`,
  omittedContentTail: "TAIL-CONTENT-SENTINEL",
  repositoryIdentityToken: `RepositoryIdentity${"UnbrokenNodeId".repeat(12)}`,
} as const;

export const projectMapAdversarialFixture = {
  identityToken: adversarialIdentityToken,
  project: {
    id: `project-${adversarialIdentityToken}-1`,
    name: `Project${"UnbrokenProjectIdentity".repeat(18)}`,
  },
  records: [
    { id: `record-${adversarialIdentityToken}-1`, kind: "outcome", label: "Product outcome", title: `Outcome${"UnbrokenBreadcrumb".repeat(15)}` },
    { id: `record-${adversarialIdentityToken}-2`, kind: "initiative", label: "Epic", title: `Initiative${"UnbrokenBreadcrumb".repeat(15)}` },
    { id: `record-${adversarialIdentityToken}-3`, kind: "deliverable", label: "Feature", title: `Deliverable${"UnbrokenBreadcrumb".repeat(15)}` },
    { id: `record-${adversarialIdentityToken}-4`, kind: "task", label: "Story or Task", title: `Task${"UnbrokenBreadcrumb".repeat(15)}` },
    { id: `record-${adversarialIdentityToken}-5`, kind: "task", label: "Subtask", title: `Subtask${"UnbrokenBreadcrumb".repeat(15)}` },
  ],
  secondOutcome: {
    id: `record-${adversarialIdentityToken}-6`,
    title: `OutcomeBranch${"UnbrokenBreadcrumb".repeat(12)}`,
  },
  alternateBranch: [
    { id: `record-${adversarialIdentityToken}-7`, kind: "initiative", title: `AlternateInitiative${"UnbrokenBreadcrumb".repeat(12)}` },
    { id: `record-${adversarialIdentityToken}-8`, kind: "deliverable", title: `AlternateDeliverable${"UnbrokenBreadcrumb".repeat(12)}` },
    { id: `record-${adversarialIdentityToken}-9`, kind: "task", title: `AlternateTask${"UnbrokenBreadcrumb".repeat(12)}` },
  ],
  unplacedTask: {
    id: `record-${adversarialIdentityToken}-10`,
    title: `UnplacedTask${"UnbrokenBreadcrumb".repeat(12)}`,
  },
  decision: {
    id: `record-${adversarialIdentityToken}-11`,
    title: `Decision${"UnbrokenRelationshipMetadata".repeat(12)}`,
  },
  selectedBody: `Body${"UnbrokenSelectedDetail".repeat(18)}`,
  evidence: {
    id: `record-${adversarialIdentityToken}-12`,
    title: `Evidence${"UnbrokenRelationshipMetadata".repeat(14)}`,
  },
  dependencyRelationshipId: `relationship-${adversarialIdentityToken}-8`,
  decisionRelationshipId: `relationship-${adversarialIdentityToken}-9`,
  relationshipId: `relationship-${adversarialIdentityToken}-10`,
  unplacedRelationshipId: `relationship-${adversarialIdentityToken}-11`,
  acceptedAttachment: {
    path: "README.md",
    body: "This is the accepted document body.",
    kind: "documents",
    basis: "accepted",
  },
} as const;

const structuredRecord = (
  key: string,
  kind: ProposedImportRecord["kind"],
  status: ProposedImportRecord["status"],
  title: string,
): ProposedImportRecord => ({
  key,
  kind,
  status,
  title,
  body: `${title} is governed local project intent.`,
  sourceKind: "agent",
  sourceRef: null,
  sourceRefs: [],
  curationReason: "Curated for deterministic browser verification.",
});

const seedVisualFoundation = (application: IntentArcApplication): void => {
  const project = application.service.createProject({
    name: "IntentArc Visual Foundation",
  });
  application.service.createRecord({
    projectId: project.id,
    kind: "outcome",
    status: "active",
    title: "Reach a trustworthy visual foundation",
    body: "Keep local project intent visible, governed, and safe to hand off.",
    sourceKind: "human",
    sourceRef: null,
  });
  const currentTask = application.service.createRecord({
    projectId: project.id,
    kind: "task",
    status: "active",
    title: "Verify deterministic browser journeys",
    body: [
      "Prove keyboard navigation, persisted preferences, and safe context.",
      "Review endpoint: 192.0.2.1.",
    ].join(" "),
    sourceKind: "human",
    sourceRef: null,
  });
  const omittedEvidence = application.service.createRecord({
    projectId: project.id,
    kind: "evidence",
    status: "accepted",
    title: "Oversized browser retrieval evidence",
    body: "Retrieve this governed detail separately. ".repeat(4_000),
    sourceKind: "human",
    sourceRef: null,
  });
  application.service.createRelationship({
    projectId: project.id,
    fromRecordId: omittedEvidence.id,
    toRecordId: currentTask.id,
    kind: "evidenced_by",
    expectedProjectRevision: application.service.getProjectSummary(project.id)
      .project.revision,
  });
  application.service.createRecord({
    projectId: project.id,
    kind: "task",
    status: "blocked",
    title: "Resolve fixture review warning",
    body: "Keep blocked attention visible until the browser proof is recorded.",
    sourceKind: "human",
    sourceRef: null,
  });

  const profile = application.service.profiles.createProfile({
    name: "Codex Safe",
    projectId: project.id,
    executionMode: "safe",
  });
  application.service.destinations.set({
    profileId: profile.profile.id,
    clientLabel: "Codex",
    type: "ide_managed",
    providerLabel: "OpenAI",
    modelLabel: null,
    accountBoundaryLabel: "Local end-to-end fixture",
    dataBoundary: "remote",
  });
  const principal = application.service.profiles.authenticate({
    profileId: profile.profile.id,
    token: profile.token,
  });
  if (!principal) throw new Error("The deterministic end-to-end profile was not created.");
  const proposal = application.service.submitChangeSet(principal, {
    projectId: project.id,
    baseProjectRevision: application.service.views.getDashboard(project.id).project.revision,
    idempotencyKey: "visual-foundation-e2e-proposal",
    rationale: "Capture visual acceptance evidence",
    sourceTaskId: currentTask.id,
    predecessorProposalId: null,
    operations: [{
      operationId: "create-visual-evidence",
      type: "create_record",
      localRef: "visual-evidence",
      kind: "evidence",
      status: "provisional",
      title: "Archive theme browser proof",
      body: "Record the reviewed light and dark browser references.",
    }],
  });
  if (proposal.outcome !== "proposed") {
    throw new Error("The deterministic proposal did not enter review.");
  }
};

export const createStructuredBrowserRepository = (): RepositoryFixture => {
  const parentDirectory = path.resolve(
    "node_modules",
    ".cache",
    "intentarc-structured-e2e",
  );
  mkdirSync(parentDirectory, { recursive: true });
  const files: Record<string, string> = {
    "project.godot": [
      "; Engine configuration file.",
      "[application]",
      'config/name="Structured Knowledge Browser Fixture"',
      "",
    ].join("\n"),
    "README.md": "# Browser knowledge\n\nThis is the accepted document body.\n",
    "docs/operations-guide.md": "# Operations guide\n\nRefreshes require review.\n",
    "src/index.ts": "export const browserFixture = true;\n",
    [structuredKnowledgeAdversarialFixture.documentPath]:
      structuredKnowledgeAdversarialFixture.acceptedBody,
  };
  for (let index = 0; index < 96; index += 1) {
    files[`docs/reference-${String(index).padStart(3, "0")}.md`] =
      `# Reference ${index}\n\nBounded browser scan evidence.\n`;
  }
  return createRepositoryFixture(files, { parentDirectory });
};

export const seedBrowserDatabase = async (
  databasePath: string,
  repository: RepositoryFixture,
): Promise<void> => {
  const idCounters = new Map<string, number>();
  const adversarialIdCounters = new Map<string, number>();
  let adversarialIds = false;
  let acceptedAttachmentTargetRecordId: string | null = null;
  const realScanner = createRepositoryObservationScanner();
  const isInjectedAttachment = (link: {
    readonly fromPath: string;
    readonly toRecordId: string | null;
    readonly toPath: string | null;
    readonly kind: string;
    readonly basis: string;
  }): boolean => (
    acceptedAttachmentTargetRecordId !== null &&
    link.fromPath === projectMapAdversarialFixture.acceptedAttachment.path &&
    link.toRecordId === acceptedAttachmentTargetRecordId &&
    link.toPath === null &&
    link.kind === projectMapAdversarialFixture.acceptedAttachment.kind &&
    link.basis === projectMapAdversarialFixture.acceptedAttachment.basis
  );
  const scanner: RepositoryObservationScanner = {
    async scan(input, options) {
      const candidate = await realScanner.scan(input, options);
      if (acceptedAttachmentTargetRecordId === null) return candidate;
      return {
        ...candidate,
        links: [...candidate.links, {
          fromPath: projectMapAdversarialFixture.acceptedAttachment.path,
          toRecordId: acceptedAttachmentTargetRecordId,
          toPath: null,
          kind: projectMapAdversarialFixture.acceptedAttachment.kind,
          basis: projectMapAdversarialFixture.acceptedAttachment.basis,
        }],
      };
    },
    verify(candidate, signal) {
      return realScanner.verify({
        ...candidate,
        links: candidate.links.filter((link) => !isInjectedAttachment(link)),
      }, signal);
    },
  };
  const application = createApplication({
    databasePath,
    now: () => E2E_TIMESTAMP,
    newId: (prefix) => {
      if (prefix === "repository-node") {
        const next = (idCounters.get(prefix) ?? 0) + 1;
        idCounters.set(prefix, next);
        return `${prefix}-${structuredKnowledgeAdversarialFixture.repositoryIdentityToken}-${next}`;
      }
      if (adversarialIds) {
        const next = (adversarialIdCounters.get(prefix) ?? 0) + 1;
        adversarialIdCounters.set(prefix, next);
        return `${prefix}-${projectMapAdversarialFixture.identityToken}-${next}`;
      }
      const next = (idCounters.get(prefix) ?? 0) + 1;
      idCounters.set(prefix, next);
      return `${prefix}-${next}`;
    },
    repositoryRefreshDependencies: { scanner },
  });
  try {
    seedVisualFoundation(application);
    const source = captureRepositorySource(repository.root);
    const manifest = withReadOnlyRepositorySource(repository.root, source, () =>
      application.service.imports.scan({
        repositoryPath: repository.root,
        canonicalSubpath: null,
      }) as RepositoryImportManifest);
    manifest.proposal.project.name = "Structured Knowledge Browser Fixture";
    manifest.proposal.records.push(
      structuredRecord("outcome.knowledge", "outcome", "accepted", "Ship structured knowledge"),
      structuredRecord("initiative.orientation", "initiative", "accepted", "Orient every project level"),
      structuredRecord("deliverable.hierarchy", "deliverable", "accepted", "Reveal governed hierarchy"),
      structuredRecord("task.map", "task", "accepted", "Verify map interaction"),
      structuredRecord("task.subtask", "task", "accepted", "Confirm authoritative subtask"),
      structuredRecord("task.narrow-overflow", "task", "active", PROJECT_MAP_ADVERSARIAL_TITLE),
      structuredRecord("milestone.review", "milestone", "active", "Review repository facts"),
      structuredRecord("task.refresh", "task", "active", "Refresh documentation safely"),
    );
    manifest.proposal.relationships.push(
      { fromKey: "outcome.knowledge", toKey: "initiative.orientation", kind: "parent_of" },
      { fromKey: "initiative.orientation", toKey: "deliverable.hierarchy", kind: "parent_of" },
      { fromKey: "deliverable.hierarchy", toKey: "task.map", kind: "parent_of" },
      { fromKey: "task.map", toKey: "task.subtask", kind: "parent_of" },
      { fromKey: "task.map", toKey: "task.narrow-overflow", kind: "parent_of" },
      { fromKey: "outcome.knowledge", toKey: "milestone.review", kind: "parent_of" },
      { fromKey: "milestone.review", toKey: "task.refresh", kind: "parent_of" },
    );
    const inspection = withReadOnlyRepositorySource(repository.root, source, () =>
      application.service.imports.inspect(manifest));
    const imported = withReadOnlyRepositorySource(repository.root, source, () =>
      application.service.imports.apply({
        manifest,
        confirmedDigest: inspection.manifestDigest,
      }));
    if (imported.projectId !== "project-2") {
      throw new Error("The structured browser fixture did not receive its stable project ID.");
    }
    const attachedRepository = application.service.views.getDashboard(imported.projectId)
      .project.primaryRepositoryPath?.replaceAll("\\", "/");
    if (attachedRepository !== repository.root.replaceAll("\\", "/")) {
      throw new Error("The structured browser fixture was not attached to its owned repository.");
    }
    const initial = await withReadOnlyRepositorySourceAsync(
      repository.root,
      source,
      () => application.service.repositoryRefresh.start(imported.projectId, {
        signal: new AbortController().signal,
        onProgress: () => undefined,
      }),
    );
    await withReadOnlyRepositorySourceAsync(repository.root, source, () =>
      application.service.repositoryRefresh.apply({
        projectId: imported.projectId,
        snapshotId: initial.snapshot.id,
        expectedProjectRevision: imported.revisionAfter,
      }));

    adversarialIds = true;
    const adversarialProject = application.service.createProject({
      name: projectMapAdversarialFixture.project.name,
      hierarchyVocabulary: softwareHierarchyVocabulary,
    });
    if (adversarialProject.id !== projectMapAdversarialFixture.project.id) {
      throw new Error("The adversarial Map fixture did not receive its stable project ID.");
    }
    const hierarchyRecords = projectMapAdversarialFixture.records.map((fixture, index) => {
      const created = application.service.createRecord({
        projectId: adversarialProject.id,
        kind: fixture.kind,
        status: index === projectMapAdversarialFixture.records.length - 1
          ? "active"
          : "accepted",
        title: fixture.title,
        body: index === projectMapAdversarialFixture.records.length - 1
          ? projectMapAdversarialFixture.selectedBody
          : `${fixture.title} remains governed project intent.`,
        sourceKind: "human",
        sourceRef: null,
      });
      if (created.id !== fixture.id) {
        throw new Error(`The adversarial Map record ${index + 1} did not receive its stable ID.`);
      }
      return created;
    });
    for (let index = 1; index < hierarchyRecords.length; index += 1) {
      application.service.createRelationship({
        projectId: adversarialProject.id,
        fromRecordId: hierarchyRecords[index - 1]!.id,
        toRecordId: hierarchyRecords[index]!.id,
        kind: "parent_of",
        expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
          .project.revision,
      });
    }
    const secondOutcome = application.service.createRecord({
      projectId: adversarialProject.id,
      kind: "outcome",
      status: "completed",
      title: projectMapAdversarialFixture.secondOutcome.title,
      body: `${projectMapAdversarialFixture.secondOutcome.title} remains a complete root outcome.`,
      sourceKind: "human",
      sourceRef: null,
    });
    if (secondOutcome.id !== projectMapAdversarialFixture.secondOutcome.id) {
      throw new Error("The adversarial Map second Outcome did not receive its stable ID.");
    }
    const alternateBranch = projectMapAdversarialFixture.alternateBranch.map((fixture, index) => {
      const created = application.service.createRecord({
        projectId: adversarialProject.id,
        kind: fixture.kind,
        status: index === projectMapAdversarialFixture.alternateBranch.length - 1
          ? "blocked"
          : "accepted",
        title: fixture.title,
        body: `${fixture.title} remains an alternate governed hierarchy branch.`,
        sourceKind: "human",
        sourceRef: null,
      });
      if (created.id !== fixture.id) {
        throw new Error(`The adversarial Map alternate record ${index + 1} did not receive its stable ID.`);
      }
      return created;
    });
    const unplacedTask = application.service.createRecord({
      projectId: adversarialProject.id,
      kind: "task",
      status: "provisional",
      title: projectMapAdversarialFixture.unplacedTask.title,
      body: `${projectMapAdversarialFixture.unplacedTask.title} remains intentionally unplaced.`,
      sourceKind: "human",
      sourceRef: null,
    });
    if (unplacedTask.id !== projectMapAdversarialFixture.unplacedTask.id) {
      throw new Error("The adversarial Map unplaced Task did not receive its stable ID.");
    }
    const decision = application.service.createRecord({
      projectId: adversarialProject.id,
      kind: "decision",
      status: "accepted",
      title: projectMapAdversarialFixture.decision.title,
      body: `${projectMapAdversarialFixture.decision.title} remains supported by local evidence.`,
      sourceKind: "human",
      sourceRef: null,
    });
    if (decision.id !== projectMapAdversarialFixture.decision.id) {
      throw new Error("The adversarial Map decision did not receive its stable ID.");
    }
    const alternateParents = [hierarchyRecords[0]!, ...alternateBranch];
    for (let index = 0; index < alternateBranch.length; index += 1) {
      application.service.createRelationship({
        projectId: adversarialProject.id,
        fromRecordId: alternateParents[index]!.id,
        toRecordId: alternateBranch[index]!.id,
        kind: "parent_of",
        expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
          .project.revision,
      });
    }
    const dependency = application.service.createRelationship({
      projectId: adversarialProject.id,
      fromRecordId: alternateBranch.at(-1)!.id,
      toRecordId: hierarchyRecords[3]!.id,
      kind: "depends_on",
      expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
        .project.revision,
    });
    if (dependency.id !== projectMapAdversarialFixture.dependencyRelationshipId) {
      throw new Error("The adversarial Map hierarchy dependency did not receive its stable ID.");
    }
    const evidence = application.service.createRecord({
      projectId: adversarialProject.id,
      kind: "evidence",
      status: "accepted",
      title: projectMapAdversarialFixture.evidence.title,
      body: `${projectMapAdversarialFixture.evidence.title} remains locally verifiable.`,
      sourceKind: "human",
      sourceRef: null,
    });
    if (evidence.id !== projectMapAdversarialFixture.evidence.id) {
      throw new Error("The adversarial Map evidence did not receive its stable ID.");
    }
    const decisionRelationship = application.service.createRelationship({
      projectId: adversarialProject.id,
      fromRecordId: decision.id,
      toRecordId: evidence.id,
      kind: "evidenced_by",
      expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
        .project.revision,
    });
    if (decisionRelationship.id !== projectMapAdversarialFixture.decisionRelationshipId) {
      throw new Error("The adversarial Map decision evidence did not receive its stable ID.");
    }
    const evidenceRelationship = application.service.createRelationship({
      projectId: adversarialProject.id,
      fromRecordId: hierarchyRecords.at(-1)!.id,
      toRecordId: evidence.id,
      kind: "evidenced_by",
      expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
        .project.revision,
    });
    if (evidenceRelationship.id !== projectMapAdversarialFixture.relationshipId) {
      throw new Error("The adversarial Map relationship did not receive its stable ID.");
    }
    const unplacedRelationship = application.service.createRelationship({
      projectId: adversarialProject.id,
      fromRecordId: hierarchyRecords[3]!.id,
      toRecordId: unplacedTask.id,
      kind: "related_to",
      expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
        .project.revision,
    });
    if (unplacedRelationship.id !== projectMapAdversarialFixture.unplacedRelationshipId) {
      throw new Error("The adversarial Map unplaced relationship did not receive its stable ID.");
    }
    acceptedAttachmentTargetRecordId = hierarchyRecords.at(-1)!.id;
    try {
      const attachmentReview = await withReadOnlyRepositorySourceAsync(
        repository.root,
        source,
        () => application.service.repositoryRefresh.attach(adversarialProject.id, {
          root: repository.root,
          expectedProjectRevision: application.service.getProjectSummary(adversarialProject.id)
            .project.revision,
          signal: new AbortController().signal,
          onProgress: () => undefined,
        }),
      );
      await withReadOnlyRepositorySourceAsync(repository.root, source, () =>
        application.service.repositoryRefresh.apply({
          projectId: adversarialProject.id,
          snapshotId: attachmentReview.snapshot.id,
          expectedProjectRevision: attachmentReview.snapshot.baseProjectRevision,
        }));
      const acceptedAttachments = application.service.projectMap.getRecordDetail(
        adversarialProject.id,
        hierarchyRecords.at(-1)!.id,
      ).attachmentsByBasis.accepted;
      if (!acceptedAttachments.some((attachment) =>
        attachment.path === projectMapAdversarialFixture.acceptedAttachment.path &&
        attachment.linkKind === projectMapAdversarialFixture.acceptedAttachment.kind &&
        attachment.basis === projectMapAdversarialFixture.acceptedAttachment.basis
      )) {
        throw new Error("The adversarial Map accepted attachment was not promoted.");
      }
    } finally {
      acceptedAttachmentTargetRecordId = null;
    }
  } finally {
    application.close();
  }
};
