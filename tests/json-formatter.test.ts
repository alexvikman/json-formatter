"use strict";

interface Window {
  __copiedText?: string;
  __getStoredTheme(): string;
}

const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const { verifyLargeDocument } = require("./large-document.test");
const { verifyRawEdgeCases } = require("./raw-view.test");
const { verifyFormatterTab } = require("./formatter-tab.test");
const { verifyAppearance } = require("./appearance.test");
const { verifyDataIntegrity } = require("./data-integrity.test");
const { verifyLinks } = require("./links.test");
const { verifySiblingCollapse } = require("./sibling-collapse.test");

function loadPlaywright() {
  try {
    return require("playwright-core");
  } catch (error) {
    try {
      return require("playwright");
    } catch (_fallbackError) {
      if (!process.env.JF_NODE_MODULES) {
        throw error;
      }
      const environmentRequire = createRequire(
        path.join(process.env.JF_NODE_MODULES, "package.json")
      );
      return environmentRequire("playwright");
    }
  }
}

async function startJsonServer(payload) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(payload);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return server;
}

async function run() {
  const { chromium } = loadPlaywright();
  const projectRoot = process.cwd();
  const extensionRoot = path.join(projectRoot, "dist");
  const sample = JSON.stringify({
    name: "Test",
    active: true,
    count: 42,
    optional: null,
    nested: {
      items: [
        { id: 1, tags: ["a", "b"] },
        { id: 2, tags: [] }
      ]
    }
  });
  const rawSample = `\n${JSON.stringify(JSON.parse(sample), null, 4)}\n`;

  const browser = await chromium.launch({
    channel: "chrome",
    executablePath: process.env.JF_CHROME_PATH || undefined,
    headless: true
  });

  try {
    await verifyFormatterTab(browser, extensionRoot);
    await verifyAppearance(browser, extensionRoot);
    await verifyDataIntegrity(browser, extensionRoot);
    await verifyLinks(browser, extensionRoot);
    await verifySiblingCollapse(browser, extensionRoot);
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    await page.addInitScript(() => {
      let storedTheme = "dark";
      type StorageListener = (
        changes: Record<string, { oldValue: string; newValue: string }>,
        areaName: string
      ) => void;
      const listeners = new Set<StorageListener>();
      const storage = {
        sync: {
          get(defaults, callback) {
            callback({ ...defaults, theme: storedTheme });
          },
          set(values, callback) {
            const oldValue = storedTheme;
            storedTheme = values.theme;
            listeners.forEach((listener) => listener({
              theme: { oldValue, newValue: storedTheme }
            }, "sync"));
            if (callback) {
              callback();
            }
          }
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          }
        }
      };
      Object.defineProperty(globalThis.chrome, "storage", {
        configurable: true,
        value: storage
      });
      globalThis.__getStoredTheme = () => storedTheme;
    });
    await page.goto(pathToFileURL(path.join(extensionRoot, "formatter.html")).href);
    assert.equal(await page.locator("html").getAttribute("data-jf-theme"), "dark");
    await page.locator("#json-input").fill(rawSample);
    await page.locator("#format-button").click();

    assert.equal(await page.locator("#result-view").isVisible(), true);
    assert.equal(await page.locator(".jf-string").count() > 0, true);
    assert.equal(await page.locator(".jf-number").count() > 0, true);
    assert.equal(await page.locator(".jf-boolean").count() > 0, true);
    assert.equal(await page.locator(".jf-null").count() > 0, true);
    assert.equal(await page.locator(".jf-container-node").count() >= 4, true);
    const monokaiColors = await page.evaluate(() => {
      const styles = getComputedStyle(document.documentElement);
      return {
        key: styles.getPropertyValue("--jf-key").trim(),
        string: styles.getPropertyValue("--jf-string").trim(),
        number: styles.getPropertyValue("--jf-number").trim(),
        boolean: styles.getPropertyValue("--jf-boolean").trim()
      };
    });
    assert.deepEqual(monokaiColors, {
      key: "#f92672",
      string: "#e6db74",
      number: "#fd971f",
      boolean: "#66d9ef"
    });
    assert.equal(
      await page.locator(".jf-container-node.is-collapsed").count(),
      0,
      "Every object and array should be expanded by default"
    );

    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text) => {
            window.__copiedText = text;
          }
        }
      });
    });

    await page.locator("#raw-mode-button").click();
    assert.equal(await page.locator("#json-raw-result").isVisible(), true);
    assert.equal(await page.locator("#json-raw-result").textContent(), sample);
    assert.equal(await page.locator("#json-raw-result .jf-key").count() > 0, true);
    assert.equal(await page.locator("#json-raw-result .jf-string").count() > 0, true);
    assert.equal(await page.locator("#json-raw-result .jf-number").count() > 0, true);
    assert.equal(await page.locator("#json-raw-result .jf-boolean").count() > 0, true);
    assert.equal(await page.locator("#json-result").isHidden(), true);
    assert.equal(await page.locator("#tree-controls").isHidden(), true);
    assert.equal(await page.locator("#copy-button").textContent(), "Copy raw");
    await page.locator("#copy-button").click();
    assert.equal(await page.evaluate(() => window.__copiedText), sample);

    await page.locator("#tree-mode-button").click();
    assert.equal(await page.locator("#json-result").isVisible(), true);
    assert.equal(await page.locator("#copy-button").textContent(), "Copy formatted");
    await page.locator("#copy-button").click();
    assert.equal(
      await page.evaluate(() => window.__copiedText),
      JSON.stringify(JSON.parse(sample), null, 2)
    );

    const selectedText = await page.locator("#json-result .jf-tree").evaluate((tree) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(tree);
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
    assert.doesNotMatch(selectedText, /\n\s*:\s*\n/);

    const copiedSelection = await page.locator("#json-result .jf-tree").evaluate((tree) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(tree);
      selection.removeAllRanges();
      selection.addRange(range);

      const clipboardData = new DataTransfer();
      const copyEvent = new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData
      });
      tree.dispatchEvent(copyEvent);
      selection.removeAllRanges();
      return clipboardData.getData("text/plain");
    });
    assert.equal(copiedSelection, JSON.stringify(JSON.parse(sample), null, 2));

    const copiedNestedSelection = await page.locator("#json-result .jf-tree").evaluate((tree) => {
      const treeElement = tree as HTMLElement;
      const nestedKey = Array.from(treeElement.querySelectorAll<HTMLElement>(".jf-key")).find(
        (key) => key.textContent === '"nested"'
      ) as HTMLElement;
      const nestedNode = nestedKey.closest(".jf-container-node") as HTMLElement;
      const closingLine = Array.from(nestedNode.children).find(
        (child) => child.classList.contains("jf-closing-line")
      );
      const selection = window.getSelection();
      const range = document.createRange();
      range.setStart(nestedKey.firstChild, 0);
      range.selectNodeContents(nestedNode);
      range.setStart(nestedKey.firstChild, 0);
      selection.removeAllRanges();
      selection.addRange(range);

      const clipboardData = new DataTransfer();
      nestedNode.dispatchEvent(new ClipboardEvent("copy", {
        bubbles: true,
        cancelable: true,
        clipboardData
      }));
      selection.removeAllRanges();
      return {
        text: clipboardData.getData("text/plain"),
        hasClosingLine: Boolean(closingLine)
      };
    });
    const nestedJson = JSON.stringify(JSON.parse(sample).nested, null, 2);
    assert.equal(copiedNestedSelection.hasClosingLine, true);
    assert.equal(copiedNestedSelection.text, `"nested": ${nestedJson}`);

    await page.locator("#collapse-button").click();
    const containers = page.locator(".jf-container-node");
    assert.equal(
      await page.locator(".jf-container-node.is-collapsed").count(),
      await containers.count()
    );

    await page.locator("#expand-button").click();
    assert.equal(await page.locator(".jf-container-node.is-collapsed").count(), 0);

    if (process.env.JF_SCREENSHOT_PATH) {
      await page.screenshot({
        path: process.env.JF_SCREENSHOT_PATH,
        animations: "disabled"
      });
    }

    await page.locator("#edit-button").click();
    await page.locator("#json-input").fill('{"broken": }');
    await page.locator("#format-button").click();
    assert.equal(await page.locator("#parse-error").isVisible(), true);

    const optionsPage = await browser.newPage();
    await optionsPage.addInitScript(() => {
      let storedTheme = "system";
      type StorageListener = (
        changes: Record<string, { oldValue: string; newValue: string }>,
        areaName: string
      ) => void;
      const listeners = new Set<StorageListener>();
      const storage = {
        sync: {
          get(defaults, callback) {
            callback({ ...defaults, theme: storedTheme });
          },
          set(values, callback) {
            const oldValue = storedTheme;
            storedTheme = values.theme;
            listeners.forEach((listener) => listener({
              theme: { oldValue, newValue: storedTheme }
            }, "sync"));
            if (callback) {
              callback();
            }
          }
        },
        onChanged: {
          addListener(listener) {
            listeners.add(listener);
          },
          removeListener(listener) {
            listeners.delete(listener);
          }
        }
      };
      Object.defineProperty(globalThis.chrome, "storage", {
        configurable: true,
        value: storage
      });
      globalThis.__getStoredTheme = () => storedTheme;
    });
    await optionsPage.goto(pathToFileURL(path.join(extensionRoot, "options.html")).href);
    assert.equal(await optionsPage.locator('input[value="system"]').isChecked(), true);
    await optionsPage.locator('input[value="dark"]').check();
    assert.equal(await optionsPage.locator("html").getAttribute("data-jf-theme"), "dark");
    assert.equal(await optionsPage.evaluate(() => window.__getStoredTheme()), "dark");
    await optionsPage.locator('input[value="light"]').check();
    assert.equal(await optionsPage.locator("html").getAttribute("data-jf-theme"), "light");
    assert.equal(await optionsPage.evaluate(() => window.__getStoredTheme()), "light");
    if (process.env.JF_OPTIONS_SCREENSHOT_PATH) {
      await optionsPage.locator('input[value="dark"]').check();
      await optionsPage.screenshot({
        path: process.env.JF_OPTIONS_SCREENSHOT_PATH,
        animations: "disabled",
        fullPage: true
      });
    }
    await optionsPage.close();

    const server = await startJsonServer(rawSample);
    try {
      const address = server.address();
      const responsePage = await browser.newPage();
      await responsePage.goto(`http://127.0.0.1:${address.port}/data`);
      assert.equal(await responsePage.evaluate(() => document.contentType), "application/json");

      await responsePage.addStyleTag({ path: path.join(extensionRoot, "styles", "page.css") });
      await responsePage.addScriptTag({ path: path.join(extensionRoot, "scripts", "theme.js") });
      await responsePage.addScriptTag({ path: path.join(extensionRoot, "scripts", "json-renderer.js") });
      await responsePage.addScriptTag({ path: path.join(extensionRoot, "scripts", "page-formatter.js") });

      assert.equal(await responsePage.locator(".jf-page-app").count(), 1);
      assert.equal(await responsePage.locator(".jf-page-content .jf-tree").count(), 1);
      assert.equal(await responsePage.getByText("Collapse all").count(), 1);
      const markLayout = await responsePage.locator(".jf-brand-mark").evaluate((mark) => {
        const styles = getComputedStyle(mark);
        return {
          display: styles.display,
          alignItems: styles.alignItems,
          justifyContent: styles.justifyContent
        };
      });
      assert.equal(["flex", "inline-flex"].includes(markLayout.display), true);
      assert.equal(markLayout.alignItems, "center");
      assert.equal(markLayout.justifyContent, "center");

      await responsePage.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: {
            writeText: async (text) => {
              window.__copiedText = text;
            }
          }
        });
      });
      await responsePage.getByRole("button", { name: "Raw", exact: true }).click();
      assert.equal(await responsePage.locator(".jf-page-raw").isVisible(), true);
      assert.equal(await responsePage.locator(".jf-page-raw").textContent(), sample);
      assert.equal(await responsePage.locator(".jf-page-raw .jf-key").count() > 0, true);
      assert.equal(await responsePage.locator(".jf-page-content .jf-tree").isHidden(), true);
      assert.equal(
        await responsePage.getByRole("button", { name: "Copy raw", exact: true }).count(),
        1
      );
      await responsePage.getByRole("button", { name: "Copy raw", exact: true }).click();
      assert.equal(await responsePage.evaluate(() => window.__copiedText), sample);
      await responsePage.close();
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }

    await page.close();
    await verifyLargeDocument(browser, extensionRoot);
    await verifyRawEdgeCases(browser, extensionRoot);
    console.log("Tests passed: formatter tab, colors, collapsing, Tree/Raw views, copying, and JSON responses.");
  } finally {
    await browser.close();
  }
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
