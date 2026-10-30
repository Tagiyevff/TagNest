# Changelog

All notable changes to TagNest are recorded here. The project follows
[Semantic Versioning](https://semver.org/).

## 0.7.0 — 2026-10-30

### Added

- **Phone access.** TagNest can now be controlled from an Android phone on the same network or from
  anywhere through a Cloudflare quick tunnel. A pairing code creates a per-device token; the phone
  gets the same chat, tool output, approval prompts, task history, stop/retry and the live Linux
  desktop. The remote server exposes only the agent API and an authenticated noVNC WebSocket — not
  SSH, the QEMU monitor or the raw VNC port.
- **A real Flutter mobile app** (`mobile/`). Pairing screen, chat with expandable tool cards,
  approval cards, task list, Linux start control, and an embedded desktop with pointer taps/drags,
  scrolling and a keyboard panel. The release workflow builds a signed APK and attaches it next to
  the Windows installer; CI analyzes, tests and builds it on every push.
- **Three access modes** in Settings → Phone access: **Cloudflare quick tunnel** (no account, works
  away from home), **Home network** (LAN address) and **Custom URL** (your own named tunnel or
  reverse proxy). The pinned `cloudflared.exe` is downloaded once and SHA-256-verified; the tunnel
  process is stopped when access is turned off.
- **Remote access survives a restart.** The enabled state and mode are persisted and restored on
  launch. While phone access is on, closing the window hides TagNest to the system tray instead of
  quitting, and system sleep is blocked so the phone keeps its connection.
- **Desktop keyboard input on the phone.** A keyboard button above the embedded desktop opens a
  text field and sends real key events to the focused guest window; taps and drags use real RFB
  pointer events.
- QEMU's missing-install flow and the first-run checklist now cover the phone-access step; the
  release notes and `mobile/README.md` document pairing, modes and signing.

### Changed

- Browser and desktop tools share one visible Chromium window, and the remote view reuses the same
  token-protected noVNC bridge as the desktop panel.
- The version is now `0.7.0` for both the Electron app and the Android app (`0.7.0+7`).

### Security

- Pairing codes expire after 15 minutes, are rate-limited and compared in constant time; only a
  SHA-256 hash of each device token is stored. Remote API responses are `no-store`, mutations reject
  cross-origin browser requests, and the noVNC upgrade requires the same device token. This is
  documented in [docs/SECURITY.md](docs/SECURITY.md).
- Android release signing is configured from repository secrets; keystores and `key.properties` are
  git-ignored and never committed.

## 0.6.0 — 2026-10-30

### Added

- **First-run checklist.** A dismissible dialog checks hardware virtualization, QEMU and the model
  configuration before the first task. It offers the one-click QEMU install in place, links to
  Settings for a missing key/model, and explains the exact Windows features needed for WHPX.
  "Don't show again" is remembered per app version.
- **Restore points before destructive commands.** After approval and before an approved destructive
  command runs, the agent starts a live qcow2 snapshot with QMP `blockdev-snapshot-sync`. The Linux
  panel shows the restore point and offers **Restore** (drop the overlay and boot the untouched
  disk) and **Keep changes** (commit the overlay into the parent). Restore points persist across app
  restarts; only one is kept at a time.
- **Resumable Linux image download.** Progress now includes real download speed, Stop cancels an
  in-flight download, and an interrupted download keeps its `.part` file. The next start sends an
  HTTP Range request and verifies the final SHA-512. Bundled images are checksum-verified before
  they are trusted. Content-Range parsing has unit tests.
- **Diagnostics report.** A single text file with versions, runtime state, sanitized settings,
  whether each provider has a stored key (never the key), disk sizes and log tails. API keys, the
  VNC token and the home/data paths are redacted. Available from Settings → About and the Linux
  panel; saved through the native Save dialog.
- Stop is available while the image is downloading or the guest is provisioning, not only while the
  desktop is running.

### Changed

- The guest disk is attached with `node-name=disk`, and the QEMU control channel uses QMP on a
  random loopback port, so live snapshots can target the real block device.
- Restore-point actions report QEMU's actual failure instead of claiming success when the host
  cannot snapshot.

### Fixed

- An interrupted base-image download used to be deleted and restarted from zero; the partial file is
  now kept and resumed.
- A bundled base image was trusted without hashing it; it is now verified and falls back to a fresh
  download if the hash does not match.
- QEMU's RAM snapshot was investigated and is not usable with WHPX ("State blocked due to missing
  dirty memory tracking support"); the implementation was changed to disk-only checkpoints rather
  than shipping a button that always fails.

## 0.5.0 — 2026-10-29

### Added

- **The agent can drive a real browser.** A dedicated Chromium window runs on the Linux desktop and
  is reused for the whole task, so "open Firefox" followed by "open YouTube" no longer leaves two
  windows and the agent can act on the page it just opened. Seven new tools:
  - `browser_open` — navigate and return the real title, URL, visible text and numbered elements.
  - `browser_read` — re-read the current page and its elements after a change.
  - `browser_click` — click by ref, CSS selector or visible text using real CDP mouse events.
  - `browser_type` — focus a field and insert real keyboard text, optionally press Enter.
  - `browser_screenshot` — capture the page and hand the PNG to a vision model.
  - `browser_back` / `browser_scroll` — history and real wheel scrolling.
  `open_url` now opens the same window, and `launch_app browser` uses it; Firefox remains the
  fallback when the automation browser cannot start.
- **QEMU one-click install.** When `qemu-system-x86_64` is missing, the Linux panel offers
  **Install QEMU** instead of only a manual command. It runs the fixed winget package
  `SoftwareFreedomConservancy.QEMU`, lets Windows show its own UAC prompt, verifies the binary and
  then starts Linux automatically. Failures (winget missing, UAC cancelled, timeout, package not
  found) are reported verbatim in the panel.
- **Automatic updates in installed builds.** `electron-updater` checks GitHub Releases 10 seconds
  after launch and every 6 hours, downloads in the background and installs on quit. The chat shows
  a download/ready strip, and Settings → About has the live status and a **Restart and install**
  action. Development checkouts report that automatic updates are only active in the installed app.
- The release workflow now attaches `latest.yml`, which electron-updater needs.
- 8 unit tests for element-ref parsing, element ranking, URL validation and page-text rewriting;
  97 tests in total.

### Changed

- Browser output lists interactive elements before free text, so a model reads the controls and the
  page content in the order it needs them.
- The system prompt documents the browser workflow (`browser_open` → read → click/type → re-read)
  and tells the agent to reuse the visible window instead of spawning more browsers.
- Guest provisioning installs `socat` and Chromium's runtime dependencies; Chromium itself is
  installed lazily on first browser use.

### Fixed

- Chromium opened the Linux keyring password dialog on first start, which blocked the renderer and
  made every CDP page command time out. It now starts with `--password-store=basic` and
  `--use-mock-keychain`.
- Chromium's DevTools port binds only to guest loopback, while QEMU's host forward reaches the
  guest's NAT address; a guest-side `socat` bridge connects the two, and the host still exposes the
  port only on loopback.
- A stale Chromium profile lock from a killed VM made the next launch hang; the browser now removes
  its own singleton lock and starts cleanly after an unclean shutdown.
- Portrait-shaped elements (tall links/buttons) are ranked correctly when building refs.

## 0.4.0 — 2026-10-28

### Added

- **Automatic model discovery.** Saving an API key now fetches the provider's real model list and
  fills a model dropdown; no model ID has to be typed. Supported sources:
  - OpenAI and custom OpenAI-compatible servers: `GET /models`
  - Anthropic: `GET /v1/models` with pagination
  - Google Gemini: `GET /models`, keeping models whose `supportedGenerationMethods` includes
    `generateContent`
  - OpenRouter: `GET /models`, including free-model metadata
  - Ollama: `GET /api/tags`
- A **Refresh** button re-fetches the list; replacing or clearing a key also reloads/clears it. Lists
  are provider-scoped and are never mixed.
- Model options show the display name, real ID, context window and capabilities when the provider
  reports them. The selected model's details appear below the selector.
- A **Custom model ID…** fallback for servers that do not expose a model list. It is optional; the
  normal path never requires typing an ID.
- **OpenRouter Free — Automatic.** The model dropdown gains a `Free — Automatic` entry. Selecting it
  fetches OpenRouter's live free models, ranks tool-capable models with the largest context first,
  and starts with the top candidate, switching automatically if it refuses the request. The Settings
  panel shows `Currently using: <real-model-id>`.
- Free-model fallback in both the agent and **Test connection**: 403, 404, 429 and 5xx from one free
  model move on to the next candidate (up to eight), with real status values. The agent shows
  "Free model unavailable, trying …" while switching and a notice with the model that answered.
- The actual free model that answered is persisted back to settings and broadcast to the renderer,
  so the footer and `Currently using` stay truthful.
- `provider:models` IPC channel with zod-validated settings access and `onSettings` renderer event.
- 15 new unit tests for the OpenAI, Anthropic, Gemini, OpenRouter and Ollama parsers, model URL/auth
  handling, free ranking, free fallback and the free-automatic connection test.

### Changed

- `AppSettings` and `SettingsView` now carry `modelMode: 'manual' | 'free-auto'`; existing settings
  files load as `manual`, and switching away from OpenRouter resets the mode.
- The chat footer displays **Free — Automatic** instead of the internal free-model ID; the real ID is
  available in Settings and on the assistant message.
- Settings no longer remounts on every model change; model lists and local fields stay stable while
  the backend broadcasts settings updates.

### Fixed

- A free OpenRouter model can be listed as free yet return HTTP 403 ("only available on agentic
  harnesses"). The old single-model path failed immediately; both the test and the agent now try the
  next ranked free model and report the real result.

## 0.3.0 — 2026-10-28

### Added

- **Linux app projects.** The agent can build, test and run a real application inside the guest
  instead of only editing loose files.
  - `app_create` scaffolds a project in `~/workspace/apps/<name>` from a `web` or `cli` template,
    with a title, optional port, starter source, README and test script.
  - `app_test` runs the project's real `sh test.sh` and returns its actual stdout, stderr and exit
    code. Failures are reported as failures; nothing is marked passed without a zero exit code.
  - `app_run` starts web projects with Python's `http.server` on a local port, waits for the URL to
    answer, opens it in Firefox on the embedded desktop and verifies that a browser window is
    visible. CLI projects open in a real `xfce4-terminal` window. It returns the real PID and URL.
  - `app_list` and `app_stop` expose project state and kill the whole process group on stop.
  - Starters include a clickable HTML/CSS/JS demo and a shell CLI, each with tests that pass out of
    the box, so the model starts from working code and changes it.
- A fourth empty-chat suggestion for building and running a small Linux app, in English and
  Azerbaijani.
- The system prompt now has an explicit “Building an app inside Linux” workflow: create, edit, test,
  fix, run, screenshot and report the real result.
- 10 unit tests for app-name/port validation, template contents, metadata parsing, HTML escaping and
  path confinement.

### Fixed

- Added `DISPLAY=:1` when opening a CLI project terminal, so `xfce4-terminal` does not fail with
  “cannot open display”.
- The first web-server implementation used `busybox httpd`, which is not present in the pinned
  Alpine image. It now uses the preinstalled Python 3 `http.server`, and the real-VM smoke test
  checks the served HTML before and after stopping the app.

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
