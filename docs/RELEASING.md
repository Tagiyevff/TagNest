# Releasing TagNest

TagNest ships as a Windows NSIS installer built by `electron-builder` and an Android APK built by
Flutter, both published to [GitHub Releases](https://github.com/Tagiyevff/TagNest/releases) by the
`Release` workflow.

## What the workflow does

[`.github/workflows/release.yml`](../.github/workflows/release.yml) runs on `windows-latest` for
every `v*` tag:

1. **Mobile job:** `flutter pub get`, `flutter analyze`, `flutter test`, decode the Android signing
   secrets, `flutter build apk --release` → `TagNest-mobile-<version>.apk`.
2. **Windows job:** `npm ci`, `npm run typecheck`, `npm run lint`, `npm test`, and
   `npm run package:win` → `release/TagNest-<version>-x64.exe` (plus `.blockmap` and `latest.yml`).
3. Downloads the APK artifact, uploads both as workflow artifacts and, for tags, creates a GitHub
   Release with generated notes, the installer, the APK and `SHA256SUMS.txt`.

`workflow_dispatch` builds the installer without creating a Release — use it to check a packaging
change before tagging.

## Cutting a release

```bash
# 1. Bump both versions (the tag must match each one)
npm version patch --no-git-tag-version   # or minor / major
# edit mobile/pubspec.yaml: version: <same>+<build>

# 2. Commit and tag
git commit -am "release: 0.1.1"
git tag v0.1.1

# 3. Publish
git push origin main --tags
```

The Windows job verifies that the tag, `package.json` and `mobile/pubspec.yaml` all have the same
version before packaging, so a mismatched mobile version fails the release.

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
**not** QEMU and **not** the Linux disk image. The APK is a separate release asset:

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

The Windows release is **unsigned** today, so SmartScreen shows "unrecognised app" until the binary
earns reputation. To sign, add the certificate as repository secrets and pass it to `electron-builder`
through `CSC_LINK` (`base64`-encoded `.pfx`) and `CSC_KEY_PASSWORD`. Never commit a certificate.

Android releases are signed with a project key stored outside the repository. The workflow expects
four repository secrets:

| Secret | Value |
|---|---|
| `ANDROID_KEYSTORE_BASE64` | `base64` of the `.jks` file |
| `ANDROID_KEYSTORE_PASSWORD` | keystore password |
| `ANDROID_KEY_ALIAS` | key alias (currently `tagnest`) |
| `ANDROID_KEY_PASSWORD` | key password |

The job writes `mobile/android/tagnest-release.jks` and `mobile/android/key.properties`; both paths
are git-ignored. Without the secrets the job warns and builds a debug-signed APK, which Android will
not install over an existing release-signed app. Back up the keystore and passwords somewhere safe:
losing them means every future APK needs a new package signature / uninstall.

## Version numbers

`package.json` `version` is the single source of truth: it appears in the installer filename
(`TagNest-<version>-x64.exe`), in the window and in the Release tag. Tags are `v<version>`.
