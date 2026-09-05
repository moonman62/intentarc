import { createRequire } from "node:module";

type PackageManifest = {
  version: string;
};

const packageManifest = createRequire(import.meta.url)(
  "../../package.json",
) as PackageManifest;

export const packageVersion = packageManifest.version;
export const protocolVersion = 1;

export function formatVersion(packageVersion: string): string {
  return `intentarc ${packageVersion}`;
}
