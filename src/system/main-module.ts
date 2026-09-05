import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

type CanonicalizePath = (path: string) => string;

export const isMainModule = (
  argumentPath: string | undefined,
  moduleUrl: string,
  canonicalizePath: CanonicalizePath = realpathSync.native,
): boolean => {
  if (!argumentPath) {
    return false;
  }

  const resolvedArgumentPath = resolve(argumentPath);
  const modulePath = fileURLToPath(moduleUrl);

  try {
    return (
      canonicalizePath(resolvedArgumentPath) === canonicalizePath(modulePath)
    );
  } catch {
    return resolvedArgumentPath === modulePath;
  }
};
