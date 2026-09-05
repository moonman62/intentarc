const manualLabelSegmenter = new Intl.Segmenter("en", {
  granularity: "grapheme",
});
const ZERO_WIDTH_JOINER = "\u200d";
const forbiddenManualLabelCharacter = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const standardizedBlankManualLabelCharacter =
  /[\u115f\u1160\u2800\u3164\uffa0]/u;
const contentBearingManualLabelGrapheme = /[\p{L}\p{N}\p{P}\p{S}]/u;
const visibleEmojiZwjGrapheme =
  /^\p{Extended_Pictographic}\ufe0f?\p{Emoji_Modifier}?(?:\u200d\p{Extended_Pictographic}\ufe0f?\p{Emoji_Modifier}?)+$/u;

export type ManualClientLabelValidation =
  | { readonly valid: true; readonly label: string }
  | {
      readonly valid: false;
      readonly reason:
        | "empty"
        | "no_visible_content"
        | "too_long"
        | "unsafe_character";
    };

export const validateManualClientLabel = (
  value: string,
): ManualClientLabelValidation => {
  if (
    forbiddenManualLabelCharacter.test(
      value.replaceAll(ZERO_WIDTH_JOINER, ""),
    ) ||
    standardizedBlankManualLabelCharacter.test(value)
  ) {
    return { valid: false, reason: "unsafe_character" };
  }

  const label = value.trim();
  let graphemeCount = 0;
  let hasVisibleGrapheme = false;
  for (const { segment } of manualLabelSegmenter.segment(label)) {
    graphemeCount += 1;
    if (graphemeCount > 80) {
      return { valid: false, reason: "too_long" };
    }
    if (
      segment.includes(ZERO_WIDTH_JOINER) &&
      !visibleEmojiZwjGrapheme.test(segment)
    ) {
      return { valid: false, reason: "unsafe_character" };
    }
    if (contentBearingManualLabelGrapheme.test(segment)) {
      hasVisibleGrapheme = true;
    }
  }

  if (graphemeCount === 0) return { valid: false, reason: "empty" };
  if (!hasVisibleGrapheme) {
    return { valid: false, reason: "no_visible_content" };
  }
  return { valid: true, label };
};
