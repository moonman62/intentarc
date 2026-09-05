import { createClaudeCodeAdapter } from "./claude-code.js";
import { createCodexAdapter } from "./codex.js";
import type { CodexConfigManager } from "./codex-config.js";
import {
  createCodexProductPresenceProbe,
  type CodexProductPresenceProbe,
} from "./codex-presence.js";
import { createCommandRunner } from "./command-runner.js";
import type {
  AiAdapterId,
  AiClientAdapter,
  CommandRunner,
} from "./types.js";

export interface CreateAiAdapterRegistryOptions {
  readonly runner?: CommandRunner;
  readonly codexConfig?: CodexConfigManager;
  readonly codexProductPresence?: CodexProductPresenceProbe;
}

export type AiAdapterRegistry = ReadonlyMap<AiAdapterId, AiClientAdapter>;

export const createAiAdapterRegistry = (
  options: CreateAiAdapterRegistryOptions = {},
): AiAdapterRegistry => {
  const runner = options.runner ?? createCommandRunner();
  const codexProductPresence = options.codexProductPresence ??
    createCodexProductPresenceProbe({ runner });
  const codex = createCodexAdapter({
    runner,
    productPresence: codexProductPresence,
    ...(options.codexConfig === undefined
      ? {}
      : { config: options.codexConfig }),
  });
  const claudeCode = createClaudeCodeAdapter({ runner });
  return new Map<AiAdapterId, AiClientAdapter>([
    [codex.id, codex],
    [claudeCode.id, claudeCode],
  ]);
};
