// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";
import type { BrowserChatExport } from "../contracts.js";
import { downloadBrowserChatExport } from "./browser-download.js";

const artifact: BrowserChatExport = {
  filename: "intentarc-browser-chat-release-1.md",
  mediaType: "text/markdown;charset=utf-8",
  text: "# IntentArc browser-chat export\n\nReleased context.",
};

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadBrowserChatExport", () => {
  test("downloads the released Markdown unchanged and cleans up the one-shot anchor", () => {
    const blobCalls: Array<{ parts: BlobPart[]; options: BlobPropertyBag }> = [];
    class CapturingBlob {
      constructor(parts: BlobPart[], options: BlobPropertyBag) {
        blobCalls.push({ parts, options });
      }
    }
    vi.stubGlobal("Blob", CapturingBlob);
    const anchor = document.createElement("a");
    const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const browser = {
      createElement: vi.fn(() => anchor),
      body: document.body,
    };
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(),
    };

    downloadBrowserChatExport(artifact, browser, urls);

    expect(blobCalls).toEqual([{
      parts: [artifact.text],
      options: { type: artifact.mediaType },
    }]);
    expect(anchor.download).toBe(artifact.filename);
    expect(anchor.href).toBe("blob:intentarc-release");
    expect(click).toHaveBeenCalledOnce();
    expect(document.body.contains(anchor)).toBe(false);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:intentarc-release");
  });

  test("revokes the object URL and removes its anchor when the click fails", () => {
    const anchor = document.createElement("a");
    const clickFailure = new Error("download blocked");
    vi.spyOn(anchor, "click").mockImplementation(() => {
      throw clickFailure;
    });
    const browser = {
      createElement: vi.fn(() => anchor),
      body: document.body,
    };
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(),
    };

    expect(() => downloadBrowserChatExport(artifact, browser, urls)).toThrow(
      clickFailure,
    );

    expect(document.body.contains(anchor)).toBe(false);
    expect(urls.revokeObjectURL).toHaveBeenCalledWith("blob:intentarc-release");
  });

  test.each(["createElement", "append"] as const)(
    "revokes the object URL when %s fails before the click",
    (failurePoint) => {
      const domFailure = new Error(`${failurePoint} failed`);
      const anchor = document.createElement("a");
      const browser = {
        createElement: vi.fn(() => {
          if (failurePoint === "createElement") throw domFailure;
          return anchor;
        }),
        body: {
          append: vi.fn(() => {
            if (failurePoint === "append") throw domFailure;
          }),
        } as unknown as HTMLElement,
      };
      const urls = {
        createObjectURL: vi.fn(() => "blob:intentarc-release"),
        revokeObjectURL: vi.fn(),
      };

      expect(() => downloadBrowserChatExport(artifact, browser, urls)).toThrow(
        domFailure,
      );
      expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
        "blob:intentarc-release",
      );
    },
  );

  test("revokes the object URL and preserves the click failure when removal also fails", () => {
    const clickFailure = new Error("download blocked");
    const removeFailure = new Error("anchor removal failed");
    const anchor = document.createElement("a");
    vi.spyOn(anchor, "click").mockImplementation(() => {
      throw clickFailure;
    });
    vi.spyOn(anchor, "remove").mockImplementation(() => {
      throw removeFailure;
    });
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(),
    };

    expect(() => downloadBrowserChatExport(
      artifact,
      { createElement: () => anchor, body: document.body },
      urls,
    )).toThrow(clickFailure);
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:intentarc-release",
    );
  });

  test("revokes the object URL and surfaces removal failure after a successful click", () => {
    const removeFailure = new Error("anchor removal failed");
    const anchor = document.createElement("a");
    vi.spyOn(anchor, "click").mockImplementation(() => {});
    vi.spyOn(anchor, "remove").mockImplementation(() => {
      throw removeFailure;
    });
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(),
    };

    expect(() => downloadBrowserChatExport(
      artifact,
      { createElement: () => anchor, body: document.body },
      urls,
    )).toThrow(removeFailure);
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:intentarc-release",
    );
  });

  test("retains removal as the first cleanup failure when URL revocation also fails", () => {
    const removeFailure = new Error("anchor removal failed");
    const revokeFailure = new Error("URL revocation failed");
    const anchor = document.createElement("a");
    const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const remove = vi.spyOn(anchor, "remove").mockImplementation(() => {
      throw removeFailure;
    });
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(() => {
        throw revokeFailure;
      }),
    };

    expect(() => downloadBrowserChatExport(
      artifact,
      { createElement: () => anchor, body: document.body },
      urls,
    )).toThrow(removeFailure);
    expect(click).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:intentarc-release",
    );
  });

  test("retains the primary DOM failure when both cleanup operations also fail", () => {
    const appendFailure = new Error("anchor append failed");
    const removeFailure = new Error("anchor removal failed");
    const revokeFailure = new Error("URL revocation failed");
    const anchor = document.createElement("a");
    const click = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const remove = vi.spyOn(anchor, "remove").mockImplementation(() => {
      throw removeFailure;
    });
    const urls = {
      createObjectURL: vi.fn(() => "blob:intentarc-release"),
      revokeObjectURL: vi.fn(() => {
        throw revokeFailure;
      }),
    };

    expect(() => downloadBrowserChatExport(
      artifact,
      {
        createElement: () => anchor,
        body: {
          append: () => {
            throw appendFailure;
          },
        } as unknown as HTMLElement,
      },
      urls,
    )).toThrow(appendFailure);
    expect(click).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledOnce();
    expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith(
      "blob:intentarc-release",
    );
  });
});
