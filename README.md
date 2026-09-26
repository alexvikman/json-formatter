<img src="assets/icon-128.png" alt="JSON Formatter icon" width="64" height="64">

# JSON Formatter for Chrome

Automatically format JSON responses or paste JSON into a dedicated tab. Everything is processed locally.

## Features

- Monokai syntax highlighting with light, dark, and system themes.
- Collapsible objects and arrays, expanded by default.
- Tree and Raw views with formatted or compact JSON copying.
- Clickable HTTP and HTTPS links that open in a new tab.
- Selection copying that preserves indentation and numeric precision.

## Installation

Requires Chrome 114+, Node.js 24+, and pnpm 11.19.0.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the generated `dist/` directory.
3. Pin **JSON Formatter** to the toolbar for easy access.

For local JSON files, enable **Allow access to file URLs** in the extension's details.

## Usage

Visit a JSON URL for automatic formatting, or click the extension button to paste JSON into a new tab. Press **Ctrl/Cmd+Enter** to format. Open **Settings** to change the theme.

Hold **Ctrl** (**Cmd** on Mac) while collapsing an object or array to collapse its siblings too.

## Development

Built with TypeScript, Bun, and Tailwind CSS.

```sh
pnpm run watch             # Rebuild on source changes
pnpm run test              # Build and run browser tests
pnpm run test:performance  # Benchmark the local 5 MB fixture
```

Reload the extension in Chrome after rebuilding. Build output is written to `dist/`, which is ignored by Git.

Tests use an installed Chrome browser. Set `JF_CHROME_PATH` for a custom installation. The performance test uses the [local fixtures](tests/fixtures/README.md) and saves results to `.performance/results.json`.

## Packaging

```sh
pnpm run package
```

Builds a signed `.crx` and a `.zip` in `release/`.
The first local run creates `.keys/json-formatter.pem`; later runs reuse it.
Back up this private key and never publish it: it preserves the extension's identity across updates.
To use an existing key, set `JF_SIGNING_KEY_PATH` to its PEM file.

## License

[MIT](LICENSE).
