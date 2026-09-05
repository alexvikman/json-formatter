import { strict as assert } from "node:assert";
import { mkdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Browser, Page } from "playwright-core";

async function verifyExtensionIcons(page: Page, extensionRoot: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest.icons), ["16", "24", "32", "48", "128"]);
  assert.deepEqual(Object.keys(manifest.action.default_icon), ["16", "24", "32", "48"]);

  for (const [size, fileName] of Object.entries<string>(manifest.icons)) {
    if (size !== "128") {
      assert.equal(manifest.action.default_icon[size], fileName,
        "The toolbar and extension list must use the same icon.");
    }
    const png = await readFile(join(extensionRoot, fileName));
    assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10],
      "Chrome extension icons must be PNG assets.");
    const icon = await page.evaluate(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
      const center = (Math.floor(canvas.height / 2) * canvas.width + Math.floor(canvas.width / 2)) * 4;
      const whiteOnEachSide = [false, false];
      for (let offset = 0; offset < data.length; offset += 4) {
        if (data[offset] > 240 && data[offset + 1] > 200 && data[offset + 2] > 200 && data[offset + 3] > 200) {
          whiteOnEachSide[(offset / 4) % canvas.width < canvas.width / 2 ? 0 : 1] = true;
        }
      }
      return {
        width: canvas.width, height: canvas.height, cornerAlpha: data[3],
        center: [...data.slice(center, center + 4)], whiteOnEachSide
      };
    }, `data:image/png;base64,${png.toString("base64")}`);
    assert.deepEqual(icon, {
      width: Number(size), height: Number(size), cornerAlpha: 0,
      center: [249, 38, 114, 255], whiteOnEachSide: [true, true]
    }, `${fileName}: preserve the cerise background, white braces and transparent corners at the declared size.`);
  }
}

async function readBrand(page: Page) {
  return page.evaluate(() => {
    const properties = [
      "display", "align-items", "justify-content", "background-color", "background-image",
      "border-radius", "border-width", "box-shadow", "color", "font-family", "font-size",
      "font-weight", "line-height", "letter-spacing", "margin-top", "margin-bottom"
    ];
    const styleOf = (selector: string) => {
      const styles = getComputedStyle(document.querySelector(selector)!);
      return Object.fromEntries(properties.map((property) => [property, styles.getPropertyValue(property)]));
    };
    const icon = document.querySelector<HTMLElement>(".jf-brand-mark")!;
    const bounds = icon.getBoundingClientRect();
    const header = document.querySelector<HTMLElement>(".jf-app-header")!;
    return {
      header: styleOf(".jf-app-header"), icon: styleOf(".jf-brand-mark"),
      title: styleOf(".jf-brand-title"), subtitle: styleOf(".jf-brand-subtitle"),
      iconText: icon.textContent, iconHidden: icon.getAttribute("aria-hidden"),
      iconBounds: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      headerHeight: header.getBoundingClientRect().height
    };
  });
}

export async function verifyAppearance(browser: Browser, extensionRoot: string): Promise<void> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    response.end('{"name":"Example","active":true,"items":[1,2,3]}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
  try {
    const options = await context.newPage();
    const formatter = await context.newPage();
    const response = await context.newPage();
    const pages = { settings: options, formatter, response };
    const errors: string[] = [];
    for (const page of Object.values(pages)) {
      page.on("pageerror", (error) => errors.push(error.message));
    }
    await options.goto(pathToFileURL(join(extensionRoot, "options.html")).href);
    await verifyExtensionIcons(options, extensionRoot);
    await formatter.goto(pathToFileURL(join(extensionRoot, "formatter.html")).href);
    await response.goto(`http://127.0.0.1:${address.port}/example.json`);
    await response.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
    for (const name of ["theme", "json-renderer", "page-formatter"]) {
      await response.addScriptTag({ path: join(extensionRoot, "scripts", `${name}.js`) });
    }
    assert.doesNotMatch(await options.locator("body").innerText(), /popup/i);

    for (const theme of ["light", "dark"] as const) {
      for (const page of Object.values(pages)) {
        await page.emulateMedia({ colorScheme: theme });
        await page.waitForFunction((expected) => document.documentElement.dataset.jfTheme === expected, theme);
      }
      const expected = await readBrand(options);
      assert.equal(expected.iconText, "{ }");
      assert.equal(expected.iconHidden, "true");
      assert.equal(expected.iconBounds.width, 44);
      assert.equal(expected.iconBounds.height, 44);
      assert.equal(expected.icon["background-color"], "rgb(249, 38, 114)");
      assert.equal(expected.icon["background-image"], "none");
      assert.equal(expected.icon["border-radius"], "12px");
      assert.equal(expected.icon.color, "rgb(255, 255, 255)");
      assert.equal(expected.header["background-color"], theme === "light" ? "rgb(255, 255, 255)" : "rgb(39, 40, 34)");
      assert.equal(expected.headerHeight, 88);
      for (const [name, page] of Object.entries(pages)) {
        assert.deepEqual(await readBrand(page), expected,
          `${name}: icon, typography, alignment and header colors must match Settings in ${theme} mode.`);
        if (process.env.JF_APPEARANCE_SCREENSHOT_DIR) {
          await mkdir(process.env.JF_APPEARANCE_SCREENSHOT_DIR, { recursive: true });
          await page.screenshot({
            path: join(process.env.JF_APPEARANCE_SCREENSHOT_DIR, `appearance-${name}-${theme}.png`),
            animations: "disabled"
          });
        }
      }
    }

    for (const page of Object.values(pages)) {
      await page.setViewportSize({ width: 360, height: 740 });
      assert((await page.locator(".jf-brand-mark").boundingBox())!.width === 44,
        "Keep the icon size consistent even in a narrow window.");
      for (const selector of [".jf-brand-mark", ".jf-brand-title", ".jf-app-header button"]) {
        for (const element of await page.locator(selector).all()) {
          const bounds = await element.boundingBox();
          assert(bounds && bounds.x >= 0 && bounds.x + bounds.width <= 360,
            "The shared header and its controls must fit a narrow window.");
        }
      }
    }
    assert.deepEqual(errors, []);
    console.log("Appearance tests passed: cerise Chrome icons in all five sizes, matching headers in all three views, light/dark themes and narrow windows.");
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
