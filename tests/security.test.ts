import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import type { Browser } from "playwright-core";

const json = '{"formatted":true}';
// The response formatter may only replace the browser's script-less text viewer.
const responses: Array<[contentType: string, body: string, formatted: boolean]> = [
  ["application/json", json, true],
  ["application/json; charset=utf-8", json, true],
  ["application/ld+json", json, true],
  ["application/vnd.api+json", json, true],
  ["text/json", json, true],
  ["text/x-json", json, true],
  ["text/plain", json, true],
  ["text/plain", "Not JSON", false],
  // Types that merely contain "json", and markup that can run page scripts.
  ["text/json+xml", json, false],
  ["text/html", `<!doctype html><title>Page</title><body>${json}</body>`, false],
  ["application/xhtml+xml",
    `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Page</title></head><body>${json}</body></html>`, false]
];

async function verifyManifest(extensionRoot: string): Promise<void> {
  const manifest = JSON.parse(await readFile(join(extensionRoot, "manifest.json"), "utf8"));
  assert.deepEqual(manifest.permissions, ["storage"], "Copying needs a click, not the clipboardWrite permission.");
  for (const key of ["host_permissions", "optional_permissions", "optional_host_permissions",
    "web_accessible_resources", "externally_connectable", "sandbox"]) {
    assert.equal(key in manifest, false, `The manifest must not declare ${key}.`);
  }
  for (const script of manifest.content_scripts) {
    assert.equal(script.all_frames ?? false, false, "Content scripts must stay in the top frame.");
    assert.equal(script.world ?? "ISOLATED", "ISOLATED", "Content scripts must stay in the isolated world.");
  }
  const policy = new Map((manifest.content_security_policy.extension_pages as string).split(";").map((directive) => {
    const [name, ...values] = directive.trim().split(/\s+/);
    return [name, values.join(" ")] as const;
  }));
  assert.deepEqual(Object.fromEntries(policy), {
    "default-src": "'none'",
    "script-src": "'self'",
    "style-src": "'self'",
    "img-src": "'self'",
    "base-uri": "'none'",
    "form-action": "'none'",
    "frame-ancestors": "'none'"
  }, "Extension pages must keep their restrictive content security policy.");
}

// Extension pages are tested from file URLs, where the manifest's policy does not
// apply. Check statically that nothing in the build depends on what it forbids.
async function verifyBuiltFiles(extensionRoot: string): Promise<void> {
  for (const name of await readdir(extensionRoot, { recursive: true })) {
    if (name.endsWith(".html")) {
      const html = await readFile(join(extensionRoot, name), "utf8");
      assert.doesNotMatch(html, /<style|\sstyle\s*=|\son[a-z]+\s*=|javascript:|:\/\//i,
        `${name} must not contain inline styles, inline handlers or remote references.`);
      for (const [tag] of html.matchAll(/<script\b[^>]*>[^<]*/gi)) {
        assert.match(tag, /^<script src="scripts\/[\w-]+\.js">$/, `${name} must only load packaged scripts.`);
      }
    } else if (name.endsWith(".js")) {
      const script = await readFile(join(extensionRoot, name), "utf8");
      assert.doesNotMatch(script,
        /\b(?:eval|Function|fetch|XMLHttpRequest|WebSocket|EventSource|importScripts)\s*\(|\.(?:innerHTML|outerHTML|insertAdjacentHTML|sendBeacon)\b|document\.write/,
        `${name} must not evaluate strings, parse HTML from data or make network requests.`);
    } else if (name.endsWith(".css")) {
      assert.doesNotMatch(await readFile(join(extensionRoot, name), "utf8"), /url\(|@import/i,
        `${name} must not load external resources.`);
    }
  }
}

export async function verifySecurity(browser: Browser, extensionRoot: string): Promise<void> {
  await verifyManifest(extensionRoot);
  await verifyBuiltFiles(extensionRoot);

  const server = createServer((request, response) => {
    // Markup pages also request a favicon.
    const [contentType, body] = responses[Number(request.url!.slice(1))] ?? [];
    response.writeHead(body === undefined ? 404 : 200, { "Content-Type": contentType ?? "text/plain" });
    response.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const context = await browser.newContext();
  try {
    for (const [index, [contentType, , formatted]] of responses.entries()) {
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${address.port}/${index}`);
      await page.addStyleTag({ path: join(extensionRoot, "styles", "page.css") });
      for (const name of ["theme", "json-renderer", "page-formatter"]) {
        await page.addScriptTag({ path: join(extensionRoot, "scripts", `${name}.js`) });
      }
      assert.equal(await page.locator(".jf-page-app").count(), Number(formatted),
        `${contentType} responses must ${formatted ? "" : "not "}be formatted.`);
      await page.close();
    }
    console.log("Security tests passed: minimal permissions, restrictive page policy, no inline or remote code, and exact JSON content types.");
  } finally {
    await context.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}
