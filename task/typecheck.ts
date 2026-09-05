import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const configFiles = [
  "tsconfig.json",
  "tsconfig.tasks.json",
  "tsconfig.tests.json"
];
const typescriptCli = path.join(projectRoot, "node_modules", "typescript", "bin", "tsc");

export function findNodeExecutable(): string {
  const executable = process.env.JF_NODE_EXECUTABLE ??
    process.env.npm_node_execpath ??
    Bun.which("node");
  if (!executable) {
    throw new Error("Node.js is required to run TypeScript and Tailwind CSS.");
  }
  return executable;
}

export async function runTypechecks(): Promise<void> {
  const nodeExecutable = findNodeExecutable();
  for (const configName of configFiles) {
    const child = Bun.spawn({
      cmd: [nodeExecutable, typescriptCli, "-p", configName, "--pretty"],
      cwd: projectRoot,
      env: process.env,
      stdout: "inherit",
      stderr: "inherit"
    });
    const exitCode = await child.exited;
    if (exitCode !== 0) {
      throw new Error(`TypeScript validation failed for ${configName}.`);
    }
  }
  console.log(`TypeScript: ${configFiles.length} projects passed`);
}

if (import.meta.main) {
  runTypechecks().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
