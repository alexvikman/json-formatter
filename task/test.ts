import { rm } from "node:fs/promises";
import path from "node:path";
import { findNodeExecutable } from "./typecheck";

const projectRoot = path.resolve(import.meta.dir, "..");
const performanceTest = process.argv.includes("--performance");
const outputRoot = path.join(projectRoot, performanceTest ? ".performance-test-dist" : ".test-dist");
const testFile = performanceTest ? "render-performance.test.js" : "json-formatter.test.js";
const typescriptCli = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

async function run(command: string[], label: string): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: projectRoot,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}.`);
  }
}

const nodeExecutable = findNodeExecutable();
await rm(outputRoot, { recursive: true, force: true });

try {
  await run([
    nodeExecutable,
    typescriptCli,
    "-p",
    "tsconfig.tests.json",
    "--noEmit",
    "false",
    "--outDir",
    outputRoot
  ], "Test compilation");
  await run([
    nodeExecutable,
    path.join(outputRoot, "tests", testFile)
  ], performanceTest ? "Rendering performance test" : "Browser-level tests");
} finally {
  await rm(outputRoot, { recursive: true, force: true });
}
