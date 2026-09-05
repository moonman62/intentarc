import { describe, expect, it } from "vitest";
import {
  softwareHierarchyVocabulary,
  type OutboundRelease,
  type TaskContextPack,
} from "../domain/index.js";
import { formatBrowserChatExport } from "./browser-chat-export.js";

const timestamp = "2026-08-21T10:00:00.000Z";
const pack: TaskContextPack = {
  id: "context-pack-1",
  projectId: "project-1",
  taskId: "task-1",
  projectRevision: 7,
  generatedAt: timestamp,
  budgetTokens: 1_200,
  estimatedTokens: 900,
  hierarchyVocabulary: softwareHierarchyVocabulary,
  stableFrame: [],
  task: {
    record: {
      id: "task-1",
      projectId: "project-1",
      kind: "task",
      status: "active",
      title: "Portable task",
      body: "Use the released task context.",
      sourceKind: "human",
      sourceRef: null,
      revision: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    mandatory: true,
    relevance: "active_task",
    relationshipKind: null,
  },
  related: [],
  omissions: [{
    recordId: "private-record",
    kind: "decision",
    reason: "sensitive",
    retrievalRef: "record:private-record",
  }],
  sourceRevisions: [{ recordId: "task-1", revision: 1 }],
};

const release: OutboundRelease = {
  releaseId: "outbound-release-1",
  requestId: "outbound-request-1",
  sourcePackId: "context-pack-1",
  releasedAt: timestamp,
  sha256: "a".repeat(64),
  disclosure: {
    destination: {
      id: "destination-1",
      revision: 3,
      clientLabel: "Synthetic Codex",
      type: "ide_managed",
      providerLabel: "Synthetic provider",
      modelLabel: "Synthetic model",
      accountBoundaryLabel: "[REDACTED:DESTINATION]",
      dataBoundary: "remote",
    },
    sourcePackId: "context-pack-1",
    projectId: "project-1",
    taskId: "task-1",
    projectRevision: 7,
    sourceRecords: [],
    omissions: pack.omissions,
    requestedBudgetTokens: 1_200,
    originalEstimatedTokens: 1_000,
    releasedEstimatedTokens: 900,
    findingCounts: {
      total: 1,
      credential: 1,
      sensitive: 0,
      forcedRedact: 1,
      redactByDefault: 0,
      redacted: 1,
      includedOnce: 0,
    },
    detectorVersion: "detector-v1",
    safetyPolicyVersion: "policy-v1",
    releaseDigest: "a".repeat(64),
    releasedAt: timestamp,
  },
  pack,
};

describe("formatBrowserChatExport", () => {
  it("carries the complete structured vocabulary into browser-chat text", () => {
    const vocabulary = {
      preset: "simple" as const,
      outcome: "Goal \u2028 / outcome",
      initiative: "Shared \u202e > tier",
      deliverable: "Shared \u202e > tier",
      milestone: "Checkpoint\u2029: α",
      task: "Action \u2066| task\u2069",
      nestedTask: "Step \u200emark \u{E0001}`nested`",
    };
    const result = formatBrowserChatExport({
      ...release,
      pack: {
        ...release.pack,
        hierarchyVocabulary: vocabulary,
      },
    });
    const vocabularyLines = result.text.split("\n").filter((line) =>
      line.startsWith("Hierarchy vocabulary (JSON): ")
    );

    expect(vocabularyLines).toEqual([
      "Hierarchy vocabulary (JSON): " +
      '{"preset":"simple","outcome":"Goal \\u2028 / outcome","initiative":"Shared \\u202e > tier","deliverable":"Shared \\u202e > tier","milestone":"Checkpoint\\u2029: α","task":"Action \\u2066| task\\u2069","nestedTask":"Step \\u200emark \\udb40\\udc01`nested`"}',
    ]);
    const encoded = vocabularyLines[0]!.slice("Hierarchy vocabulary (JSON): ".length);
    expect(encoded).not.toMatch(/[\p{Zl}\p{Zp}\p{Cf}]/u);
    expect(JSON.parse(encoded)).toEqual(vocabulary);
    for (const role of [
      "preset",
      "outcome",
      "initiative",
      "deliverable",
      "milestone",
      "task",
      "nestedTask",
    ]) {
      expect(encoded.match(new RegExp(`"${role}":`, "g"))).toHaveLength(1);
    }
  });

  it("renders the complete disclosed outbound release deterministically", () => {
    const result = formatBrowserChatExport(release);

    expect(result).toMatchObject({
      filename: "intentarc-browser-chat-outbound-release-1.md",
      mediaType: "text/markdown;charset=utf-8",
    });
    expect(result.text).toBe([
      "# IntentArc browser-chat export",
      "",
      "Release: `outbound-release-1`",
      "Request: `outbound-request-1`",
      "Source pack: `context-pack-1`",
      "Project: `project-1`",
      "Task: `task-1`",
      "Project revision: 7",
      `Release digest: \`${"a".repeat(64)}\``,
      `Released at: ${timestamp}`,
      `Release SHA-256: ${"a".repeat(64)}`,
      "Destination: Synthetic Codex",
      "Data boundary: remote",
      "Detector version: detector-v1",
      "Safety policy version: policy-v1",
      "Original estimated tokens: 1000",
      "Released tokens: 900 / 1200",
      "",
      "## Finding counts",
      "- Total: 1",
      "- Credential: 1",
      "- Sensitive: 0",
      "- Forced redactions: 1",
      "- Redactions by default: 0",
      "- Redacted: 1",
      "- Included once: 0",
      "",
      "## Explicit omissions",
      "- `private-record` omitted for sensitive; retrieve with `record:private-record`",
      "",
      "# Task Context: Portable task",
      "",
      "Pack: `context-pack-1`",
      "Project revision: 7",
      "Estimated tokens: 900 / 1200",
      'Hierarchy vocabulary (JSON): {"preset":"software","outcome":"Product outcome","initiative":"Epic","deliverable":"Feature","milestone":"Milestone","task":"Story or Task","nestedTask":"Subtask"}',
      "",
      "## Project frame",
      "## Active task",
      "### Portable task",
      "- ID: `task-1`",
      "- Kind: task",
      "- Status: active",
      "- Mandatory: yes",
      "",
      "Use the released task context.",
      "",
      "",
      "## Relevant records",
      "## Explicit omissions",
      "- `private-record` omitted for sensitive; retrieve with `record:private-record`",
      "",
    ].join("\n"));

    expect(formatBrowserChatExport(release)).toEqual(result);
  });

  it("uses only the opaque release id for its filename and excludes destination secrets", () => {
    const privateMetadata = "account-secret-provider-token";
    const result = formatBrowserChatExport({
      ...release,
      releaseId: "opaque.release-7",
      disclosure: {
        ...release.disclosure,
        destination: {
          ...release.disclosure.destination,
          clientLabel: "[REDACTED:DESTINATION]",
          providerLabel: "[REDACTED:DESTINATION]",
          modelLabel: null,
          accountBoundaryLabel: privateMetadata,
        },
      },
    });

    expect(result.filename).toBe("intentarc-browser-chat-opaque.release-7.md");
    expect(result.text).not.toContain(privateMetadata);
    expect(result.text).not.toContain("accountBoundaryLabel");
    expect(result.text).not.toContain("providerLabel");
    expect(result.text).not.toContain("modelLabel");
  });

  it.each([
    ["outbound-release-1", "intentarc-browser-chat-outbound-release-1.md"],
    ["release/../../secrets", "intentarc-browser-chat-release-..-..-secrets.md"],
    ["release\\windows:path", "intentarc-browser-chat-release-windows-path.md"],
    ["release\u0000\u001fcontrol", "intentarc-browser-chat-release-control.md"],
  ])("projects release id %j to the safe filename %s", (releaseId, filename) => {
    expect(formatBrowserChatExport({ ...release, releaseId }).filename).toBe(
      filename,
    );
  });
});
