import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser } from "playwright-core";

declare global {
  interface Window {
    find(text: string): boolean;
  }
}

export async function verifyLargeDocument(browser: Browser, extensionRoot: string): Promise<void> {
  const records = Array.from({ length: 513 }, (_unused, index) => ({
    id: index,
    text: index === 512 ? "Unique offscreen search marker" : `Record ${index}`,
    nested: { active: true, values: [null, -2.5e-12, "quotes: \" \\ true null <img src=x onerror=alert(1)>"] },
    empty: []
  }));
  const source = JSON.stringify(records);
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    await page.locator("#json-input").fill(source);
    await page.locator("#format-button").click();
    assert.equal(await page.locator(".jf-raw-code").count(), 0, "Raw should be created on first selection.");
    const initialLines = await page.locator(".jf-line").count();
    assert(initialLines > 5_000);
    assert.equal(await page.locator(".jf-render-chunk").count(), 9);
    assert.equal(await page.locator(".is-collapsed").count(), 0);

    const copyWholeTree = () => page.locator(".jf-tree").evaluate((tree) => {
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
    assert.equal(await copyWholeTree(), JSON.stringify(records, null, 2),
      "Full selection must copy every offscreen row with indentation.");

    // Find-in-page must discover a value in the last offscreen chunk.
    const found = await page.evaluate(() => {
      return window.find("Unique offscreen search marker");
    });
    assert.equal(found, true);
    assert.equal(await page.evaluate(() => window.getSelection()?.toString()), "Unique offscreen search marker");
    const lastValue = page.locator(".jf-string").filter({ hasText: "Unique offscreen search marker" });
    await lastValue.scrollIntoViewIfNeeded();
    assert.equal(await lastValue.isVisible(), true);
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    assert.equal(await page.locator(".jf-line").count(), initialLines, "Scrolling must not discard DOM rows.");

    const firstChunk = page.locator(".jf-render-chunk").first();
    const beforeHeight = await firstChunk.evaluate((chunk) => (chunk as HTMLElement).style.containIntrinsicBlockSize);
    const firstRecordToggle = firstChunk.locator(":scope > .jf-container-node > .jf-container-line > .jf-toggle").first();
    await firstRecordToggle.scrollIntoViewIfNeeded();
    await firstRecordToggle.click();
    assert.equal(await firstRecordToggle.getAttribute("aria-expanded"), "false");
    const collapsedHeight = await firstChunk.evaluate((chunk) => (chunk as HTMLElement).style.containIntrinsicBlockSize);
    assert(parseFloat(collapsedHeight) < parseFloat(beforeHeight), "Chunk height must track collapsed rows.");
    await firstRecordToggle.press("Enter");
    assert.equal(await firstRecordToggle.getAttribute("aria-expanded"), "true");
    assert.equal(await firstChunk.evaluate((chunk) => (chunk as HTMLElement).style.containIntrinsicBlockSize), beforeHeight);

    await firstRecordToggle.click({ modifiers: ["Control"] });
    assert.equal(await page.locator(".is-collapsed").count(), records.length,
      "Sibling collapsing must include records in every offscreen layout chunk.");
    const collapsedChunks = await page.locator(".jf-render-chunk").evaluateAll((chunks) => chunks.map((chunk) => ({
      height: parseFloat((chunk as HTMLElement).style.containIntrinsicBlockSize),
      records: chunk.children.length
    })));
    assert(collapsedChunks.every((chunk) => chunk.height === chunk.records * 22));
    assert.equal(await copyWholeTree(), JSON.stringify(records, null, 2));
    await firstRecordToggle.click({ modifiers: ["Control"] });
    assert.equal(await page.locator(".is-collapsed").count(), records.length - 1);

    await page.locator("#collapse-button").click();
    await page.locator("#expand-button").click();
    assert.equal(await page.locator(".is-collapsed").count(), 0);
    assert.equal(await page.locator(".jf-line").count(), initialLines);
    assert.equal(await copyWholeTree(), JSON.stringify(records, null, 2));

    await page.locator("#raw-mode-button").click();
    assert.equal(await page.locator(".jf-raw-code").textContent(), source);
    assert.equal(await page.locator(".jf-raw-code img").count(), 0, "JSON must never be interpreted as HTML.");
    assert.equal(await page.locator(".jf-raw-code .jf-number").count(), 1_026);
    assert.equal(await page.locator(".jf-raw-code .jf-null").count(), 513);
    await page.locator(".jf-raw-code").evaluate((code) => { code.setAttribute("data-test-original", "yes"); });
    await page.locator("#tree-mode-button").click();
    await page.locator("#raw-mode-button").click();
    assert.equal(await page.locator(".jf-raw-code").getAttribute("data-test-original"), "yes", "Reuse Raw after first opening.");

    await page.locator("#edit-button").click();
    const replacement = { unicode: "漢字 😀 café", negative: -3.2e20, value: false };
    await page.locator("#json-input").fill(JSON.stringify(replacement));
    await page.locator("#format-button").click();
    assert.equal(await page.locator(".jf-raw-code").count(), 0, "Editing must invalidate cached Raw.");
    await page.locator("#raw-mode-button").click();
    assert.equal(await page.locator(".jf-raw-code").textContent(), JSON.stringify(replacement));
    console.log("Large-document tests passed: offscreen copying/search, scrolling, collapsing, safe coloring and Raw reuse.");
  } finally {
    await page.close();
  }
}
