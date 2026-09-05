import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { cpus, platform, release, totalmem } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Page } from "playwright-core";
import { verifyRawInteractions, type RawInteractions } from "./raw-view.test";

const sourceUrl = "https://microsoftedge.github.io/Demos/json-dummy-data/64KB.json";
const targetBytes = 5_000_000;
const projectRoot = process.cwd();
const extensionRoot = join(projectRoot, "dist");
const outputRoot = join(projectRoot, ".performance");
const fixtureRoot = join(projectRoot, "tests", "fixtures");
const runCount = positiveNumber("JF_PERFORMANCE_RUNS", 3)!;
const maxFrameMs = positiveNumber("JF_PERFORMANCE_MAX_MS", 2_000);
assert(Number.isInteger(runCount), "JF_PERFORMANCE_RUNS must be an integer.");

type Mode = "response-page" | "formatter-tab";
interface TreeCounts {
  lines: number;
  containers: number;
}
interface Sample extends RawInteractions {
  mode: Mode;
  iteration: number;
  synchronousMs: number;
  frameReadyMs: number;
  rawFrameReadyMs: number;
  layoutMs: number;
  styleMs: number;
  treeLines: number;
  containers: number;
  domElements: number;
}

function positiveNumber(name: string, fallback: number | undefined): number | undefined {
  const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
  if (value !== undefined) {
    assert(Number.isFinite(value) && value > 0, `${name} must be a positive number.`);
  }
  return value;
}

function sha256(contents: string | Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function countTree(value: JsonValue): TreeCounts {
  if (value === null || typeof value !== "object") {
    return { lines: 1, containers: 0 };
  }
  const children = Object.values(value);
  if (children.length === 0) {
    return { lines: 1, containers: 0 };
  }
  return children.reduce<TreeCounts>((total, child) => {
    const counts = countTree(child);
    return { lines: total.lines + counts.lines, containers: total.containers + counts.containers };
  }, { lines: 2, containers: 1 });
}

async function readFixture() {
  await mkdir(outputRoot, { recursive: true });
  const source = await readFile(join(fixtureRoot, "microsoft-64KB.json"));
  const payload = await readFile(join(fixtureRoot, "microsoft-5MB.json"), "utf8");
  assert.equal(sha256(source), "cde3fa1e4696435fb274304f710742f67bc4b810fd7ee850543d162f3e10aa70");
  assert.equal(sha256(payload), "2af6b1174a6a1ab3de6cffabd675f7a07d485a26bf2058cecf26345226221bc6");
  const records: JsonValue = JSON.parse(payload);
  assert(Array.isArray(records) && records.length > 0, "The sample must be a nonempty array.");
  const expected = countTree(records);
  const normalized = JSON.stringify(records);
  const paddingBytes = targetBytes - Buffer.byteLength(normalized);
  assert.equal(Buffer.byteLength(payload), targetBytes);
  console.log("Using the fixed project fixture; no downloads or data generation.");
  return {
    payload, normalized, expected,
    metadata: {
      sourceUrl, sourceBytes: source.length, sourceSha256: sha256(source),
      bytes: targetBytes, sha256: sha256(payload), records: records.length,
      sourceRecords: JSON.parse(source.toString("utf8")).length, paddingBytes, expected
    }
  };
}

async function waitForFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

async function validateResult(page: Page, fixture: Awaited<ReturnType<typeof readFixture>>) {
  const actual = await page.evaluate(() => {
    const tree = document.querySelector<HTMLElement>(".jf-tree");
    if (!tree) {
      throw new Error("The formatter did not create the Tree view.");
    }
    return {
      lines: tree.querySelectorAll(".jf-line").length,
      containers: tree.querySelectorAll(".jf-container-node").length,
      collapsed: tree.querySelectorAll(".is-collapsed").length,
      unexpanded: tree.querySelectorAll('.jf-toggle:not([aria-expanded="true"])').length,
      visible: tree.getBoundingClientRect().height > 0,
      strings: tree.querySelectorAll(".jf-string").length,
      numbers: tree.querySelectorAll(".jf-number").length,
      domElements: document.getElementsByTagName("*").length
    };
  });
  assert.equal(actual.lines, fixture.expected.lines, "The whole tree must be rendered.");
  assert.equal(actual.containers, fixture.expected.containers);
  assert.equal(actual.collapsed, 0, "Every object and array must be expanded.");
  assert.equal(actual.unexpanded, 0);
  assert.equal(actual.visible, true);
  assert(actual.strings > 0 && actual.numbers > 0, "Syntax highlighting must be present.");
  return actual;
}

async function validateRaw(page: Page, normalized: string): Promise<number> {
  const rawFrameReadyMs = await page.evaluate(async () => {
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
      .find((candidate) => candidate.textContent === "Raw");
    if (!button) {
      throw new Error("The Raw view button is missing.");
    }
    const startedAt = performance.now();
    button.click();
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
    return performance.now() - startedAt;
  });
  assert.equal(await page.locator(".jf-raw-code").textContent(), normalized);
  assert.equal(await page.locator(".jf-raw-code").isVisible(), true);
  const geometry = await page.locator(".jf-raw-code").evaluate((code) => ({
    width: code.getBoundingClientRect().width,
    viewportWidth: window.innerWidth,
    scrollWidth: code.parentElement!.scrollWidth
  }));
  assert(geometry.width <= geometry.viewportWidth + 2,
    `Raw must wrap to the viewport, not create a ${geometry.width}px-wide line.`);
  assert(geometry.scrollWidth <= geometry.viewportWidth + 2,
    "Raw must not create an enormous horizontal scroll surface.");
  return rawFrameReadyMs;
}

async function validateLargeSelection(page: Page, payload: string): Promise<void> {
  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await page.locator(".jf-tree .jf-line").last().scrollIntoViewIfNeeded();
  const copied = await page.locator(".jf-tree").evaluate((tree) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(tree);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    tree.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
  assert.equal(copied, JSON.stringify(JSON.parse(payload), null, 2),
    "Selecting the 5 MB tree must copy every row, including offscreen chunks.");
}

function summary(samples: Sample[], metric: "synchronousMs" | "frameReadyMs" | "rawFrameReadyMs") {
  const sorted = samples.map((sample) => sample[metric]).sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return {
    median: sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2,
    min: sorted[0], max: sorted[sorted.length - 1]
  };
}

async function run() {
  const fixture = await readFixture();
  console.log(`Fixture: ${targetBytes.toLocaleString("en-US")} bytes, ${fixture.metadata.records} records, ` +
    `${fixture.expected.lines} expanded tree rows.`);
  const formatterSource = await readFile(join(extensionRoot, "scripts", "page-formatter.js"), "utf8");
  const buildFiles = [
    "scripts/background.js", "scripts/theme.js", "scripts/json-renderer.js", "scripts/page-formatter.js", "scripts/formatter.js",
    "styles/page.css", "styles/formatter.css", "formatter.html", "manifest.json"
  ];
  const buildHashes = Object.fromEntries(await Promise.all(buildFiles.map(async (name) =>
    [name, sha256(await readFile(join(extensionRoot, name)))])));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(fixture.payload);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const samples: Sample[] = [];
  let browserVersion = "";
  try {
    for (const mode of ["response-page", "formatter-tab"] as const) {
      for (let iteration = 1; iteration <= runCount; iteration++) {
        console.log(`${mode}: starting run ${iteration}/${runCount} in a fresh Chrome process...`);
        const browser = await chromium.launch({
          channel: "chrome",
          executablePath: process.env.JF_CHROME_PATH || undefined,
          headless: true
        });
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          browserVersion = browser.version();
          const measure = async (): Promise<Sample> => {
            const page = await browser.newPage({
              viewport: { width: 1280, height: 800 },
              colorScheme: "dark", reducedMotion: "reduce"
            });
            const profiling = await page.context().newCDPSession(page);
            await profiling.send("Performance.enable");
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(error.message));
            page.on("crash", () => errors.push("The Chrome renderer crashed."));
            if (mode === "response-page") {
              await page.goto(`http://127.0.0.1:${address.port}/input-5MB.json`);
              assert.equal(await page.evaluate(() => document.contentType), "application/json");
              await page.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
              await page.addScriptTag({ path: join(extensionRoot, "scripts", "theme.js") });
              await page.addScriptTag({ path: join(extensionRoot, "scripts", "json-renderer.js") });
            } else {
              await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
              await page.locator("#json-input").fill(fixture.payload);
            }
            await waitForFrame(page);
            const beforeMetrics = await profiling.send("Performance.getMetrics");
            const timing = await page.evaluate(async ({ mode, formatterSource }) => {
              const startedAt = performance.now();
              if (mode === "response-page") {
                const script = document.createElement("script");
                script.textContent = formatterSource;
                document.head.appendChild(script);
              } else {
                document.querySelector<HTMLButtonElement>("#format-button")!.click();
              }
              const synchronousMs = performance.now() - startedAt;
              // A frame can perform style, layout and paint between these callbacks.
              await new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              });
              return { synchronousMs, frameReadyMs: performance.now() - startedAt };
            }, { mode, formatterSource: mode === "response-page" ? formatterSource : "" });
            const afterMetrics = await profiling.send("Performance.getMetrics");
            const elapsedMetric = (name: string): number => 1_000 * (
              (afterMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0) -
              (beforeMetrics.metrics.find((metric) => metric.name === name)?.value ?? 0)
            );
            const actual = await validateResult(page, fixture);
            const rawFrameReadyMs = await validateRaw(page, fixture.normalized);
            const rawInteractions = await verifyRawInteractions(page, fixture.normalized, iteration === runCount);
            if (iteration === runCount) {
              await validateLargeSelection(page, fixture.payload);
              console.log(`${mode}: full 5 MB selection/copy and scrolling verified.`);
            }
            assert.deepEqual(errors, [], "There must be no browser errors.");
            return {
              mode, iteration, ...timing, rawFrameReadyMs, ...rawInteractions,
              layoutMs: elapsedMetric("LayoutDuration"), styleMs: elapsedMetric("RecalcStyleDuration"),
              treeLines: actual.lines,
              containers: actual.containers, domElements: actual.domElements
            };
          };
          const sample = await Promise.race([
            measure(),
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => reject(new Error(`${mode} exceeded the 120-second safety timeout.`)), 120_000);
            })
          ]);
          samples.push(sample);
          console.log(`${mode} ${iteration}: formatting ${sample.synchronousMs.toFixed(1)} ms; ` +
            `frame ready ${sample.frameReadyMs.toFixed(1)} ms; first Raw switch ${sample.rawFrameReadyMs.toFixed(1)} ms; ` +
            `${sample.domElements} initial DOM elements; layout ${sample.layoutMs.toFixed(1)} ms, style ${sample.styleMs.toFixed(1)} ms.`);
          console.log(`  Raw interactions: slowest scroll frame ${sample.rawScrollMaxFrameMs.toFixed(1)} ms; ` +
            `slowest Tree/Raw switch ${sample.rawToggleMaxFrameMs.toFixed(1)} ms; ` +
            `native Select All / Copy ${sample.rawNativeCopyMs?.toFixed(1) ?? "not sampled"} ms.`);
        } finally {
          clearTimeout(timeout);
          await browser.close();
        }
      }
    }
    const summaries = Object.fromEntries((["response-page", "formatter-tab"] as const).map((mode) => {
      const matching = samples.filter((sample) => sample.mode === mode);
      return [mode, {
        synchronousMs: summary(matching, "synchronousMs"), frameReadyMs: summary(matching, "frameReadyMs"),
        rawFrameReadyMs: summary(matching, "rawFrameReadyMs")
      }];
    }));
    const report = {
      recordedAt: new Date().toISOString(),
      environment: {
        chrome: browserVersion, headless: true, platform: platform(), osRelease: release(),
        cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), node: process.version,
        viewports: { "response-page": { width: 1280, height: 800 }, "formatter-tab": { width: 1280, height: 800 } },
        colorScheme: "dark", cpuThrottling: false, freshBrowserPerSample: true, warmupRuns: 0
      },
      measurement: {
        unit: "ms", runsPerMode: runCount, maxFrameMs: maxFrameMs ?? null,
        synchronousMs: "JSON parsing, tree creation and DOM mounting; may include forced layout.",
        frameReadyMs: "From formatting start through two requestAnimationFrame callbacks, allowing a rendering opportunity.",
        rawFrameReadyMs: "First Raw selection through two requestAnimationFrame callbacks, including lazy Raw creation.",
        rawScrollMaxFrameMs: "Slowest vertical Raw scroll through two requestAnimationFrame callbacks.",
        rawToggleMaxFrameMs: "Slowest of four subsequent Tree/Raw switches through two requestAnimationFrame callbacks.",
        rawNativeCopyMs: "Native keyboard Select All and Copy round trip, including automation overhead; sampled on the last run.",
        excludes: ["fixture loading", "browser startup", "navigation", "input entry", "assertions", "extension startup"]
      },
      fixture: fixture.metadata, buildHashes, samples, summaries
    };
    const reportPath = join(outputRoot, "results.json");
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    for (const [mode, result] of Object.entries(summaries)) {
      const timing = result.frameReadyMs;
      console.log(`${mode}: median ${timing.median.toFixed(1)} ms ` +
        `(min ${timing.min.toFixed(1)}, max ${timing.max.toFixed(1)}); through rendered frame. ` +
        `First Raw switch: median ${result.rawFrameReadyMs.median.toFixed(1)} ms.`);
    }
    console.log(`Performance report: ${reportPath}`);
    if (maxFrameMs !== undefined) {
      for (const sample of samples) {
        assert(sample.frameReadyMs <= maxFrameMs,
          `${sample.mode} run ${sample.iteration}: ${sample.frameReadyMs.toFixed(1)} ms exceeds ${maxFrameMs} ms.`);
        assert(sample.rawFrameReadyMs <= maxFrameMs,
          `${sample.mode} first Raw switch ${sample.iteration}: ${sample.rawFrameReadyMs.toFixed(1)} ms exceeds ${maxFrameMs} ms.`);
        assert(sample.rawScrollMaxFrameMs <= 500, `${sample.mode}: Raw scrolling stalled for over 500 ms.`);
        assert(sample.rawToggleMaxFrameMs <= 500, `${sample.mode}: Tree/Raw switching stalled for over 500 ms.`);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
