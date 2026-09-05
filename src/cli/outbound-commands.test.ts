import { describe, expect, it, vi } from "vitest";
import type { IntentArcService } from "../core/intentarc-service.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import { createProgram } from "./program.js";

const captureOutput = (isTTY?: boolean) => {
  let value = "";
  return {
    isTTY,
    write(chunk: string) {
      value += chunk;
      return true;
    },
    text: () => value,
  };
};

const createService = (): IntentArcService =>
  ({
    destinations: {
      getCurrent: vi.fn(),
      set: vi.fn(),
      disable: vi.fn(),
    },
    outbound: {
      request: vi.fn(),
      getReleased: vi.fn(),
      list: vi.fn(),
      inspect: vi.fn(),
      reveal: vi.fn(),
      approve: vi.fn(),
      deny: vi.fn(),
      disablePolicy: vi.fn(),
    },
  }) as unknown as IntentArcService;

const createHarness = (options: {
  isTTY?: boolean;
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
} = {}) => {
  const service = createService();
  const stdout = captureOutput(options.stdoutIsTTY ?? options.isTTY);
  const stderr = captureOutput();
  const program = createProgram({
    service,
    stdout,
    stderr,
    stdin: { isTTY: options.stdinIsTTY ?? options.isTTY },
    confirmationService: { confirm: vi.fn() },
  });
  return { program, service, stdout, stderr };
};

describe("human outbound CLI commands", () => {
  it("sets a destination with every required and optional field", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.destinations.set).mockReturnValue({
      id: "destination-1",
    } as never);

    await harness.program.parseAsync([
      "profile", "destination", "set",
      "--profile", "profile-1",
      "--client-label", "Codex workstation",
      "--type", "direct_provider",
      "--provider", "OpenAI",
      "--data-boundary", "remote",
      "--model", "gpt-5",
      "--account-boundary", "Team account",
    ], { from: "user" });

    expect(harness.service.destinations.set).toHaveBeenCalledWith({
      profileId: "profile-1",
      clientLabel: "Codex workstation",
      type: "direct_provider",
      providerLabel: "OpenAI",
      modelLabel: "gpt-5",
      accountBoundaryLabel: "Team account",
      dataBoundary: "remote",
    });
    expect(harness.stdout.text()).toBe(
      `${JSON.stringify({ id: "destination-1" }, null, 2)}\n`,
    );
  });

  it("disables the current profile destination", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.destinations.disable).mockReturnValue({
      status: "disabled",
    } as never);

    await harness.program.parseAsync([
      "profile", "destination", "disable", "--profile", "profile-1",
    ], { from: "user" });

    expect(harness.service.destinations.disable).toHaveBeenCalledWith("profile-1");
    expect(harness.stdout.text()).toContain('"status": "disabled"');
  });

  it("forwards outbound request list filters", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.outbound.list).mockReturnValue([]);

    await harness.program.parseAsync([
      "context", "outbound", "list",
      "--project", "project-1",
      "--status", "review_required",
    ], { from: "user" });

    expect(harness.service.outbound.list).toHaveBeenCalledWith({
      projectId: "project-1",
      status: "review_required",
    });
    expect(harness.stdout.text()).toBe("[]\n");
  });

  it("writes inspection as JSON without an unmasked finding value", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.outbound.inspect).mockReturnValue({
      findings: [{ id: "finding-1", path: "/records/0/body" }],
      redactedPreview: { records: [{ body: "[REDACTED]" }] },
    } as never);

    await harness.program.parseAsync([
      "context", "outbound", "inspect", "--request", "request-1",
    ], { from: "user" });

    expect(harness.service.outbound.inspect).toHaveBeenCalledWith("request-1");
    expect(JSON.parse(harness.stdout.text())).toEqual({
      findings: [{ id: "finding-1", path: "/records/0/body" }],
      redactedPreview: { records: [{ body: "[REDACTED]" }] },
    });
    expect(harness.stdout.text()).not.toContain("matched-secret");
  });

  it("refuses reveal without a TTY before reading the matched value", async () => {
    const harness = createHarness({ isTTY: false });

    await expect(harness.program.parseAsync([
      "context", "outbound", "reveal",
      "--request", "request-1",
      "--finding", "finding-1",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.service.outbound.reveal).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("outbound_reveal_requires_tty");
    expect(harness.stdout.text()).toBe("");
  });

  it("refuses reveal when stdout is redirected before reading the matched value", async () => {
    const harness = createHarness({
      stdinIsTTY: true,
      stdoutIsTTY: false,
    });

    await expect(harness.program.parseAsync([
      "context", "outbound", "reveal",
      "--request", "request-1",
      "--finding", "finding-1",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.service.outbound.reveal).not.toHaveBeenCalled();
    expect(harness.stderr.text()).toContain("outbound_reveal_requires_tty");
    expect(harness.stdout.text()).toBe("");
  });

  it("warns on a TTY before writing exactly one revealed value", async () => {
    const harness = createHarness({ isTTY: true });
    vi.mocked(harness.service.outbound.reveal).mockReturnValue({
      requestId: "request-1",
      findingId: "finding-1",
      value: "matched-secret",
    });

    await harness.program.parseAsync([
      "context", "outbound", "reveal",
      "--request", "request-1",
      "--finding", "finding-1",
    ], { from: "user" });

    expect(harness.stderr.text()).toBe(
      "Warning: revealing this finding may expose sensitive content in the terminal.\n",
    );
    expect(harness.service.outbound.reveal).toHaveBeenCalledWith(
      "request-1",
      "finding-1",
    );
    expect(harness.stdout.text()).toBe("matched-secret\n");
  });

  it("collects one-time finding inclusions exactly", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.outbound.approve).mockReturnValue({
      releaseId: "release-1",
    } as never);

    await harness.program.parseAsync([
      "context", "outbound", "approve",
      "--request", "request-1",
      "--include-finding", "finding-1",
      "--include-finding", "finding-2",
    ], { from: "user" });

    expect(harness.service.outbound.approve).toHaveBeenCalledWith({
      requestId: "request-1",
      rememberClean: false,
      includeFindingIds: ["finding-1", "finding-2"],
    });
  });

  it("forwards remember-clean with an empty inclusion list", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.outbound.approve).mockReturnValue({
      releaseId: "release-1",
    } as never);

    await harness.program.parseAsync([
      "context", "outbound", "approve",
      "--request", "request-1",
      "--remember-clean",
    ], { from: "user" });

    expect(harness.service.outbound.approve).toHaveBeenCalledWith({
      requestId: "request-1",
      rememberClean: true,
      includeFindingIds: [],
    });
  });

  it("denies one outbound request", async () => {
    const harness = createHarness();
    vi.mocked(harness.service.outbound.deny).mockReturnValue({
      requestId: "request-1",
      status: "denied",
    } as never);

    await harness.program.parseAsync([
      "context", "outbound", "deny", "--request", "request-1",
    ], { from: "user" });

    expect(harness.service.outbound.deny).toHaveBeenCalledWith("request-1");
    expect(harness.stdout.text()).toContain('"status": "denied"');
  });

  it("disables an outbound policy for one profile and project", async () => {
    const harness = createHarness();

    await harness.program.parseAsync([
      "context", "outbound", "policy", "disable",
      "--profile", "profile-1",
      "--project", "project-1",
    ], { from: "user" });

    expect(harness.service.outbound.disablePolicy).toHaveBeenCalledWith(
      "profile-1",
      "project-1",
    );
    expect(harness.stdout.text()).toBe(
      `${JSON.stringify({
        disabled: true,
        profileId: "profile-1",
        projectId: "project-1",
      }, null, 2)}\n`,
    );
  });

  it("rejects strict invalid input before invoking an outbound service", async () => {
    const harness = createHarness();

    await expect(harness.program.parseAsync([
      "context", "outbound", "approve",
      "--request", "request-1",
      "--include-finding", "finding-1",
      "--include-finding", "finding-1",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 2 });

    expect(harness.stderr.text()).toBe("Invalid command input.\n");
    expect(harness.service.outbound.approve).not.toHaveBeenCalled();
  });

  it("renders canonical outbound failures without attached private data", async () => {
    const harness = createHarness();
    const error = new OutboundSafetyError(
      "outbound_destination_changed",
      {
        requestId: "request-1",
        expectedRevision: 1,
        currentRevision: 2,
      },
    );
    Object.assign(error, {
      cause: new Error("SELECT matched-secret FROM C:/private/store.sqlite"),
      clientLabel: "private destination label",
      findingValue: "matched-secret",
    });
    vi.mocked(harness.service.outbound.inspect).mockImplementation(() => {
      throw error;
    });

    await expect(harness.program.parseAsync([
      "context", "outbound", "inspect", "--request", "request-1",
    ], { from: "user" })).rejects.toMatchObject({ exitCode: 1 });

    expect(harness.stderr.text()).toBe(
      "outbound_destination_changed: Outbound destination has changed. " +
        "Details: {\"requestId\":\"request-1\",\"expectedRevision\":1,\"currentRevision\":2}\n",
    );
    expect(harness.stderr.text()).not.toMatch(
      /matched-secret|private destination label|store\.sqlite|SELECT|stack|cause/i,
    );
  });
});
