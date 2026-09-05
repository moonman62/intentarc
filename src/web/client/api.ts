import { apiErrorResponseSchema } from "../contracts.js";

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly recoverable: boolean,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export interface ApiProfileCredentials {
  profileId: string;
  token: string;
}

export async function apiRequest<Result>(
  path: string,
  init: RequestInit = {},
  profileCredentials?: ApiProfileCredentials,
): Promise<Result> {
  let headers: HeadersInit;
  if (profileCredentials) {
    const credentialHeaders = new Headers(init.headers);
    if (init.body && !credentialHeaders.has("Content-Type")) {
      credentialHeaders.set("Content-Type", "application/json");
    }
    credentialHeaders.set("X-IntentArc-Profile-Id", profileCredentials.profileId);
    credentialHeaders.set("Authorization", `Bearer ${profileCredentials.token}`);
    headers = credentialHeaders;
  } else {
    headers = {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    };
  }
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  const body: unknown = await response.json();
  if (!response.ok) {
    const parsed = apiErrorResponseSchema.parse(body);
    throw new ApiError(
      parsed.error.code,
      parsed.error.message,
      parsed.error.recoverable,
      response.status,
    );
  }
  return body as Result;
}
