# Security

What JSON Formatter may do in the browser, how it handles JSON it cannot trust, and how that is checked. Kept up to date with the code.

## What the extension may do

- **One permission**, `storage`, for the theme. The stored value is only ever read as `system`, `light` or `dark`.
- **One content script**, on `http`, `https` and, when the user allows it, `file` pages. That is how JSON responses are found. It runs in the top frame only and in its own world, apart from the page's scripts.
- **Nothing else**: no host permissions, no resources that web pages can load, no messaging with pages or other extensions, and no network requests.

## JSON is untrusted

A response can come from anyone, so nothing in it is ever run or read as markup.

- **Text only.** Keys and values are put on the page as text, never as HTML.
- **Only the browser's text viewer is replaced.** A response is formatted when its type is `application/json`, `text/json`, their `x-json` forms, or ends in `+json`; or when it is `text/plain`, is a bare text document, starts with `{` or `[`, and parses. The browser shows all of these without running scripts. A type that merely contains "json" is left alone.
- **Links.** A string value becomes a link only when the whole value is an `http` or `https` URL, at most 16,384 characters, without whitespace or control characters and without a user name or password in it. Keys never become links. Links open in a new tab that cannot reach the JSON page and is not told its address.
- **Copying** needs a click. The extension has no permission to write to the clipboard by itself.

## Extension pages

The formatter tab and the settings page run under a content security policy that allows the extension's own scripts, styles and images and nothing else: no inline code, no evaluated strings, no connections, no frames and no forms. The pages contain no inline scripts, styles or event handlers.

## Not guarded against

A program or another extension that already controls the user's browser can read and change what JSON Formatter shows. A link goes where the JSON says; the address is shown in full, and it is the user who chooses to follow it.

## Checking it

`pnpm run test` checks this on the built extension: [`security.test.ts`](../tests/security.test.ts) the manifest, the policy, the absence of inline and remote code and the response types; [`links.test.ts`](../tests/links.test.ts) which values become links and that following one discloses nothing. [`package.test.ts`](../tests/package.test.ts) checks the signature, that the archive holds only the built files, and that a stray key stops packaging.

The tests load the pages from files, where the manifest's policy does not apply, so they check that the build contains nothing the policy forbids. To see the policy itself at work, load `dist/` in Chrome.

The build tools are checked for known vulnerabilities in CI and kept current by Dependabot; see [DEVELOPMENT.md](DEVELOPMENT.md). How the repository and the signing key are protected is in [RELEASING.md](RELEASING.md).
