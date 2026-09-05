import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  bridgeProtocolEnvironment,
  retainBridgeProtocolChild,
  verifyBridgeProtocolCompatibilityWithDependencies,
} from "./bridge-protocol-verifier.js";

const activationOwnerEnvironmentKey =
  "INTENTARC_BRIDGE_ACTIVATION_TRANSACTION_OWNER";

class FakeProtocolChild extends EventEmitter {
  exitCode: number | null = null;
  readonly kill = vi.fn((_signal: NodeJS.Signals) => true);

  emitExit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  emitClose(code: number | null = this.exitCode): void {
    this.emit("close", code, null);
  }
}

const deferred = <T = void>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
};

const settlementHarness = () => {
  const deadlines: Array<{
    readonly milliseconds: number;
    readonly expire: () => void;
  }> = [];
  return {
    deadlines,
    dependencies: {
      now: () => 1_000,
      scheduleDeadline: (expire: () => void, milliseconds: number) => {
        const deadline = { expire, milliseconds };
        deadlines.push(deadline);
        return () => {
          const index = deadlines.indexOf(deadline);
          if (index >= 0) deadlines.splice(index, 1);
        };
      },
    },
  };
};

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("bridge protocol verification environment", () => {
  it("forwards only the exact active transaction marker and strips inherited lookalikes", () => {
    const transaction = {
      transactionId: "44444444-4444-4444-8444-444444444444",
      phase: "active-verification" as const,
    };

    expect(bridgeProtocolEnvironment({
      PATH: "C:\\Windows\\System32",
      intentarc_bridge_activation_transaction_owner: "attacker-marker",
    }, "C:\\isolated\\Roaming", transaction)).toEqual({
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\isolated\\Roaming",
      [activationOwnerEnvironmentKey]: transaction.transactionId,
    });

    expect(bridgeProtocolEnvironment({
      PATH: "C:\\Windows\\System32",
      [activationOwnerEnvironmentKey]: "attacker-marker",
    }, "C:\\isolated\\Roaming")).toEqual({
      PATH: "C:\\Windows\\System32",
      APPDATA: "C:\\isolated\\Roaming",
    });
  });
});

describe("retained bridge protocol child settlement", () => {
  it("does not settle when client close resolves before child close", async () => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const close = deferred();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    let outcome = "pending";
    const settlement = retained.settle(() => close.promise).then(() => {
      outcome = "settled";
    });

    close.resolve();
    await flushPromises();

    expect(outcome).toBe("pending");
    expect(child.kill).toHaveBeenCalledTimes(1);
    child.emitExit(0);
    child.emitClose();
    await settlement;
  });

  it("does not settle from exit without close", async () => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    let outcome = "pending";
    const settlement = retained.settle(async () => undefined).then(() => {
      outcome = "settled";
    });

    child.emitExit(0);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(outcome).toBe("pending");
    child.emitClose();
    await settlement;
  });

  it("requires zero exit plus close", async () => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    const settlement = retained.settle(async () => undefined);

    child.emitExit(0);
    child.emitClose();

    await expect(settlement).resolves.toBeUndefined();
    expect(harness.deadlines).toHaveLength(0);
  });

  it.each([
    ["process error", (child: FakeProtocolChild) => {
      child.emit("error", new Error("synthetic child error"));
      child.emitExit(0);
      child.emitClose();
    }, /synthetic child error/],
    ["nonzero exit", (child: FakeProtocolChild) => {
      child.emitExit(7);
      child.emitClose();
    }, /exited unsuccessfully/],
  ])("rejects %s after exact close proof", async (_label, fail, expected) => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    const settlement = retained.settle(async () => undefined);

    fail(child);

    await expect(settlement).rejects.toThrow(expected);
  });

  it("rejects an absolute close-settlement deadline", async () => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    const settlement = retained.settle(async () => undefined);

    expect(harness.deadlines).toHaveLength(1);
    expect(harness.deadlines[0]?.milliseconds).toBe(5_000);
    harness.deadlines[0]?.expire();

    await expect(settlement).rejects.toThrow(/settlement timed out/i);
    expect(retained.hasCloseProof()).toBe(false);
  });

  it("kills only the exact retained child and at most once", async () => {
    const retainedChild = new FakeProtocolChild();
    const unrelatedChild = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(
      retainedChild,
      harness.dependencies,
    );
    const settlement = retained.settle(async () => undefined);

    await flushPromises();
    retainedChild.emitExit(0);
    retainedChild.emitClose();
    await settlement;

    expect(retainedChild.kill).toHaveBeenCalledTimes(1);
    expect(retainedChild.kill).toHaveBeenCalledWith("SIGKILL");
    expect(unrelatedChild.kill).not.toHaveBeenCalled();
  });

  it("does not permit temporary cleanup before close proof", async () => {
    const child = new FakeProtocolChild();
    const harness = settlementHarness();
    const retained = retainBridgeProtocolChild(child, harness.dependencies);
    const events: string[] = [];
    const settlement = retained.settle(async () => undefined).then(() => {
      events.push("cleanup");
    });

    child.emitExit(0);
    await flushPromises();
    expect(events).toEqual([]);
    child.emitClose();
    await settlement;

    expect(events).toEqual(["cleanup"]);
    expect(retained.hasCloseProof()).toBe(true);
  });
});

const requiredProtocolTools = [
  "get_my_change",
  "get_project_summary",
  "get_released_context",
  "list_my_changes",
  "list_projects",
  "request_task_context",
  "submit_change_set",
].map((name) => ({ name }));

const topLevelVerifierHarness = (options: {
  readonly listToolsError?: Error;
  readonly removeError?: Error;
  readonly settleChild?: boolean;
  readonly exitCode?: number;
} = {}) => {
  const events: string[] = [];
  const child = new FakeProtocolChild();
  const settlement = settlementHarness();
  const transport = {};
  let retainedTransportChild: FakeProtocolChild | undefined = child;
  const dependencies = {
    createTemporaryRoot: async () => "C:\\isolated-protocol-root",
    prepareWorkspace: () => {
      events.push("prepare-workspace");
    },
    createTransport: () => transport,
    createClient: () => ({
      connect: async () => {
        events.push("client-connect");
      },
      listTools: async () => {
        events.push("list-tools");
        if (options.listToolsError) throw options.listToolsError;
        return { tools: requiredProtocolTools };
      },
      callTool: async () => {
        events.push("call-tool");
        return { isError: false };
      },
      close: async () => {
        events.push("client-close");
        retainedTransportChild = undefined;
        if (options.settleChild !== false) {
          child.emitExit(options.exitCode ?? 0);
          events.push("child-exit");
          child.emitClose();
          events.push("child-close");
        }
      },
    }),
    getTransportChild: () => {
      events.push("capture-child");
      return retainedTransportChild;
    },
    removeTemporaryRoot: async () => {
      events.push("remove-root");
      if (options.removeError) throw options.removeError;
    },
    childSettlementDependencies: settlement.dependencies,
  };
  return { child, dependencies, events, settlement };
};

const fakeVerificationInput = {
  phase: "staged" as const,
  executablePath: "C:\\payload\\IntentArc Bridge.exe",
  versionDirectory: "C:\\payload",
  binaryRoot: "C:\\IntentArc",
};

describe("top-level bridge protocol verifier lifecycle", () => {
  it("captures the transport child before client close clears it and cleans after close", async () => {
    const harness = topLevelVerifierHarness();

    await verifyBridgeProtocolCompatibilityWithDependencies(
      fakeVerificationInput,
      harness.dependencies,
    );

    expect(harness.events.indexOf("capture-child")).toBeLessThan(
      harness.events.indexOf("client-close"),
    );
    expect(harness.events.indexOf("remove-root")).toBeGreaterThan(
      harness.events.indexOf("child-close"),
    );
  });

  it("retains the temporary root when exact child close remains uncertain", async () => {
    const harness = topLevelVerifierHarness({ settleChild: false });
    const verification = verifyBridgeProtocolCompatibilityWithDependencies(
      fakeVerificationInput,
      harness.dependencies,
    );

    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.settlement.deadlines).toHaveLength(1);
    harness.settlement.deadlines[0]?.expire();

    await expect(verification).rejects.toThrow(/settlement timed out/i);
    expect(harness.events).not.toContain("remove-root");
  });

  it("keeps verification primary before settlement and cleanup failures", async () => {
    const primary = new Error("synthetic verification primary");
    const cleanup = new Error("synthetic cleanup secondary");
    const harness = topLevelVerifierHarness({
      listToolsError: primary,
      removeError: cleanup,
      exitCode: 7,
    });

    const failure = await verifyBridgeProtocolCompatibilityWithDependencies(
      fakeVerificationInput,
      harness.dependencies,
    ).then(() => undefined, (error: unknown) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toHaveLength(3);
    expect((failure as AggregateError).errors[0]).toBe(primary);
    expect((failure as AggregateError).errors[1]).toMatchObject({
      message: expect.stringMatching(/exited unsuccessfully/i),
    });
    expect((failure as AggregateError).errors[2]).toBe(cleanup);
    expect(harness.events.indexOf("remove-root")).toBeGreaterThan(
      harness.events.indexOf("child-close"),
    );
  });
});
