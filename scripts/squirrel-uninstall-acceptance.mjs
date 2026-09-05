import { createReadStream } from "node:fs";
import { access, lstat, readdir, readlink, rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const APP_VERSION_DIRECTORY =
  "app-\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?";
const acceptedResiduePatterns = [
  /^\.dead$/,
  /^Update\.exe$/,
  new RegExp(`^${APP_VERSION_DIRECTORY}/$`),
  new RegExp(`^${APP_VERSION_DIRECTORY}/squirrel\\.exe$`),
  new RegExp(`^${APP_VERSION_DIRECTORY}/v8_context_snapshot\\.bin$`),
];

const normalizeRelativePath = (path) => path.replaceAll("\\", "/");

const isSafeRelativePath = (path) => {
  if (!path || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
  const value = path.endsWith("/") ? path.slice(0, -1) : path;
  const parts = value.split("/");
  return !parts.some((part) => part === "" || part === "." || part === "..");
};

export const classifySquirrelUninstallResidue = (paths) => {
  const accepted = [];
  const unexpected = [];
  for (const inputPath of paths) {
    const path = normalizeRelativePath(String(inputPath));
    if (
      isSafeRelativePath(path) &&
      acceptedResiduePatterns.some((pattern) => pattern.test(path))
    ) {
      accepted.push(path);
    } else {
      unexpected.push(path);
    }
  }
  return { accepted, unexpected };
};

export const assertInstallerAcceptancePreflight = ({
  platform,
  optIn,
  setupExists,
  installRootExists = false,
  uninstallRegistered = false,
  existingShortcuts = [],
}) => {
  if (platform !== "win32") {
    throw new Error("The real installer acceptance test requires Windows.");
  }
  if (optIn !== "1") {
    throw new Error(
      "The real installer acceptance test requires INTENTARC_RUN_INSTALLER_E2E=1 opt-in.",
    );
  }
  if (!setupExists) {
    throw new Error("The IntentArc installer acceptance setup artifact is missing.");
  }
  if (installRootExists) {
    throw new Error(
      "The installer acceptance test refuses a pre-existing IntentArc install root.",
    );
  }
  if (uninstallRegistered) {
    throw new Error(
      "The installer acceptance test refuses a pre-existing IntentArc uninstall registration.",
    );
  }
  if (existingShortcuts.length > 0) {
    throw new Error(
      `The installer acceptance test refuses pre-existing IntentArc shortcuts: ${existingShortcuts.join(", ")}`,
    );
  }
};

export const parseQuietUninstallCommand = (command, installRoot) => {
  const executablePath = win32.join(installRoot, "Update.exe");
  const suffix = " --uninstall -s";
  const trimmed = String(command).trim();
  if (!trimmed.endsWith(suffix)) {
    throw new Error("Unsafe Squirrel quiet uninstall registration.");
  }
  let registeredExecutable = trimmed.slice(0, -suffix.length).trim();
  if (registeredExecutable.startsWith("\"") || registeredExecutable.endsWith("\"")) {
    if (
      registeredExecutable.length < 2 ||
      !registeredExecutable.startsWith("\"") ||
      !registeredExecutable.endsWith("\"")
    ) {
      throw new Error("Unsafe Squirrel quiet uninstall registration.");
    }
    registeredExecutable = registeredExecutable.slice(1, -1);
  }
  if (
    win32.normalize(registeredExecutable).toLowerCase() !==
      win32.normalize(executablePath).toLowerCase()
  ) {
    throw new Error("Unsafe Squirrel quiet uninstall registration.");
  }
  return {
    executablePath,
    arguments: ["--uninstall", "-s"],
  };
};

const sha256File = (path) => new Promise((resolveHash, reject) => {
  const hash = createHash("sha256");
  const stream = createReadStream(path);
  stream.on("error", reject);
  stream.on("data", (chunk) => hash.update(chunk));
  stream.on("end", () => resolveHash(hash.digest("hex")));
});

export const createReadOnlyTreeManifest = async (root) => {
  const manifest = [];

  const visit = async (directory, relativeDirectory = "") => {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, entry.name)
        : entry.name;
      const absolutePath = join(directory, entry.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isSymbolicLink()) {
        manifest.push({
          path: relativePath,
          kind: "symbolic-link",
          target: normalizeRelativePath(await readlink(absolutePath)),
        });
      } else if (metadata.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (metadata.isFile()) {
        manifest.push({
          path: relativePath,
          kind: "file",
          size: metadata.size,
          sha256: await sha256File(absolutePath),
        });
      } else {
        manifest.push({
          path: relativePath,
          kind: "other",
          size: metadata.size,
        });
      }
    }
  };

  try {
    await visit(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return manifest;
};

const executeFile = promisify(execFile);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const uninstallRegistryKey =
  "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\IntentArc";

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};

const systemExecutable = (environment, ...parts) => {
  const systemRoot = environment.SystemRoot ?? environment.SYSTEMROOT;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new Error("A valid Windows SystemRoot is required for installer acceptance.");
  }
  return win32.join(systemRoot, "System32", ...parts);
};

export const createWindowsSpecialFoldersScript = () => [
  "$ErrorActionPreference = 'Stop'",
  "$folders = [ordered]@{ localAppData = [Environment]::GetFolderPath('LocalApplicationData'); appData = [Environment]::GetFolderPath('ApplicationData'); desktop = [Environment]::GetFolderPath('DesktopDirectory'); programs = [Environment]::GetFolderPath('Programs') }",
  "$folders | ConvertTo-Json -Compress",
].join("; ");

const readSpecialFolders = async (environment) => {
  const powerShell = systemExecutable(
    environment,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = createWindowsSpecialFoldersScript();
  const { stdout } = await executeFile(powerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], { env: environment, windowsHide: true, maxBuffer: 16 * 1024 });
  const folders = JSON.parse(stdout);
  for (const key of ["localAppData", "appData", "desktop", "programs"]) {
    if (typeof folders[key] !== "string" || !win32.isAbsolute(folders[key])) {
      throw new Error(`Windows returned an invalid ${key} folder.`);
    }
  }
  return folders;
};

const readUninstallRegistration = async (environment) => {
  const registry = systemExecutable(environment, "reg.exe");
  try {
    const { stdout } = await executeFile(registry, [
      "query",
      uninstallRegistryKey,
      "/v",
      "QuietUninstallString",
    ], { env: environment, windowsHide: true, maxBuffer: 16 * 1024 });
    const quietUninstall =
      /^\s*QuietUninstallString\s+REG_SZ\s+(.+?)\s*$/mi.exec(stdout)?.[1];
    if (!quietUninstall) {
      throw new Error(
        "IntentArc uninstall registration is missing QuietUninstallString.",
      );
    }
    return { quietUninstall };
  } catch (error) {
    if (error?.code === 1) return null;
    throw error;
  }
};

const waitFor = async (description, action, timeoutMilliseconds = 60_000) => {
  const deadline = Date.now() + timeoutMilliseconds;
  let lastError;
  while (Date.now() <= deadline) {
    try {
      const result = await action();
      if (result) return result;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out waiting for ${description}.`);
};

const listInstallRootEntries = async (root) => {
  const entries = [];
  const visit = async (directory, relativeDirectory = "") => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const child of children) {
      const relativePath = relativeDirectory
        ? posix.join(relativeDirectory, child.name)
        : child.name;
      const absolutePath = join(directory, child.name);
      const metadata = await lstat(absolutePath);
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        entries.push(`${relativePath}/`);
        await visit(absolutePath, relativePath);
      } else {
        entries.push(relativePath);
      }
    }
  };
  try {
    await visit(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return entries;
};

const readInstalledProcesses = async (installRoot, environment) => {
  const powerShell = systemExecutable(
    environment,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$root = [Environment]::GetEnvironmentVariable('INTENTARC_ACCEPTANCE_INSTALL_ROOT', 'Process')",
    "$matches = @(Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ExecutablePath -and $_.ExecutablePath.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)",
    "} | Select-Object ProcessId, ExecutablePath)",
    "ConvertTo-Json -InputObject $matches -Compress",
  ].join("; ");
  const { stdout } = await executeFile(powerShell, [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ], {
    env: {
      ...environment,
      INTENTARC_ACCEPTANCE_INSTALL_ROOT: `${installRoot}\\`,
    },
    windowsHide: true,
    maxBuffer: 64 * 1024,
  });
  const processes = JSON.parse(stdout || "[]");
  return Array.isArray(processes) ? processes : [processes];
};

const bestEffortUninstall = async (installRoot, environment) => {
  try {
    const registration = await readUninstallRegistration(environment);
    const updater = registration
      ? parseQuietUninstallCommand(registration.quietUninstall, installRoot)
      : {
          executablePath: join(installRoot, "Update.exe"),
          arguments: ["--uninstall", "-s"],
        };
    if (await exists(updater.executablePath)) {
      await executeFile(updater.executablePath, updater.arguments, {
        env: environment,
        windowsHide: true,
        timeout: 120_000,
      });
    }
  } catch {
    // The original acceptance failure remains authoritative.
  }
};

export const runSquirrelUninstallAcceptance = async ({
  environment = process.env,
  platform = process.platform,
  setupPath = environment.INTENTARC_INSTALLER_E2E_SETUP ?? resolve(
    packageRoot,
    "out",
    "make",
    "squirrel.windows",
    "x64",
    "IntentArc Setup.exe",
  ),
} = {}) => {
  const folders = platform === "win32"
    ? await readSpecialFolders(environment)
    : {
        localAppData: "",
        appData: "",
        desktop: "",
        programs: "",
      };
  const installRoot = join(folders.localAppData, "IntentArc");
  const userDataRoot = join(folders.appData, "IntentArc");
  const shortcutPaths = [
    join(folders.desktop, "IntentArc.lnk"),
    join(folders.programs, "IntentArc.lnk"),
  ];
  const [
    setupExists,
    installRootExists,
    registration,
    shortcutExistence,
  ] = await Promise.all([
    exists(setupPath),
    exists(installRoot),
    platform === "win32" ? readUninstallRegistration(environment) : null,
    Promise.all(shortcutPaths.map(async (path) => ({
      path,
      exists: await exists(path),
    }))),
  ]);
  assertInstallerAcceptancePreflight({
    platform,
    optIn: environment.INTENTARC_RUN_INSTALLER_E2E,
    setupExists,
    installRootExists,
    uninstallRegistered: registration !== null,
    existingShortcuts: shortcutExistence
      .filter((entry) => entry.exists)
      .map((entry) => entry.path),
  });

  const userDataBefore = await createReadOnlyTreeManifest(userDataRoot);
  let installationStarted = false;
  try {
    installationStarted = true;
    await executeFile(setupPath, ["--silent"], {
      env: environment,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    });
    const installed = await waitFor("the installed launcher and registration", async () => {
      const currentRegistration = await readUninstallRegistration(environment);
      return await exists(join(installRoot, "IntentArc.exe")) && currentRegistration
        ? currentRegistration
        : null;
    });
    const uninstall = parseQuietUninstallCommand(
      installed.quietUninstall,
      installRoot,
    );
    await executeFile(uninstall.executablePath, uninstall.arguments, {
      env: environment,
      windowsHide: true,
      timeout: 120_000,
      maxBuffer: 64 * 1024,
    });
    await waitFor("the uninstall registration and shortcuts to disappear", async () => {
      const [currentRegistration, currentShortcuts] = await Promise.all([
        readUninstallRegistration(environment),
        Promise.all(shortcutPaths.map(exists)),
      ]);
      return currentRegistration === null && currentShortcuts.every((value) => !value);
    });

    const [processes, residueEntries, userDataAfter] = await Promise.all([
      readInstalledProcesses(installRoot, environment),
      listInstallRootEntries(installRoot),
      createReadOnlyTreeManifest(userDataRoot),
    ]);
    if (processes.length > 0) {
      throw new Error(
        `Installed IntentArc processes remain after uninstall: ${JSON.stringify(processes)}`,
      );
    }
    const residue = classifySquirrelUninstallResidue(residueEntries);
    if (residue.unexpected.length > 0) {
      throw new Error(
        `Unexpected IntentArc uninstall residue: ${residue.unexpected.join(", ")}`,
      );
    }
    if (!isDeepStrictEqual(userDataAfter, userDataBefore)) {
      throw new Error("IntentArc user data changed during installer acceptance.");
    }

    if (await exists(installRoot)) {
      await rm(installRoot, { recursive: true, force: true, maxRetries: 5 });
    }
    if (await exists(installRoot)) {
      throw new Error("Permitted Squirrel tombstone residue could not be removed.");
    }
    const result = {
      setupPath,
      installRoot,
      userDataRoot,
      userDataEntries: userDataBefore.length,
      acceptedResidue: residue.accepted,
      unexpectedResidue: residue.unexpected,
      installedProcesses: processes,
      registrationRemoved: true,
      shortcutsRemoved: shortcutPaths,
      userDataUnchanged: true,
      permittedResidueRemoved: true,
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return result;
  } catch (error) {
    if (installationStarted) await bestEffortUninstall(installRoot, environment);
    throw error;
  }
};

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runSquirrelUninstallAcceptance();
}
