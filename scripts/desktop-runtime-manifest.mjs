import {
  existsSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";

const normalize = (path) => path.replaceAll("\\", "/");

const isContained = (root, candidate) => {
  const child = relative(root, candidate);
  return child === "" ||
    (!isAbsolute(child) && child !== ".." && !child.startsWith("../") &&
      !child.startsWith("..\\"));
};

const packageDirectoryFor = (packageRoot, parentDirectory, name) => {
  const parts = name.split("/");
  let current = parentDirectory;
  while (isContained(packageRoot, current)) {
    const candidate = join(current, "node_modules", ...parts);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (current === packageRoot) break;
    const next = dirname(current);
    if (next === current) break;
    current = next;
  }
  return undefined;
};

const licenseFilesFor = (packageRoot, packageDirectory) =>
  readdirSync(packageDirectory, { withFileTypes: true })
    .filter((entry) =>
      entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(
        entry.name,
      )
    )
    .map((entry) =>
      normalize(relative(packageRoot, join(packageDirectory, entry.name)))
    )
    .sort();

const licenseName = (metadata) => {
  if (typeof metadata.license === "string" && metadata.license.trim()) {
    return metadata.license.trim();
  }
  if (Array.isArray(metadata.licenses)) {
    const names = metadata.licenses
      .map((entry) => typeof entry === "string" ? entry : entry?.type)
      .filter((entry) => typeof entry === "string" && entry.trim());
    if (names.length > 0) return names.join(" OR ");
  }
  return "SEE PACKAGE";
};

export const createDesktopRuntimeManifest = (
  inputRoot = resolve(dirname(fileURLToPath(import.meta.url)), ".."),
) => {
  const packageRoot = resolve(inputRoot);
  const rootMetadata = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  );
  const queue = Object.keys(rootMetadata.dependencies ?? {})
    .sort()
    .map((name) => ({
      name,
      parentDirectory: packageRoot,
      optional: false,
    }));
  const packagesByDirectory = new Map();

  while (queue.length > 0) {
    const requested = queue.shift();
    const packageDirectory = packageDirectoryFor(
      packageRoot,
      requested.parentDirectory,
      requested.name,
    );
    if (!packageDirectory) {
      if (requested.optional) continue;
      throw new Error(
        `Desktop runtime dependency ${requested.name} is not installed.`,
      );
    }
    const packagePath = normalize(relative(packageRoot, packageDirectory));
    const key = packagePath.toLowerCase();
    if (packagesByDirectory.has(key)) continue;
    const metadata = JSON.parse(
      readFileSync(join(packageDirectory, "package.json"), "utf8"),
    );
    if (
      typeof metadata.name !== "string" ||
      typeof metadata.version !== "string"
    ) {
      throw new Error(
        `Desktop runtime dependency ${requested.name} has malformed metadata.`,
      );
    }
    packagesByDirectory.set(key, {
      name: metadata.name,
      version: metadata.version,
      license: licenseName(metadata),
      packageDirectory: packagePath,
      licenseFiles: licenseFilesFor(packageRoot, packageDirectory),
    });
    const dependencies = Object.keys(metadata.dependencies ?? {}).sort();
    const optionalDependencies = new Set(
      Object.keys(metadata.optionalDependencies ?? {}),
    );
    for (const name of [...new Set([
      ...dependencies,
      ...optionalDependencies,
    ])].sort()) {
      queue.push({
        name,
        parentDirectory: packageDirectory,
        optional: optionalDependencies.has(name),
      });
    }
  }

  return {
    schemaVersion: 1,
    packages: [...packagesByDirectory.values()].sort((left, right) =>
      left.packageDirectory.localeCompare(right.packageDirectory, "en")
    ),
  };
};
