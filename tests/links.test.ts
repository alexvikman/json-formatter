import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Locator, Page } from "playwright-core";

declare global {
  interface Window {
    __linkClipboard?: string;
  }
}

async function copySelection(element: Locator): Promise<string> {
  return element.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
}

async function verifyDragSelection(page: Page, link: Locator, expected: string): Promise<void> {
  await link.scrollIntoViewIfNeeded();
  const points = await link.evaluate((element) => {
    const text = element.firstChild!;
    const caret = (offset: number) => {
      const range = document.createRange();
      range.setStart(text, offset);
      range.collapse(true);
      const rect = range.getBoundingClientRect();
      return { x: rect.x + 0.1, y: rect.y + rect.height / 2 };
    };
    return { start: caret(2), end: caret(15) };
  });
  const pagesBefore = page.context().pages().length;
  await page.mouse.move(points.start.x, points.start.y);
  await page.mouse.down();
  await page.mouse.move(points.end.x, points.end.y, { steps: 8 });
  await page.mouse.up();
  const copied = await link.evaluate((element) => {
    const selection = window.getSelection()!;
    const selected = selection.toString();
    const clipboardData = new DataTransfer();
    element.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return { selected, copied: clipboardData.getData("text/plain") };
  });
  assert.equal(copied.selected, expected.slice(2, 15));
  assert.equal(copied.copied, copied.selected);
  assert.equal(page.context().pages().length, pagesBefore, "Selecting link text must not open a tab.");
}

async function verifyDocument(page: Page, values: object, urls: string[]): Promise<void> {
  const formatted = JSON.stringify(values, null, 2);
  const compact = JSON.stringify(values);
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { window.__linkClipboard = text; } }
    });
  });
  for (const mode of ["Tree", "Raw"] as const) {
    await page.getByRole("button", { name: mode, exact: true }).click();
    const viewer = page.locator(mode === "Tree" ? ".jf-tree" : ".jf-raw-code");
    const links = viewer.locator("a.jf-link");
    const actual = await links.evaluateAll((elements) => elements.map((element: HTMLAnchorElement) => ({
      href: element.href, text: element.textContent, target: element.target,
      rel: element.rel, draggable: element.draggable
    })));
    assert.deepEqual(actual.map((link) => link.href), urls.map((url) => new URL(url).href));
    assert.deepEqual(actual.map((link) => link.text), urls.map((url) => JSON.stringify(url).slice(1, -1)),
      "Links must display the JSON-escaped value, with quotes outside the anchor.");
    for (const link of actual) {
      assert.equal(link.target, "_blank");
      assert.equal(link.rel, "noopener noreferrer");
      assert.equal(link.draggable, false);
    }
    assert.equal(await viewer.locator("img, script, iframe").count(), 0);
    const expectedCopy = mode === "Tree" ? formatted : compact;
    assert.equal(await copySelection(viewer), expectedCopy);
    assert.equal(await copySelection(links.first()), urls[0]);
    await page.getByRole("button", { name: mode === "Tree" ? "Copy formatted" : "Copy raw", exact: true }).click();
    assert.equal(await page.evaluate(() => window.__linkClipboard), expectedCopy);
    if (mode === "Raw") assert.equal(await viewer.textContent(), compact);

    for (const theme of ["light", "dark"]) {
      await page.evaluate((theme) => document.documentElement.setAttribute("data-jf-theme", theme), theme);
      const colors = await links.first().evaluate((element) => ({
        link: getComputedStyle(element).color,
        string: getComputedStyle(element.parentElement!).color,
        decoration: getComputedStyle(element).textDecorationLine
      }));
      assert.equal(colors.link, colors.string, "Links must retain the theme's JSON string color.");
      assert.equal(colors.decoration, "underline");
    }
    await verifyDragSelection(page, links.first(), urls[0]);

    // Only navigate to the local test server; external example links are never opened.
    const originalUrl = page.url();
    const opened = page.context().waitForEvent("page");
    if (mode === "Tree") await links.first().click();
    else await links.first().press("Enter");
    const destination = await opened;
    try {
      await destination.waitForLoadState();
      assert.equal(destination.url(), urls[0]);
      assert.equal(await destination.evaluate(() => window.opener), null);
      assert.equal(page.url(), originalUrl);
    } finally {
      await destination.close();
    }
    if (mode === "Tree") {
      await viewer.locator(".jf-toggle").nth(1).click();
      assert.equal(await copySelection(viewer), formatted, "Folded URL arrays must retain their full text when copied.");
      await page.getByRole("button", { name: "Expand all", exact: true }).click();
    }
  }
}

export async function verifyLinks(browser: Browser, extensionRoot: string): Promise<void> {
  let source = "";
  const referrers: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    if (request.url?.startsWith("/opened")) {
      referrers.push(request.headers.referer);
      response.writeHead(200, { "Content-Type": "text/html" });
      response.end("<!doctype html><title>Link destination</title><p>Opened</p>");
    } else {
      response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      response.end(source);
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const urls = [
    `${base}/opened?q=1&next=2#done`,
    "https://example.test/search?q=a%20b&next=%2F#section",
    "HTTPS://EXAMPLE.TEST/upper-case",
    'https://example.test/\"><img/src=x/onerror=alert(1)>',
    "https://räksmörgås.example/漢字/😀"
  ];
  const values = {
    urls,
    plain: [
      "javascript:alert(1)", "data:text/html,<script>alert(1)</script>",
      "file:///example.json", "chrome://settings", "mailto:person@example.test",
      "//example.test/path", "/relative", "http://", "https://[broken",
      "See https://example.test/ for details", " https://example.test/",
      "https://example.test/path with spaces", "https://example.test/\npath"
    ],
    "https://example.test/key": "Keys remain text",
    nested: { enabled: true, count: 42, nothing: null }
  };
  source = JSON.stringify(values);
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    await page.locator("#json-input").fill(source);
    await page.locator("#format-button").click();
    await verifyDocument(page, values, urls);

    const responsePage = await context.newPage();
    await responsePage.goto(`${base}/links.json`);
    await responsePage.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
    for (const name of ["theme", "json-renderer", "page-formatter"]) {
      await responsePage.addScriptTag({ path: join(extensionRoot, "scripts", `${name}.js`) });
    }
    await verifyDocument(responsePage, values, urls);
    assert.deepEqual(referrers, [undefined, undefined, undefined, undefined],
      "Following a link must not disclose the JSON document's URL.");

    const prefix = "https://example.test/";
    const longUrl = prefix + "x".repeat(4_094 - prefix.length) + "😀" + "x".repeat(100);
    const escaped = String.raw`"\u0068ttps:\/\/example.test\/path?q=\u0026\u0022quoted\u0022"`;
    for (const raw of [JSON.stringify(longUrl), escaped]) {
      const expectedUrl = JSON.parse(raw) as string;
      const rendered = await page.evaluate((raw) => {
        const tree = window.JsonFormatterRenderer.render(JSON.parse(raw)).element;
        const code = window.JsonFormatterRenderer.renderRaw(raw);
        const links = code.querySelectorAll<HTMLAnchorElement>(".jf-link");
        document.body.appendChild(code);
        const selection = window.getSelection()!;
        const range = document.createRange();
        range.setStart(links[0].firstChild!, 2);
        range.setEnd(links[links.length - 1].firstChild!, links[links.length - 1].textContent!.length - 2);
        selection.removeAllRanges();
        selection.addRange(range);
        const clipboardData = new DataTransfer();
        code.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
        selection.removeAllRanges();
        code.remove();
        return {
          treeText: tree.textContent,
          treeHref: tree.querySelector<HTMLAnchorElement>(".jf-link")?.href,
          rawText: code.textContent,
          partialCopy: clipboardData.getData("text/plain"),
          links: Array.from(code.querySelectorAll<HTMLAnchorElement>(".jf-link"), (link) => ({
            href: link.href, text: link.textContent
          })),
          chunks: Array.from(code.querySelectorAll(".jf-raw-chunk"), (chunk) => chunk.textContent!)
        };
      }, raw);
      assert.equal(rendered.treeText, JSON.stringify(expectedUrl));
      assert.equal(rendered.treeHref, new URL(expectedUrl).href);
      assert.equal(rendered.rawText, raw);
      assert.equal(rendered.partialCopy, raw.slice(3, -3), "Copying across linked chunks must preserve JSON escapes and Unicode.");
      assert.equal(rendered.links.map((link) => link.text).join(""), raw.slice(1, -1));
      assert(rendered.links.every((link) => link.href === new URL(expectedUrl).href));
      assert(rendered.chunks.every((chunk) => chunk.length <= 4_096));
      assert(rendered.chunks.every((chunk) => !/[\ud800-\udbff]$/.test(chunk) && !/^[\udc00-\udfff]/.test(chunk)));
      if (expectedUrl === longUrl) assert(rendered.links.length > 1, "Long Raw links must remain chunked.");
    }
    console.log("Link tests passed: HTTP/HTTPS, safe new tabs, mouse/keyboard activation, selection/copy, themes, escapes and chunked URLs in both formatters.");
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
