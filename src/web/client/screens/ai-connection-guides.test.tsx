// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, test, vi } from "vitest";
import type {
  DesktopAiApi,
  DesktopAiCatalog,
  DesktopAiConnectionState,
  DesktopManualConnectionSetup,
} from "../desktop-api.js";
import { AiConnections } from "./ai-connections.js";

afterEach(cleanup);
afterEach(() => document.body.removeAttribute("tabindex"));

const catalog = (
  automatic: DesktopAiConnectionState[],
): DesktopAiCatalog => ({ automatic, manual: [] });

const aiApi = (
  automatic: DesktopAiConnectionState[],
  overrides: Partial<DesktopAiApi> = {},
): DesktopAiApi => ({
  list: async () => catalog(automatic),
  createManual: async () => {
    throw new Error("Not used in automatic guide tests.");
  },
  removeManual: async () => {
    throw new Error("Not used in automatic guide tests.");
  },
  connect: async (adapterId) => ({
    adapterId,
    status: "connected",
    profileId: "profile-one",
    restartRequired: false,
  }),
  test: async (adapterId) => ({
    adapterId,
    status: "connected",
    availability: "ready",
    availabilityReason: "connector_ready",
    version: "1.2.3",
    profileId: "profile-one",
  }),
  remove: async (adapterId) => ({
    adapterId,
    status: "not_connected",
    profileId: null,
  }),
  launchForProject: async (input) => ({
    adapterId: input.adapterId,
    result: "manual_required",
  }),
  ...overrides,
});

const unavailableConnection = (
  adapterId: DesktopAiConnectionState["adapterId"],
  availabilityReason: DesktopAiConnectionState["availabilityReason"],
  availability: DesktopAiConnectionState["availability"] = "setup_required",
): DesktopAiConnectionState => ({
  adapterId,
  status: "not_connected",
  availability,
  availabilityReason,
  version: null,
  profileId: null,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

describe("automatic AI connection guides", () => {
  test("gives maintained Codex CLI steps when only Codex desktop is present", async () => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi([
      unavailableConnection("codex", "cli_missing"),
    ])} />);

    const codex = await screen.findByRole("article", { name: "Codex" });
    await user.click(within(codex).getByRole("button", {
      name: "How to connect Codex",
    }));

    const guide = within(codex).getByRole("region", {
      name: "How to connect Codex",
    });
    expect(within(guide).getByText(
      /Codex desktop application is present/i,
    )).toBeTruthy();
    expect(within(guide).getByText(
      /protected internal executable is not used/i,
    )).toBeTruthy();
    expect(within(guide).getByText(
      "Install or update the supported CLI with npm install -g @openai/codex.",
    )).toBeTruthy();
    expect(within(guide).getByText(
      "Run codex login and complete ChatGPT sign-in if Codex is not already signed in.",
    )).toBeTruthy();
    expect(within(guide).getByText(
      "You can confirm the account state with codex login status. IntentArc checks the local CLI and MCP setup, not your ChatGPT account.",
    )).toBeTruthy();
    expect(within(guide).getByText(
      "Return to IntentArc and choose Check again.",
    )).toBeTruthy();
  });

  test.each([
    [
      "access_blocked",
      "IntentArc cannot access the Codex CLI from your user account.",
    ],
    [
      "unsupported_version",
      "IntentArc found Codex, but could not confirm a supported CLI version.",
    ],
    [
      "probe_failed",
      "IntentArc could not finish checking Codex on this device.",
    ],
  ] as const)(
    "keeps a distinct Codex %s diagnostic",
    async (availabilityReason, diagnostic) => {
      const user = userEvent.setup();
      render(<AiConnections ai={aiApi([
        unavailableConnection("codex", availabilityReason),
      ])} />);

      const codex = await screen.findByRole("article", { name: "Codex" });
      await user.click(within(codex).getByRole("button", {
        name: "How to connect Codex",
      }));

      expect(within(codex).getByText(diagnostic)).toBeTruthy();
    },
  );

  test("guides Claude Code installation without inventing a remote-install command", async () => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi([
      unavailableConnection("claude-code", "not_installed", "not_detected"),
    ])} />);

    const claude = await screen.findByRole("article", { name: "Claude Code" });
    await user.click(within(claude).getByRole("button", {
      name: "Installation guide for Claude Code",
    }));

    const guide = within(claude).getByRole("region", {
      name: "Installation guide for Claude Code",
    });
    expect(within(guide).getByText(
      "Install the supported Claude Code CLI using Anthropic's maintained instructions.",
    )).toBeTruthy();
    expect(within(guide).getByText(
      /confirm claude --version works/i,
    )).toBeTruthy();
    expect(within(guide).getByText(
      /then return to IntentArc and choose Check again/i,
    )).toBeTruthy();
    expect(guide.textContent).not.toMatch(
      /\b(?:curl|wget|irm|iwr)\b|https?:\/\//i,
    );
  });
});

describe("other AI tool guide", () => {
  test.each([
    [
      "a connected automatic client",
      [{
        ...unavailableConnection("codex", "connector_ready", "ready"),
        status: "connected" as const,
        profileId: "profile-one",
      }],
    ],
    ["no ready automatic client", []],
  ])("stays available with %s and explains local MCP and API-only limits", async (
    _scenario,
    automatic,
  ) => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi(automatic)} />);

    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));

    const dialog = screen.getByRole("dialog", {
      name: "Use another AI tool",
    });
    expect(within(dialog).getByText(
      "Your AI tool must support a local MCP server that it can start as a command.",
    )).toBeTruthy();
    expect(within(dialog).getByRole("button", {
      name: "Set up an MCP client",
    })).toBeTruthy();
    expect(within(dialog).getByRole("heading", {
      name: "Using an API-only service?",
    })).toBeTruthy();
    expect(within(dialog).getByText(
      /does not request or store your API key/i,
    )).toBeTruthy();
    expect(within(dialog).queryByLabelText(/api key/i)).toBeNull();
    expect(within(dialog).getByRole("link", {
      name: "Continue without AI",
    })).toBeTruthy();
  });

  test("creates explicit setup details and copies only exact service-returned values", async () => {
    const user = userEvent.setup();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-private",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "C:\\Program Files\\IntentArc\\IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    const createManual = vi.fn(async () => setup);
    const writeText = vi.fn(async (_value: string) => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(<AiConnections ai={aiApi([], { createManual })} />);

    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Use another AI tool",
    });
    expect(dialog.textContent).not.toContain(setup.command);
    expect(dialog.textContent).not.toContain(setup.args[1]);

    await user.type(within(dialog).getByRole("textbox", {
      name: "AI client name",
    }), "My editor");
    await user.click(within(dialog).getByRole("button", {
      name: "Set up an MCP client",
    }));

    await waitFor(() => expect(createManual).toHaveBeenCalledWith({
      label: "My editor",
    }));
    expect(await within(dialog).findByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();
    expect(within(dialog).getByRole("textbox", {
      name: "Command",
    })).toHaveProperty("value", setup.command);
    expect(within(dialog).getByRole("textbox", {
      name: "Arguments",
    })).toHaveProperty("value", "--connection service-returned-reference");
    expect(dialog.textContent).not.toContain(setup.profileId);
    expect(dialog.textContent).not.toMatch(/\bConnected\b/);

    await user.click(within(dialog).getByRole("button", {
      name: "Copy command",
    }));
    await user.click(within(dialog).getByRole("button", {
      name: "Copy arguments",
    }));

    expect(writeText).toHaveBeenNthCalledWith(1, setup.command);
    expect(writeText).toHaveBeenNthCalledWith(
      2,
      "--connection service-returned-reference",
    );
  });

  test("moves focus to setup details after deferred creation", async () => {
    const user = userEvent.setup();
    const pending = deferred<DesktopManualConnectionSetup>();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-private",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    const createManual = vi.fn(() => pending.promise);
    render(<AiConnections ai={aiApi([], { createManual })} />);

    await user.click(await screen.findByRole("button", {
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
    await waitFor(() => expect(createManual).toHaveBeenCalledTimes(1));
    document.body.tabIndex = -1;
    document.body.focus();

    pending.resolve(setup);

    const heading = await within(dialog).findByRole("heading", {
      name: "Setup details created",
    });
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(dialog.contains(document.activeElement)).toBe(true);
  });

  test("associates blank-name errors and clears them while editing", async () => {
    const user = userEvent.setup();
    render(<AiConnections ai={aiApi([])} />);

    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    const dialog = screen.getByRole("dialog", {
      name: "Use another AI tool",
    });
    const input = within(dialog).getByRole("textbox", {
      name: "AI client name",
    });
    await user.type(input, "   ");
    await user.click(within(dialog).getByRole("button", {
      name: "Set up an MCP client",
    }));

    const error = within(dialog).getByRole("alert");
    expect(error.textContent).toContain("Enter a client name");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toContain(error.id);

    fireEvent.change(input, { target: { value: "My editor" } });

    expect(within(dialog).queryByRole("alert")).toBeNull();
    expect(input.getAttribute("aria-invalid")).toBe("false");
  });

  test("accepts an emoji-ZWJ client name at 80 graphemes and rejects 81 without truncation", async () => {
    const user = userEvent.setup();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "unused",
      profileId: "profile-private",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    const createManual = vi.fn(async ({ label }: { label: string }) => ({
      ...setup,
      label,
    }));
    const { unmount } = render(
      <AiConnections ai={aiApi([], { createManual })} />,
    );
    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    const emojiZwj = "\u{1f469}\u200d\u{1f4bb}";
    const accepted = `Editor ${emojiZwj.repeat(73)}`;
    const input = screen.getByRole("textbox", { name: "AI client name" });
    fireEvent.change(input, { target: { value: accepted } });
    await user.click(screen.getByRole("button", {
      name: "Set up an MCP client",
    }));
    await waitFor(() => expect(createManual).toHaveBeenCalledWith({
      label: accepted,
    }));

    unmount();
    createManual.mockClear();
    render(<AiConnections ai={aiApi([], { createManual })} />);
    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    fireEvent.change(screen.getByRole("textbox", {
      name: "AI client name",
    }), {
      target: { value: `Editor ${emojiZwj.repeat(74)}` },
    });
    await user.click(screen.getByRole("button", {
      name: "Set up an MCP client",
    }));

    expect(createManual).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain(
      "80 characters or fewer",
    );
  });

  test.each([
    ["standardized blank", "\u2800"],
    ["embedded format control", "My\u200B editor"],
    ["line separator", "My\u2028editor"],
    ["bidirectional control", "\u202EMy editor"],
    ["standalone ZWJ", "\u200d"],
    ["embedded text ZWJ", "A\u200dB"],
    ["dangling emoji ZWJ", "Editor \u{1f469}\u200d"],
    ["no content-bearing grapheme", "\u0301"],
  ])("rejects a client name containing %s", async (_case, label) => {
    const user = userEvent.setup();
    const createManual = vi.fn(async () => ({
      id: "manual-one",
      label,
      profileId: "profile-private",
      state: "setup_created" as const,
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: [
        "--connection",
        "service-returned-reference",
      ] as const,
    }));
    render(<AiConnections ai={aiApi([], { createManual })} />);
    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    fireEvent.change(screen.getByRole("textbox", {
      name: "AI client name",
    }), { target: { value: label } });

    await user.click(screen.getByRole("button", {
      name: "Set up an MCP client",
    }));

    expect(createManual).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeTruthy();
  });

  test("keeps every dialog exit inert until setup details are available", async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, "", "/settings/ai");
    const pending = deferred<DesktopManualConnectionSetup>();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-private",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    render(<AiConnections ai={aiApi([], {
      createManual: () => pending.promise,
    })} />);
    await user.click(await screen.findByRole("button", {
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
    await waitFor(() => expect(dialog.getAttribute("aria-busy")).toBe("true"));

    const continueLink = within(dialog).getByRole("link", {
      name: "Continue without AI",
    });
    expect(continueLink.getAttribute("aria-disabled")).toBe("true");
    expect(fireEvent.click(continueLink, { ctrlKey: true })).toBe(false);
    fireEvent.click(continueLink);
    await user.keyboard("{Escape}");
    for (const close of screen.getAllByRole("button", {
      name: "Close manual AI setup",
    })) {
      expect(close.hasAttribute("disabled")).toBe(true);
      fireEvent.click(close);
    }
    expect(window.location.pathname).toBe("/settings/ai");
    expect(screen.getByRole("dialog", {
      name: "Use another AI tool",
    })).toBeTruthy();

    pending.resolve(setup);

    await within(dialog).findByRole("heading", {
      name: "Setup details created",
    });
    expect(dialog.getAttribute("aria-busy")).toBe("false");
    expect(continueLink.getAttribute("aria-disabled")).toBe("false");
    await user.click(continueLink);
    expect(window.location.pathname).toBe("/");
  });

  test("creates setup details when a legacy catalog omits manual entries", async () => {
    const user = userEvent.setup();
    const setup: DesktopManualConnectionSetup = {
      id: "manual-one",
      label: "My editor",
      profileId: "profile-private",
      state: "setup_created",
      createdAt: "2026-08-01T12:00:00.000Z",
      command: "IntentArc Bridge.exe",
      args: ["--connection", "service-returned-reference"],
    };
    render(<AiConnections ai={aiApi([], {
      list: async () => ({ automatic: [] } as DesktopAiCatalog),
      createManual: async () => setup,
    })} />);
    await user.click(await screen.findByRole("button", {
      name: "Use another AI tool",
    }));
    await user.type(screen.getByRole("textbox", {
      name: "AI client name",
    }), setup.label);

    await user.click(screen.getByRole("button", {
      name: "Set up an MCP client",
    }));

    expect(await screen.findByRole("heading", {
      name: "Setup details created",
    })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
