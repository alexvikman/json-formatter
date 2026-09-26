import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";

declare global {
  interface Window {
    __integrityClipboard?: string;
    __integrityCopyHandled?: boolean;
  }
}

// Expected values are text, never JavaScript numeric literals or a lossy parse.
const numbers = [
  "9007199254740993", "-9007199254740993", "18446744073709551615",
  "123456789012345678901234567890", "1.234567890123456789",
  "1e400", "1e-400", "-0", "1.2300e+04", "42"
];
const label = "Keep 9007199254740993 as text";
const compact = `{"numbers":[${numbers.join(",")}],"label":${JSON.stringify(label)},"lookalike":{"rawJSON":"42"}}`;
const arrayText = `[\n  ${numbers.join(",\n  ")}\n]`;
const formatted = `{
  "numbers": [
    ${numbers.join(",\n    ")}
  ],
  "label": ${JSON.stringify(label)},
  "lookalike": {
    "rawJSON": "42"
  }
}`;
const input = `\n\t${formatted}\n  `;

async function copySelection(page: Page, selector = ".jf-tree"): Promise<string> {
  return page.locator(selector).evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
}

async function copyNativeSelection(page: Page): Promise<string> {
  await page.locator(".jf-tree").evaluate((tree) => {
    (tree as HTMLElement).tabIndex = -1;
    (tree as HTMLElement).focus();
    const range = document.createRange();
    range.selectNodeContents(tree);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    delete window.__integrityClipboard;
    document.addEventListener("copy", (event) => {
      window.__integrityCopyHandled = event.defaultPrevented;
      window.__integrityClipboard = event.clipboardData?.getData("text/plain");
      event.preventDefault(); // Never write test data to the user's OS clipboard.
    }, { once: true });
  });
  await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+c`);
  await page.waitForFunction(() => typeof window.__integrityClipboard === "string");
  assert.equal(await page.evaluate(() => window.__integrityCopyHandled), true);
  return page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    return window.__integrityClipboard!;
  });
}

async function verifyDocument(page: Page): Promise<void> {
  const tree = page.locator(".jf-tree");
  assert.deepEqual(await tree.locator(".jf-number").allTextContents(), numbers);
  assert.equal(await tree.locator(".jf-container-node").count(), 3,
    "A rawJSON property in user data is an ordinary object, not an internal numeric value.");
  assert.equal(await copySelection(page), formatted);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { window.__integrityClipboard = text; } }
    });
  });
  await page.getByRole("button", { name: "Copy formatted", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__integrityClipboard), formatted);
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  assert.equal(await page.locator(".jf-raw-code").textContent(), compact);
  await page.getByRole("button", { name: "Copy raw", exact: true }).click();
  assert.equal(await page.evaluate(() => window.__integrityClipboard), compact);
  await page.getByRole("button", { name: "Tree", exact: true }).click();

  await tree.locator(".jf-toggle").nth(1).click();
  assert.equal(await copySelection(page), formatted, "Selecting folded branches includes their full contents.");
  assert.equal(await tree.locator(".is-collapsed").count(), 1, "Copying must not change expansion state.");
  const foldedLine = ".jf-container-node.is-collapsed > .jf-container-line";
  assert.equal(await copySelection(page, foldedLine), `"numbers": ${arrayText},`);
  const commaOnly = await page.locator(foldedLine).evaluate((line) => {
    const closingText = line.querySelector(".jf-inline-tail")!.lastChild as Text;
    const range = document.createRange();
    range.setStart(closingText, closingText.length - 1);
    range.setEnd(closingText, closingText.length);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    line.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
  assert.equal(commaOnly, ",", "Selecting only a trailing comma must not include the folded value.");
  assert.equal(await copySelection(page, `${foldedLine} > .jf-key`), '"numbers"');

  await page.getByRole("button", { name: "Collapse all", exact: true }).click();
  const collapsedCount = await tree.locator(".is-collapsed").count();
  assert.equal(await copySelection(page), formatted, "A folded root must copy as a complete JSON document.");
  assert.equal(await copyNativeSelection(page), formatted, "Native keyboard copying must preserve folded numeric data.");
  assert.equal(await tree.locator(".is-collapsed").count(), collapsedCount);
  await page.getByRole("button", { name: "Expand all", exact: true }).click();

  const partial = await tree.evaluate((element) => {
    const values = element.querySelectorAll(".jf-number");
    const range = document.createRange();
    range.setStart(values[0].firstChild!, 4);
    range.setEnd(values[1].firstChild!, 5);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
  assert.equal(partial, `${numbers[0].slice(4)},\n${numbers[1].slice(0, 5)}`,
    "Multi-line copying must not add unselected characters at either end.");
}

export async function verifyDataIntegrity(browser: Browser, extensionRoot: string): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(input);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    await page.locator("#json-input").fill(input);
    await page.locator("#format-button").click();
    await verifyDocument(page);

    // Exercise the automatic paste path separately from the Format button.
    await page.locator("#edit-button").click();
    await page.locator("#json-input").fill("9007199254740993");
    await page.locator("#json-input").dispatchEvent("paste");
    await page.locator("#result-view").waitFor({ state: "visible" });
    assert.match((await page.locator("#result-meta").textContent())!, /^Number/);
    assert.equal(await copySelection(page), "9007199254740993");
    await page.locator("#raw-mode-button").click();
    assert.equal(await page.locator(".jf-raw-code").textContent(), "9007199254740993");

    const checks = await page.evaluate(() => {
      const api = window.JsonFormatterRenderer;
      const malformed = ['{"n":NaN}', '{"n":Infinity}', '{"n":01}', '{"n":1.}', '{"n":+1}', '{"n":1e}'];
      return {
        rejected: malformed.every((source) => { try { api.parse(source); return false; } catch { return true; } }),
        protectedKeys: JSON.stringify(api.parse('{"__proto__":{"id":9007199254740993},"rawJSON":"7","constructor":42}')),
        duplicateKey: JSON.stringify(api.parse('{"id":9007199254740992,"id":9007199254740993}')),
        giantInteger: JSON.stringify(api.parse("9".repeat(1_000)))
      };
    });
    assert.equal(checks.rejected, true);
    assert.equal(checks.protectedKeys, '{"__proto__":{"id":9007199254740993},"rawJSON":"7","constructor":42}');
    assert.equal(checks.duplicateKey, '{"id":9007199254740993}');
    assert.equal(checks.giantInteger, "9".repeat(1_000));

    const numberScanning = await page.evaluate(() => {
      const api = window.JsonFormatterRenderer;
      const strings = ['"42"', "\\", '\\"', "\\\\", "\n\t", "漢字 😀", "9".repeat(65_536)];
      return strings.flatMap((text) => ["42", "-0", "9007199254740993", "1e400", "1.2300e+04"].map((number) => {
        const key = JSON.stringify(text);
        const source = `{${key}:${key},"number":${number}}`;
        return JSON.stringify(api.parse(source)) === source;
      }));
    });
    assert(numberScanning.every(Boolean), "Escaped quotes, backslashes and digits in strings must not hide later exact number tokens.");
    const byteCounts = await page.evaluate(() => {
      const api = window.JsonFormatterRenderer;
      return ["ASCII", "café", "漢字", "😀", "\ud800"].map((source) => ({
        actual: api.formatBytes(source), expected: `${new Blob([source]).size} B`
      }));
    });
    assert(byteCounts.every(({ actual, expected }) => actual === expected), "Size labels must count UTF-8 bytes, including surrogate replacement.");

    // Lazily built folded trees must copy correctly even without descendant DOM.
    await page.locator("#tree-mode-button").click();
    await page.locator("#json-result").evaluate((container, source) => {
      const api = window.JsonFormatterRenderer;
      container.replaceChildren(api.render(api.parse(source), { expandedDepth: 0 }).element);
    }, input);
    assert.equal(await page.locator(".jf-container-node").count(), 1);
    assert.equal(await copySelection(page), formatted);
    assert.equal(await page.locator(".jf-container-node").count(), 1);

    // The original reported failure, plus folded first/middle/last siblings.
    for (const source of [
      '{"nested":{"id":1},"after":2}',
      '{"first":{"id":1},"middle":[{"id":2},{}],"last":{"id":3}}'
    ]) {
      await page.locator("#json-result").evaluate((container, source) => {
        const api = window.JsonFormatterRenderer;
        container.replaceChildren(api.render(api.parse(source)).element);
      }, source);
      const toggles = await page.locator(
        ".jf-tree > .jf-container-node > .jf-children > .jf-container-node > .jf-container-line > .jf-toggle"
      ).all();
      for (const toggle of toggles) {
        await toggle.click();
        const copied = await copySelection(page);
        assert.equal(copied, JSON.stringify(JSON.parse(source), null, 2));
        assert.doesNotThrow(() => JSON.parse(copied));
      }
    }

    const responsePage = await context.newPage();
    await responsePage.goto(`http://127.0.0.1:${address.port}/numbers.json`);
    await responsePage.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
    for (const name of ["theme", "json-renderer", "page-formatter"]) {
      await responsePage.addScriptTag({ path: join(extensionRoot, "scripts", `${name}.js`) });
    }
    await verifyDocument(responsePage);
    console.log("Data-integrity tests passed: exact numeric tokens, Tree/Raw copying, folded branches, native copy and partial selections in both formatters.");
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
