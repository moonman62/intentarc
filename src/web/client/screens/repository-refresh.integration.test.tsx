// @vitest-environment jsdom

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createApplication,
  type IntentArcApplication,
} from "../../../app/create-application.js";
import type { RepositoryObservationCandidate } from "../../../domain/index.js";
import {
  createTemporaryDatabase,
  removeTemporaryDatabase,
  type TemporaryDatabase,
} from "../../../test-support/database.js";
import { createApplicationRoutes } from "../../server/api-routes.js";
import { createApiHandler } from "../../server/router.js";
import { RepositoryRefresh } from "./repository-refresh.js";

const candidate: RepositoryObservationCandidate = {
  root: "C:/projects/example",
  canonicalSubpath: null,
  repositoryIdentity: "git:example",
  branch: "main",
  head: "a".repeat(40),
  fingerprint: "b".repeat(64),
  scannerVersion: "scanner-1",
  rulesetVersion: "rules-1",
  warnings: [],
  exclusions: [],
  findingCounts: {},
  observations: [{
    path: "tests/refresh-evidence.txt",
    kind: "file",
    sha256: "c".repeat(64),
    byteSize: 24,
    sourceStatus: "tracked",
    role: "test",
    documentKind: "test_evidence",
    documentFormat: "plain_text",
    contentEligible: true,
    instructionClient: null,
    instructionScope: null,
  }],
  links: [],
};

describe("repository refresh service-to-UI integration", () => {
  let temporaryDatabase: TemporaryDatabase | undefined;
  let application: IntentArcApplication | undefined;
  let server: ReturnType<typeof createServer> | undefined;

  afterEach(async () => {
    cleanup();
    vi.unstubAllGlobals();
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => error ? reject(error) : resolve());
      });
    }
    application?.close();
    if (temporaryDatabase) removeTemporaryDatabase(temporaryDatabase);
    server = undefined;
    application = undefined;
    temporaryDatabase = undefined;
  });

  test("exposes a real inferred operation unselected and creates one governed proposal after review", async () => {
    temporaryDatabase = createTemporaryDatabase();
    const ids: Record<string, number> = {};
    application = createApplication({
      databasePath: temporaryDatabase.path,
      now: () => "2026-08-02T12:00:00.000Z",
      newId: (prefix) => `${prefix}-${ids[prefix] = (ids[prefix] ?? 0) + 1}`,
      repositoryRefreshDependencies: {
        scanner: {
          scan: async () => candidate,
          verify: async () => undefined,
        },
      },
    });
    const project = application.service.createProject({
      name: "Example",
      primaryRepositoryPath: candidate.root,
    });
    server = createServer(createApiHandler(createApplicationRoutes(application)));
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const nativeFetch = globalThis.fetch;
    vi.stubGlobal("fetch", (
      input: string | URL | Request,
      init?: RequestInit,
    ) => nativeFetch(new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      origin,
    ), init));
    const user = userEvent.setup();

    render(
      <RepositoryRefresh
        projectId={project.id}
        projectRevision={project.revision}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Scan repository" }));

    const operation = await screen.findByRole("checkbox", {
      name: "Evidence: Repository test evidence: tests/refresh-evidence.txt",
    });
    expect((operation as HTMLInputElement).checked).toBe(false);
    expect(screen.getByRole("button", { name: "Accept repository refresh" })).toBeTruthy();

    await user.click(operation);
    await user.click(await screen.findByRole("button", {
      name: "Accept refresh and create proposal",
    }));

    expect(await screen.findByText("Repository refresh accepted and proposal created."))
      .toBeTruthy();
    const proposals = application.service.proposals.list({ projectId: project.id });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      origin: {
        type: "repository_refresh",
        repositorySnapshotId: "repository-snapshot-1",
      },
      state: "pending",
    });
    expect(application.service.proposals.get(proposals[0]!.id).operations).toEqual([
      expect.objectContaining({
        type: "create_record",
        kind: "evidence",
        status: "provisional",
        title: "Repository test evidence: tests/refresh-evidence.txt",
      }),
    ]);
  });
});
