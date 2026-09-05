import {
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export type TokenBytesGenerator = (size: number) => Buffer;

export const generateCredential = (
  generateBytes: TokenBytesGenerator = randomBytes,
): string => generateBytes(32).toString("base64url");

export const hashCredential = (credential: string): string =>
  createHash("sha256").update(credential).digest("hex");

export const credentialMatches = (
  candidate: string,
  expectedHash: string,
): boolean => {
  const candidateDigest = Buffer.from(hashCredential(candidate), "hex");
  const expectedDigest = Buffer.from(expectedHash, "hex");

  return (
    candidateDigest.length === expectedDigest.length &&
    timingSafeEqual(candidateDigest, expectedDigest)
  );
};
