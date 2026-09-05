import { strict as assert } from "node:assert";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";

declare global {
  interface Window {
    __rawCopiedText?: string;
    __rawCopyHandled?: boolean;
  }
}

export interface RawInteractions {
  rawScrollMaxFrameMs: number;
  rawToggleMaxFrameMs: number;
  rawNativeCopyMs: number | null;
}

async function verifySelection(page: Page, source: string, nativeCopy: boolean): Promise<number | null> {
  const code = page.locator(".jf-raw-code");
  // Select part of two chunks: visual wrapping must not add newlines or extra text.
  const partial = await code.evaluate((element) => {
    const boundary = element.querySelector(".jf-raw-chunk")!.textContent!.length;
    const start = Math.max(0, boundary - 12);
    const end = Math.min(element.textContent!.length, boundary + 15);
    const range = document.createRange();
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let offset = 0;
    let startSet = false;
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (!startSet && start <= offset + text.length) {
        range.setStart(text, start - offset);
        startSet = true;
      }
      if (startSet && end <= offset + text.length) {
        range.setEnd(text, end - offset);
        break;
      }
      offset += text.length;
    }
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return { start, end, copied: clipboardData.getData("text/plain") };
  });
  assert.equal(partial.copied, source.slice(partial.start, partial.end));
  if (!nativeCopy) {
    return null;
  }
  await code.evaluate((element) => {
    (element as HTMLElement).focus({ preventScroll: true });
    delete window.__rawCopiedText;
    element.addEventListener("copy", (event: ClipboardEvent) => {
      window.__rawCopyHandled = event.defaultPrevented;
      window.__rawCopiedText = event.clipboardData?.getData("text/plain");
      event.preventDefault(); // Never modify the user's OS clipboard from a test.
    }, { once: true });
  });
  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  const startedAt = performance.now();
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+c`);
  await page.waitForFunction(() => typeof window.__rawCopiedText === "string");
  const elapsed = performance.now() - startedAt;
  assert.equal(await page.evaluate(() => window.__rawCopyHandled), true);
  assert.equal(await page.evaluate(() => window.__rawCopiedText), source,
    "Native Select All / Copy must preserve the compact JSON without visual line breaks.");
  await page.evaluate(() => {
    window.getSelection()?.removeAllRanges();
    delete window.__rawCopiedText;
  });
  return elapsed;
}

export async function verifyRawInteractions(page: Page, source: string, nativeCopy = false): Promise<RawInteractions> {
  const code = page.locator(".jf-raw-code");
  const chunks = await code.evaluate((element) => {
    const lengths = Array.from(element.querySelectorAll(".jf-raw-chunk"), (chunk) => chunk.textContent!.length);
    return { count: lengths.length, maxLength: Math.max(...lengths) };
  });
  assert(chunks.count > 1, "Large Raw documents must be split into bounded layout chunks.");
  assert(chunks.maxLength <= 4_096, "Even individual giant JSON strings must be bounded.");
  const frameTimes: number[] = [];
  for (const fraction of [0.25, 0.5, 1, 0]) {
    frameTimes.push(await code.evaluate(async (element, fraction) => {
      const scroller = element.closest("#json-raw-result") ?? document.scrollingElement!;
      const startedAt = performance.now();
      scroller.scrollTop = fraction * (scroller.scrollHeight - scroller.clientHeight);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return performance.now() - startedAt;
    }, fraction));
  }
  await code.locator(".jf-raw-chunk").last().scrollIntoViewIfNeeded();
  assert.equal(await code.textContent(), source);
  const toggleTimes: number[] = [];
  for (const mode of ["tree", "raw", "tree", "raw"]) {
    toggleTimes.push(await page.evaluate(async (mode) => {
      const button = document.querySelector<HTMLButtonElement>(`#${mode}-mode-button`) ??
        document.querySelectorAll<HTMLButtonElement>(".jf-page-mode-button")[mode === "tree" ? 0 : 1];
      const startedAt = performance.now();
      button.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      return performance.now() - startedAt;
    }, mode));
  }
  const rawNativeCopyMs = await verifySelection(page, source, nativeCopy);
  return {
    rawScrollMaxFrameMs: Math.max(...frameTimes),
    rawToggleMaxFrameMs: Math.max(...toggleTimes),
    rawNativeCopyMs
  };
}

export async function verifyRawEdgeCases(browser: Browser, extensionRoot: string): Promise<void> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  try {
    await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    // Put an emoji exactly across the first chunk boundary and exercise a giant token.
    const urlPrefix = "https://example.test/";
    const source = JSON.stringify({
      long: urlPrefix + "x".repeat(4_086 - urlPrefix.length) + "😀" + "x".repeat(4_093) + "😀" + "x".repeat(5_000_000) + '\\"\n漢字'
    });
    await page.evaluate((source) => {
      document.querySelector<HTMLElement>("#editor-view")!.hidden = true;
      document.querySelector<HTMLElement>("#result-view")!.hidden = false;
      document.querySelector<HTMLElement>("#json-result")!.hidden = true;
      const result = document.querySelector<HTMLElement>("#json-raw-result")!;
      result.hidden = false;
      result.replaceChildren(window.JsonFormatterRenderer.renderRaw(source));
    }, source);
    const actual = await page.locator(".jf-raw-code").evaluate((code) => ({
      text: code.textContent,
      width: code.getBoundingClientRect().width,
      splitSurrogate: Array.from(code.querySelectorAll(".jf-raw-chunk")).some((chunk) => {
        const text = chunk.textContent!;
        const first = text.charCodeAt(0);
        const last = text.charCodeAt(text.length - 1);
        return (first >= 0xdc00 && first <= 0xdfff) || (last >= 0xd800 && last <= 0xdbff);
      }),
      maxTokenLength: Math.max(...Array.from(code.querySelectorAll(".jf-string"), (token) => token.textContent!.length))
    }));
    assert.equal(actual.text, source);
    assert.equal(await page.locator(".jf-raw-code .jf-link").count(), 0,
      "Multi-megabyte URL-like strings must not create an unbounded href for each chunk.");
    assert.equal(actual.splitSurrogate, false);
    assert(actual.width <= 1280 && actual.maxTokenLength <= 4_096);
    await verifySelection(page, source, true);
    console.log("Raw edge cases passed: giant strings, Unicode boundaries and native compact-JSON copying.");
  } finally {
    await page.close();
  }
}
