import { describe, expect, it } from "vitest";
import {
  credentialMatches,
  generateCredential,
  hashCredential,
} from "./credential-hash.js";

describe("credential hashing", () => {
  it("creates a lowercase SHA-256 digest and verifies only the original credential", () => {
    const digest = hashCredential("secret");

    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(credentialMatches("secret", digest)).toBe(true);
    expect(credentialMatches("wrong", digest)).toBe(false);
  });

  it("encodes injected token bytes as base64url", () => {
    expect(
      generateCredential(() => Buffer.from([251, 255, 239])),
    ).toBe("-__v");
  });
});
