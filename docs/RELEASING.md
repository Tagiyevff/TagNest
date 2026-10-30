# Releasing TagNest

TagNest ships as a Windows NSIS installer built by `electron-builder` and published to
[GitHub Releases](https://github.com/Tagiyevff/TagNest/releases) by the `Release` workflow.

## What the workflow does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on `windows-latest` for
every `v*` tag:

1. `npm ci`, `npm run typecheck`, `npm run lint`, `npm test` — a release never goes out on a red
   build.
2. `npm run package:win` → `release/TagNest-<version>-x64.exe` (plus its `.blockmap` and
   `latest.yml`).
3. Uploads the files as a workflow artifact and, for tags, creates a GitHub Release with generated
   notes and the installer attached.

`workflow_dispatch` builds the installer without creating a Release — use it to check a packaging
change before tagging.

## Cutting a release

```bash
# 1. Bump the version (keeps package.json and the tag in sync)
npm version patch --no-git-tag-version   # or minor / major

# 2. Commit and tag
git commit -am "release: 0.1.1"
git tag v0.1.1

# 3. Publish
git push origin main --tags
```

The `Release` workflow builds for roughly 6–10 minutes. When it finishes, the installer appears at
`https://github.com/Tagiyevff/TagNest/releases/latest`.

Nothing else has to be uploaded by hand. Do not attach build output from your own machine — CI is
the only place release binaries come from, so a release always corresponds to a commit.

## Local packaging check

```bash
npm run package:win
```

Output lands in `release/`, which is git-ignored. The app is launched from
`release/win-unpacked/TagNest.exe`, so a smoke test before tagging is cheap:

```bash
npm run build && npx electron-builder --win --x64 --dir --publish never
```

## What is inside the installer

The installer contains the main/preload/renderer bundles, `resources/` and `build/icon.png`, and
**not** QEMU and **not** the Linux disk image:

| Component | How it gets to the user |
|---|---|
| QEMU | The app offers a one-click install (`winget install SoftwareFreedomConservancy.QEMU` with the normal UAC prompt), or the user installs it themselves. Not redistributed here — see [LICENSING.md](LICENSING.md). |
| Alpine base image | Downloaded from the pinned `dl.alpinelinux.org` URL on first launch and verified against a SHA-512 digest. |
| XFCE, TigerVNC, Firefox | Installed inside the guest on first boot with `apk`. |
| User data | Always outside the install directory, in `%APPDATA%\TagNest`. |

To ship an installer that already contains the base image:

```bash
npm run provision:linux   # downloads + verifies resources/linux/alpine-*.qcow2
npm run package:win
```

That makes the installer roughly 150 MB larger and means you are redistributing the Alpine image —
read the "Distribution checklist" in [LICENSING.md](LICENSING.md) first.

## Automatic updates

`electron-updater` reads `latest.yml`, the installer and its `.blockmap` from the **latest published
GitHub Release**. The workflow attaches all three, so no separate update server exists. Two rules
matter for releases:

- Never publish a release without `latest.yml`; installed apps would report an error instead of
  updating.
- The feed uses the public GitHub API and the release must not be a prerelease if it should be
  offered. Tag pushes are normal releases.

The downloaded update is checksum-verified from `latest.yml`, but the installer is unsigned, so
Authenticode verification is not a guarantee. Code signing also removes the SmartScreen warning
when the downloaded installer runs.

## Code signing

The release is **unsigned** today, so Windows SmartScreen shows "unrecognised app" until the binary
earns reputation. To sign, add the certificate as repository secrets and pass it to `electron-builder`
through `CSC_LINK` (`base64`-encoded `.pfx`) and `CSC_KEY_PASSWORD`. Never commit a certificate.

## Version numbers

`package.json` `version` is the single source of truth: it appears in the installer filename
(`TagNest-<version>-x64.exe`), in the window and in the Release tag. Tags are `v<version>`.
