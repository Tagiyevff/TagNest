# Changelog

All notable changes to TagNest are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.2.0 — 2026-10-28

### Added

- **Windows ↔ Linux file bridge.** Drop files or folders onto the Linux panel, or use the new
  **Linux files** drawer (folder icon in the panel header) to browse `~/workspace`, upload through
  the native picker and save files back to Windows.
  - Drag & drop accepts up to 200 files / 64 MB per drop; the native uploader accepts up to
    500 files / 512 MB; downloads are capped at 512 MB per file.
  - Existing guest files are never overwritten: the bridge picks `name-1.ext`, `name-2.ext`, …
  - Browse and download paths are resolved with `realpath` inside the guest and must stay under
    `/home/tagnest/workspace`; upload paths reject `..` segments.
- **Live guest resources.** The Linux panel header shows real memory and disk usage percentages
  (from `free` and `df` in the guest) with a tooltip containing the absolute values, the guest
  load average and the uptime. Refreshes every 5 seconds only while the VM runs.
- **Provider connection test.** Settings → *Test connection* sends one real, tiny chat request
  through the selected provider, model, endpoint and stored key, and shows the measured latency or
  the provider's actual error (401, 404, rate limit, unreachable local server).
- **Update check.** Settings → *About TagNest* shows the current version, queries the latest GitHub
  release and links to its notes when a newer version exists. It reports rate limits and network
  failures instead of pretending to be up to date.
- `CHANGELOG.md`, README “Working with files”, architecture notes for the bridge and IPC validation
  schemas for the new channels.

### Changed

- `AppSnapshot` now includes the application version so the renderer can show it.
- `GuestClient` gained `writeBuffer`, `uploadFile`, `downloadFile` and `realpath`.
- `LinuxRuntime.getStats()` caches guest readings for four seconds and keys the cache on the boot
  timestamp, so a restarted VM cannot show stale values from the previous boot.
- The Azerbaijani and English dictionaries cover every new string.

### Fixed

- In-flight tests and settings now surface the real backend error text instead of Electron's
  `Error invoking remote method …` prefix (the file drawer and Settings use the same cleanup).

## 0.1.0 — 2026-10-27

Initial public release: local QEMU Alpine Linux desktop embedded with noVNC, agent tool loop with
approvals and cancellation, vision-based desktop control, Firefox and internet tools, six model
providers, OS-encrypted keys, English/Azerbaijani UI, NSIS build and GitHub release workflow.
