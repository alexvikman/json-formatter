# Releasing JSON Formatter

How a release is made and signed, and how the repository is set up on GitHub.

## Making a release

1. Set the new version in `package.json` and `src/manifest.json`, and commit it as "Bump version.".
2. Build and sign the packages:

   ```sh
   pnpm run package
   ```

3. Push `main` and publish a GitHub release tagged with the bare version, with both packages attached:

   ```sh
   git push origin main
   gh release create 1.1.2 release/json-formatter-1.1.2.crx release/json-formatter-1.1.2.zip --title 1.1.2 --generate-notes
   ```

`pnpm run package` makes a production build and writes two files to `release/`, which is ignored by Git:

- `json-formatter-<version>.crx`, the extension signed with the key below.
- `json-formatter-<version>.zip`, exactly the archive that was signed, with `manifest.json` at its root. It is what the README tells users to install.

Packaging the same build again gives the same files. It refuses a development build, and any private key, source file, source map, hidden file or link among the extension's files.

## The signing key

The first local run creates `.keys/json-formatter.pem`; later runs reuse it. Back up this private key and never publish it: it preserves the extension's identity across updates. To use an existing key, set `JF_SIGNING_KEY_PATH` to its PEM file.

The released extension's ID is `efmnkdncdpnopieemobahioefjjnjele`. `pnpm run package` prints the ID of what it signed; a release must show this one.

On another computer or a fresh clone, put the key back before packaging. Without it a new key is made, and with it a new ID, unless `release/` already holds a `.crx` or the build runs in CI: then packaging stops instead.

Git ignores `.keys/` and every `*.pem` and `*.key` file. The key is used only on the developer's computer: CI builds and tests, but never sees the key and makes no release.

## Once, on GitHub

- **Actions** (Settings, Actions, General): only actions by GitHub and `pnpm/action-setup` allowed, every action pinned to a full commit SHA, workflow permissions read-only, and approval required for workflows from all outside contributors. A workflow that uses another action is refused until the action is added to the list.
- **Branch protection for `main`** (Settings, Branches): `main` cannot be deleted or force-pushed, and the `verify` check of [`ci.yml`](../.github/workflows/ci.yml) must pass before a pull request is merged. Administrators are exempt, so the owner still pushes to `main`. If the job is renamed, the required check must be renamed with it.
- **Dependabot** (in the repository's security settings): alerts and security updates on. Version updates follow [`dependabot.yml`](../.github/dependabot.yml).
- **Secret scanning** with push protection: on.

The repository holds no secrets, and no workflow needs one.
