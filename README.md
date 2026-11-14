<img src="src/assets/icon-128.png" alt="JSON Formatter icon" width="64" height="64">

# JSON Formatter for Chrome

Automatically format JSON responses or paste JSON into a dedicated tab. Everything is processed locally.

## Features

- Monokai syntax highlighting with light, dark, and system themes.
- Collapsible objects and arrays, expanded by default.
- Tree and Raw views with formatted or compact JSON copying.
- Clickable HTTP and HTTPS links that open in a new tab.
- Selection copying that preserves indentation and numeric precision.

## Installation

Requires Chrome 114 or later.

1. Download the `.zip` from the [latest release](https://github.com/alexvikman/json-formatter/releases/latest) and unpack it to a folder you keep; Chrome loads the extension from there.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the unpacked folder.
4. Pin **JSON Formatter** to the toolbar for easy access.

To update, replace the folder's contents with a newer release and reload the extension on `chrome://extensions`.

For local JSON files, enable **Allow access to file URLs** in the extension's details.

## Usage

Visit a JSON URL for automatic formatting, or click the extension button to paste JSON into a new tab. Press **Ctrl/Cmd+Enter** to format. Open **Settings** to change the theme.

Hold **Ctrl** (**Cmd** on Mac) while collapsing an object or array to collapse its siblings too.

A response is formatted when it is served as JSON (`application/json`, `text/json`, or a type ending in `+json`), or as plain text that contains only JSON.

## Privacy

JSON Formatter runs on every page so that it can recognize JSON responses, which is why Chrome lists it as having access to all sites. It only acts on JSON and plain-text responses, makes no network requests, and sends nothing anywhere. The one thing it stores is your theme choice, in Chrome's synced settings.

## For developers

Building from source, the tests, how the code is laid out and how releases are made: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## License

[MIT](LICENSE).
