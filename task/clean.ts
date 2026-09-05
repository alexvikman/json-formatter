import { rm } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dir, "..");
const targets = [".build", ".test-dist", "dist"].map((name) => path.join(projectRoot, name));

for (const target of targets) {
  const relativePath = path.relative(projectRoot, target);
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error(`Refusing to remove an unsafe path: ${target}`);
  }
  await rm(target, { recursive: true, force: true });
}

console.log("Removed generated extension files.");
