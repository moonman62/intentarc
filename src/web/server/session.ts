import { createHash, timingSafeEqual } from "node:crypto";

const SESSION_COOKIE_NAME = "intentarc_session";

export interface LaunchTokenExchangeInput {
  url: URL;
  expectedToken: string;
}

export interface LaunchTokenExchange {
  redirect: string;
  cookie: string;
}

export const exchangeLaunchToken = (
  input: LaunchTokenExchangeInput,
): LaunchTokenExchange | null => {
  const presentedToken = input.url.searchParams.get("key");
  if (
    presentedToken === null ||
    !constantTimeEqual(presentedToken, input.expectedToken)
  ) {
    return null;
  }

  return {
    redirect: "/",
    cookie:
      `${SESSION_COOKIE_NAME}=${input.expectedToken}; ` +
      "HttpOnly; SameSite=Strict; Path=/",
  };
};

export const isAuthenticated = (
  cookieHeader: string | undefined,
  expectedToken: string,
): boolean => {
  if (!cookieHeader) {
    return false;
  }

  for (const cookie of cookieHeader.split(";")) {
    const separator = cookie.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const name = cookie.slice(0, separator).trim();
    const value = cookie.slice(separator + 1).trim();
    if (
      name === SESSION_COOKIE_NAME &&
      constantTimeEqual(value, expectedToken)
    ) {
      return true;
    }
  }

  return false;
};

export const isAllowedMutationOrigin = (
  originHeader: string | undefined,
  expectedOrigin: string,
): boolean => {
  return originHeader === expectedOrigin;
};

const constantTimeEqual = (left: string, right: string): boolean => {
  const leftDigest = createHash("sha256").update(left, "utf8").digest();
  const rightDigest = createHash("sha256").update(right, "utf8").digest();

  return timingSafeEqual(leftDigest, rightDigest);
};
