import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

type CrxPackager = (
  files: string[],
  options: { keyPath: string; crxPath: string; forceDateTime: number }
) => Promise<{ appId: string }>;

interface PackageOptions {
  sourceDirectory: string;
  outputDirectory: string;
  keyPath: string;
  createKey?: boolean;
}

function isWithin(directory: string, target: string): boolean {
  const relative = path.relative(directory, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function resolvePath(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    const parent = path.dirname(target);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === target) {
      throw error;
    }
    return path.join(await resolvePath(parent), path.basename(target));
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name < right.name ? -1 : 1)) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink() || entry.name.startsWith(".") || /\.(?:pem|key|pfx|p12|[cm]?tsx?|map)$/i.test(entry.name)) {
      throw new Error(`Refusing to package a private, source, or linked file: ${file}`);
    }
    if (entry.isDirectory()) {
      files.push(...await collectFiles(file));
    } else if (entry.isFile()) {
      files.push(file);
    } else {
      throw new Error(`Refusing to package a non-regular file: ${file}`);
    }
  }
  return files;
}

async function loadSigningKey(keyPath: string, outputDirectory: string, createKey: boolean) {
  let pem: string;
  let created = false;
  try {
    pem = await readFile(keyPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    if (!createKey || (await readdir(outputDirectory)).some((name) => name.endsWith(".crx"))) {
      throw new Error(`Signing key is missing: ${keyPath}. Restore the original key; a new key changes the extension ID.`);
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    await mkdir(path.dirname(keyPath), { recursive: true, mode: 0o700 });
    // Never overwrite a key, even when two first-time package commands race.
    await writeFile(keyPath, pem, { flag: "wx", mode: 0o600 });
    created = true;
  }

  let key;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new Error(`Invalid signing key: ${keyPath}. Expected an unencrypted RSA private key in PEM format.`);
  }
  if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) {
    throw new Error("The signing key must be an RSA private key of at least 2048 bits.");
  }
  const publicKey = createPublicKey(key).export({ type: "spki", format: "der" });
  const extensionId = createHash("sha256").update(publicKey).digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, (digit) => String.fromCharCode(97 + parseInt(digit, 16)));
  return { extensionId, created };
}

export async function packageExtension(options: PackageOptions) {
  const sourceDirectory = await realpath(options.sourceDirectory);
  const outputDirectory = await resolvePath(path.resolve(options.outputDirectory));
  const keyPath = await resolvePath(path.resolve(options.keyPath));
  if (isWithin(sourceDirectory, outputDirectory) || isWithin(outputDirectory, sourceDirectory)
    || isWithin(sourceDirectory, keyPath) || isWithin(outputDirectory, keyPath)) {
    throw new Error("The signing key and release directory must be separate from the extension files and each other.");
  }
  const manifest = JSON.parse(await readFile(path.join(sourceDirectory, "manifest.json"), "utf8"));
  const version: unknown = manifest.version;
  if (manifest.manifest_version !== 3 || typeof version !== "string" || !/^\d+(?:\.\d+){0,3}$/.test(version)) {
    throw new Error("Packaging requires a Manifest V3 extension with a numeric version.");
  }
  if (manifest.version_name === "Development build") {
    throw new Error("Run pnpm run package to build a production release before packaging.");
  }
  const files = await collectFiles(sourceDirectory);
  // crx3 is CommonJS and has no TypeScript declarations.
  const packagerName = "crx3";
  const packager = await import(packagerName);
  const createCrx = (packager.default ?? packager) as CrxPackager;
  await mkdir(outputDirectory, { recursive: true });
  const signing = await loadSigningKey(keyPath, outputDirectory, options.createKey === true);
  const fileName = `json-formatter-${version}`;
  const crxPath = path.join(outputDirectory, `${fileName}.crx`);
  const zipPath = path.join(outputDirectory, `${fileName}.zip`);
  const staging = await mkdtemp(path.join(outputDirectory, ".package-"));

  try {
    const stagedCrx = path.join(staging, `${fileName}.crx`);
    const result = await createCrx(files, {
      keyPath,
      crxPath: stagedCrx,
      forceDateTime: Date.UTC(2000, 0, 1)
    });
    if (result.appId !== signing.extensionId) {
      throw new Error("The package was not signed with the expected key.");
    }
    const crx = await readFile(stagedCrx);
    if (crx.length < 12 || crx.toString("ascii", 0, 4) !== "Cr24" || crx.readUInt32LE(4) !== 3) {
      throw new Error("The packager did not produce a CRX3 file.");
    }
    const zipStart = 12 + crx.readUInt32LE(8);
    if (zipStart + 4 > crx.length || crx.readUInt32LE(zipStart) !== 0x04034b50) {
      throw new Error("The CRX3 package does not contain a ZIP archive.");
    }
    // Publish the exact archive that was signed, with manifest.json at its root.
    const stagedZip = path.join(staging, `${fileName}.zip`);
    await writeFile(stagedZip, crx.subarray(zipStart));
    await rename(stagedZip, zipPath);
    await rename(stagedCrx, crxPath);
  } finally {
    if (staging === outputDirectory || !isWithin(outputDirectory, staging)) {
      throw new Error(`Refusing to remove an unsafe staging directory: ${staging}`);
    }
    await rm(staging, { recursive: true, force: true });
  }
  return { crxPath, zipPath, keyPath, extensionId: signing.extensionId, createdKey: signing.created };
}
