import { createHash } from "node:crypto";
import { packageVersion } from "./version.js";

export interface BridgeBuildIdentity {
  readonly formatVersion: 1;
  readonly releaseVersion: string;
  readonly buildMode: "signed-release" | "unsigned-development";
  readonly supportSha256: string;
}

export interface BridgeAuthorizedPredecessor extends BridgeBuildIdentity {
  readonly formatVersion: 1;
  readonly versionDirectory: string;
  readonly executableSha256: string;
  readonly payloadSha256: string;
  readonly publisher?: {
    readonly thumbprint: string;
    readonly subject: string;
  };
}

// Source and ordinary developer builds are deliberately unsigned-development
// builds. The release build replaces this module with generated, embedded
// identity constants before signing.
export const bridgeBuildIdentity: BridgeBuildIdentity = {
  formatVersion: 1,
  releaseVersion: packageVersion,
  buildMode: "unsigned-development",
  supportSha256: createHash("sha256")
    .update("intentarc-unbundled-development-support")
    .digest("hex"),
};

export const bridgeAuthorizedPredecessor: BridgeAuthorizedPredecessor | null =
  null;
