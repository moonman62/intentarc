// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type {
  DesktopAiApi,
  DesktopAiCatalog,
  DesktopAiConnectionState,
  DesktopAiConnectResult,
  DesktopAiRemoveResult,
  DesktopManualConnectionSummary,
  DesktopManualConnectionSetup,
} from "../desktop-api.js";
import { AiConnections } from "./ai-connections.js";

afterEach(cleanup);
afterEach(() => vi.restoreAllMocks());
afterEach(() => document.body.removeAttribute("tabindex"));

beforeEach(() => {
  window.history.replaceState(null, "", "/settings/ai");
  const nativeFocus = HTMLElement.prototype.focus;
  vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (
    this: HTMLElement,
    options?: FocusOptions,
  ) {
    nativeFocus.call(this, options);
  });
});

const connection = (
  adapterId: DesktopAiConnectionState["adapterId"],
  overrides: Partial<DesktopAiConnectionState> = {},
): DesktopAiConnectionState => ({
  adapterId,
  status: "not_connected",
  availability: "ready",
  availabilityReason: "connector_ready",
  version: "1.2.3",
  profileId: null,
  ...overrides,
});

const catalog = (
  ...automatic: DesktopAiConnectionState[]
): DesktopAiCatalog => ({ automatic, manual: [] });

const manualConnection = (
  overrides: Partial<DesktopManualConnectionSummary> = {},
): DesktopManualConnectionSummary => ({
  id: "manual-one",
  label: "My editor",
  profileId: "profile-manual",
  state: "setup_created",
  createdAt: "2026-08-01T12:00:00.000Z",
  ...overrides,
});

const aiApi = (overrides: Partial<DesktopAiApi> = {}): DesktopAiApi => ({
  list: async () => catalog(
    connection("codex"),
    connection("claude-code", {
      availability: "not_detected",
      availabilityReason: "not_installed",
      version: null,
    }),
  ),
  createManual: async () => {
    throw new Error("Not used in automatic connection tests.");
  },
  removeManual: async () => {
    throw new Error("Not used in automatic connection tests.");
  },
  connect: async (adapterId) => ({
    adapterId,
    status: "connected",
    profileId: "profile-one",
    restartRequired: false,
  }),
  test: async (adapterId) => connection(adapterId, {
    status: "connected",
    profileId: "profile-one",
  }),
  remove: async (adapterId) => ({
    adapterId,
    status: "not_connected",
    profileId: "profile-one",
  }),
  launchForProject: async (input) => ({
    adapterId: input.adapterId,
    result: "manual_required",
  }),
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
};

describe("AiConnections", () => {
  test("announces loading without showing stale actions", () => {
    render(
      <AiConnections
        ai={aiApi({
          list: () =>
            new Promise<DesktopAiCatalog>(() => undefined),
        })}
      />,
    );

    expect(screen.getByRole("status").textContent).toContain(
      "Looking for supported AI clients",
    );
    expect(screen.queryByRole("button", { name: /Connect/ })).toBeNull();
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    expect(screen.queryByText(
      "No manual MCP setup details have been created.",
    )).toBeNull();
    expect(screen.getByText(/Checking for saved manual MCP setups/))
      .toBeTruthy();
  });

  test("offers recovery when the automatic catalog is empty", async () => {
    render(<AiConnections ai={aiApi({ list: async () => catalog() })} />);

    expect(await screen.findByRole("heading", {
      name: "No automatic AI connection is ready",
    })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(
      /token|https?:\/\/|--connection/i,
    );
    expect(screen.getByText(
      "No manual MCP setup details have been created.",
    )).toBeTruthy();
  });

  test("shows ready-to-connect and connected client states", async () => {
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(
            connection("codex"),
            connection("claude-code", {
              status: "connected",
              profileId: "profile-claude",
            }),
          ),
        })}
      />,
    );

    const codex = await screen.findByRole("article", { name: "Codex" });
    expect(within(codex).getByText("Ready to connect")).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Connect Codex",
    })).toBeTruthy();

    const claude = screen.getByRole("article", { name: "Claude Code" });
    expect(within(claude).getByText("Connected")).toBeTruthy();
    expect(within(claude).getByRole("button", {
      name: "Test Claude Code",
    })).toBeTruthy();
    expect(within(claude).getByRole("button", {
      name: "Remove Claude Code",
    })).toBeTruthy();
  });

  test("shows a not-detected client with installation and refresh actions", async () => {
    render(<AiConnections ai={aiApi()} />);

    const claude = await screen.findByRole("article", {
      name: "Claude Code",
    });
    expect(within(claude).getByText("Not detected", {
      selector: ".status-chip",
    })).toBeTruthy();
    expect(within(claude).getByRole("button", {
      name: "Installation guide for Claude Code",
    })).toBeTruthy();
    expect(within(claude).getByRole("button", {
      name: "Check again",
    })).toBeTruthy();
    expect(within(claude).queryByRole("button", {
      name: "Connect Claude Code",
    })).toBeNull();
  });

  test("renders manual MCP setups without claiming they are connected", async () => {
    const existing = manualConnection();
    render(<AiConnections ai={aiApi({
      list: async () => ({
        automatic: [connection("codex")],
        manual: [existing],
      }),
    })} />);

    const section = await screen.findByRole("region", {
      name: "Manual MCP connections",
    });
    const item = within(section).getByRole("article", {
      name: "My editor",
    });
    expect(within(item).getByText("Setup details created")).toBeTruthy();
    expect(within(item).getByRole("button", {
      name: "Remove My editor setup",
    })).toBeTruthy();
    expect(item.textContent).not.toContain(existing.profileId);
    expect(item.textContent).not.toMatch(/\bConnected\b/);
  });

  test("reviews manual removal, refreshes the catalog, and restores section focus", async () => {
    const user = userEvent.setup();
    const existing = manualConnection();
    const list = vi.fn()
      .mockResolvedValueOnce({
        automatic: [connection("codex")],
        manual: [existing],
      })
      .mockResolvedValueOnce({
        automatic: [connection("codex")],
        manual: [],
      });
    const removeManual = vi.fn(async () => ({ id: existing.id }));
    render(<AiConnections ai={aiApi({ list, removeManual })} />);

    await user.click(await screen.findByRole("button", {
      name: "Remove My editor setup",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove My editor setup",
    });
    expect(within(dialog).getByText(/revokes IntentArc access/i)).toBeTruthy();
    expect(within(dialog).getByText(/cannot edit My editor/i)).toBeTruthy();
    await user.click(within(dialog).getByRole("button", {
      name: "Remove setup",
    }));

    await waitFor(() => expect(removeManual).toHaveBeenCalledWith(existing.id));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("article", { name: "My editor" })).toBeNull();
    const heading = screen.getByRole("heading", {
      name: "Manual MCP connections",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test("keeps the manual catalog and heading focus when removal refresh fails", async () => {
    const user = userEvent.setup();
    const existing = manualConnection();
    const list = vi.fn()
      .mockResolvedValueOnce({
        automatic: [connection("codex")],
        manual: [existing],
      })
      .mockRejectedValueOnce(new Error("Catalog refresh failed."));
    const removeManual = vi.fn(async () => ({ id: existing.id }));
    render(<AiConnections ai={aiApi({ list, removeManual })} />);
    await user.click(await screen.findByRole("button", {
      name: "Remove My editor setup",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Remove My editor setup",
    })).getByRole("button", { name: "Remove setup" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Catalog refresh failed.",
    );
    const heading = screen.getByRole("heading", {
      name: "Manual MCP connections",
    });
    expect(screen.queryByRole("article", { name: "My editor" })).toBeNull();
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test("ignores an initial catalog captured before manual setup and converges with a fresh catalog", async () => {
    const user = userEvent.setup();
    const initialList = deferred<DesktopAiCatalog>();
    const postMutationList = deferred<DesktopAiCatalog>();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-manual",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    const list = vi.fn()
      .mockImplementationOnce(() => initialList.promise)
      .mockImplementationOnce(() => postMutationList.promise);
    render(<AiConnections ai={aiApi({
      list,
      createManual: async () => setup,
    })} />);

    await user.click(screen.getByRole("button", {
      name: "Use another AI tool",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Use another AI tool",
    });
    await user.type(within(dialog).getByRole("textbox", {
      name: "AI client name",
    }), setup.label);
    await user.click(within(dialog).getByRole("button", {
      name: "Set up an MCP client",
    }));
    expect(await within(dialog).findByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await act(async () => {
      initialList.resolve({ automatic: [], manual: [] });
      await initialList.promise;
    });
    expect(within(dialog).getByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();

    postMutationList.resolve({ automatic: [], manual: [manualConnection()] });
    expect(await screen.findByRole("article", {
      name: "My editor",
    })).toBeTruthy();
    expect(within(dialog).getByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
  });

  test("retires a manual setup overlay after one mismatched post-mutation catalog", async () => {
    const user = userEvent.setup();
    const initialList = deferred<DesktopAiCatalog>();
    const firstPostMutationList = deferred<DesktopAiCatalog>();
    const userRefresh = deferred<DesktopAiCatalog>();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-manual",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    const list = vi.fn()
      .mockImplementationOnce(() => initialList.promise)
      .mockImplementationOnce(() => firstPostMutationList.promise)
      .mockImplementationOnce(() => userRefresh.promise);
    render(<AiConnections ai={aiApi({
      list,
      createManual: async () => setup,
    })} />);

    await user.click(screen.getByRole("button", {
      name: "Use another AI tool",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Use another AI tool",
    });
    await user.type(within(dialog).getByRole("textbox", {
      name: "AI client name",
    }), setup.label);
    await user.click(within(dialog).getByRole("button", {
      name: "Set up an MCP client",
    }));
    expect(await within(dialog).findByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    await act(async () => {
      initialList.resolve({ automatic: [], manual: [] });
      await initialList.promise;
    });
    expect(within(dialog).getByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();

    await act(async () => {
      firstPostMutationList.resolve({ automatic: [], manual: [] });
      await firstPostMutationList.promise;
    });
    expect(screen.getByRole("article", { name: "My editor" })).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await act(async () => {
      userRefresh.resolve({ automatic: [], manual: [] });
      await userRefresh.promise;
    });

    await waitFor(() => expect(screen.queryByRole("article", {
      name: "My editor",
    })).toBeNull());
    expect(within(dialog).getByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(3);
  });

  test("ignores a refresh snapshot captured before an automatic connection mutation", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<DesktopAiCatalog>();
    const postMutationList = deferred<DesktopAiCatalog>();
    const initialConnection = connection("codex", { status: "unknown" });
    const connected = connection("codex", {
      status: "connected",
      profileId: "profile-one",
    });
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(initialConnection))
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockImplementationOnce(() => postMutationList.promise);
    render(<AiConnections ai={aiApi({ list })} />);
    const card = await screen.findByRole("article", { name: "Codex" });

    await user.click(within(card).getByRole("button", {
      name: "Check again",
    }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await user.click(within(card).getByRole("button", {
      name: "Review connection",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));

    expect(await within(card).findByText("Connected")).toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));
    await act(async () => {
      staleRefresh.resolve(catalog(connection("codex")));
      await staleRefresh.promise;
    });
    expect(within(card).getByText("Connected")).toBeTruthy();

    postMutationList.resolve(catalog(connected));
    await waitFor(() => expect(within(card).getByText("Connected")).toBeTruthy());
    expect(list).toHaveBeenCalledTimes(3);
  });

  test("retires an automatic overlay after one mismatched post-mutation catalog", async () => {
    const user = userEvent.setup();
    const staleRefresh = deferred<DesktopAiCatalog>();
    const firstPostMutationList = deferred<DesktopAiCatalog>();
    const userRefresh = deferred<DesktopAiCatalog>();
    const initialConnection = connection("codex", { status: "unknown" });
    const actualConnection = connection("codex");
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(initialConnection))
      .mockImplementationOnce(() => staleRefresh.promise)
      .mockImplementationOnce(() => firstPostMutationList.promise)
      .mockImplementationOnce(() => userRefresh.promise);
    render(<AiConnections ai={aiApi({
      list,
      connect: async () => ({
        adapterId: "codex",
        status: "unknown",
        profileId: "profile-one",
        restartRequired: false,
      }),
    })} />);
    const card = await screen.findByRole("article", { name: "Codex" });

    await user.click(within(card).getByRole("button", {
      name: "Check again",
    }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await user.click(within(card).getByRole("button", {
      name: "Review connection",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));
    expect(await within(card).findByText("Connection needs attention"))
      .toBeTruthy();
    await waitFor(() => expect(list).toHaveBeenCalledTimes(3));

    await act(async () => {
      staleRefresh.resolve(catalog(actualConnection));
      await staleRefresh.promise;
    });
    expect(within(card).getByText("Connection needs attention")).toBeTruthy();

    await act(async () => {
      firstPostMutationList.resolve(catalog(actualConnection));
      await firstPostMutationList.promise;
    });
    expect(within(card).getByText("Connection needs attention")).toBeTruthy();

    await user.click(within(card).getByRole("button", {
      name: "Check again",
    }));
    await waitFor(() => expect(list).toHaveBeenCalledTimes(4));
    await act(async () => {
      userRefresh.resolve(catalog(actualConnection));
      await userRefresh.promise;
    });

    expect(await within(card).findByText("Ready to connect")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(4);
  });

  test("provides all-width wrapping hooks for long manual removal labels", async () => {
    const user = userEvent.setup();
    const label = "M".repeat(80);
    render(<AiConnections ai={aiApi({
      list: async () => ({
        automatic: [connection("codex")],
        manual: [manualConnection({ label })],
      }),
    })} />);

    const removal = await screen.findByRole("button", {
      name: `Remove ${label} setup`,
    });
    expect(removal.classList).toContain("manual-connection-card__remove");
    await user.click(removal);

    const dialog = screen.getByRole("dialog", {
      name: `Remove ${label} setup`,
    });
    expect(dialog.classList).toContain("manual-ai-dialog--remove");
    expect(within(dialog).getByText((_content, element) =>
      element?.tagName === "P" &&
      element.textContent?.includes(`IntentArc cannot edit ${label}.`) === true
    )).toBeTruthy();
  });

  test("shows setup-required clients without an invalid connect action", async () => {
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            availability: "setup_required",
            availabilityReason: "cli_missing",
            version: null,
          })),
        })}
      />,
    );

    const codex = await screen.findByRole("article", { name: "Codex" });
    expect(within(codex).getByText("Additional setup needed")).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "How to connect Codex",
    })).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Check again",
    })).toBeTruthy();
    expect(within(codex).queryByRole("button", {
      name: "Connect Codex",
    })).toBeNull();
  });

  test.each([
    ["access_blocked", "IntentArc cannot access the Codex CLI"],
    ["probe_failed", "IntentArc could not finish checking Codex"],
  ] as const)(
    "shows a distinct %s setup diagnostic",
    async (availabilityReason, diagnostic) => {
      const user = userEvent.setup();
      render(
        <AiConnections
          ai={aiApi({
            list: async () => catalog(connection("codex", {
              availability: "setup_required",
              availabilityReason,
              version: null,
            })),
          })}
        />,
      );

      const codex = await screen.findByRole("article", { name: "Codex" });
      await user.click(within(codex).getByRole("button", {
        name: "How to connect Codex",
      }));

      expect(within(codex).getByText(diagnostic, { exact: false })).toBeTruthy();
    },
  );

  test("shows ready-but-unknown clients as needing connection review", async () => {
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "unknown",
          })),
        })}
      />,
    );

    const codex = await screen.findByRole("article", { name: "Codex" });
    expect(within(codex).getByText("Connection needs attention")).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Review connection",
    })).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Check again",
    })).toBeTruthy();
    expect(within(codex).queryByRole("button", {
      name: "Connect Codex",
    })).toBeNull();
  });

  test("keeps an owned connection removable while its status is unknown", async () => {
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "unknown",
            profileId: "profile-one",
          })),
        })}
      />,
    );

    const codex = await screen.findByRole("article", { name: "Codex" });
    expect(within(codex).getByRole("button", {
      name: "Remove Codex",
    })).toBeTruthy();
    expect(within(codex).getByText("Safe profile found")).toBeTruthy();
  });

  test.each([
    [
      "setup_required",
      "cli_missing",
      "Additional setup needed",
      "How to connect Codex",
      /Codex desktop application is present/i,
    ],
    [
      "not_detected",
      "not_installed",
      "Not detected",
      "Installation guide for Codex",
      /IntentArc did not detect Codex/i,
    ],
    [
      "setup_required",
      "access_blocked",
      "Additional setup needed",
      "How to connect Codex",
      /IntentArc cannot access the Codex CLI/i,
    ],
  ] as const)(
    "keeps an owned unknown %s/%s client in the availability guide flow",
    async (
      availability,
      availabilityReason,
      statusLabel,
      guideLabel,
      guideDiagnostic,
    ) => {
      const user = userEvent.setup();
      render(
        <AiConnections
          ai={aiApi({
            list: async () => catalog(connection("codex", {
              status: "unknown",
              availability,
              availabilityReason,
              version: null,
              profileId: "profile-one",
            })),
          })}
        />,
      );

      const codex = await screen.findByRole("article", { name: "Codex" });
      expect(within(codex).getByText(statusLabel, {
        selector: ".status-chip",
      })).toBeTruthy();
      expect(within(codex).getByText("Safe profile found")).toBeTruthy();
      expect(within(codex).getByRole("button", {
        name: "Remove Codex",
      })).toBeTruthy();
      expect(within(codex).queryByRole("button", {
        name: "Review connection",
      })).toBeNull();
      expect(within(codex).queryByRole("button", {
        name: "Connect Codex",
      })).toBeNull();

      await user.click(within(codex).getByRole("button", {
        name: guideLabel,
      }));
      expect(within(codex).getByText(guideDiagnostic)).toBeTruthy();
    },
  );

  test("refreshes the full catalog and restores focus to the initiating card heading", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(connection("codex", {
        availability: "setup_required",
        availabilityReason: "cli_missing",
        version: null,
      })))
      .mockResolvedValueOnce(catalog(
        connection("codex"),
        connection("claude-code", {
          availability: "not_detected",
          availabilityReason: "not_installed",
          version: null,
        }),
      ));
    render(<AiConnections ai={aiApi({ list })} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    await user.click(within(codex).getByRole("button", {
      name: "Check again",
    }));

    const refreshedCodex = await screen.findByRole("article", { name: "Codex" });
    expect(within(refreshedCodex).getByText("Ready to connect")).toBeTruthy();
    expect(screen.getByRole("article", { name: "Claude Code" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(document.activeElement).toBe(within(refreshedCodex).getByRole(
        "heading",
        { name: "Codex" },
      ));
    });
  });

  test("refreshes from recovery and restores focus to the recovery heading", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(connection("codex", {
        availability: "setup_required",
        availabilityReason: "cli_missing",
        version: null,
      })))
      .mockResolvedValueOnce(catalog(
        connection("codex", {
          availability: "setup_required",
          availabilityReason: "cli_missing",
          version: null,
        }),
        connection("claude-code", {
          availability: "not_detected",
          availabilityReason: "not_installed",
          version: null,
        }),
      ));
    render(<AiConnections ai={aiApi({ list })} />);

    const recovery = await screen.findByRole("region", {
      name: "No automatic AI connection is ready",
    });
    await user.click(within(recovery).getByRole("button", {
      name: "Check again",
    }));

    const refreshedRecovery = await screen.findByRole("region", {
      name: "No automatic AI connection is ready",
    });
    expect(screen.getByRole("article", { name: "Claude Code" })).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(document.activeElement).toBe(within(refreshedRecovery).getByRole(
        "heading",
        { name: "No automatic AI connection is ready" },
      ));
    });
  });

  test("moves recovery refresh focus to the first card when recovery resolves", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(connection("codex", {
        availability: "setup_required",
        availabilityReason: "cli_missing",
        version: null,
      })))
      .mockResolvedValueOnce(catalog(connection("codex")));
    render(<AiConnections ai={aiApi({ list })} />);

    const recovery = await screen.findByRole("region", {
      name: "No automatic AI connection is ready",
    });
    await user.click(within(recovery).getByRole("button", {
      name: "Check again",
    }));

    expect(screen.queryByRole("region", {
      name: "No automatic AI connection is ready",
    })).toBeNull();
    const codex = await screen.findByRole("article", { name: "Codex" });
    const heading = within(codex).getByRole("heading", { name: "Codex" });
    await waitFor(() => {
      expect(document.activeElement).toBe(heading);
    });
  });

  test("retains card focus restoration through repeated catalog retry failures", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(connection("codex", {
        availability: "setup_required",
        availabilityReason: "cli_missing",
        version: null,
      })))
      .mockRejectedValueOnce(new Error("First refresh failed."))
      .mockRejectedValueOnce(new Error("Second refresh failed."))
      .mockResolvedValueOnce(catalog(connection("codex")));
    render(<AiConnections ai={aiApi({ list })} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    await user.click(within(codex).getByRole("button", {
      name: "Check again",
    }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "First refresh failed.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Second refresh failed.",
    );
    await user.click(screen.getByRole("button", { name: "Try again" }));

    const refreshedCodex = await screen.findByRole("article", { name: "Codex" });
    expect(within(refreshedCodex).getByText("Ready to connect")).toBeTruthy();
    expect(list).toHaveBeenCalledTimes(4);
    await waitFor(() => {
      expect(document.activeElement).toBe(within(refreshedCodex).getByRole(
        "heading",
        { name: "Codex" },
      ));
    });
  });

  test("downgrades stale connected claims when a catalog refresh fails while retaining recovery UI", async () => {
    const user = userEvent.setup();
    const existing = manualConnection();
    const list = vi.fn()
      .mockResolvedValueOnce({
        automatic: [
          connection("codex", {
            status: "connected",
            profileId: "profile-one",
          }),
          connection("claude-code", {
            availability: "setup_required",
            availabilityReason: "cli_missing",
            version: null,
          }),
        ],
        manual: [existing],
      })
      .mockRejectedValueOnce(new Error("Refresh inspection failed."));
    render(<AiConnections ai={aiApi({ list })} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    expect(within(codex).getByText("Connected")).toBeTruthy();
    const claude = screen.getByRole("article", { name: "Claude Code" });
    const refresh = within(claude).getByRole("button", {
      name: "Check again",
    });
    await user.click(refresh);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Refresh inspection failed.",
    );
    expect(within(codex).getByText("Connection needs attention")).toBeTruthy();
    expect(within(codex).getByText("Safe profile found")).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Review connection",
    })).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Remove Codex",
    })).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByRole("article", { name: existing.label })).toBeTruthy();
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    expect(document.activeElement).toBe(refresh);
  });

  test("preserves restart-required through a failed post-connect refresh until an explicit test succeeds", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(connection("codex")))
      .mockRejectedValueOnce(new Error("Post-connect refresh failed."))
      .mockResolvedValue(catalog(connection("codex", {
        status: "connected",
        profileId: "profile-one",
      })));
    render(<AiConnections ai={aiApi({
      list,
      connect: async () => ({
        adapterId: "codex",
        status: "connected",
        profileId: "profile-one",
        restartRequired: true,
      }),
    })} />);

    await user.click(within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("button", { name: "Connect Codex" }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Post-connect refresh failed.",
    );
    const downgraded = screen.getByRole("article", { name: "Codex" });
    expect(within(downgraded).getByText("Connection needs attention"))
      .toBeTruthy();
    expect(within(downgraded).queryByText("Connected")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    const retried = await screen.findByRole("article", { name: "Codex" });
    await waitFor(() => {
      expect(within(retried).getByText("Restart required"))
        .toBeTruthy();
    });
    expect(within(retried).queryByText("Connected")).toBeNull();
    expect(list).toHaveBeenCalledTimes(3);

    await user.click(within(retried).getByRole("button", {
      name: "Test Codex",
    }));

    expect(await within(retried).findByText("Connected")).toBeTruthy();
    expect(within(retried).queryByText("Restart required")).toBeNull();
  });

  test("offers recovery when every automatic connector is non-ready", async () => {
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(
            connection("codex", {
              availability: "setup_required",
              availabilityReason: "cli_missing",
              version: null,
            }),
            connection("claude-code", {
              availability: "not_detected",
              availabilityReason: "not_installed",
              version: null,
            }),
          ),
        })}
      />,
    );

    expect(await screen.findByRole("heading", {
      name: "No automatic AI connection is ready",
    })).toBeTruthy();
    expect(screen.getAllByRole("button", {
      name: "Check again",
    })).toHaveLength(3);
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Codex" })).toBeTruthy();
    expect(screen.getByRole("article", { name: "Claude Code" })).toBeTruthy();
  });

  test("continues without AI through the existing client router", async () => {
    const user = userEvent.setup();
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            availability: "setup_required",
            availabilityReason: "cli_missing",
            version: null,
          })),
        })}
      />,
    );

    await user.click(await screen.findByRole("link", {
      name: "Continue without AI",
    }));

    expect(window.location.pathname).toBe("/");
  });

  test("reviews user scope, local bridge, Safe profile, trust, and restart before connecting", async () => {
    const user = userEvent.setup();
    const connect = vi.fn(async () => ({
      adapterId: "codex" as const,
      status: "connected" as const,
      profileId: "profile-one",
      restartRequired: true,
    }));
    render(<AiConnections ai={aiApi({ connect })} />);

    const trigger = within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("button", { name: "Connect Codex" });
    await user.click(trigger);

    const dialog = screen.getByRole("dialog", { name: "Connect Codex" });
    expect(within(dialog).getByText(/your user account/i)).toBeTruthy();
    expect(within(dialog).getByText(/IntentArc Bridge\.exe/i)).toBeTruthy();
    expect(within(dialog).getByText(
      /Codex keeps its own repository and terminal permission mode/i,
    )).toBeTruthy();
    expect(within(dialog).getByText(
      /Safe profile governs only IntentArc tools and project mutations/i,
    )).toBeTruthy();
    expect(within(dialog).getByText(/third-party/i)).toBeTruthy();
    expect(within(dialog).getByText(/restart Codex/i)).toBeTruthy();
    expect(within(dialog).getByText(
      /does not connect your ChatGPT account/i,
    )).toBeTruthy();

    await user.click(within(dialog).getByRole("button", {
      name: "Connect Codex",
    }));

    await waitFor(() => expect(connect).toHaveBeenCalledWith("codex"));
    expect(screen.getByRole("status").textContent).toContain(
      "Restart Codex to finish",
    );
    expect(within(screen.getByRole("article", { name: "Codex" })).getByText(
      "Restart required",
    )).toBeTruthy();
  });

  test("closes the connection review with Escape and restores trigger focus", async () => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi()} />);
    const trigger = within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("button", { name: "Connect Codex" });

    await user.click(trigger);
    expect(screen.getByRole("dialog", { name: "Connect Codex" })).toBeTruthy();
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("dialog", { name: "Connect Codex" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  test("moves focus to the stable client heading after successful connection", async () => {
    const user = userEvent.setup();
    render(
      <AiConnections
        ai={aiApi({ list: async () => catalog(connection("codex")) })}
      />,
    );

    await user.click(await screen.findByRole("button", {
      name: "Connect Codex",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));

    const heading = within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("heading", {
      name: "Codex",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test("moves focus to the stable client heading after successful removal", async () => {
    const user = userEvent.setup();
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "connected",
            profileId: "profile-one",
          })),
        })}
      />,
    );

    await user.click(await screen.findByRole("button", {
      name: "Remove Codex",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Remove Codex connection",
    })).getByRole("button", { name: "Remove connection" }));

    const heading = within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("heading", {
      name: "Codex",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
  });

  test("explains the automatic Connect action without presenting it as manual setup", async () => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi()} />);
    const codex = await screen.findByRole("article", { name: "Codex" });

    await user.click(within(codex).getByText("What Connect does"));

    const details = within(codex).getByText(
      /IntentArc uses Codex's supported command to add the local bridge/i,
    );
    expect(details).toBeTruthy();
    expect(details.textContent).toMatch(/do not need to copy configuration/i);
    expect(details.textContent).not.toMatch(
      /token|https?:\/\/|--connection|\.toml|\.json/i,
    );
  });

  test("tests a connected client and reports the checked result", async () => {
    const user = userEvent.setup();
    const testConnection = vi.fn(async () => connection("codex", {
      status: "connected",
      profileId: "profile-one",
    }));
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "connected",
            profileId: "profile-one",
          })),
          test: testConnection,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", {
      name: "Test Codex",
    }));

    await waitFor(() => expect(testConnection).toHaveBeenCalledWith("codex"));
    expect(screen.getByRole("status").textContent).toContain(
      "Codex connection is ready",
    );
  });

  test("downgrades a connected client immediately when its explicit health test fails", async () => {
    const user = userEvent.setup();
    const testConnection = vi.fn(async () => {
      throw new Error("IntentArc bridge health check failed.");
    });
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "connected",
            profileId: "profile-one",
          })),
          test: testConnection,
        })}
      />,
    );

    const codex = await screen.findByRole("article", { name: "Codex" });
    await user.click(within(codex).getByRole("button", {
      name: "Test Codex",
    }));

    await waitFor(() => expect(testConnection).toHaveBeenCalledWith("codex"));
    expect(screen.getByRole("status").textContent).toContain(
      "IntentArc bridge health check failed.",
    );
    expect(within(codex).getByText("Connection needs attention")).toBeTruthy();
    expect(within(codex).getByText("Safe profile found")).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Review connection",
    })).toBeTruthy();
    expect(within(codex).getByRole("button", {
      name: "Remove Codex",
    })).toBeTruthy();
    expect(within(codex).queryByText("Connected")).toBeNull();
  });

  test("keeps a failed health check at needs-attention through catalog refresh until reconnect succeeds", async () => {
    const user = userEvent.setup();
    const list = vi.fn(async () => catalog(connection("codex", {
      status: "connected",
      profileId: "profile-one",
    })));
    const testConnection = vi.fn(async () => {
      throw new Error("Bridge health failed.");
    });
    render(<AiConnections ai={aiApi({ list, test: testConnection })} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    await user.click(within(codex).getByRole("button", {
      name: "Test Codex",
    }));
    expect(await within(codex).findByText("Connection needs attention"))
      .toBeTruthy();

    await user.click(within(codex).getByRole("button", {
      name: "Check again",
    }));

    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(within(codex).getByText("Connection needs attention")).toBeTruthy();
    expect(within(codex).queryByText("Connected")).toBeNull();

    await user.click(within(codex).getByRole("button", {
      name: "Review connection",
    }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));

    expect(await within(codex).findByText("Connected")).toBeTruthy();
  });

  test("preserves fresher catalog metadata when a pending health test later fails", async () => {
    const user = userEvent.setup();
    const catalogRefresh = deferred<DesktopAiCatalog>();
    const healthTest = deferred<DesktopAiConnectionState>();
    const postFailureList = deferred<DesktopAiCatalog>();
    const list = vi.fn()
      .mockResolvedValueOnce(catalog(
        connection("codex", {
          status: "connected",
          profileId: "profile-old",
          version: "1.2.3",
        }),
        connection("claude-code", {
          availability: "setup_required",
          availabilityReason: "cli_missing",
          version: null,
        }),
      ))
      .mockImplementationOnce(() => catalogRefresh.promise)
      .mockImplementationOnce(() => postFailureList.promise);
    render(<AiConnections ai={aiApi({
      list,
      test: () => healthTest.promise,
    })} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    const claude = screen.getByRole("article", { name: "Claude Code" });
    await user.click(within(claude).getByRole("button", {
      name: "Check again",
    }));
    await user.click(within(codex).getByRole("button", {
      name: "Test Codex",
    }));
    catalogRefresh.resolve(catalog(
      connection("codex", {
        status: "connected",
        profileId: "profile-new",
        version: "9.9.9",
      }),
      connection("claude-code", {
        availability: "setup_required",
        availabilityReason: "cli_missing",
        version: null,
      }),
    ));
    expect(await within(codex).findByText("9.9.9")).toBeTruthy();

    healthTest.reject(new Error("Late bridge health failure."));

    expect((await screen.findByRole("status")).textContent).toContain(
      "Late bridge health failure.",
    );
    expect(within(codex).getByText("Connection needs attention")).toBeTruthy();
    expect(within(codex).getByText("9.9.9")).toBeTruthy();
    expect(within(codex).queryByText("1.2.3")).toBeNull();
  });

  test("clears restart-required after a successful connection test", async () => {
    const user = userEvent.setup();
    render(
      <AiConnections
        ai={aiApi({
          connect: async () => ({
            adapterId: "codex",
            status: "connected",
            profileId: "profile-one",
            restartRequired: true,
          }),
          test: async () => connection("codex", {
            status: "connected",
            profileId: "profile-one",
          }),
        })}
      />,
    );

    await user.click(within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("button", { name: "Connect Codex" }));
    await user.click(within(screen.getByRole("dialog", {
      name: "Connect Codex",
    })).getByRole("button", { name: "Connect Codex" }));
    expect(await screen.findByText("Restart required")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Test Codex" }));

    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByText("Restart required")).toBeNull();
  });

  test("reviews removal and returns the client to ready-to-connect", async () => {
    const user = userEvent.setup();
    const remove = vi.fn(async () => ({
      adapterId: "codex" as const,
      status: "not_connected" as const,
      profileId: "profile-one",
    }));
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "connected",
            profileId: "profile-one",
          })),
          remove,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", {
      name: "Remove Codex",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove Codex connection",
    });
    expect(within(dialog).getByText(/only the IntentArc connection/i))
      .toBeTruthy();
    await user.click(within(dialog).getByRole("button", {
      name: "Remove connection",
    }));

    await waitFor(() => expect(remove).toHaveBeenCalledWith("codex"));
    expect(within(screen.getByRole("article", { name: "Codex" })).getByText(
      "Ready to connect",
    )).toBeTruthy();
  });

  test("restores modal focus after deferred Connect failure and retries with Enter", async () => {
    const user = userEvent.setup();
    const firstAttempt = deferred<DesktopAiConnectResult>();
    const connect = vi.fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockResolvedValueOnce({
        adapterId: "codex",
        status: "connected",
        profileId: "profile-one",
        restartRequired: false,
      });
    render(<AiConnections ai={aiApi({ connect })} />);

    await user.click(within(await screen.findByRole("article", {
      name: "Codex",
    })).getByRole("button", { name: "Connect Codex" }));
    const dialog = screen.getByRole("dialog", { name: "Connect Codex" });
    const confirmation = within(dialog).getByRole("button", {
      name: "Connect Codex",
    });
    await user.click(confirmation);

    await waitFor(() => {
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(confirmation.textContent).toContain("Connecting");
    });
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    firstAttempt.reject(new Error("Codex settings could not be updated."));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Codex settings could not be updated.",
    );
    await waitFor(() => {
      expect(confirmation.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).toBe(confirmation);
    });

    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Connect Codex" })).toBeNull()
    );
    const heading = within(screen.getByRole("article", {
      name: "Codex",
    })).getByRole("heading", { name: "Codex" });
    expect(document.activeElement).toBe(heading);
  });

  test("restores modal focus after deferred Remove failure and retries with Enter", async () => {
    const user = userEvent.setup();
    const firstAttempt = deferred<DesktopAiRemoveResult>();
    const remove = vi.fn()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockResolvedValueOnce({
        adapterId: "codex",
        status: "not_connected",
        profileId: "profile-one",
      });
    render(
      <AiConnections
        ai={aiApi({
          list: async () => catalog(connection("codex", {
            status: "connected",
            profileId: "profile-one",
          })),
          remove,
        })}
      />,
    );

    await user.click(await screen.findByRole("button", {
      name: "Remove Codex",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Remove Codex connection",
    });
    const confirmation = within(dialog).getByRole("button", {
      name: "Remove connection",
    });
    await user.click(confirmation);

    await waitFor(() => {
      expect(confirmation.hasAttribute("disabled")).toBe(true);
      expect(confirmation.textContent).toContain("Removing");
    });
    document.body.tabIndex = -1;
    document.body.focus();
    expect(document.activeElement).toBe(document.body);
    firstAttempt.reject(new Error("Codex settings could not be updated."));

    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "Codex settings could not be updated.",
    );
    await waitFor(() => {
      expect(confirmation.hasAttribute("disabled")).toBe(false);
      expect(document.activeElement).toBe(confirmation);
    });

    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(screen.queryByRole("dialog", {
        name: "Remove Codex connection",
      })).toBeNull()
    );
    const heading = within(screen.getByRole("article", {
      name: "Codex",
    })).getByRole("heading", { name: "Codex" });
    expect(document.activeElement).toBe(heading);
  });

  test("offers retry after the client list fails", async () => {
    const user = userEvent.setup();
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("Could not check AI clients."))
      .mockResolvedValueOnce(catalog(connection("codex")));
    render(<AiConnections ai={aiApi({ list })} />);

    expect((await screen.findByRole("alert")).textContent).toContain(
      "Could not check AI clients.",
    );
    expect(screen.getByRole("button", {
      name: "Use another AI tool",
    })).toBeTruthy();
    expect(screen.getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
    expect(screen.queryByText(
      "No manual MCP setup details have been created.",
    )).toBeNull();
    expect(screen.getByText(
      "Saved manual MCP setups are unavailable until this check succeeds.",
    )).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("article", { name: "Codex" })).toBeTruthy();
  });
});
