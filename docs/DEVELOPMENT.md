# Developing JSON Formatter

JSON Formatter is a Manifest V3 Chrome extension written in TypeScript, built with Bun and Tailwind CSS. It has no runtime dependencies: every dependency is a build or test tool.

## Building

Requires Node.js 24+ and pnpm 11.19.0. Bun is installed with the other dependencies.

```sh
pnpm install --frozen-lockfile
pnpm run build
```

The build type-checks the code, bundles it and writes the extension to `dist/`, which is ignored by Git. To load it, open `chrome://extensions`, enable **Developer mode**, click **Load unpacked** and select `dist/`. Reload the extension there after rebuilding.

```sh
pnpm run watch       # Rebuild on source changes
pnpm run build:dev   # One development build: unminified, with source maps
pnpm run typecheck   # Type-check the extension, the build tools and the tests
pnpm run icons       # Regenerate the PNG icons after editing src/assets/icon.svg
pnpm run clean       # Remove generated files
```

Development builds are named "JSON Formatter (Development)" and cannot be packaged.

The build tools run TypeScript and Tailwind CSS with Node.js, found through pnpm or the `PATH`. Set `JF_NODE_EXECUTABLE` to choose another.

## Tests

```sh
pnpm run test              # Build and run browser tests
pnpm run test:performance  # Benchmark the local 5 MB fixture
```

Tests use an installed Chrome browser. Set `JF_CHROME_PATH` for a custom installation. The performance test uses the [local fixtures](../tests/fixtures/README.md) and saves results to `.performance/results.json`.

## Checks

[`ci.yml`](../.github/workflows/ci.yml) runs on every push and pull request: it installs the locked dependencies, fails on known vulnerabilities of high severity or worse (`pnpm audit`), then builds, type-checks and tests.

Dependencies are pinned by `pnpm-lock.yaml`. [Dependabot](../.github/dependabot.yml) proposes updates of them and of the GitHub Actions once a week, a week after a version is published; security updates are not delayed.

## Releases and security

[RELEASING.md](RELEASING.md) describes how a release is made and signed, and how the repository is set up on GitHub. [SECURITY.md](SECURITY.md) describes what the extension may do in the browser and how untrusted JSON is handled.

## Layout

| Path | Contents |
|---|---|
| `src/manifest.json` | The extension's manifest: permissions, content security policy, content script |
| `src/formatter.html`, `src/options.html` | The formatter tab and the settings page |
| `src/scripts/json-renderer.ts` | Parsing that keeps numbers exact, and the Tree and Raw views |
| `src/scripts/page-formatter.ts` | The content script that formats JSON responses |
| `src/scripts/formatter.ts`, `options.ts`, `theme.ts` | The formatter tab, the settings page, and the theme shared by all views |
| `src/scripts/background.ts` | The service worker: opens the formatter tab from the toolbar button |
| `src/styles/` | CSS, compiled with Tailwind |
| `src/assets/` | The icon artwork and the PNG sizes made from it |
| `task/` | Build tools: build, watch, type-check, test runner and packaging |
| `tests/` | Browser tests and their fixtures |
| `docs/` | Development, releasing and security notes |
