import { watch, type FSWatcher } from "node:fs";
import path from "node:path";
import { buildExtension } from "./build";

const projectRoot = path.resolve(import.meta.dir, "..");
const watchedDirectories = ["src", "task", "tests"];
const watchedFiles = [
  "LICENSE",
  "package.json",
  "tsconfig.json",
  "tsconfig.tasks.json",
  "tsconfig.tests.json"
];

let building = false;
let rebuildQueued = false;
let debounceTimer: Timer | undefined;

async function rebuild(): Promise<void> {
  if (building) {
    rebuildQueued = true;
    return;
  }

  building = true;
  try {
    await buildExtension({ development: true });
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
  } finally {
    building = false;
    if (rebuildQueued) {
      rebuildQueued = false;
      await rebuild();
    }
  }
}

function scheduleRebuild(): void {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => void rebuild(), 120);
}

function startWatchers(): FSWatcher[] {
  const watchers = watchedDirectories.map((directory) => {
    return watch(path.join(projectRoot, directory), { recursive: true }, scheduleRebuild);
  });
  for (const fileName of watchedFiles) {
    watchers.push(watch(path.join(projectRoot, fileName), scheduleRebuild));
  }
  return watchers;
}

await rebuild();
const watchers = startWatchers();
console.log("Watching TypeScript, Tailwind CSS, tests, and extension assets. Press Ctrl+C to stop.");

function stop(): void {
  watchers.forEach((watcher) => watcher.close());
  process.exit(0);
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
await new Promise(() => undefined);
