// @vitest-environment jsdom

import { afterEach, describe, expect, test } from "vitest";
import {
  getDesktopApi,
  type IntentArcDesktopApi,
} from "./desktop-api.js";

afterEach(() => {
  delete window.intentArcDesktop;
});

describe("getDesktopApi", () => {
  test("returns null in the browser build", () => {
    delete window.intentArcDesktop;

    expect(getDesktopApi()).toBeNull();
  });

  test("returns the credential-free preload facade unchanged", () => {
    const api = {
      ai: {
        list: async () => ({ automatic: [], manual: [] }),
        connect: async () => ({
          adapterId: "codex" as const,
          status: "connected" as const,
          profileId: "profile-one",
          restartRequired: false,
        }),
        test: async () => ({
          adapterId: "codex" as const,
          status: "connected" as const,
          availability: "ready" as const,
          availabilityReason: "connector_ready" as const,
          version: "1.2.3",
          profileId: "profile-one",
        }),
        remove: async () => ({
          adapterId: "codex" as const,
          status: "not_connected" as const,
          profileId: "profile-one",
        }),
        createManual: async ({ label }) => ({
          id: "manual-connection",
          label,
          profileId: "profile-manual",
          state: "setup_created" as const,
          createdAt: "2026-07-30T12:00:00.000Z",
          command: "C:\\IntentArc\\bridge\\current\\IntentArc Bridge.exe",
          args: ["--connection", "manual-connection"] as const,
        }),
        removeManual: async (id) => ({ id }),
        launchForProject: async () => ({
          adapterId: "codex" as const,
          result: "manual_required" as const,
        }),
      },
      lifecycle: {
        getState: async () => ({
          archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
          onboardingCompleted: true,
          restartRequired: false,
        }),
        chooseArchive: async () => ({
          archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
          onboardingCompleted: true,
          restartRequired: false,
        }),
        completeOnboarding: async () => ({
          archivePath: "C:\\Users\\Ada\\IntentArc\\archive.sqlite",
          onboardingCompleted: true,
          restartRequired: false,
        }),
        restart: async () => ({ restarting: true as const }),
      },
      updates: {
        getStatus: async () => ({ state: "disabled" as const }),
        applyAndRestart: async () => ({ restarting: false }),
      },
      documents: {
        externalOpenAvailable: true as const,
        openRepositoryFile: async () => ({ opened: true as const }),
        openExternalHttps: async () => ({ opened: true as const }),
      },
      repository: {
        chooseRepositoryDirectory: async () => "C:\\projects\\IntentArc",
      },
    } satisfies IntentArcDesktopApi;
    window.intentArcDesktop = api;

    expect(getDesktopApi()).toBe(api);
    expect(Object.keys(getDesktopApi() ?? {})).toEqual([
      "ai",
      "lifecycle",
      "updates",
      "documents",
      "repository",
    ]);
  });
});
