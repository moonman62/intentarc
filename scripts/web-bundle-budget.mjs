import { lstat, readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_MAXIMUM_JAVASCRIPT_CHUNK_BYTES = 500 * 1024;

const compareCodePoints = (left, right) => left < right ? -1 : left > right ? 1 : 0;

class WebBundleBudgetError extends Error {
  constructor(category, message) {
    super(message);
    this.category = category;
  }
}

class UnsupportedWebBundleEntryError extends WebBundleBudgetError {
  constructor() {
    super(
      "unsupported-entry",
      "IntentArc web bundle output contains an unsupported entry.",
    );
  }
}

class WebBundleOutputUnavailableError extends WebBundleBudgetError {
  constructor() {
    super(
      "output-unavailable",
      "IntentArc web bundle output is unavailable.",
    );
  }
}

class NoJavaScriptChunksError extends WebBundleBudgetError {
  constructor() {
    super(
      "no-javascript-chunks",
      "IntentArc web bundle output contains no JavaScript chunks.",
    );
  }
}

class WebBundleBudgetExceededError extends WebBundleBudgetError {
  constructor() {
    super("budget-exceeded", "IntentArc web chunk budget exceeded.");
  }
}

const listJavaScriptChunks = async (directory) => {
  const entries = await readdir(directory, { withFileTypes: true });
  const chunks = [];

  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new UnsupportedWebBundleEntryError();
    } else if (entry.isDirectory()) {
      chunks.push(...await listJavaScriptChunks(path));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      chunks.push({
        file: basename(entry.name),
        bytes: (await stat(path)).size,
      });
    } else if (!entry.isFile()) {
      throw new UnsupportedWebBundleEntryError();
    }
  }

  return chunks;
};

const validateOutputRoot = async (outputDirectory, trustedRoot) => {
  const absoluteOutputDirectory = resolve(outputDirectory);
  const absoluteTrustedRoot = resolve(trustedRoot);
  const relativeOutputDirectory = relative(
    absoluteTrustedRoot,
    absoluteOutputDirectory,
  );
  if (
    relativeOutputDirectory === ".." ||
    relativeOutputDirectory.startsWith(`..${sep}`) ||
    isAbsolute(relativeOutputDirectory)
  ) {
    throw new UnsupportedWebBundleEntryError();
  }

  const components = relativeOutputDirectory.split(sep).filter(Boolean);
  let current = absoluteTrustedRoot;
  let currentStats = await stat(current);

  for (const component of components) {
    current = join(current, component);
    currentStats = await lstat(current);
    if (currentStats.isSymbolicLink()) {
      throw new UnsupportedWebBundleEntryError();
    }
  }

  if (!currentStats.isDirectory()) {
    throw new WebBundleOutputUnavailableError();
  }
  return absoluteOutputDirectory;
};

const readWebBundleMetrics = async (
  outputDirectory,
  trustedRoot = dirname(resolve(outputDirectory)),
) => {
  let chunks;
  try {
    const validatedOutputDirectory = await validateOutputRoot(
      outputDirectory,
      trustedRoot,
    );
    chunks = await listJavaScriptChunks(validatedOutputDirectory);
  } catch (error) {
    if (error instanceof WebBundleBudgetError) throw error;
    throw new WebBundleOutputUnavailableError();
  }

  chunks.sort((left, right) =>
    compareCodePoints(left.file, right.file) || left.bytes - right.bytes
  );
  if (chunks.length === 0) {
    throw new NoJavaScriptChunksError();
  }

  const largest = chunks.reduce((current, chunk) =>
    chunk.bytes > current.bytes ? chunk : current
  );
  return {
    largestChunk: largest.file,
    largestChunkBytes: largest.bytes,
    chunks,
  };
};

const enforceWebBundleBudget = (metrics, maximumJavaScriptChunkBytes) => {
  if (metrics.largestChunkBytes > maximumJavaScriptChunkBytes) {
    throw new WebBundleBudgetExceededError();
  }
};

export const assertWebBundleBudget = async ({
  outputDirectory,
  maximumJavaScriptChunkBytes = DEFAULT_MAXIMUM_JAVASCRIPT_CHUNK_BYTES,
  trustedRoot = dirname(resolve(outputDirectory)),
}) => {
  const metrics = await readWebBundleMetrics(outputDirectory, trustedRoot);
  enforceWebBundleBudget(metrics, maximumJavaScriptChunkBytes);
  return metrics;
};

const isDirectExecution = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isDirectExecution) {
  let metrics = null;
  try {
    metrics = await readWebBundleMetrics(
      resolve("dist", "web-client"),
      process.cwd(),
    );
    enforceWebBundleBudget(metrics, DEFAULT_MAXIMUM_JAVASCRIPT_CHUNK_BYTES);
    process.stdout.write(`${JSON.stringify({
      status: "pass",
      category: null,
      ...metrics,
    })}\n`);
  } catch (error) {
    const failure = error instanceof WebBundleBudgetError
      ? error
      : new WebBundleBudgetError(
          "budget-check-failed",
          "IntentArc web bundle budget failed.",
        );
    process.stdout.write(`${JSON.stringify({
      status: "fail",
      category: failure.category,
      largestChunk: metrics?.largestChunk ?? null,
      largestChunkBytes: metrics?.largestChunkBytes ?? null,
      chunks: metrics?.chunks ?? [],
    })}\n`);
    process.stderr.write(`${failure.message}\n`);
    process.exitCode = 1;
  }
}
