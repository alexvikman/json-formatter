# Chrome Web Store listing

What goes into the Developer Dashboard, tab by tab. Text in code blocks is pasted as it stands. The store takes the name and the short summary from `manifest.json` in the package, so they are not entered here.

## Package

Upload `release/json-formatter-<version>.zip`, the same file that is attached to the GitHub release.

## Store listing

**Description**

```text
JSON Formatter makes JSON readable. Open a URL that returns JSON and it is shown as a highlighted, collapsible tree instead of a wall of text. You can also click the toolbar button and paste JSON into a tab of its own.

FEATURES
• Formats JSON responses automatically, with nothing to click.
• Collapsible objects and arrays, expanded by default. Hold Ctrl (Cmd on Mac) while collapsing to collapse the siblings too.
• Tree and Raw views, and one-click copying of formatted or compact JSON.
• Monokai syntax highlighting with light, dark and system themes.
• String values that are http or https URLs are clickable and open in a new tab.
• Large numbers keep every digit, and copied selections keep their indentation.
• A separate tab for pasting JSON. Press Ctrl/Cmd+Enter to format.

WHEN A PAGE IS FORMATTED
A response is formatted when it is served as JSON (application/json, text/json, or a type ending in +json), or as plain text that contains only JSON. Other pages are left untouched. For local JSON files, turn on "Allow access to file URLs" in the extension's details.

PRIVACY
Everything is processed locally in your browser. The extension makes no network requests, has no analytics and sends nothing anywhere. It runs on every page only so that it can recognize JSON responses, which is why Chrome lists it as having access to all sites. The one thing it stores is your theme choice, in Chrome's synced settings.

OPEN SOURCE
MIT licensed. Source code, issues and release notes: https://github.com/alexvikman/json-formatter
```

**Category:** Developer Tools

**Language:** English

**Store icon (128×128):** `src/assets/icon-128.png`

**Screenshots (1280×800), in this order:**

1. `store/screenshots/1-json-response-dark.png`
2. `store/screenshots/2-json-response-light-collapsed.png`
3. `store/screenshots/3-paste-json-dark.png`
4. `store/screenshots/4-pasted-json-formatted-light.png`
5. `store/screenshots/5-settings-dark.png`

A spare, in case one is to be replaced: `store/screenshots/extra-raw-view-dark.png`.

The screenshots show the released package in a 1024×640 viewport at a device scale factor of 1.25, which gives 1280×800 pixels.

**Small promo tile (440×280, optional):** `store/promo-tile-440x280.png`

**Homepage URL**

```text
https://github.com/alexvikman/json-formatter
```

**Support URL**

```text
https://github.com/alexvikman/json-formatter/issues
```

**Mature content:** No

## Privacy practices

**Single purpose**

```text
Formats JSON so that it is easy to read. JSON responses opened in a tab, and JSON pasted into the extension's own tab, are shown as a syntax-highlighted, collapsible tree.
```

**Justification for the `storage` permission**

```text
Stores a single setting, the user's theme choice (system, light or dark), in chrome.storage.sync so that it applies to the formatter tab and to formatted JSON pages. Nothing else is stored.
```

**Host permission justification**

```text
The content script matches http, https and file URLs because a JSON response can come from any address, and whether a response is JSON is only known once it has loaded. On each page the script checks the document's content type and stops unless the response is JSON (application/json, text/json or a +json type) or a plain-text document that contains only JSON. Ordinary web pages are never read or changed. Formatting has to happen automatically when a JSON URL is opened, so activeTab is not enough. The extension makes no network requests and sends no data anywhere. file URLs work only if the user turns on "Allow access to file URLs".
```

**Remote code:** No, I am not using remote code.

**Data usage:** tick no data category. The extension reads JSON only to show it locally and passes nothing on; the theme choice is not user data in the store's sense. Certify the three statements below the list (no selling of data, no use outside the single purpose, no use for creditworthiness).

**Privacy policy URL (optional when no data is collected)**

```text
https://github.com/alexvikman/json-formatter#privacy
```

## Distribution

- **Payment:** free
- **Visibility:** Public
- **Regions:** All regions

## Test instructions (optional tab)

```text
No account or setup is needed.
1. Open a URL that returns JSON, for example https://api.github.com/ . The response is shown as a formatted tree.
2. Click the extension's toolbar button, paste any JSON and press "Format JSON".
3. The theme is changed with the Settings button in that tab.
```
