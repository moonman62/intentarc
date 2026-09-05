import { isAbsolute } from "node:path";
import { isMainModule } from "../../system/main-module.js";
import { cleanupPreservedClientPortabilityRoot } from "./client-portability-cleanup.js";

export interface ClientPortabilityCleanupCliInput {
  readonly argv: readonly string[];
  readonly writeLine: (line: string) => void;
}

export const runClientPortabilityCleanupCli = async (
  input: ClientPortabilityCleanupCliInput,
): Promise<0 | 1> => {
  if (
    input.argv.length !== 2
    || input.argv[0] !== "--receipt"
    || typeof input.argv[1] !== "string"
    || !isAbsolute(input.argv[1])
  ) {
    input.writeLine(JSON.stringify({ status: "preserved", category: "arguments" }));
    return 1;
  }
  try {
    const result = await cleanupPreservedClientPortabilityRoot(input.argv[1]);
    if (result.status === "removed") {
      input.writeLine(JSON.stringify({
        status: "removed",
        removedEntries: result.removedEntries,
      }));
      return 0;
    }
    if (result.status === "cleanup_failed") {
      input.writeLine(JSON.stringify({ status: "cleanup_failed", category: "root" }));
      return 1;
    }
    input.writeLine(JSON.stringify({
      status: "preserved",
      category: result.category,
    }));
    return 1;
  } catch {
    input.writeLine(JSON.stringify({ status: "preserved", category: "root" }));
    return 1;
  }
};

if (isMainModule(process.argv[1], import.meta.url)) {
  void runClientPortabilityCleanupCli({
    argv: process.argv.slice(2),
    writeLine: (line) => { process.stdout.write(`${line}\n`); },
  }).then((exitCode) => { process.exitCode = exitCode; }, () => {
    process.stdout.write(`${JSON.stringify({ status: "preserved", category: "root" })}\n`);
    process.exitCode = 1;
  });
}
