import { readFile } from "node:fs/promises";
import path from "node:path";
import { chromium } from "playwright-core";

// PNGs are checked in; run `pnpm icons` after editing src/assets/icon.svg.
// Ordinary builds only copy the assets and do not need a browser.
const assetsDirectory = path.resolve(import.meta.dirname, "..", "src", "assets");
const source = await readFile(path.join(assetsDirectory, "icon.svg"), "utf8");
const browser = await chromium.launch({
  channel: "chrome",
  executablePath: process.env.JF_CHROME_PATH || undefined,
  headless: true
});

try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html><html><head><style>
    body { margin: 0; }
    svg { display: block; width: 100vw; height: 100vh; }
  </style></head><body>${source}</body></html>`);

  for (const size of [16, 24, 32, 48, 128]) {
    await page.setViewportSize({ width: size, height: size });
    await page.screenshot({
      path: path.join(assetsDirectory, `icon-${size}.png`),
      omitBackground: true,
      animations: "disabled"
    });
  }
  console.log("Generated extension icons in 16, 24, 32, 48 and 128 px.");
} finally {
  await browser.close();
}
