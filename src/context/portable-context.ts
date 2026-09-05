import {
  neutralHierarchyVocabulary,
  type ContextItem,
  type HierarchyVocabulary,
  type TaskContextPack,
} from "../domain/index.js";

const recordLine = ({ record, mandatory }: ContextItem): string =>
  `### ${record.title}\n` +
  `- ID: \`${record.id}\`\n` +
  `- Kind: ${record.kind}\n` +
  `- Status: ${record.status}\n` +
  `- Mandatory: ${mandatory ? "yes" : "no"}\n\n` +
  `${record.body}\n`;

const jsonUnicodeEscape = (character: string): string => {
  const codePoint = character.codePointAt(0)!;
  if (codePoint <= 0xffff) {
    return `\\u${codePoint.toString(16).padStart(4, "0")}`;
  }

  const supplementary = codePoint - 0x10000;
  const highSurrogate = 0xd800 + (supplementary >> 10);
  const lowSurrogate = 0xdc00 + (supplementary & 0x3ff);
  return `\\u${highSurrogate.toString(16)}\\u${lowSurrogate.toString(16)}`;
};

const escapeJsonLineControls = (json: string): string =>
  json.replace(/[\p{Zl}\p{Zp}\p{Cf}]/gu, jsonUnicodeEscape);

const hierarchyVocabularyLine = (
  vocabulary: HierarchyVocabulary = neutralHierarchyVocabulary,
): string => `Hierarchy vocabulary (JSON): ${escapeJsonLineControls(
  JSON.stringify({
    preset: vocabulary.preset,
    outcome: vocabulary.outcome,
    initiative: vocabulary.initiative,
    deliverable: vocabulary.deliverable,
    milestone: vocabulary.milestone,
    task: vocabulary.task,
    nestedTask: vocabulary.nestedTask,
  }),
)}`;

export const formatTaskContextPack = (pack: TaskContextPack): string => [
  `# Task Context: ${pack.task.record.title}`,
  "",
  `Pack: \`${pack.id}\``,
  `Project revision: ${pack.projectRevision}`,
  `Estimated tokens: ${pack.estimatedTokens} / ${pack.budgetTokens}`,
  hierarchyVocabularyLine(pack.hierarchyVocabulary),
  "",
  "## Project frame",
  ...pack.stableFrame.flatMap((item) => [recordLine(item), ""]),
  "## Active task",
  recordLine(pack.task),
  "",
  "## Relevant records",
  ...pack.related.flatMap((item) => [recordLine(item), ""]),
  "## Explicit omissions",
  ...(pack.omissions.length === 0
    ? ["- None"]
    : pack.omissions.map((omission) =>
      `- \`${omission.recordId}\` omitted for ${omission.reason}; ` +
      `retrieve with \`${omission.retrievalRef}\``
    )),
  "",
].join("\n");
