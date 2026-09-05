import type { BrowserChatExport } from "../contracts.js";

export const downloadBrowserChatExport = (
  artifact: BrowserChatExport,
  browser: Pick<Document, "createElement" | "body"> = document,
  urls: Pick<typeof URL, "createObjectURL" | "revokeObjectURL"> = URL,
): void => {
  const blob = new Blob([artifact.text], { type: artifact.mediaType });
  const objectUrl = urls.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  let primaryFailed = false;
  let primaryFailure: unknown;
  try {
    anchor = browser.createElement("a");
    anchor.href = objectUrl;
    anchor.download = artifact.filename;
    anchor.hidden = true;
    browser.body.append(anchor);
    anchor.click();
  } catch (error) {
    primaryFailed = true;
    primaryFailure = error;
  }

  let cleanupFailed = false;
  let cleanupFailure: unknown;
  try {
    anchor?.remove();
  } catch (error) {
    cleanupFailed = true;
    cleanupFailure = error;
  }
  try {
    urls.revokeObjectURL(objectUrl);
  } catch (error) {
    if (!cleanupFailed) {
      cleanupFailed = true;
      cleanupFailure = error;
    }
  }

  if (primaryFailed) throw primaryFailure;
  if (cleanupFailed) throw cleanupFailure;
};
