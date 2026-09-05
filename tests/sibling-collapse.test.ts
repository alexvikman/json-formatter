import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Locator, Page } from "playwright-core";

const value = {
  group: {
    first: { firstChild: { id: 1 }, preservedChild: { id: 2 } },
    second: [{ arrayFirst: { id: 3 } }, [{ arraySecond: { id: 4 } }], 42, [], {}],
    third: { thirdChild: { id: 5 } },
    emptyObject: {},
    emptyArray: [],
    primitive: "unchanged"
  },
  independent: { otherA: { id: 6 }, otherB: [7] }
};
const source = JSON.stringify(value);

function container(page: Page, key: string): Locator {
  return page.locator(".jf-tree .jf-container-node").filter({
    has: page.locator(":scope > .jf-container-line > .jf-key")
      .filter({ hasText: new RegExp(`^${JSON.stringify(key)}$`) })
  });
}

function toggle(page: Page, key: string): Locator {
  return container(page, key).locator(":scope > .jf-container-line > .jf-toggle");
}

async function expectExpanded(element: Locator, expected: boolean): Promise<void> {
  assert.equal(await element.getAttribute("aria-expanded"), String(expected));
}

async function copyTree(page: Page): Promise<string> {
  return page.locator(".jf-tree").evaluate((tree) => {
    const range = document.createRange();
    range.selectNodeContents(tree);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new DataTransfer();
    tree.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true, clipboardData }));
    selection.removeAllRanges();
    return clipboardData.getData("text/plain");
  });
}

async function verifyDocument(page: Page): Promise<void> {
  const root = page.locator(".jf-tree > .jf-container-node > .jf-container-line > .jf-toggle");
  const expandAll = page.getByRole("button", { name: "Expand all", exact: true });
  await toggle(page, "first").click();
  await expectExpanded(toggle(page, "first"), false);
  await expectExpanded(toggle(page, "second"), true);
  await expectExpanded(toggle(page, "third"), true);

  for (const modifier of ["Control", "Meta"] as const) {
    await expandAll.click();
    await toggle(page, "preservedChild").click();
    await toggle(page, "third").click();
    assert.match((await toggle(page, "first").getAttribute("title"))!, /Ctrl\/Cmd\+click/);
    await toggle(page, "first").click({ modifiers: [modifier] });
    for (const key of ["first", "second", "third", "preservedChild"]) {
      await expectExpanded(toggle(page, key), false);
    }
    for (const key of ["group", "firstChild", "thirdChild", "independent", "otherA", "otherB"]) {
      await expectExpanded(toggle(page, key), true);
    }
    await expectExpanded(root, true);
    assert.equal(await copyTree(page), JSON.stringify(value, null, 2));

    // The modifier applies only when collapsing; expanding remains local.
    await toggle(page, "first").click({ modifiers: [modifier] });
    await expectExpanded(toggle(page, "first"), true);
    await expectExpanded(toggle(page, "firstChild"), true);
    await expectExpanded(toggle(page, "preservedChild"), false);
    await expectExpanded(toggle(page, "second"), false);
    await expectExpanded(toggle(page, "third"), false);

    await expandAll.click();
    const arrayItems = container(page, "second").locator(
      ":scope > .jf-children > .jf-container-node > .jf-container-line > .jf-toggle"
    );
    assert.equal(await arrayItems.count(), 2);
    await arrayItems.first().click({ modifiers: [modifier] });
    await expectExpanded(arrayItems.first(), false);
    await expectExpanded(arrayItems.nth(1), false);
    for (const key of ["first", "second", "third", "arrayFirst", "arraySecond", "otherA"]) {
      await expectExpanded(toggle(page, key), true);
    }

    await expandAll.click();
    await root.click({ modifiers: [modifier] });
    assert.equal(await page.locator(".is-collapsed").count(), 1, "The root has no siblings.");
    assert.equal(await copyTree(page), JSON.stringify(value, null, 2));
    await root.click();
    assert.equal(await page.locator(".is-collapsed").count(), 0);
  }

  await toggle(page, "first").click({ modifiers: ["Control"] });
  await page.getByRole("button", { name: "Raw", exact: true }).click();
  assert.equal(await page.locator(".jf-raw-code").textContent(), source);
  await page.getByRole("button", { name: "Tree", exact: true }).click();
  await expectExpanded(toggle(page, "first"), false);
  await expectExpanded(toggle(page, "second"), false);
}

async function verifyNestedChunks(page: Page): Promise<void> {
  const records = Array.from({ length: 65 }, (_unused, id) => ({
    id,
    items: id === 0 ? Array.from({ length: 65 }, (_unused, id) => ({ id })) : []
  }));
  await page.locator("#edit-button").click();
  await page.locator("#json-input").fill(JSON.stringify(records));
  await page.locator("#format-button").click();
  const outerChunks = page.locator(".jf-tree > .jf-container-node > .jf-children > .jf-render-chunk");
  const firstRecord = outerChunks.first().locator(":scope > .jf-container-node").first();
  const innerChunks = firstRecord.locator(":scope > .jf-children > .jf-container-node > .jf-children > .jf-render-chunk");
  assert.equal(await outerChunks.count(), 2);
  assert.equal(await innerChunks.count(), 2);
  const height = (chunk: Locator) => chunk.evaluate((element) => parseFloat((element as HTMLElement).style.containIntrinsicBlockSize));
  const originalHeight = await height(outerChunks.first());
  const otherHeight = await height(outerChunks.nth(1));
  const innerToggle = innerChunks.first().locator(":scope > .jf-container-node > .jf-container-line > .jf-toggle").first();
  await innerToggle.click({ modifiers: ["Control"] });
  assert.equal(await page.locator(".is-collapsed").count(), 65);
  assert.equal(await height(innerChunks.first()), 64 * 22);
  assert.equal(await height(innerChunks.nth(1)), 22);
  assert.equal(await height(outerChunks.first()), originalHeight - 65 * 2 * 22,
    "Collapsing siblings must also update their ancestor layout chunks.");
  assert.equal(await height(outerChunks.nth(1)), otherHeight);
  assert.equal(await copyTree(page), JSON.stringify(records, null, 2));
  await innerToggle.click({ modifiers: ["Meta"] });
  assert.equal(await page.locator(".is-collapsed").count(), 64);
  assert.equal(await height(outerChunks.first()), originalHeight - 64 * 2 * 22);
}

export async function verifySiblingCollapse(browser: Browser, extensionRoot: string): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end(source);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    await page.locator("#json-input").fill(source);
    await page.locator("#format-button").click();
    await verifyDocument(page);
    await verifyNestedChunks(page);

    const responsePage = await context.newPage();
    await responsePage.goto(`http://127.0.0.1:${address.port}/siblings.json`);
    await responsePage.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
    for (const name of ["theme", "json-renderer", "page-formatter"]) {
      await responsePage.addScriptTag({ path: join(extensionRoot, "scripts", `${name}.js`) });
    }
    await verifyDocument(responsePage);
    console.log("Sibling-collapse tests passed: Ctrl/Cmd, objects/arrays, independent branches, retained child state, copying and nested layout chunks in both formatters.");
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
