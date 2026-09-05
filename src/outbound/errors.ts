import { z } from "zod";

const identifierSchema = z.string().trim().min(1).max(200);
const positiveIntegerSchema = z.number().int().positive();

export const outboundErrorCodes = [
  "outbound_destination_required",
  "outbound_destination_changed",
  "outbound_request_conflict",
  "outbound_safety_failed",
  "outbound_release_invalid",
  "outbound_reveal_requires_tty",
] as const;

export type OutboundErrorCode = (typeof outboundErrorCodes)[number];

const messages = {
  outbound_destination_required: "Outbound destination is required.",
  outbound_destination_changed: "Outbound destination has changed.",
  outbound_request_conflict: "Outbound request conflicts with existing state.",
  outbound_safety_failed: "Outbound safety processing failed.",
  outbound_release_invalid: "Outbound release is invalid.",
  outbound_reveal_requires_tty: "Sensitive finding reveal requires an interactive terminal.",
} satisfies Record<OutboundErrorCode, string>;

export type OutboundErrorDetailsByCode = {
  outbound_destination_required: { profileId: string };
  outbound_destination_changed: {
    requestId: string;
    expectedRevision: number;
    currentRevision: number;
  };
  outbound_request_conflict: { requestId: string };
  outbound_safety_failed: {};
  outbound_release_invalid: { requestId: string };
  outbound_reveal_requires_tty: {
    requestId: string;
    findingId: string;
  };
};

export const outboundErrorDetailsSchemas = {
  outbound_destination_required: z.object({ profileId: identifierSchema }).strict(),
  outbound_destination_changed: z.object({
    requestId: identifierSchema,
    expectedRevision: positiveIntegerSchema,
    currentRevision: positiveIntegerSchema,
  }).strict(),
  outbound_request_conflict: z.object({ requestId: identifierSchema }).strict(),
  outbound_safety_failed: z.object({}).strict(),
  outbound_release_invalid: z.object({ requestId: identifierSchema }).strict(),
  outbound_reveal_requires_tty: z.object({
    requestId: identifierSchema,
    findingId: identifierSchema,
  }).strict(),
} satisfies Record<OutboundErrorCode, z.ZodType>;

export class OutboundSafetyError<
  Code extends OutboundErrorCode = OutboundErrorCode,
> extends Error {
  readonly code: Code;
  readonly details: Readonly<OutboundErrorDetailsByCode[Code]>;

  constructor(code: Code, details: OutboundErrorDetailsByCode[Code]) {
    super(messages[code]);
    this.name = "OutboundSafetyError";
    this.code = code;
    this.details = outboundErrorDetailsSchemas[code].parse(details) as
      OutboundErrorDetailsByCode[Code];
  }
}
