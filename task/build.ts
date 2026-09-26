import { createHash } from "node:crypto";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";
import { findNodeExecutable, runTypechecks } from "./typecheck";

interface BuildOptions {
  development?: boolean;
}

interface ManifestContentScript {
  css?: string[];
  js?: string[];
}

interface ExtensionManifest {
  manifest_version?: number;
  name?: string;
  version_name?: string;
  options_page?: string;
  icons?: Record<string, string>;
  action?: {
    default_icon?: Record<string, string>;
  };
  background?: {
    service_worker?: string;
  };
  content_scripts?: ManifestContentScript[];
}

interface OutputFile {
  absolutePath: string;
  relativePath: string;
  size: number;
}

const projectRoot = path.resolve(import.meta.dir, "..");
const sourceRoot = path.join(projectRoot, "src");
const scriptsRoot = path.join(sourceRoot, "scripts");
const buildRoot = path.join(projectRoot, ".build");
const stageRoot = path.join(buildRoot, "extension");
const distRoot = path.join(projectRoot, "dist");
const tailwindCli = path.join(
  projectRoot,
  "node_modules",
  "@tailwindcss",
  "cli",
  "dist",
  "index.mjs"
);

const scriptEntries = [
  "background.ts",
  "theme.ts",
  "json-renderer.ts",
  "page-formatter.ts",
  "formatter.ts",
  "options.ts"
].map((fileName) => path.join(scriptsRoot, fileName));

const styleEntries = ["formatter.css", "options.css", "page.css"];
const staticFiles = ["manifest.json", "formatter.html", "options.html"];

function assertProjectPath(targetPath: string): void {
  const relativePath = path.relative(projectRoot, path.resolve(targetPath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to modify a path outside the project: ${targetPath}`);
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function runCommand(command: string[], label: string): Promise<void> {
  const child = Bun.spawn({
    cmd: command,
    cwd: projectRoot,
    env: process.env,
    stdout: "inherit",
    stderr: "inherit"
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} failed with exit code ${exitCode}`);
  }
}

async function bundleScripts(development: boolean): Promise<void> {
  const outputDirectory = path.join(stageRoot, "scripts");
  await mkdir(outputDirectory, { recursive: true });
  const result = await Bun.build({
    entrypoints: scriptEntries,
    root: scriptsRoot,
    outdir: outputDirectory,
    target: "browser",
    format: "iife",
    minify: !development,
    sourcemap: development ? "linked" : "none",
    naming: "[name].[ext]"
  });

  if (!result.success) {
    const details = result.logs.map((message) => String(message)).join("\n");
    throw new Error(`Bun could not bundle the extension scripts.\n${details}`);
  }
}

async function compileStyles(development: boolean): Promise<void> {
  const outputDirectory = path.join(stageRoot, "styles");
  const nodeExecutable = findNodeExecutable();
  await mkdir(outputDirectory, { recursive: true });

  for (const fileName of styleEntries) {
    const command = [
      nodeExecutable,
      tailwindCli,
      "-i",
      path.join(sourceRoot, "styles", fileName),
      "-o",
      path.join(outputDirectory, fileName)
    ];
    if (!development) {
      command.push("--minify");
    }
    await runCommand(command, `Tailwind compilation for ${fileName}`);
  }
}

async function copyStaticFiles(development: boolean): Promise<void> {
  for (const fileName of staticFiles) {
    await cp(path.join(sourceRoot, fileName), path.join(stageRoot, fileName));
  }
  await cp(path.join(projectRoot, "LICENSE"), path.join(stageRoot, "LICENSE"));

  const assetsDirectory = path.join(sourceRoot, "assets");
  if (await pathExists(assetsDirectory)) {
    await cp(assetsDirectory, path.join(stageRoot, "assets"), { recursive: true });
  }

  if (development) {
    const manifestPath = path.join(stageRoot, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExtensionManifest;
    manifest.name = `${manifest.name ?? "JSON Formatter"} (Development)`;
    manifest.version_name = "Development build";
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
}

async function collectOutputFiles(directory: string): Promise<OutputFile[]> {
  const files: OutputFile[] = [];

  async function visit(currentDirectory: string): Promise<void> {
    const entries = await readdir(currentDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentDirectory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const fileStats = await stat(absolutePath);
      files.push({
        absolutePath,
        relativePath: path.relative(directory, absolutePath).replaceAll(path.sep, "/"),
        size: fileStats.size
      });
    }
  }

  await visit(directory);
  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function validateOutput(): Promise<void> {
  const manifestPath = path.join(stageRoot, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ExtensionManifest;
  if (manifest.manifest_version !== 3) {
    throw new Error("The built manifest must use Manifest V3.");
  }

  const referencedFiles = new Set<string>([...staticFiles, "LICENSE"]);
  for (const fileName of [
    ...Object.values(manifest.icons ?? {}),
    ...Object.values(manifest.action?.default_icon ?? {})
  ]) {
    referencedFiles.add(fileName);
  }
  if (manifest.options_page) {
    referencedFiles.add(manifest.options_page);
  }
  if (manifest.background?.service_worker) {
    referencedFiles.add(manifest.background.service_worker);
  }
  for (const contentScript of manifest.content_scripts ?? []) {
    for (const fileName of [...(contentScript.css ?? []), ...(contentScript.js ?? [])]) {
      referencedFiles.add(fileName);
    }
  }

  for (const htmlName of [...referencedFiles].filter((fileName) => fileName.endsWith(".html"))) {
    const html = await readFile(path.join(stageRoot, htmlName), "utf8");
    for (const match of html.matchAll(/(?:href|src)="([^"#]+)"/g)) {
      const reference = match[1];
      if (!reference.includes("://")) {
        referencedFiles.add(reference);
      }
    }
  }

  for (const fileName of referencedFiles) {
    if (!(await pathExists(path.join(stageRoot, fileName)))) {
      throw new Error(`The built extension references a missing file: ${fileName}`);
    }
  }

  const files = await collectOutputFiles(stageRoot);
  const sourceFile = files.find((file) => /\.(?:ts|tsx)$/.test(file.relativePath));
  if (sourceFile) {
    throw new Error(`TypeScript source leaked into dist: ${sourceFile.relativePath}`);
  }

  const pageCss = await readFile(path.join(stageRoot, "styles", "page.css"), "utf8");
  if (pageCss.includes(":root")) {
    throw new Error("The response-page stylesheet contains an unscoped :root selector.");
  }
  const cssWithoutBanner = pageCss.replace(/^\/\*![\s\S]*?\*\//, "");
  const leakedUtility = cssWithoutBanner.match(
    /(?:^|[{}])\s*\.(?!jf-)[A-Za-z_][A-Za-z0-9_-]*(?=\s*[,{}])/
  );
  if (leakedUtility) {
    throw new Error(`An unscoped utility leaked into the response-page stylesheet: ${leakedUtility[0].trim()}`);
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  return `${(bytes / 1024).toFixed(1)} kB`;
}

async function reportOutput(): Promise<void> {
  const files = await collectOutputFiles(distRoot);
  const longestName = Math.max(...files.map((file) => file.relativePath.length));
  const hash = createHash("sha256");
  let totalSize = 0;

  console.log("\nExtension output");
  for (const file of files) {
    const contents = await readFile(file.absolutePath);
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(contents);
    totalSize += file.size;
    console.log(`  ${file.relativePath.padEnd(longestName)}  ${formatBytes(file.size)}`);
  }
  console.log(`  ${"Total".padEnd(longestName)}  ${formatBytes(totalSize)}`);
  console.log(`  SHA-256${" ".repeat(Math.max(1, longestName - 6))}  ${hash.digest("hex")}`);
}

export async function buildExtension(options: BuildOptions = {}): Promise<void> {
  const development = options.development === true;
  const startedAt = performance.now();
  assertProjectPath(buildRoot);
  assertProjectPath(distRoot);

  await runTypechecks();
  await rm(buildRoot, { recursive: true, force: true });
  await mkdir(stageRoot, { recursive: true });

  try {
    await Promise.all([
      bundleScripts(development),
      compileStyles(development),
      copyStaticFiles(development)
    ]);
    await validateOutput();
    await rm(distRoot, { recursive: true, force: true });
    await rename(stageRoot, distRoot);
  } finally {
    await rm(buildRoot, { recursive: true, force: true });
  }

  await reportOutput();
  console.log(`\n${development ? "Development" : "Production"} build completed in ${Math.round(performance.now() - startedAt)} ms.`);
}

if (import.meta.main) {
  buildExtension({ development: process.argv.includes("--dev") }).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
