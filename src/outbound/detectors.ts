import { isIP } from "node:net";

export const OUTBOUND_DETECTOR_VERSION = "1";
export const OUTBOUND_SAFETY_POLICY_VERSION = "1";

export interface DetectedSpan {
  detectorId: string;
  category: "private_key" | "api_token" | "authorization" |
    "credential_uri" | "secret_assignment" | "high_entropy" |
    "email" | "phone" | "network_address" | "local_user_path";
  confidence: "high" | "possible";
  severity: "credential" | "sensitive";
  path: string;
  start: number;
  end: number;
  requiredAction: "forced_redact" | "redact_by_default";
}

const privateKeyBlock =
  /-----BEGIN ((?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY)-----[\s\S]{0,65536}?-----END \1-----/g;
const bearer = /\bAuthorization\s*:\s*Bearer\s+([A-Za-z0-9._~+/=-]{16,})/gi;
const jwtInAuthContext = /\b(?:bearer|token)\s*[=:]\s*([A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/gi;
const secretAssignment = /\b(password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key)\s*[=:]\s*["']?([^\s"',;]{8,})/gi;
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phone = /\b(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?|\d{2,4}[\s.-])\d{3,4}[\s.-]\d{3,4}\b/g;
const canonicalUuid = /(?<![A-Za-z0-9_])[0-9A-F]{8}-[0-9A-F]{4}-[1-5][0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}(?![A-Za-z0-9_])/gi;
const ipv4 = /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g;
const windowsUserPath = /\b[A-Za-z]:\\Users\\[^\\\r\n]+/g;
const posixUserPath = /\/(?:home|Users)\/[^/\r\n]+/g;
const providerTokenPatterns = [
  ["openai", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ["anthropic", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ["github", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["stripe-live-secret", /\bsk_live_[A-Za-z0-9]{16,}\b/g],
] as const;

const uriCandidate = /[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s"'<>]{1,2048}/g;
const ipv6Candidate = /(?<![A-Za-z0-9:])[0-9A-Fa-f:]{2,45}(?![A-Za-z0-9:])/g;
const contextualEntropy = /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|private[_-]?key|credential|credentials|token|bearer)\s*[=:]\s*["']?([^\s"',;]{20,})/gi;

export const detectorPriorities: Readonly<Record<string, number>> = {
  "pem-private-key": 0,
  "provider-token": 1,
  "authorization-bearer": 2,
  "authorization-jwt": 3,
  "credential-uri": 4,
  "contextual-entropy": 5,
  "secret-assignment": 6,
  email: 7,
  phone: 8,
  ipv4: 9,
  ipv6: 10,
  "windows-user-path": 11,
  "posix-user-path": 12,
};

const forced = (
  detectorId: string,
  category: Extract<DetectedSpan["category"], "private_key" | "api_token" | "authorization" | "credential_uri" | "secret_assignment" | "high_entropy">,
  path: string,
  start: number,
  end: number,
): DetectedSpan => ({ detectorId, category, confidence: "high", severity: "credential", path, start, end, requiredAction: "forced_redact" });

const defaultRedaction = (
  detectorId: string,
  category: Extract<DetectedSpan["category"], "email" | "phone" | "network_address" | "local_user_path">,
  path: string,
  start: number,
  end: number,
): DetectedSpan => ({ detectorId, category, confidence: "possible", severity: "sensitive", path, start, end, requiredAction: "redact_by_default" });

const eachMatch = (pattern: RegExp, text: string, callback: (match: RegExpExecArray) => void): void => {
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) callback(match);
};

const isWithinCanonicalUuid = (text: string, start: number, end: number): boolean => {
  canonicalUuid.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = canonicalUuid.exec(text)) !== null) {
    if (match.index <= start && match.index + match[0].length >= end) return true;
  }
  return false;
};

const entropy = (value: string): number => {
  const frequencies = new Map<string, number>();
  for (const character of value) frequencies.set(character, (frequencies.get(character) ?? 0) + 1);
  let result = 0;
  for (const count of frequencies.values()) {
    const probability = count / value.length;
    result -= probability * Math.log2(probability);
  }
  return result;
};

const isContextualEntropyValue = (value: string): boolean => {
  if (value.length < 20) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/]
    .filter((pattern) => pattern.test(value)).length;
  return classes >= 3 && entropy(value) >= 3.5;
};

const detectLine = (path: string, line: string, offset: number, spans: DetectedSpan[]): void => {
  for (const [provider, pattern] of providerTokenPatterns) {
    eachMatch(pattern, line, (match) => spans.push(forced("provider-token", "api_token", path, offset + match.index, offset + match.index + match[0].length)));
  }
  eachMatch(bearer, line, (match) => {
    const value = match[1]!;
    spans.push(forced("authorization-bearer", "authorization", path, offset + match.index + match[0].lastIndexOf(value), offset + match.index + match[0].length));
  });
  eachMatch(jwtInAuthContext, line, (match) => {
    const value = match[1]!;
    spans.push(forced("authorization-jwt", "authorization", path, offset + match.index + match[0].lastIndexOf(value), offset + match.index + match[0].length));
  });
  eachMatch(contextualEntropy, line, (match) => {
    const value = match[1]!;
    if (/^\[REDACTED:[A-Z_]+:\d+\]$/.test(value) || !isContextualEntropyValue(value)) return;
    const start = offset + match.index + match[0].lastIndexOf(value);
    spans.push(forced("contextual-entropy", "high_entropy", path, start, start + value.length));
  });
  eachMatch(secretAssignment, line, (match) => {
    const value = match[2]!;
    if (/^\[REDACTED:[A-Z_]+:\d+\]$/.test(value)) return;
    const start = offset + match.index + match[0].lastIndexOf(value);
    spans.push(forced("secret-assignment", "secret_assignment", path, start, start + value.length));
  });
  eachMatch(uriCandidate, line, (match) => {
    try {
      const candidate = match[0];
      const parsed = new URL(candidate);
      if (!parsed.username && !parsed.password) return;
      const userInfoStart = candidate.indexOf("//") + 2;
      const userInfoEnd = candidate.indexOf("@", userInfoStart);
      if (userInfoEnd > userInfoStart) spans.push(forced("credential-uri", "credential_uri", path, offset + match.index + userInfoStart, offset + match.index + userInfoEnd));
    } catch {
      // A syntactically invalid candidate is not a credential URI.
    }
  });
  eachMatch(email, line, (match) => spans.push(defaultRedaction("email", "email", path, offset + match.index, offset + match.index + match[0].length)));
  eachMatch(phone, line, (match) => {
    if (!isWithinCanonicalUuid(line, match.index, match.index + match[0].length)) {
      spans.push(defaultRedaction("phone", "phone", path, offset + match.index, offset + match.index + match[0].length));
    }
  });
  eachMatch(ipv4, line, (match) => spans.push(defaultRedaction("ipv4", "network_address", path, offset + match.index, offset + match.index + match[0].length)));
  eachMatch(ipv6Candidate, line, (match) => {
    if (isIP(match[0]) === 6) spans.push(defaultRedaction("ipv6", "network_address", path, offset + match.index, offset + match.index + match[0].length));
  });
  eachMatch(windowsUserPath, line, (match) => spans.push(defaultRedaction("windows-user-path", "local_user_path", path, offset + match.index, offset + match.index + match[0].length)));
  eachMatch(posixUserPath, line, (match) => spans.push(defaultRedaction("posix-user-path", "local_user_path", path, offset + match.index, offset + match.index + match[0].length)));
};

export const detectText = (path: string, text: string): DetectedSpan[] => {
  const spans: DetectedSpan[] = [];
  eachMatch(privateKeyBlock, text, (match) => spans.push(forced("pem-private-key", "private_key", path, match.index, match.index + match[0].length)));

  let offset = 0;
  for (const line of text.split("\n")) {
    detectLine(path, line, offset, spans);
    offset += line.length + 1;
  }
  return spans;
};
