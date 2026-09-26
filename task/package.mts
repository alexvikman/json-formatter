import path from "node:path";
import { packageExtension } from "./pack-extension.ts";

const projectRoot = path.resolve(import.meta.dirname, "..");
const suppliedKey = process.env.JF_SIGNING_KEY_PATH;

try {
  const result = await packageExtension({
    sourceDirectory: path.join(projectRoot, "dist"),
    outputDirectory: path.join(projectRoot, "release"),
    keyPath: suppliedKey ? path.resolve(projectRoot, suppliedKey) : path.join(projectRoot, ".keys", "json-formatter.pem"),
    createKey: !suppliedKey && !process.env.CI
  });
  console.log(`\nCRX: ${result.crxPath}`);
  console.log(`ZIP: ${result.zipPath}`);
  console.log(`Extension ID: ${result.extensionId}`);
  console.log(`Signing key: ${result.keyPath}`);
  if (result.createdKey) {
    console.log("A new signing key was created. Back it up privately and keep using it for future releases.");
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
