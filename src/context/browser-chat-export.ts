import type { OutboundRelease } from "../domain/index.js";
import { formatTaskContextPack } from "./portable-context.js";

export interface BrowserChatExport {
  readonly filename: string;
  readonly mediaType: "text/markdown;charset=utf-8";
  readonly text: string;
}

const toFilenameSafeReleaseId = (releaseId: string): string =>
  releaseId.replace(/[^A-Za-z0-9._-]+/g, "-");

export const formatBrowserChatExport = (
  release: OutboundRelease,
): BrowserChatExport => {
  const { disclosure } = release;
  const text = [
    "# IntentArc browser-chat export",
    "",
    `Release: \`${release.releaseId}\``,
    `Request: \`${release.requestId}\``,
    `Source pack: \`${release.sourcePackId}\``,
    `Project: \`${disclosure.projectId}\``,
    `Task: \`${disclosure.taskId}\``,
    `Project revision: ${disclosure.projectRevision}`,
    `Release digest: \`${disclosure.releaseDigest}\``,
    `Released at: ${release.releasedAt}`,
    `Release SHA-256: ${release.sha256}`,
    `Destination: ${disclosure.destination.clientLabel}`,
    `Data boundary: ${disclosure.destination.dataBoundary}`,
    `Detector version: ${disclosure.detectorVersion}`,
    `Safety policy version: ${disclosure.safetyPolicyVersion}`,
    `Original estimated tokens: ${disclosure.originalEstimatedTokens}`,
    `Released tokens: ${disclosure.releasedEstimatedTokens} / ${disclosure.requestedBudgetTokens}`,
    "",
    "## Finding counts",
    `- Total: ${disclosure.findingCounts.total}`,
    `- Credential: ${disclosure.findingCounts.credential}`,
    `- Sensitive: ${disclosure.findingCounts.sensitive}`,
    `- Forced redactions: ${disclosure.findingCounts.forcedRedact}`,
    `- Redactions by default: ${disclosure.findingCounts.redactByDefault}`,
    `- Redacted: ${disclosure.findingCounts.redacted}`,
    `- Included once: ${disclosure.findingCounts.includedOnce}`,
    "",
    "## Explicit omissions",
    ...(disclosure.omissions.length === 0
      ? ["- None"]
      : disclosure.omissions.map((omission) =>
        `- \`${omission.recordId}\` omitted for ${omission.reason}; ` +
        `retrieve with \`${omission.retrievalRef}\``
      )),
    "",
    formatTaskContextPack(release.pack),
  ].join("\n");

  return {
    filename: `intentarc-browser-chat-${toFilenameSafeReleaseId(release.releaseId)}.md`,
    mediaType: "text/markdown;charset=utf-8",
    text,
  };
};
