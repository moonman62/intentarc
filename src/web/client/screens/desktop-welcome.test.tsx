// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  DesktopLifecycleApi,
  DesktopLifecycleState,
} from "../desktop-api.js";
import { DesktopWelcome } from "./desktop-welcome.js";

afterEach(cleanup);

const archivePath = "C:\\Users\\Ada\\IntentArc\\archive.sqlite";

const lifecycleApi = (
  overrides: Partial<DesktopLifecycleApi> = {},
): DesktopLifecycleApi => ({
  getState: async () => ({
    archivePath,
    onboardingCompleted: false,
    restartRequired: false,
  }),
  chooseArchive: async () => ({
    archivePath,
    onboardingCompleted: false,
    restartRequired: false,
  }),
  completeOnboarding: async () => ({
    archivePath,
    onboardingCompleted: true,
    restartRequired: false,
  }),
  restart: async () => ({ restarting: true }),
  ...overrides,
});

describe("DesktopWelcome", () => {
  test("holds the archive UI in a local-first loading state", () => {
    render(
      <DesktopWelcome
        lifecycle={lifecycleApi({
          getState: () => new Promise<DesktopLifecycleState>(() => undefined),
        })}
      >
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Opening your project archive",
    );
    expect(screen.queryByText("Project hub")).toBeNull();
  });

  test("shows the already-open default archive before onboarding", async () => {
    render(
      <DesktopWelcome lifecycle={lifecycleApi()}>
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    expect(await screen.findByRole("heading", {
      name: "Choose where your archive lives",
    })).toBeTruthy();
    expect(screen.getByText(archivePath)).toBeTruthy();
    expect(screen.getByText(/stays on this device/i)).toBeTruthy();
    expect(screen.getByRole("list", {
      name: "Archive setup progress",
    })).toBeTruthy();
    expect(screen.queryByText("Project hub")).toBeNull();
  });

  test("persists a different archive and completes onboarding only after confirmation", async () => {
    const user = userEvent.setup();
    const selectedPath = "D:\\IntentArc\\team-archive.sqlite";
    const completeOnboarding = vi.fn(async () => ({
      archivePath: selectedPath,
      onboardingCompleted: true,
      restartRequired: true,
    }));
    const restart = vi.fn(async () => ({ restarting: true as const }));
    render(
      <DesktopWelcome
        lifecycle={lifecycleApi({
          chooseArchive: vi.fn(async () => ({
            archivePath: selectedPath,
            onboardingCompleted: false,
            restartRequired: true,
          })),
          completeOnboarding,
          restart,
        })}
      >
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    await user.click(await screen.findByRole("button", {
      name: "Choose another location",
    }));
    expect(screen.getByText(selectedPath)).toBeTruthy();
    expect(completeOnboarding).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", {
      name: "Use this archive",
    }));

    await waitFor(() => expect(completeOnboarding).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("heading", {
      name: "Open the selected archive",
    })).toBeTruthy();
    expect(screen.queryByText("Project hub")).toBeNull();

    await user.click(screen.getByRole("button", {
      name: "Restart IntentArc",
    }));
    expect(restart).toHaveBeenCalledOnce();
    expect(screen.getByRole("status").textContent).toContain(
      "Restarting IntentArc",
    );
  });

  test("offers a manual close only after a restart request fails", async () => {
    const user = userEvent.setup();
    const restart = vi.fn(async () => {
      throw new Error("IntentArc could not schedule the restart.");
    });
    const closeManually = vi.fn();
    render(
      <DesktopWelcome
        lifecycle={lifecycleApi({
          getState: async () => ({
            archivePath: "D:\\IntentArc\\team-archive.sqlite",
            onboardingCompleted: true,
            restartRequired: true,
          }),
          restart,
        })}
        closeManually={closeManually}
      >
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    await user.click(await screen.findByRole("button", {
      name: "Restart IntentArc",
    }));
    expect(restart).toHaveBeenCalledOnce();
    expect(closeManually).not.toHaveBeenCalled();
    expect((await screen.findByRole("alert")).textContent).toContain(
      "IntentArc could not schedule the restart.",
    );

    await user.click(screen.getByRole("button", {
      name: "Close and reopen manually",
    }));
    expect(closeManually).toHaveBeenCalledOnce();
  });

  test("keeps a changed archive restart-required after a second picker is cancelled", async () => {
    const user = userEvent.setup();
    const selectedPath = "D:\\IntentArc\\team-archive.sqlite";
    const chooseArchive = vi.fn()
      .mockResolvedValueOnce({
        archivePath: selectedPath,
        onboardingCompleted: false,
        restartRequired: true,
      })
      .mockResolvedValueOnce({
        archivePath: selectedPath,
        onboardingCompleted: false,
        restartRequired: true,
      });
    render(
      <DesktopWelcome
        lifecycle={lifecycleApi({
          chooseArchive,
          completeOnboarding: async () => ({
            archivePath: selectedPath,
            onboardingCompleted: true,
            restartRequired: true,
          }),
        })}
      >
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    await user.click(await screen.findByRole("button", {
      name: "Choose another location",
    }));
    await user.click(screen.getByRole("button", {
      name: "Choose another location",
    }));
    await user.click(screen.getByRole("button", {
      name: "Use this archive",
    }));

    expect(await screen.findByRole("heading", {
      name: "Open the selected archive",
    })).toBeTruthy();
    expect(screen.queryByText("Project hub")).toBeNull();
  });

  test("restores restart-required from lifecycle state after renderer remount", async () => {
    render(
      <DesktopWelcome
        lifecycle={lifecycleApi({
          getState: async () => ({
            archivePath: "D:\\IntentArc\\team-archive.sqlite",
            onboardingCompleted: true,
            restartRequired: true,
          }),
        })}
      >
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    expect(await screen.findByRole("heading", {
      name: "Open the selected archive",
    })).toBeTruthy();
    expect(screen.queryByText("Project hub")).toBeNull();
  });

  test("continues to the existing project choices after confirming the active archive", async () => {
    const user = userEvent.setup();
    render(
      <DesktopWelcome lifecycle={lifecycleApi()}>
        <section aria-label="Project hub">
          <button>Start new</button>
          <a href="/projects/import">Import existing</a>
        </section>
      </DesktopWelcome>,
    );

    await user.click(await screen.findByRole("button", {
      name: "Use this archive",
    }));

    expect(await screen.findByRole("region", {
      name: "Project hub",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start new" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Import existing" })).toBeTruthy();
  });

  test("keeps archive-selection failures in plain language and allows retry", async () => {
    const user = userEvent.setup();
    const chooseArchive = vi.fn()
      .mockRejectedValueOnce(new Error("Could not open the location picker."))
      .mockResolvedValueOnce({
        archivePath,
        onboardingCompleted: false,
        restartRequired: false,
      });
    render(
      <DesktopWelcome lifecycle={lifecycleApi({ chooseArchive })}>
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    await user.click(await screen.findByRole("button", {
      name: "Choose another location",
    }));
    expect(screen.getByRole("alert").textContent).toContain(
      "Could not open the location picker.",
    );

    await user.click(screen.getByRole("button", {
      name: "Choose another location",
    }));
    expect(chooseArchive).toHaveBeenCalledTimes(2);
  });

  test("offers a retry when the desktop archive state is unavailable", async () => {
    const user = userEvent.setup();
    const getState = vi.fn()
      .mockRejectedValueOnce(new Error("Could not read desktop setup."))
      .mockResolvedValueOnce({
        archivePath,
        onboardingCompleted: false,
        restartRequired: false,
      });
    render(
      <DesktopWelcome lifecycle={lifecycleApi({ getState })}>
        <p>Project hub</p>
      </DesktopWelcome>,
    );

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not read desktop setup.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText(archivePath)).toBeTruthy();
  });
});
