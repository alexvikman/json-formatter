import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";
import type { Browser, Page } from "playwright-core";

declare global {
  interface Window {
    __settingsOpenCount: number;
  }
}

async function assertViewportLayout(page: Page, selector: string): Promise<void> {
  const layout = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      width: bounds.width, height: bounds.height, bottom: bounds.bottom,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      documentWidth: document.documentElement.scrollWidth,
      documentHeight: document.documentElement.scrollHeight
    };
  });
  assert(layout.width > layout.viewportWidth * 0.9, "The workspace must use the tab's width.");
  assert(layout.height > layout.viewportHeight * 0.5, "The workspace must use the tab's height.");
  assert(layout.bottom <= layout.viewportHeight + 1, "The workspace must fit below the toolbars.");
  assert(layout.documentWidth <= layout.viewportWidth, "Only the JSON pane may scroll horizontally.");
  assert(layout.documentHeight <= layout.viewportHeight, "JSON should scroll inside the workspace.");
}

async function captureLayout(page: Page, name: string): Promise<void> {
  if (process.env.JF_TAB_SCREENSHOT_DIR) {
    await mkdir(process.env.JF_TAB_SCREENSHOT_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.JF_TAB_SCREENSHOT_DIR, `${name}.png`), animations: "disabled" });
  }
}

export async function verifyFormatterTab(browser: Browser, extensionRoot: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  assert.equal(manifest.action.default_popup, undefined, "A popup prevents action.onClicked from firing.");
  assert.equal(manifest.background.service_worker, "scripts/background.js");
  assert.deepEqual(manifest.permissions, ["clipboardWrite", "storage"], "Opening a tab needs no new permissions.");
  const workerSource = await readFile(join(extensionRoot, manifest.background.service_worker), "utf8");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark" });
  await context.addInitScript(() => {
    window.__settingsOpenCount = 0;
    Object.defineProperty(window.chrome, "runtime", {
      configurable: true,
      value: { openOptionsPage: () => { window.__settingsOpenCount++; } }
    });
  });

  try {
    const listeners: Array<() => void> = [];
    const requests: Array<{ url: string; active: boolean }> = [];
    const errors: string[] = [];
    context.on("page", (page) => page.on("pageerror", (error) => errors.push(error.message)));
    let pendingTab: Promise<Page> | undefined;
    // Exercise the built worker without DOM globals. Chrome's action/tabs APIs are
    // mocked; each requested extension URL is opened as a built page in Chrome.
    runInNewContext(workerSource, {
      console,
      chrome: {
        action: { onClicked: { addListener: (listener: () => void) => listeners.push(listener) } },
        runtime: { getURL: (file: string) => `chrome-extension://formatter-test/${file}` },
        tabs: {
          create: (options: { url: string; active: boolean }) => {
            requests.push({ ...options });
            assert.equal(options.url, "chrome-extension://formatter-test/formatter.html");
            assert.equal(options.active, true);
            pendingTab = context.newPage().then(async (page) => {
              await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
              return page;
            });
            return pendingTab.then(() => ({}));
          }
        }
      }
    });
    assert.equal(listeners.length, 1, "Register the action listener immediately when the worker starts.");
    assert.equal(requests.length, 0, "Starting the worker must not open a tab by itself.");
    const clickAction = async (): Promise<Page> => {
      pendingTab = undefined;
      listeners[0]();
      assert(pendingTab, "Clicking the extension action must open a new tab.");
      return pendingTab;
    };

    const first = await clickAction();
    assert.equal(await first.title(), "JSON Formatter");
    await assertViewportLayout(first, "#json-input");
    await captureLayout(first, "formatter-editor-dark");
    await first.emulateMedia({ colorScheme: "light" });
    await captureLayout(first, "formatter-editor-light");
    await first.emulateMedia({ colorScheme: "dark" });
    const originalBounds = await first.locator("#json-input").boundingBox();
    await first.setViewportSize({ width: 1600, height: 1000 });
    await assertViewportLayout(first, "#json-input");
    const largerBounds = await first.locator("#json-input").boundingBox();
    assert(largerBounds!.width > originalBounds!.width + 250);
    assert(largerBounds!.height > originalBounds!.height + 150);
    await first.setViewportSize({ width: 1280, height: 800 });

    const unfinished = '{"unfinished":';
    await first.locator("#json-input").fill(unfinished);
    const second = await clickAction();
    assert.equal(context.pages().length, 2, "Each click opens a separate document tab.");
    assert.equal(await second.locator("#json-input").inputValue(), "");
    await first.bringToFront();
    assert.equal(await first.locator("#json-input").inputValue(), unfinished,
      "Switching tabs must preserve unfinished input.");

    const records = Array.from({ length: 256 }, (_, id) => ({ id, message: "Long value ".repeat(100) }));
    const source = JSON.stringify(records);
    await second.locator("#json-input").fill(source);
    await second.locator("#format-button").click();
    await assertViewportLayout(second, "#json-result");
    await captureLayout(second, "formatter-tree");
    const toolbarBefore = await second.locator(".result-toolbar").boundingBox();
    await second.locator(".jf-line").last().scrollIntoViewIfNeeded();
    assert((await second.locator("#json-result").evaluate((element) => element.scrollTop)) > 0);
    const toolbarAfter = await second.locator(".result-toolbar").boundingBox();
    assert.equal(toolbarAfter!.y, toolbarBefore!.y, "The toolbar must stay in place while JSON scrolls.");
    await assertViewportLayout(second, "#json-result");
    await second.locator("#raw-mode-button").click();
    await assertViewportLayout(second, "#json-raw-result");
    await captureLayout(second, "formatter-raw");
    assert.equal(await second.locator(".jf-raw-code").textContent(), source);

    await first.setViewportSize({ width: 360, height: 740 });
    await assertViewportLayout(first, "#json-input");
    await first.locator("#json-input").fill('{"items":[1,2,3]}');
    await first.locator("#json-input").press(`${process.platform === "darwin" ? "Meta" : "Control"}+Enter`);
    await assertViewportLayout(first, "#json-result");
    await captureLayout(first, "formatter-narrow");
    for (const selector of ["#settings-button", "#edit-button", "#copy-button", "#expand-button"]) {
      const bounds = await first.locator(selector).boundingBox();
      assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360, `${selector} must fit a narrow tab.`);
    }
    await first.locator("#collapse-button").click();
    await second.bringToFront();
    assert.equal(await second.locator("#raw-mode-button").getAttribute("aria-pressed"), "true");
    assert.equal(await second.locator(".is-collapsed").count(), 0, "Document state must be isolated per tab.");
    await first.bringToFront();
    await first.locator("#settings-button").click();
    assert.equal(await first.evaluate(() => window.__settingsOpenCount), 1);
    await first.keyboard.press("Escape");
    assert.equal(await first.locator("#json-input").inputValue(), '{"items":[1,2,3]}');
    assert.equal(requests.length, 2);
    assert.deepEqual(errors, []);
    console.log("Formatter-tab tests passed: action handler, independent documents, responsive layout, scrolling and settings.");
  } finally {
    await context.close();
  }
}
