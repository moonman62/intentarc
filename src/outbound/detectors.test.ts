import { describe, expect, it } from "vitest";
import { detectText } from "./detectors.js";

const path = "/task/record/body";

describe("outbound text detectors", () => {
  it.each([
    ["pem private key", "-----BEGIN PRIVATE KEY-----\nSYNTHETIC\n-----END PRIVATE KEY-----", "pem-private-key", "private_key", "forced_redact", 0, 63],
    ["OpenAI token", "sk-proj-SyntheticTokenValue0123456789", "provider-token", "api_token", "forced_redact", 0, 37],
    ["Anthropic token", "sk-ant-SyntheticTokenValue0123456789", "provider-token", "api_token", "forced_redact", 0, 36],
    ["GitHub token", "ghp_SyntheticTokenValue0123456789", "provider-token", "api_token", "forced_redact", 0, 33],
    ["AWS access key", "AKIAABCDEFGHIJKLMNOP", "provider-token", "api_token", "forced_redact", 0, 20],
    ["Slack token", "xoxb-1234567890abcdefghijkl", "provider-token", "api_token", "forced_redact", 0, 27],
    ["Stripe live secret", "sk_live_ABCDEFGHIJKLMNOP", "provider-token", "api_token", "forced_redact", 0, 24],
    ["bearer authorization", "Authorization: Bearer synthetictokenvalue123456789", "authorization-bearer", "authorization", "forced_redact", 22, 50],
    ["JWT authorization", "token=synthetic1.synthetic2.synthetic3", "authorization-jwt", "authorization", "forced_redact", 6, 38],
    ["credential URI", "postgres://user:synthetic-password@example.invalid/db", "credential-uri", "credential_uri", "forced_redact", 11, 34],
    ["secret assignment", "api_key=synthetic-value-123456789", "secret-assignment", "secret_assignment", "forced_redact", 8, 33],
    ["contextual entropy", "credential=Qa9!syntheticHighEntropyValue", "contextual-entropy", "high_entropy", "forced_redact", 11, 40],
    ["email", "owner@example.invalid", "email", "email", "redact_by_default", 0, 21],
    ["phone", "123-456-7890", "phone", "phone", "redact_by_default", 0, 12],
    ["IPv4", "192.0.2.42", "ipv4", "network_address", "redact_by_default", 0, 10],
    ["IPv6", "2001:db8::42", "ipv6", "network_address", "redact_by_default", 0, 12],
    ["Windows user path", "C:\\Users\\synthetic-user\\project", "windows-user-path", "local_user_path", "redact_by_default", 0, 23],
    ["POSIX user path", "/home/synthetic-user/project", "posix-user-path", "local_user_path", "redact_by_default", 0, 20],
  ])("detects %s with its exact public span", (_name, value, detectorId, category, requiredAction, start, end) => {
    expect(detectText(path, value)).toContainEqual(expect.objectContaining({
      detectorId,
      category,
      requiredAction,
      path,
      start,
      end,
    }));
  });

  it.each([
    "record-550e8400-e29b-41d4-a716-446655440000",
    `sha256=${"a".repeat(64)}`,
    "https://example.invalid/public/path",
  ])("does not classify structural value %s as a credential", (value) => {
    expect(detectText(path, value)
      .filter((finding) => finding.severity === "credential")).toEqual([]);
  });

  it("does not classify a canonical UUID as a phone number", () => {
    expect(detectText(path, "52f2a11c-4621-4910-8514-9090b4fe7a9f")
      .filter((finding) => finding.category === "phone")).toEqual([]);
  });

  it("detects a phone-like span in mixed text containing a UUID-shaped substring", () => {
    expect(detectText(path, "x52f2a11c-4621-4910-8514-9090b4fe7a9fy"))
      .toContainEqual(expect.objectContaining({ category: "phone", detectorId: "phone" }));
  });

  it("finishes bounded detection on a long non-secret line", () => {
    const longInput = `note=${"a".repeat(250_000)}`;
    const startedAt = performance.now();

    expect(detectText(path, longInput)).toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
