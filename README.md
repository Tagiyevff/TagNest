# TagNest

**A local-first AI workspace with a real Linux desktop inside it.**

[![CI](https://github.com/Tagiyevff/TagNest/actions/workflows/ci.yml/badge.svg)](https://github.com/Tagiyevff/TagNest/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Tagiyevff/TagNest?color=11181c&v=0.7.0)](https://github.com/Tagiyevff/TagNest/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-11181c.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-11181c)](README.md#requirements)

TagNest is an open-source desktop app for Windows 10/11. On the left, you talk to an AI agent.
On the right is a real Alpine Linux + XFCE desktop running locally in QEMU, streamed into the
window with noVNC. The agent can run commands, read and write files, start servers, drive a real
Chromium page and control the desktop with the mouse and keyboard — and you can take over at any
moment with your own mouse and keyboard.

There is no TagNest account, no TagNest server and no subscription. The Linux machine is yours,
on your computer, stored on your disk.

![TagNest](docs/tagnest-desktop.png)

> Screenshot captured from the real Electron window: an agent task on the left and the actual XFCE
> desktop on the right. See [docs/VALIDATION.md](docs/VALIDATION.md) for the checks that were
> actually executed, with their output and the things that were not tested.

## Install (Windows)

1. **Download the installer** from [Releases](https://github.com/Tagiyevff/TagNest/releases/latest):
   `TagNest-<version>-x64.exe`. Builds are produced and attached by the
   [Release workflow](.github/workflows/release.yml), so every binary comes from a tagged commit.
2. **Run TagNest.** If QEMU is missing, the Linux panel offers **Install QEMU**: it runs
   `winget install SoftwareFreedomConservancy.QEMU` and Windows shows its normal UAC prompt. You can
   still install it yourself with that command; TagNest does not redistribute QEMU.
3. The first launch downloads the Alpine base image, provisions the desktop and installs Firefox
   inside the guest (a few minutes, ≈250 MB of downloads). Chromium is installed the first time the
   agent uses a browser tool. Later launches boot straight to the desktop; your Linux files stay in
   `%APPDATA%\TagNest`. Auto-updates apply to the installed build and install on the next quit.
4. **Add a model** in Settings (gear icon): paste an OpenAI / Anthropic / Gemini / OpenRouter key,
   point it at a custom OpenAI-compatible endpoint, or select **Ollama (local)** for fully local
   inference. The app fetches the provider's real model list as soon as the key is saved — you pick
   from a dropdown instead of typing an ID. On OpenRouter, **Free — Automatic** selects a working
   free model for you. Keys are encrypted with the OS credential store and never leave your machine
   except as the request to the provider you chose.

The installer is **unsigned**, so Windows SmartScreen will show "unrecognised app" on first run.
Hardware virtualization (WHPX) is strongly recommended; without it TagNest explains the problem and
offers the slow software-emulation path.

Building from source instead: see [Quick start (development)](#quick-start-development) and
[docs/RELEASING.md](docs/RELEASING.md).

## Install (Android phone)

Download `TagNest-mobile-<version>.apk` from the same
[Releases page](https://github.com/Tagiyevff/TagNest/releases/latest) and install it (Android will
ask you to allow installs from your browser/file manager because the APK is sideloaded).

1. On the computer: **Settings → Phone access**, choose **Cloudflare quick tunnel** (works away
   from home, no account) and start it. Copy the address it shows.
2. In the app: enter that address, the 6-digit pairing code and a name for the phone.
3. Chat, approve commands and open the **Desktop** tab for the live Linux screen. Press the keyboard
   button above the desktop to send real key input to the guest.

TagNest keeps running in the system tray after you close its window while phone access is on, and it
blocks system sleep, so the phone keeps working. The quick-tunnel address changes when the computer
or TagNest restarts; use **Home network** on the same Wi-Fi or a **Custom URL** from a stable tunnel
for a permanent address. Full details: [mobile/README.md](mobile/README.md).

## Status

Early release (`0.7.0`). The Linux runtime, embedded desktop, agent tool loop, approvals and
settings are implemented and were exercised against a real VM. Typecheck, lint, 119 unit tests, the
production build and the real-VM smoke test pass. Provider adapters were tested against local mocks
of their real HTTP APIs, and the OpenAI-compatible path was additionally driven end to end against
a local router that forwards to a real hosted model — tool calls, file creation and read-back in the
guest all worked. The full agent loop — including web search, page fetch and opening a page in the
guest browser — was tested against a mock OpenAI-compatible server driving real guest commands and
real internet requests. See [docs/VALIDATION.md](docs/VALIDATION.md) for the exact results, including
what was **not** verified.

`0.7.0` adds **phone access**: a real Flutter Android app that pairs with the desktop, chats with
the same agent, approves commands and embeds the live Linux desktop; remote access runs over a
Cloudflare quick tunnel, the home network or your own stable URL, with per-device tokens and no
account. The desktop app stays in the tray while a phone is connected and blocks sleep.

`0.6.0` added a first-run checklist, automatic **restore points** before destructive agent commands
(disk-only, because WHPX cannot save RAM state), resumable Linux image downloads with real progress
and speed, and a redacted diagnostics report for support. `0.5.0` gave the agent a real browser: one
visible Chromium window it can navigate, read, click and type in — with a screenshot tool for vision
models — plus a one-click QEMU install and in-app automatic updates. `0.4.0` made model selection
automatic: each provider's real model list is loaded into a dropdown (right after the API key is
saved and on **Refresh**), and OpenRouter gets a **Free — Automatic** mode that selects and verifies
a currently working free model, falling back to the next one when a model refuses direct API
traffic. See [CHANGELOG.md](CHANGELOG.md).

## What works

- Split-panel UI: chat (≈29% width) + live Linux desktop (≈71%), responsive and independently scrollable.
- A real Alpine Linux 3.24 VM (QEMU, WHPX acceleration on Windows) provisioned automatically on
  first launch — no manual Linux install, no VM setup.
- Persistent qcow2 overlay disk: files written in Linux survive app and VM restarts.
- Real internet in the guest: it shares the computer's own connection through QEMU user-mode
  networking, so downloads, package installs and web pages behave like on the host.
- A real browser in the guest: Firefox is installed automatically on the first start after
  provisioning (one `apk` install, about 90 MB) and runs on the visible desktop.
- **Agent browser automation:** one visible Chromium window on the desktop, reused for the whole
  task. `browser_open` returns the real title, URL, visible text and numbered links/buttons/fields;
  `browser_read` re-reads after a change; `browser_click` and `browser_type` use real CDP mouse and
  keyboard events; `browser_screenshot` feeds the page to a vision model; `browser_back` and
  `browser_scroll` cover history and scrolling. `open_url` opens the same window, so watching the
  agent work is watching the actual page it is using.
- Agent internet tools: `web_search` (DuckDuckGo), `web_fetch` (URL → readable text) for fast,
  non-interactive reading.
- A structured system prompt (`src/main/agent/prompts.ts`) sent to every provider: who the agent is,
  the real guest facts, the full tool inventory, how to verify its own work and how to reply — so a
  fresh model starts useful instead of guessing.
- Embedded TigerVNC → WebSocket → noVNC display with mouse, keyboard, clipboard paste/copy and
  viewport scaling.
- **Phone access.** A pairing-code based remote server (HTTP + authenticated noVNC WebSocket) with
  three modes: Cloudflare quick tunnel (no account, works anywhere), home network, or a custom
  stable URL. Each phone gets its own revocable token, pairing is rate-limited, and turning remote
  access off stops the listener and the tunnel. The **Flutter Android app** (`mobile/`) is built and
  attached to every release; it has chat, approvals, task history, stop/retry and the embedded
  desktop with pointer and keyboard input. The desktop app moves to the system tray when its window
  is closed while phone access is on.
- **The agent can see the screen.** `desktop_screenshot` captures the real guest desktop and hands
  the PNG to a vision-capable model, so it can read a page, find a button and click it — verified
  end to end against a live model (see [docs/VALIDATION.md](docs/VALIDATION.md)).
- **Build real apps inside Linux.** Ask for an app and the agent creates a project under
  `~/workspace/apps/<name>` with `app_create`, writes and edits the files, runs its real test script
  with `app_test`, then starts it with `app_run`: web projects are served on a local port and opened
  in Firefox on the embedded desktop; CLI projects open in a terminal window. `app_list` shows the
  real state, URL and PID, and `app_stop` kills the process group. Starter projects include a small
  HTML/CSS/JS page and a shell CLI with their own tests, so a fresh model has a working baseline
  instead of inventing a build system.
- Agent tools that act on real state: shell commands, SFTP file read/write/edit/list/search,
  system inspection, background processes, and `xdotool` desktop control — move, single/double/right
  click, wheel scroll, type, key chords, list and focus windows, launch apps. The AI cursor is drawn
  over the desktop so every movement is visible.
- A visible AI cursor and activity indicator over the desktop.
- Explicit approval gates for `sudo`, package installs, service changes, downloads piped to a
  shell, GitHub pushes, recursive deletion and other high-impact commands.
- Cancellation for in-flight model calls and guest commands; aborting kills the guest process group,
  not just the SSH channel.
- Model providers: OpenAI, Anthropic, Google Gemini, OpenRouter, Ollama (local) and any custom
  OpenAI-compatible endpoint. Keys are encrypted with the OS credential store (DPAPI on Windows).
- **Automatic model discovery:** the settings screen calls the selected provider's real model-list
  endpoint after a key is saved (and on **Refresh**), shows the model name, ID, context and reported
  capabilities in a dropdown, and never asks the user to type an ID unless they choose **Custom
  model ID…**. The list is provider-scoped; switching providers fetches that provider's own list.
- **OpenRouter Free — Automatic:** one dropdown entry that fetches OpenRouter's free models, ranks
  the ones that report tool support and context size, and uses the first that actually answers. If
  one is rate-limited or restricted to a different harness (403/404/429), the agent and the
  connection test try the next free model and report the switch instead of failing silently.
- Local conversation history and task/tool logs; conversation JSON is stored in the app data dir.
- **File bridge:** drag files or folders from Windows onto the Linux panel, or open the file drawer
  in the panel to browse `~/workspace`, upload and save individual files back to Windows. Names are
  never overwritten and upload paths are confined to `~/workspace` (see below).
- Live guest memory, disk and load readings in the Linux panel (real values from `free`, `df` and
  `/proc/loadavg`, refreshed every 5 s while the VM runs).
- **Settings → Test connection:** sends one real, tiny request through the selected provider and
  reports the actual latency or the provider's error; no cached or invented success.
- **Settings → About:** checks the latest GitHub release and links to it when a newer version exists.
- English and Azerbaijani UI.
- Configurable VM memory/CPU count/disk size and automatic startup.
- **First-run checklist:** checks hardware virtualization, QEMU and the model configuration, offers
  the one-click QEMU install there, and explains the Windows feature needed for WHPX. It can be
  dismissed for the current version.
- **Restore points:** before an approved destructive command, the agent starts a live qcow2 snapshot
  of the Linux disk. The panel then offers **Restore** (discard everything written since the
  snapshot) and **Keep changes** (merge the snapshot and continue). Restore points survive an app
  restart.
- **Resumable Linux image download:** progress, speed and ETA in the panel; Stop cancels the
  download; if it is interrupted, the next start continues with an HTTP Range request instead of
  downloading the 150 MB image again. Bundled images are checksum-verified before use.
- **Diagnostics report:** Settings → About and the Linux panel save a text report with versions,
  runtime state, sanitized settings, provider key presence (never values) and log tails. API keys,
  the VNC token and the user's home path are removed.
- **One-click QEMU install** when the host has no emulator (winget + the Windows UAC prompt), and
  **automatic updates** for the installed build (background download, install on quit, status in
  the chat and Settings → About).

## Requirements

| | |
|---|---|
| OS | Windows 10/11 x64 (primary target). macOS/Linux run the UI and a slower TCG VM for development. |
| RAM | 8 GB total recommended; the VM defaults to 3 GB and is configurable (2–8 GB). |
| Disk | ~250 MB for the base image + ~1–2 GB for the installed desktop + your files, in the 20 GB (sparse) workspace disk. |
| CPU | Hardware virtualization (WHPX) strongly recommended. Software emulation (TCG) is very slow. |
| QEMU | Required on the host. TagNest can install it for you with one click (winget + UAC); you can also run `winget install SoftwareFreedomConservancy.QEMU` (QEMU 11 tested) or set `TAGNEST_QEMU` to the executable. |
| Internet | First launch downloads the pinned Alpine image and lets the guest install the desktop and Firefox (≈150 MB + ≈90 MB). After that the guest uses your connection like any other app, and model calls need the network (unless you use Ollama). |

QEMU is intentionally **not** committed to this repository; it is GPL software with its own
distribution requirements. If you ship installers, see [docs/LICENSING.md](docs/LICENSING.md).

## Working with files

Files cross the boundary through SFTP, not through a shared folder or a host mount. The guest
filesystem is not mounted on Windows, and the Windows filesystem is not mounted in Linux.

- **Copy in:** drop files or whole folders anywhere on the Linux desktop, or press the folder icon
  in the panel header and choose **Upload**. Files land in `~/workspace`; a folder keeps its name.
  Large uploads use the native file picker and SFTP `fastPut` rather than sending bytes through the
  renderer.
- **Copy out:** open the file drawer, navigate into a folder and press the download icon (or click a
  file) to save it anywhere on Windows through the system dialog.
- **Never overwritten:** if a file with the same name already exists, TagNest picks `name-1.ext`,
  `name-2.ext`, … instead of destroying the existing guest file.
- **Confined:** every browse/download path is resolved inside the guest and checked after symlink
  resolution, so a link cannot redirect the drawer to `/etc`. Upload names are stripped of `..`
  segments. Host folders are walked without following host symlinks.
- **Limits:** drag & drop accepts up to 200 files / 64 MB per drop; the native uploader accepts up
  to 500 files / 512 MB; downloads are capped at 512 MB per file. Larger files should be fetched in
  the guest or split first.
- The drawer only lists `~/workspace`. Files elsewhere in Linux are still reachable by the agent
  through `run_command`, as before.

## Quick start (development)

```bash
npm install
npm run dev
```

The Electron window opens. On first launch TagNest:

1. checks for QEMU and probes WHPX,
2. downloads the official Alpine 3.24 cloud image (≈150 MB) and verifies its SHA-512,
3. creates a 20 GB sparse qcow2 overlay,
4. boots the VM with cloud-init (seed served from the app over QEMU's user-mode network),
5. installs XFCE, TigerVNC, xdotool and an SSH key for the agent,
6. starts Xvnc + XFCE and attaches the display to the right-hand panel.

Provisioning takes a few minutes the first time. Later launches boot straight to the desktop.

Add an API key in **Settings** (gear icon), pick a model, then ask for something:

- "Create a small Express app in `~/workspace/demo` and start it on port 3000."
- "Search the web for the Alpine Linux wiki and open the result in the browser."
- "Open the terminal on the desktop and show the kernel version."
- "Find failing tests in `~/workspace/app` and fix them."

Or use a local model: install [Ollama](https://ollama.com), pull a model, select **Ollama (local)**
in Settings and pick the pulled model from the list (it comes from Ollama's `/api/tags`). Prompts
and tool results then stay on your machine.

## How it works

```
┌───────────────────────── Electron window ─────────────────────────┐
│ Renderer (React)                                                  │
│   ChatPanel                 LinuxPanel -> noVNC canvas            │
│        │ IPC (contextBridge, validated)      │ WebSocket          │
│ ───────┼─────────────────────────────────────┼──────────────────  │
│ Main process                                 │                    │
│   AgentRuntime ── providers (OpenAI, Anthropic, Gemini, …)        │
│        │ tool executor                       │                    │
│        │ SSH (exec + SFTP)                   │ token-gated proxy  │
│        ▼                                     ▼                    │
│   QEMU (WHPX, pc/qemu64)  ── hostfwd:22──►  guest sshd           │
│        │                     hostfwd:5901──►  Xvnc :1 + XFCE     │
│        └─ qcow2 overlay (persistent)          xdotool, files      │
└───────────────────────────────────────────────────────────────────┘
```

- The renderer has no Node access. `contextIsolation: true`, `sandbox: true`, a Content-Security
  Policy, navigations blocked, and a narrow typed API in `src/preload`.
- QEMU, SSH, VNC and filesystem control live only in the main process.
- The agent loop is in `src/main/agent/agent.ts`; providers implement one `complete()` interface.
- The guest is a normal QEMU VM. The host filesystem is not mounted into it, and QEMU's user-mode
  network is the only network path. SSH/VNC are forwarded to random loopback ports only.
- The VNC WebSocket proxy requires a per-session random token. The guest's Xvnc accepts unauthenticated
  RFB, but is reachable only through that loopback forward.

![The agent looking at the screen](docs/tagnest-vision.png)

> The agent took a screenshot, opened `alpinelinux.org` in the existing Firefox window, looked again
> and described the real page. Vision needs a model that accepts images (see Providers).

More detail: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Providers

| Provider | Endpoint | Auth | Privacy |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` Chat Completions | API key | prompts + tool results leave the machine |
| Anthropic | `https://api.anthropic.com/v1/messages` | API key | same |
| Gemini | `generativelanguage.googleapis.com` `generateContent` | API key | same |
| OpenRouter | `https://openrouter.ai/api/v1` | API key | same |
| Ollama | `http://127.0.0.1:11434/v1` | none | stays on your machine |
| Custom | your OpenAI-compatible base URL | optional | depends on the endpoint |

The model dropdown is populated from each provider's own API: `GET /models` for OpenAI and
OpenAI-compatible endpoints, `GET /v1/models` for Anthropic, `GET /models` for Gemini (keeping
`generateContent` models), `GET /models` for OpenRouter and `GET /api/tags` for Ollama. If a list
request fails, Settings shows that endpoint's real error and keeps the **Custom model ID…** fallback.

OpenRouter's **Free — Automatic** is not a hardcoded model ID. It filters the live model list for
free pricing/`:free` models, prefers tool-capable models with larger context, and treats 403, 404,
429 and 5xx as "try the next free model". The actual model that answered is written back to Settings
and shown as **Currently using: …**. This is a real fallback, not a claim that every free model is
usable: OpenRouter can restrict a listed free model to other apps, and the app moves on.

There is no invented fallback: if a provider is selected without a key or the request fails, the
error appears in the chat and no command is run. Keys never go to the renderer and are never logged.

Local OpenAI-compatible relays and routers are supported: the response body is read tolerantly, so a
router that appends an SSE `data: [DONE]` terminator after a non-streaming JSON reply still works.
If an endpoint answers with something that is not JSON at all, the chat reports the HTTP status,
content type and the first bytes instead of a raw parser error.

## Building and packaging

```bash
npm run build        # typecheck-free production bundle (electron-vite)
npm run typecheck
npm test
npm run lint
npm run package:win  # electron-builder NSIS installer in release/
```

The app icon and installer icon come from `build/icon.png` (1024×1024, generated from the TagNest
logo crop); the sidebar logo is `src/renderer/src/assets/logo.png`.

Native dependency rebuilding is disabled in the packaging config: ssh2's optional `cpu-features`
addon is not needed (ssh2 falls back to pure JavaScript), and its vendored gyp files are incomplete
in this environment. The packaged app includes the main/preload/renderer bundles and `resources/`
but **not** QEMU or a guest disk image.

Optional: bundle the Linux base image into the installer instead of downloading on first launch:

```bash
npm run provision:linux   # downloads + verifies resources/linux/alpine-*.qcow2
npm run package:win
```

`resources/linux/*.qcow2` is git-ignored. The VM's overlay always lives in the user data directory,
so upgrading or replacing the base image never deletes user files.

## Data locations

Windows: `%APPDATA%\TagNest`

```
settings.json          preferences (no secrets)
secrets.json           DPAPI-encrypted provider keys
conversations/*.json   chat history and tool results
linux/base/            verified Alpine base image
linux/disk/workspace.qcow2   persistent guest disk (your files)
linux/ssh/             agent SSH keypair
linux/logs/            QEMU serial console + stderr
logs/                  app log (redacted)
```

Delete `linux/disk/workspace.qcow2` only if you mean to destroy the Linux workspace.

## Testing

```bash
npm test             # unit tests: providers against mock HTTP APIs, policy, paths, storage, web helpers
npm run typecheck
npm run lint
npm run smoke:linux  # boots the real VM and verifies the runtime end to end
npm run smoke:agent  # agent loop against a scripted OpenAI-compatible endpoint: approvals, file
                     # tools, web_search / web_fetch / open_url against the real guest

cd mobile
flutter analyze      # Dart analyzer, zero issues
flutter test         # pairing screen, URL normalization, remote state parsing
flutter build apk --release
```

`smoke:linux` downloads/provisions on first use (`TAGNEST_SMOKE_CLEAN=1` to force a fresh
workspace). To reuse an existing workspace instead of provisioning another one:

```bash
# Windows PowerShell
$env:TAGNEST_SMOKE_DIR="$env:APPDATA\TagNest"; npm run smoke:linux
```

It runs real commands, writes/reads a file over SFTP, checks the 1440×900 X display and moves the
real guest mouse with `xdotool`, completes an RFB greeting through the token bridge, cancels a
running command (and checks it returns quickly without printing), restarts the VM, verifies the
file persisted and checks that no Windows host paths are mounted. The recorded run: **PASS**,
94.9 s total, 30.3 s restart, 425 ms cancellation. See [docs/VALIDATION.md](docs/VALIDATION.md).

## Known limitations

- **First launch is not instant.** No prebuilt TagNest image is committed or hosted in this
  repository (it would be hundreds of MB to over a GB). The app downloads the pinned official
  Alpine cloud image, boots it, lets cloud-init apply the seed, and installs XFCE/TigerVNC inside
  the guest. On this machine that took about six minutes on a cold workspace; later boots took
  about 30 seconds. The build supports bundling a prebuilt base image in the installer
  (`resources/linux/*.qcow2` via `npm run provision:linux`), which a release should do; that path
  was not built or tested here.
- **Windows/WHPX first.** Without WHPX the VM falls back to TCG. The pinned Alpine 6.18 kernel
  panicked under TCG on the development machine, so software emulation is not a reliable fallback.
  TagNest reports the problem and the serial log instead of pretending it works. Enabling Windows
  Hypervisor Platform is the supported fix.
- QEMU is expected on the host; the repo does not redistribute QEMU binaries. The app installs it
  with winget on request, and the first-run checklist offers that too.
- **Restore points are disk-only and require a reboot to apply.** WHPX refuses QEMU RAM snapshots
  (`savevm` reports missing dirty-memory-tracking support), so a restore point protects the Linux
  filesystem, not running processes. Restoring or keeping the changes stops the VM, moves/merges the
  overlay and boots it again (about 15–45 s in the real-VM test). Only one restore point is kept at
  a time.
- **Quick-tunnel addresses are temporary.** Cloudflare quick tunnels do not need an account but get a
  new `https://…trycloudflare.com` name whenever the tunnel restarts, so after a computer reboot the
  phone must be re-pointed. Keep TagNest running (it stays in the tray) or use Home network / Custom
  URL with a named Cloudflare Tunnel for a permanent address. A remote session also needs the
  computer awake and TagNest running; phone access blocks app suspension but a laptop lid can still
  suspend the machine depending on its power plan.
- **The Android app is sideloaded.** It is not on Google Play, release builds are signed with the
  project's release key, and Android will warn about installing from outside the store. iOS is not
  built.
- The NSIS installer builds (`release/TagNest-0.7.0-x64.exe`, ≈120 MB). The packaged `win-unpacked`
  app was launched for earlier versions (it reported its version and opened the checklist) but install/uninstall was
  not exercised on a clean Windows machine. It is unsigned, so Windows SmartScreen will warn, and
  automatic updates from an unsigned build still show that warning when the installer runs.
- The one-click QEMU install was not executed in validation because QEMU was already installed. The
  fixed winget command, UAC prompt and post-install verification are implemented and typechecked,
  and the checklist offers the same path; see [docs/VALIDATION.md](docs/VALIDATION.md).
- Drag & drop was verified with a real DOM drop event (file bytes through the preload bridge and
  SFTP), not by dragging from Explorer with the OS pointer. The download flow's dialog is covered by
  a unit test with a mocked dialog; the native Save dialog was not clicked in the validation run.
- The desktop is scaled to the panel; dynamic guest resolution changes are not implemented. The
  guest screen is fixed at 1440×900 (VNC viewport scaling keeps it usable).
- **Vision needs a vision-capable model.** `desktop_screenshot` and `browser_screenshot` send a real
  PNG to the provider, so the selected model must accept images (e.g. a multimodal
  OpenAI/Anthropic/Gemini model, or a vision model on your local router). A text-only model answers
  without seeing the image or rejects the request; that error is shown in the chat. Very large
  screenshots are capped at 4 MB.
- **Browser automation covers normal web pages, not every browser surface.** It drives one Chromium
  window with CDP: navigation, DOM text, element refs, mouse clicks, typing, screenshots, history
  and wheel scrolling. Native file pickers, cross-origin iframes, browser-internal pages
  (`chrome://…`), PDFs and pages that block automation can fail or be invisible; the tool reports
  the real error. A page that renders only inside a canvas is readable through
  `browser_screenshot`, not through text. Chromium is installed on first use (internet required,
  adds a few hundred MB to the guest disk); Firefox stays available for `open_url` fallback and
  `launch_app browser`.
- App projects are deliberately small: `web` is plain HTML/CSS/JS served by the guest's Python
  `http.server`, and `cli` is a shell program in a terminal. Native GUI toolkits (GTK/Qt), packaged
  desktop bundles and app-store style distribution are not scaffolded; the agent can still install
  a toolkit and build one manually, but it is not a turnkey template.
- Web app projects need a free local port (1024–65535, default 8080) and a running VM. The agent
  checks the port before creating and before starting, but two projects can share a default port
  while stopped; start them on different ports.
- Hosted provider calls were not exercised with live keys in this environment; see VALIDATION.
- Automatic updates only run in the packaged Windows build. The update feed requires a published
  release with `latest.yml`; development checkouts show a "not active" status instead of pretending
  to update.
- Clipboard transfer and proportional guest-resolution changes are implemented but were not
  exercised in the validation run.
- Guest isolation is strong (a VM) but not a certified security boundary. See SECURITY.
- Azerbaijani translations are complete for UI strings but not professionally reviewed.

## License

MIT for TagNest's own code. QEMU, Alpine, XFCE, TigerVNC and other components keep their own
licenses — see [LICENSE](LICENSE) and [docs/LICENSING.md](docs/LICENSING.md).
