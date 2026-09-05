import { describe, expect, it } from "vitest";
import { OutboundSafetyError, outboundErrorCodes } from "./errors.js";

describe("outbound safety errors", () => {
  it("uses a canonical message and validates safe details for every code", () => {
    const cases = [
      ["outbound_destination_required", { profileId: "profile-1" }, "Outbound destination is required."],
      ["outbound_destination_changed", { requestId: "request-1", expectedRevision: 1, currentRevision: 2 }, "Outbound destination has changed."],
      ["outbound_request_conflict", { requestId: "request-1" }, "Outbound request conflicts with existing state."],
      ["outbound_safety_failed", {}, "Outbound safety processing failed."],
      ["outbound_release_invalid", { requestId: "request-1" }, "Outbound release is invalid."],
      ["outbound_reveal_requires_tty", { requestId: "request-1", findingId: "finding-1" }, "Sensitive finding reveal requires an interactive terminal."],
    ] as const;

    expect(outboundErrorCodes).toHaveLength(cases.length);
    for (const [code, details, message] of cases) {
      const error = new OutboundSafetyError(code, details);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("OutboundSafetyError");
      expect(error.code).toBe(code);
      expect(error.message).toBe(message);
      expect(error.details).toEqual(details);
    }
  });

  it("rejects unknown and structurally invalid error details", () => {
    expect(() => new OutboundSafetyError("outbound_safety_failed", { requestId: "request-1" }))
      .toThrow();
    expect(() => new OutboundSafetyError("outbound_request_conflict", {
      requestId: { rawSecret: "synthetic" },
    })).toThrow();
    expect(() => new OutboundSafetyError("outbound_destination_changed", {
      requestId: "request-1",
      expectedRevision: 1,
      currentRevision: -1,
    })).toThrow();
  });
});
