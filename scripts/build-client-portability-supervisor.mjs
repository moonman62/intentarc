import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

export const buildClientPortabilitySupervisor = async ({
  outputFile = resolve("dist/test-support/client-portability-session-supervisor.mjs"),
} = {}) => build({
  entryPoints: [resolve("src/desktop/e2e/client-portability-session-supervisor.ts")],
  outfile: outputFile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  sourcemap: false,
  legalComments: "none",
  logLevel: "silent",
  banner: {
    js: 'import { createRequire as __intentarcCreateRequire } from "node:module"; const require = __intentarcCreateRequire(import.meta.url);',
  },
});

const isDirect = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isDirect) {
  const output = resolve(
    process.argv[2] ?? "dist/test-support/client-portability-session-supervisor.mjs",
  );
  try {
    await buildClientPortabilitySupervisor({ outputFile: output });
    const bytes = (await stat(output)).size;
    process.stdout.write(`${JSON.stringify({ status: "closed", output, bytes })}\n`);
  } catch {
    process.stdout.write(`${JSON.stringify({ status: "failed", output, bytes: 0 })}\n`);
    process.exitCode = 1;
  }
}
