import { realpathSync } from "node:fs";
import { win32 } from "node:path";

const OS_ROOTED_WINDOWS_POWERSHELL =
  "\\\\?\\GLOBALROOT\\SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
const SELECTOR_ENVIRONMENT_KEYS = new Set([
  "comspec",
  "path",
  "psmodulepath",
  "systemroot",
  "windir",
]);

/**
 * @param {(path: string) => string} [resolveNative]
 * @returns {string}
 */
export const resolveOsRootedWindowsPowerShellPath = (
  resolveNative = realpathSync.native,
) => {
  const resolved = resolveNative(OS_ROOTED_WINDOWS_POWERSHELL);
  if (
    !win32.isAbsolute(resolved) ||
    win32.basename(resolved).toLowerCase() !== "powershell.exe" ||
    win32.basename(win32.dirname(resolved)).toLowerCase() !== "v1.0" ||
    win32.basename(win32.dirname(win32.dirname(resolved))).toLowerCase() !==
      "windowspowershell" ||
    win32.basename(
      win32.dirname(win32.dirname(win32.dirname(resolved))),
    ).toLowerCase() !== "system32"
  ) {
    throw new Error("IntentArc cannot resolve the OS-rooted Windows helper.");
  }
  return resolved;
};

/**
 * @param {Record<string, string | undefined>} environment
 * @param {(path: string) => string} [resolveNative]
 * @returns {{
 *   executablePath: string;
 *   environment: Record<string, string | undefined>;
 * }}
 */
export const resolveWindowsPowerShellInvocation = (
  environment,
  resolveNative = realpathSync.native,
) => {
  const executablePath = resolveOsRootedWindowsPowerShellPath(resolveNative);
  const systemRoot = win32.dirname(
    win32.dirname(win32.dirname(win32.dirname(executablePath))),
  );
  return {
    executablePath,
    environment: {
      ...Object.fromEntries(
        Object.entries(environment).filter(([key]) =>
          !SELECTOR_ENVIRONMENT_KEYS.has(key.toLowerCase())
        ),
      ),
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
    },
  };
};
