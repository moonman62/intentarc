import type { Command } from "commander";
import { z } from "zod";
import type { IntentArcService } from "../core/intentarc-service.js";
import {
  approveOutboundRequestInputSchema,
  outboundRequestFilterSchema,
  setOutboundDestinationInputSchema,
} from "../domain/index.js";
import { OutboundSafetyError } from "../outbound/errors.js";
import type { CliOutput } from "./program.js";

export interface RegisterOutboundCommandsOptions {
  profileCommand: Command;
  contextCommand: Command;
  service: IntentArcService;
  stdout: CliOutput;
  stderr: CliOutput;
  stdin: { isTTY?: boolean };
  fail: (error: unknown) => never;
}

const identifierSchema = z.string().trim().min(1).max(200);
const profileInputSchema = z.object({ profileId: identifierSchema }).strict();
const requestInputSchema = z.object({ requestId: identifierSchema }).strict();
const revealInputSchema = z.object({
  requestId: identifierSchema,
  findingId: identifierSchema,
}).strict();
const policyInputSchema = z.object({
  profileId: identifierSchema,
  projectId: identifierSchema,
}).strict();

const collect = (value: string, previous: string[]): string[] =>
  [...previous, value];

const writeJson = (stdout: CliOutput, value: unknown): void => {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};

export const registerOutboundCommands = ({
  profileCommand,
  contextCommand,
  service,
  stdout,
  stderr,
  stdin,
  fail,
}: RegisterOutboundCommandsOptions): void => {
  const destination = profileCommand
    .command("destination")
    .description("Manage outbound destinations");

  destination
    .command("set")
    .requiredOption("--profile <profileId>")
    .requiredOption("--client-label <label>")
    .requiredOption("--type <type>")
    .requiredOption("--provider <provider>")
    .requiredOption("--data-boundary <boundary>")
    .option("--model <model>")
    .option("--account-boundary <label>")
    .action((options: {
      profile: string;
      clientLabel: string;
      type: string;
      provider: string;
      dataBoundary: string;
      model?: string;
      accountBoundary?: string;
    }) => {
      try {
        const input = setOutboundDestinationInputSchema.parse({
          profileId: options.profile,
          clientLabel: options.clientLabel,
          type: options.type,
          providerLabel: options.provider,
          modelLabel: options.model ?? null,
          accountBoundaryLabel: options.accountBoundary ?? null,
          dataBoundary: options.dataBoundary,
        });
        writeJson(stdout, service.destinations.set(input));
      } catch (error) {
        fail(error);
      }
    });

  destination
    .command("disable")
    .requiredOption("--profile <profileId>")
    .action((options: { profile: string }) => {
      try {
        const input = profileInputSchema.parse({ profileId: options.profile });
        writeJson(stdout, service.destinations.disable(input.profileId));
      } catch (error) {
        fail(error);
      }
    });

  const outbound = contextCommand
    .command("outbound")
    .description("Review outbound context requests");

  outbound
    .command("list")
    .option("--project <projectId>")
    .option("--status <status>")
    .action((options: { project?: string; status?: string }) => {
      try {
        const input = outboundRequestFilterSchema.parse({
          ...(options.project === undefined
            ? {}
            : { projectId: options.project }),
          ...(options.status === undefined ? {} : { status: options.status }),
        });
        writeJson(stdout, service.outbound.list(input));
      } catch (error) {
        fail(error);
      }
    });

  outbound
    .command("inspect")
    .requiredOption("--request <requestId>")
    .action((options: { request: string }) => {
      try {
        const input = requestInputSchema.parse({ requestId: options.request });
        writeJson(stdout, service.outbound.inspect(input.requestId));
      } catch (error) {
        fail(error);
      }
    });

  outbound
    .command("reveal")
    .requiredOption("--request <requestId>")
    .requiredOption("--finding <findingId>")
    .action((options: { request: string; finding: string }) => {
      try {
        const input = revealInputSchema.parse({
          requestId: options.request,
          findingId: options.finding,
        });
        if (!stdin.isTTY || !stdout.isTTY) {
          throw new OutboundSafetyError("outbound_reveal_requires_tty", input);
        }
        stderr.write(
          "Warning: revealing this finding may expose sensitive content in the terminal.\n",
        );
        const revealed = service.outbound.reveal(
          input.requestId,
          input.findingId,
        );
        stdout.write(`${revealed.value}\n`);
      } catch (error) {
        fail(error);
      }
    });

  outbound
    .command("approve")
    .requiredOption("--request <requestId>")
    .option("--remember-clean")
    .option(
      "--include-finding <findingId>",
      "Include a review finding once",
      collect,
      [],
    )
    .action((options: {
      request: string;
      rememberClean?: boolean;
      includeFinding: string[];
    }) => {
      try {
        const input = approveOutboundRequestInputSchema.parse({
          requestId: options.request,
          rememberClean: options.rememberClean === true,
          includeFindingIds: options.includeFinding,
        });
        writeJson(stdout, service.outbound.approve(input));
      } catch (error) {
        fail(error);
      }
    });

  outbound
    .command("deny")
    .requiredOption("--request <requestId>")
    .action((options: { request: string }) => {
      try {
        const input = requestInputSchema.parse({ requestId: options.request });
        writeJson(stdout, service.outbound.deny(input.requestId));
      } catch (error) {
        fail(error);
      }
    });

  const policy = outbound
    .command("policy")
    .description("Manage outbound release policies");

  policy
    .command("disable")
    .requiredOption("--profile <profileId>")
    .requiredOption("--project <projectId>")
    .action((options: { profile: string; project: string }) => {
      try {
        const input = policyInputSchema.parse({
          profileId: options.profile,
          projectId: options.project,
        });
        service.outbound.disablePolicy(input.profileId, input.projectId);
        writeJson(stdout, {
          disabled: true,
          profileId: input.profileId,
          projectId: input.projectId,
        });
      } catch (error) {
        fail(error);
      }
    });
};
