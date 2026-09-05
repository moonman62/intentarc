import { describe, expect, it } from "vitest";
import {
  exchangeLaunchToken,
  isAllowedMutationOrigin,
  isAuthenticated,
} from "./session.js";

describe("web session security", () => {
  it("exchanges the exact launch token for a strict HTTP-only session cookie", () => {
    expect(exchangeLaunchToken({
      url: new URL("http://127.0.0.1:47861/?key=secret"),
      expectedToken: "secret",
    })).toMatchObject({
      redirect: "/",
      cookie: expect.stringContaining(
        "intentarc_session=secret; HttpOnly; SameSite=Strict; Path=/",
      ),
    });

    expect(exchangeLaunchToken({
      url: new URL("http://127.0.0.1:47861/?key=wrong"),
      expectedToken: "secret",
    })).toBeNull();
  });

  it("authenticates only the exact session cookie", () => {
    expect(isAuthenticated("intentarc_session=secret", "secret")).toBe(true);
    expect(isAuthenticated("intentarc_session=wrong", "secret")).toBe(false);
    expect(isAuthenticated(undefined, "secret")).toBe(false);
  });

  it("allows mutation requests only from the exact server origin", () => {
    expect(isAllowedMutationOrigin(
      "http://127.0.0.1:47861",
      "http://127.0.0.1:47861",
    )).toBe(true);
    expect(isAllowedMutationOrigin(
      "http://evil.example",
      "http://127.0.0.1:47861",
    )).toBe(false);
  });
});
