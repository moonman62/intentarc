import { describe, expect, it, vi } from "vitest";
import {
  SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS,
  createDesktopUpdateService,
  type DesktopAutoUpdater,
} from "./updates.js";

class TestAutoUpdater implements DesktopAutoUpdater {
  readonly listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  feedUrls: string[] = [];
  checks = 0;
  installs = 0;

  setFeedURL(options: { url: string }): void {
    this.feedUrls.push(options.url);
  }

  checkForUpdates(): void {
    this.checks += 1;
  }

  quitAndInstall(): void {
    this.installs += 1;
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
    return this;
  }

  removeListener(event: string, listener: (...args: unknown[]) => void): this {
    const listeners = this.listeners.get(event) ?? [];
    this.listeners.set(event, listeners.filter((candidate) => candidate !== listener));
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

describe("desktop update service", () => {
  it("is inert and credential-free when no update feed is configured", () => {
    const autoUpdater = new TestAutoUpdater();
    const schedule = vi.fn();

    const updates = createDesktopUpdateService({
      autoUpdater,
      feedUrl: undefined,
      packaged: true,
      platform: "win32",
      argv: [],
      schedule,
    });

    expect(updates.getStatus()).toEqual({ state: "disabled" });
    expect(JSON.stringify(updates.getStatus())).not.toMatch(
      /url|feed|token|credential|password/i,
    );
    expect(autoUpdater.feedUrls).toEqual([]);
    expect(autoUpdater.listeners.size).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
    expect(updates.applyAndRestart()).toBe(false);

    const blankFeedUpdater = new TestAutoUpdater();
    expect(createDesktopUpdateService({
      autoUpdater: blankFeedUpdater,
      feedUrl: "   ",
      packaged: true,
      platform: "win32",
      argv: [],
      schedule,
    }).getStatus()).toEqual({ state: "disabled" });
    expect(blankFeedUpdater.feedUrls).toEqual([]);
  });

  it("delays first-run checks, reports only public state, and applies after explicit restart", () => {
    const autoUpdater = new TestAutoUpdater();
    let scheduled: (() => void) | undefined;
    const schedule = vi.fn((operation: () => void, delayMs: number) => {
      scheduled = operation;
      expect(delayMs).toBe(SQUIRREL_FIRST_RUN_UPDATE_DELAY_MS);
      return { dispose: vi.fn() };
    });
    const updates = createDesktopUpdateService({
      autoUpdater,
      feedUrl: "https://updates.example.test/intentarc",
      packaged: true,
      platform: "win32",
      argv: ["--squirrel-firstrun"],
      schedule,
    });

    expect(autoUpdater.feedUrls).toEqual([
      "https://updates.example.test/intentarc",
    ]);
    expect(autoUpdater.checks).toBe(0);
    expect(updates.getStatus()).toEqual({ state: "idle" });
    expect(updates.applyAndRestart()).toBe(false);

    scheduled!();
    expect(autoUpdater.checks).toBe(1);
    expect(updates.getStatus()).toEqual({ state: "checking" });
    autoUpdater.emit(
      "update-downloaded",
      {},
      "private release notes",
      "IntentArc 0.2.0",
    );
    expect(updates.getStatus()).toEqual({
      state: "downloaded",
      version: "IntentArc 0.2.0",
    });
    expect(JSON.stringify(updates.getStatus())).not.toContain(
      "private release notes",
    );
    expect(updates.applyAndRestart()).toBe(true);
    expect(autoUpdater.installs).toBe(1);
  });

  it("sanitizes updater failures and rejects credential-bearing feeds", () => {
    const autoUpdater = new TestAutoUpdater();
    const updates = createDesktopUpdateService({
      autoUpdater,
      feedUrl: "https://updates.example.test/intentarc",
      packaged: true,
      platform: "win32",
      argv: [],
      schedule: () => ({ dispose: () => undefined }),
    });

    autoUpdater.emit("error", new Error("secret-token=provider-secret"));
    expect(updates.getStatus()).toEqual({ state: "error" });
    expect(JSON.stringify(updates.getStatus())).not.toContain("provider-secret");

    expect(() => createDesktopUpdateService({
      autoUpdater: new TestAutoUpdater(),
      feedUrl: "https://user:password@updates.example.test/intentarc",
      packaged: true,
      platform: "win32",
      argv: [],
    })).toThrow(/credential|feed/i);
    expect(() => createDesktopUpdateService({
      autoUpdater: new TestAutoUpdater(),
      feedUrl: "https://updates.example.test/intentarc?token=secret",
      packaged: true,
      platform: "win32",
      argv: [],
    })).toThrow(/credential|feed/i);
  });

  it("removes listeners and a pending timer when disposed", () => {
    const autoUpdater = new TestAutoUpdater();
    const disposeTimer = vi.fn();
    const updates = createDesktopUpdateService({
      autoUpdater,
      feedUrl: "https://updates.example.test/intentarc",
      packaged: true,
      platform: "win32",
      argv: [],
      schedule: () => ({ dispose: disposeTimer }),
    });

    updates.dispose();

    expect(disposeTimer).toHaveBeenCalledOnce();
    expect([...autoUpdater.listeners.values()].flat()).toEqual([]);
  });
});
