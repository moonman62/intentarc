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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ProfileSetupDialog } from "./profile-setup-dialog.js";

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ProfileSetupDialog", () => {
  test("offers enabled global profiles plus project-authorized profiles that need destination repair", async () => {
    const user = userEvent.setup();
    const configured = vi.fn();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        profiles: [{
          profileId: "profile-global",
          name: "Global Codex",
          status: "enabled",
          executionMode: "custom",
          projectIds: ["project-other"],
          lastUsedAt: null,
          hasDestination: true,
        }, {
          profileId: "profile-current",
          name: "Already here",
          status: "enabled",
          executionMode: "safe",
          projectIds: ["project-1"],
          lastUsedAt: null,
          hasDestination: true,
        }, {
          profileId: "profile-current-destinationless",
          name: "Authorized CLI profile",
          status: "enabled",
          executionMode: "custom",
          projectIds: ["project-1"],
          lastUsedAt: null,
          hasDestination: false,
        }, {
          profileId: "profile-disabled",
          name: "Disabled profile",
          status: "disabled",
          executionMode: "safe",
          projectIds: [],
          lastUsedAt: null,
          hasDestination: true,
        }],
      }))
      .mockResolvedValueOnce(jsonResponse({
        profileId: "profile-current-destinationless",
        token: null,
        tokenShownOnce: false,
      }));
    vi.stubGlobal("fetch", fetchStub);

    render(
      <ProfileSetupDialog
        projectId="project-1"
        onClose={vi.fn()}
        onProfileConfigured={configured}
      />,
    );

    expect(await screen.findByText("Global Codex")).toBeTruthy();
    expect(screen.queryByText("Already here")).toBeNull();
    expect(screen.getByText("Authorized CLI profile")).toBeTruthy();
    expect(screen.queryByText("Disabled profile")).toBeNull();
    await user.click(screen.getByRole("radio", {
      name: /Authorized CLI profile/,
    }));
    expect(screen.getByText(/already authorized/i)).toBeTruthy();
    await user.type(
      screen.getByRole("textbox", { name: "Client label" }),
      "Codex repaired",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Provider label" }),
      "OpenAI",
    );
    await user.click(
      screen.getByRole("button", { name: "Repair selected profile" }),
    );

    await waitFor(() => expect(configured).toHaveBeenCalledWith(
      "profile-current-destinationless",
    ));
    const [, init] = fetchStub.mock.calls[1] as [string, RequestInit];
    expect(fetchStub.mock.calls[1]?.[0]).toBe(
      "/api/projects/project-1/profiles",
    );
    expect(JSON.parse(String(init.body))).toEqual({
      source: "existing",
      profileId: "profile-current-destinationless",
      executionMode: "custom",
      destination: {
        clientLabel: "Codex repaired",
        type: "local_model",
        providerLabel: "OpenAI",
        modelLabel: null,
        accountBoundaryLabel: null,
        dataBoundary: "local",
      },
    });
  });

  test("records Trusted as a declared execution mode without changing knowledge authority", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }))
      .mockResolvedValueOnce(jsonResponse({
        profileId: "profile-new",
        token: "one-time-token",
        tokenShownOnce: true,
      }));
    vi.stubGlobal("fetch", fetchStub);

    render(
      <ProfileSetupDialog
        projectId="project-1"
        onClose={vi.fn()}
        onProfileConfigured={vi.fn()}
      />,
    );

    await screen.findByRole("heading", { name: "Create new profile" });
    await user.type(
      screen.getByRole("textbox", { name: "Profile name" }),
      "Trusted client",
    );
    await user.click(screen.getByRole("radio", { name: "Trusted" }));
    expect(screen.getByText(
      /Trusted allows the AI client broad direct changes/,
    ).textContent).toContain(
      "IntentArc records this declared mode but does not grant the external tool permission.",
    );
    expect(screen.getByText(
      /Accepted IntentArc goals, scope, priorities, and decisions/,
    ).textContent).toContain(
      "separate knowledge-authority setting shown below",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Client label" }),
      "Codex desktop",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Destination type" }),
      "ide_managed",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Provider label" }),
      "OpenAI",
    );
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Data boundary" }),
      "remote",
    );
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    await waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(2));
    const [, init] = fetchStub.mock.calls[1] as [string, RequestInit];
    const posted = JSON.parse(String(init.body));
    expect(posted).toEqual({
      source: "new",
      name: "Trusted client",
      executionMode: "trusted",
      destination: {
        clientLabel: "Codex desktop",
        type: "ide_managed",
        providerLabel: "OpenAI",
        modelLabel: null,
        accountBoundaryLabel: null,
        dataBoundary: "remote",
      },
    });
    expect(posted).not.toHaveProperty("knowledgeAuthority");
  });

  test("shows a new token once, copies it explicitly, and discards it on close", async () => {
    const user = userEvent.setup();
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: copy },
    });
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }))
      .mockResolvedValueOnce(jsonResponse({
        profileId: "profile-new",
        token: "one-time-secret-token",
        tokenShownOnce: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }));
    vi.stubGlobal("fetch", fetchStub);
    localStorage.setItem("intentarc.unrelated", "kept");

    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            Add another destination
          </button>
          {open
            ? (
                <ProfileSetupDialog
                  projectId="project-1"
                  onClose={() => setOpen(false)}
                  onProfileConfigured={vi.fn()}
                />
              )
            : null}
        </>
      );
    }

    render(<Harness />);
    await screen.findByRole("heading", { name: "Create new profile" });
    await user.type(
      screen.getByRole("textbox", { name: "Profile name" }),
      "Safe client",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Client label" }),
      "Local model",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Provider label" }),
      "Local runtime",
    );
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    const credentialPanel = await screen.findByRole("region", {
      name: "One-time profile credential",
    });
    expect(within(credentialPanel).getByText("one-time-secret-token"))
      .toBeTruthy();
    expect(screen.queryByRole("form", { name: "Create new profile" })).toBeNull();
    expect(JSON.stringify({ ...localStorage })).not.toContain(
      "one-time-secret-token",
    );

    await user.click(
      within(credentialPanel).getByRole("button", { name: "Copy token" }),
    );
    expect(copy).toHaveBeenCalledWith("one-time-secret-token");
    expect(
      (await within(credentialPanel).findByRole("status")).textContent,
    ).toContain("Token copied");

    await user.click(screen.getByRole("button", {
      name: "Close destination setup",
    }));
    expect(screen.queryByText("one-time-secret-token")).toBeNull();
    await user.click(screen.getByRole("button", {
      name: "Add another destination",
    }));
    expect(await screen.findByRole("heading", { name: "Create new profile" }))
      .toBeTruthy();
    expect(screen.queryByText("one-time-secret-token")).toBeNull();
    expect(localStorage.getItem("intentarc.unrelated")).toBe("kept");
  });

  test("clears a one-time credential when the project changes", async () => {
    const user = userEvent.setup();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }))
      .mockResolvedValueOnce(jsonResponse({
        profileId: "profile-old",
        token: "old-project-token",
        tokenShownOnce: true,
      }))
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }));
    vi.stubGlobal("fetch", fetchStub);

    const { rerender } = render(
      <ProfileSetupDialog
        projectId="project-1"
        onClose={vi.fn()}
        onProfileConfigured={vi.fn()}
      />,
    );
    await screen.findByRole("heading", { name: "Create new profile" });
    await user.type(
      screen.getByRole("textbox", { name: "Profile name" }),
      "Old project client",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Client label" }),
      "Old client",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Provider label" }),
      "Old provider",
    );
    await user.click(screen.getByRole("button", { name: "Create profile" }));
    expect(await screen.findByText("old-project-token")).toBeTruthy();

    rerender(
      <ProfileSetupDialog
        projectId="project-2"
        onClose={vi.fn()}
        onProfileConfigured={vi.fn()}
      />,
    );

    expect(screen.queryByText("old-project-token")).toBeNull();
    expect(await screen.findByRole("heading", {
      name: "Create new profile",
    })).toBeTruthy();
  });

  test("ignores a late profile creation response from the previous project", async () => {
    const user = userEvent.setup();
    let resolveOldCreation: ((response: Response) => void) | undefined;
    const pendingOldCreation = new Promise<Response>((resolve) => {
      resolveOldCreation = resolve;
    });
    const configured = vi.fn();
    const fetchStub = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }))
      .mockReturnValueOnce(pendingOldCreation)
      .mockResolvedValueOnce(jsonResponse({ profiles: [] }));
    vi.stubGlobal("fetch", fetchStub);

    const { rerender } = render(
      <ProfileSetupDialog
        projectId="project-1"
        onClose={vi.fn()}
        onProfileConfigured={configured}
      />,
    );
    await screen.findByRole("heading", { name: "Create new profile" });
    await user.type(
      screen.getByRole("textbox", { name: "Profile name" }),
      "Slow old client",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Client label" }),
      "Slow destination",
    );
    await user.type(
      screen.getByRole("textbox", { name: "Provider label" }),
      "Slow provider",
    );
    await user.click(screen.getByRole("button", { name: "Create profile" }));

    rerender(
      <ProfileSetupDialog
        projectId="project-2"
        onClose={vi.fn()}
        onProfileConfigured={configured}
      />,
    );
    const oldPostSignal = (
      fetchStub.mock.calls[1]?.[1] as RequestInit | undefined
    )?.signal as AbortSignal;
    expect(oldPostSignal.aborted).toBe(true);
    await screen.findByRole("heading", { name: "Create new profile" });
    await act(async () => {
      resolveOldCreation?.(jsonResponse({
        profileId: "profile-old",
        token: "late-old-token",
        tokenShownOnce: true,
      }));
      await pendingOldCreation;
      await Promise.resolve();
    });

    expect(configured).not.toHaveBeenCalled();
    expect(screen.queryByText("late-old-token")).toBeNull();
    expect(screen.getByRole("heading", {
      name: "Create new profile",
    })).toBeTruthy();
  });

  test("ignores a late profile-list response from the previous project", async () => {
    let resolveOldProfiles: ((response: Response) => void) | undefined;
    const pendingOldProfiles = new Promise<Response>((resolve) => {
      resolveOldProfiles = resolve;
    });
    const fetchStub = vi.fn()
      .mockReturnValueOnce(pendingOldProfiles)
      .mockResolvedValueOnce(jsonResponse({
        profiles: [{
          profileId: "profile-new-project",
          name: "New project profile",
          status: "enabled",
          executionMode: "safe",
          projectIds: [],
          lastUsedAt: null,
          hasDestination: true,
        }],
      }));
    vi.stubGlobal("fetch", fetchStub);

    const { rerender } = render(
      <ProfileSetupDialog
        projectId="project-1"
        onClose={vi.fn()}
        onProfileConfigured={vi.fn()}
      />,
    );
    rerender(
      <ProfileSetupDialog
        projectId="project-2"
        onClose={vi.fn()}
        onProfileConfigured={vi.fn()}
      />,
    );
    expect(await screen.findByText("New project profile")).toBeTruthy();

    await act(async () => {
      resolveOldProfiles?.(jsonResponse({
        profiles: [{
          profileId: "profile-old-project",
          name: "Old project profile",
          status: "enabled",
          executionMode: "trusted",
          projectIds: [],
          lastUsedAt: null,
          hasDestination: true,
        }],
      }));
      await pendingOldProfiles;
      await Promise.resolve();
    });

    expect(screen.queryByText("Old project profile")).toBeNull();
    expect(screen.getByText("New project profile")).toBeTruthy();
  });
});
