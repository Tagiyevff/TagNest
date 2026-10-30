# Architecture

TagNest is an Electron application with three strict layers: renderer UI, trusted main process,
and a local Linux VM. The renderer can never spawn processes or read files directly.

```
src/
  shared/            renderer-safe types, IPC schemas (zod), channels.ts, constants
  preload/           contextBridge surface, no business logic; imports channels.ts only
                     (a sandboxed preload cannot require zod or other external modules)
  main/
    index.ts         window, CSP, lifecycle, auto-start
    ipc.ts           validated IPC handlers
    logger.ts        redacted file log
    storage/         settings, DPAPI secrets, conversations (atomic JSON)
    linux/
      config.ts      pinned Alpine image URL + SHA-512
      provision.ts   image download/verify, qcow2 overlay, SSH keys, cloud-init seed server
      guest.ts       first-boot provisioning script (cloud-init user-data)
      qemu.ts        binary discovery, WHPX probe, acceleration fallback
      qemu-install.ts fixed winget install with the Windows UAC prompt
      runtime.ts     lifecycle state machine, boot/provision/ready detection
      ssh.ts         SSH exec + SFTP wrapper, cancellation, output limits
      vnc.ts         token-authenticated WebSocket→TCP RFB bridge
      browser.ts     Chromium lifecycle, CDP client, page text and element refs
    agent/
      agent.ts       task loop, tool execution, approvals, cancellation, persistence
      tools.ts       tool schemas + real guest implementations
      policy.ts      command risk classifier
      workspace.ts   file-tool path confinement
      prompts.ts     system prompt
      provider-test.ts  one real request to the configured provider
      providers/     OpenAI-compatible, Anthropic, Gemini adapters
    updates.ts       GitHub Releases check + semver comparison
    auto-update.ts   electron-updater controller (packaged Windows builds)
    apps/
      projects.ts    Linux app projects: templates, metadata, test, run and stop
    workspace/
      files.ts       Windows↔Linux SFTP bridge, listing and symlink-safe checks
  renderer/
    src/App.tsx      app state, IPC subscriptions, approvals
    src/components/  ChatPanel, LinuxPanel (noVNC), SettingsDialog, tool/approval UI
    src/i18n.ts      English + Azerbaijani dictionaries
```

## Boot sequence

1. `LinuxRuntime.start()` resolves QEMU (`TAGNEST_QEMU_DIR`, bundled `resources/qemu`,
   `C:\Program Files\qemu`, PATH) and probes WHPX by launching a paused 128 MB VM. Failure falls
   back to TCG with an explicit warning.
2. `LinuxProvisioner.ensureBaseImage()` prefers `TAGNEST_BASE_IMAGE`, then a bundled image, then a
   checksum-protected download to the user data directory.
3. `ensureDisk()` creates a qcow2 overlay backed by the base image. Existing overlays are never
   recreated. Because the overlay is the user's data, the base can be replaced safely.
4. A per-install SSH keypair is generated (`ssh2.utils.generateKeyPairSync`).
5. A loopback HTTP server serves cloud-init `network-config`, `meta-data`, `user-data` and an empty
   `vendor-data`. QEMU is told `-smbios type=1,serial=ds=nocloud;s=http://10.0.2.2:<port>/`; the
   guest reaches the host through QEMU's user-mode network. Serving a valid `network-config` matters:
   a 404 there makes some cloud-init versions abandon the seed and spend minutes probing public
   cloud metadata endpoints before retrying.
6. QEMU starts headless with `-machine pc -accel whpx -cpu qemu64`, virtio disk/NIC, and loopback
   forwards for SSH (random port → 22) and VNC (random port → 5901).
7. On a fresh disk main waits up to 15 minutes for SSH (cloud-init datasource discovery plus the
   guest's first package install). The provisioning script starts sshd before the large XFCE
   install, so the runtime can supervise it: `/var/lib/tagnest-provisioned` is polled for up to 30
   minutes, and the guest reports `wget .../progress?step=packages|account|desktop|done`.
8. It waits for Xvnc, and for `xfwm4` (window manager) via SSH — so "running" means a real session,
   not just a listening port. On the way it runs an idempotent repair: `/run/tagnest` lives on
   tmpfs, so it is recreated with the guest user as owner and the desktop service is restarted if
   Xvnc is not running. It also (re)installs the guest-side `tagnest-open` helper and, when Firefox
   is missing (older workspaces), runs one `apk add firefox`; the guest reaches the Alpine mirror
   over the computer's own connection.
9. The VNC bridge URL is handed to the renderer; noVNC attaches.

On subsequent boots cloud-init keeps its instance id, so provisioning is skipped; the same overlay
disk is reused. The completion marker (not just the JSON state file) is authoritative, so an
interrupted first launch does not produce a false “provisioned” result. If provisioning fails, a new
instance id forces cloud-init to retry on the next start. Observed timings on the test machine:
≈6 minutes cold (download + cloud-init + desktop install), ≈30 seconds once provisioned.

## Display and input

- Guest: TigerVNC `Xvnc :1` (no RFB auth, bound inside the guest) plus an XFCE session via
  `dbus-run-session`.
- Host: QEMU forwards guest 5901 to a random loopback port. `VncBridge` listens on another random
  loopback port, checks `?token=<random>` on the WebSocket upgrade, and pipes bytes to the VNC port.
- Renderer: noVNC RFB with `scaleViewport`, pointer/keyboard forwarding, guest clipboard events, and
  a paste action. `xdotool` drives the same display for the agent; the UI places an AI cursor
  marker using the tool's coordinates mapped onto the actual letterboxed canvas rectangle.

## File bridge

The renderer never reads or writes host files directly. Two paths exist:

- **Drag & drop:** Chromium hands the renderer `File` objects. The renderer reads their bytes
  (`arrayBuffer`), walks dropped folders with `webkitGetAsEntry`, applies caps (200 files / 64 MB)
  and sends `{ name, relativePath, data }` over IPC. The main process validates the relative path,
  creates missing folders in the guest, and writes through SFTP. No host path string is accepted, so
  a compromised renderer cannot ask the main process to read an arbitrary file.
- **Native dialog:** the renderer asks main to show `dialog.showOpenDialog`; the chosen host paths
  stay in the main process and are copied with SFTP `fastPut`. Downloads use `showSaveDialog` and
  `fastGet`. These are the only operations that touch host paths, and they always follow an explicit
  user action in a system dialog.

`workspace/files.ts` confines every browse/download request to `GUEST_WORKSPACE` twice: the lexical
check in `resolveWorkspacePath` and a `realpath` check over SFTP, so a symlink inside the workspace
cannot escape. Upload destinations are sanitized segment-by-segment; traversal is rejected. A name
that already exists gets `-1`, `-2`, … instead of being overwritten. Host folders are walked with
`readdir(..., { withFileTypes: true })` and symlinks are skipped.

The Linux panel's file drawer calls `workspace:list` and shows directories first. The header's live
memory/disk/load readings come from `runtime:stats`, which runs `free`, `df` and reads
`/proc/loadavg` inside the guest and caches the parsed result for four seconds in `LinuxRuntime`.

## Browser automation

One Chromium window, owned by the main process, is shared by every browser tool and by the agent's
`open_url` / `launch_app browser`. Keeping one window is what makes “open YouTube, then click the
first video” work on the page the agent just opened instead of a new tab in a second window.

- **Startup:** if `chromium` is missing, `apk add --no-cache chromium` runs once (the guest has the
  community repository configured). The browser starts with a dedicated profile, real X11 output on
  the embedded desktop and `--remote-debugging-port=9222`.
- **Reachability:** Chromium refuses to bind DevTools to anything but loopback. Alpine's `socat`
  listens on `0.0.0.0:9223` in the guest and forwards to `127.0.0.1:9222`; QEMU forwards guest 9223
  to a random host loopback port, which is what the CDP client dials. The VNC-style LAN exposure does
  not happen: QEMU forwards bind to loopback only.
- **Protocol:** a minimal CDP client (WebSocket + request ids + timeouts) navigates, evaluates
  extraction scripts, dispatches real `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent`, inserts
  text, captures screenshots and scrolls. `Page.navigate` is not used for navigation: the client
  sets `location.href` through `Runtime.evaluate`, which works on Chrome's attached page target and
  avoids a second navigation path. A settle delay makes an input's page update observable before
  the next read.
- **Refs:** `browser_read` returns numbered elements (`1:button:Submit`). Each element carries a
  stable `data-tagnest-ref` attribute while a page session lasts; clicks re-resolve the element from
  the DOM by ref, so a stale coordinate cannot hit the wrong control. The ranking prefers inputs,
  buttons and links, then text, and keeps only visible elements.
- **Images:** `browser_screenshot` uses `Page.captureScreenshot` and feeds the PNG to the same image
  path as `desktop_screenshot`, so only vision models can describe it.

## Automatic updates

`auto-update.ts` owns `electron-updater`. It starts only when `app.isPackaged` and the platform is
Windows; a development checkout reports `disabled` with a clear message instead of contacting
GitHub. Packaged builds check 10 s after launch and every 6 hours, download in the background
(`autoDownload`), install on quit (`autoInstallOnAppQuit`), and expose `checking / available /
downloading / ready / up-to-date / error` to the renderer. The release workflow attaches
`latest.yml` and the `.blockmap`, so the feed needs no separate update server.

## Linux app projects

`apps/projects.ts` turns “build me an app” into a real project instead of a pile of loose files.
Every project lives at `/home/tagnest/workspace/apps/<name>` and carries a small
`tagnest-app.json` file with `format: 1`, the display title, template, optional port and timestamps.
The directory listing ignores anything without valid metadata, so a hand-made folder is not
mistaken for a project.

| Template | Files | How `app_run` starts it |
|---|---|---|
| `web` | `index.html`, `styles.css`, `app.js`, `test.sh`, `README.md` | `setsid python3 -m http.server <port> --bind 127.0.0.1` in the project directory, then a bounded `wget` readiness probe and `tagnest-open` in Firefox |
| `cli` | `app.sh`, `run.sh`, `test.sh`, `README.md` | `xfce4-terminal --disable-server` on `DISPLAY=:1`, running `run.sh` |

Names are normalized to lowercase letters, digits and single hyphens; `..`, slashes and existing
projects are rejected rather than overwritten. Ports must be 1024–65535 and are checked with
`netstat` before creation and before start. The PID from the detached session is written to
`.tagnest.pid`; `app_stop` signals the whole process group (`kill -TERM -- -PID`, then `KILL`) and
removes the file. `app_list` verifies the PID with `kill -0` instead of trusting the file.

`app_test` runs `sh test.sh` with the project as the working directory over SSH and returns the
real exit code, stdout and stderr. The agent is instructed to fix failures and rerun, then to take a
`desktop_screenshot` after `app_run` so it can confirm the window is actually visible. For stacks
outside the templates the agent still writes project files under `~/workspace`, installs
prerequisites (behind the normal approval gate) and uses `run_command`/`start_process`; the app
project tools are a working baseline, not the only supported path.

The app server listens on guest loopback only. It is reachable from the guest browser and from the
agent over SSH, not from the Windows host. Project files are ordinary files in the persistent home
disk, so they survive VM and app restarts; they are not written to the host workspace or the
repository.

## Agent loop

1. The renderer sends text over validated IPC.
2. Main appends the user message and an empty assistant message to a JSON conversation, then starts
   a run (one at a time).
3. The provider adapter receives the system prompt (`prompts.ts`: the agent's identity, the guest
   facts, the full tool inventory, the working rules and the reply style) plus a neutral transcript
   (`user`, `assistant` with tool calls, `tool` results) and JSON-schema tool definitions.
4. Every tool call is classified (`safe`, `elevated`, `destructive`). Elevated/destructive calls
   pause the run and emit an approval request; the UI shows the command and waits for
   allow-once/deny (10-minute timeout).
5. Approved tools execute against the live guest over SSH/SFTP. Results are the real stdout,
   stderr, exit codes and file contents, truncated at 24 KB, redacted for secrets.
6. Tool results are sent back to the model until it returns no tool calls (max 12 rounds).
7. Cancellation aborts the HTTP request (AbortController) and stops the guest command. Each exec
   runs under `setsid -w` with its PID recorded in a temporary file; abort/timeout issues
   `kill -TERM -- -PID` on a second channel, then closes the channel. Closing the channel alone
   does not kill the remote process.
8. Messages, tool outputs and errors are persisted after every step, so the UI and history survive
   a crash or restart. Aborted tool calls are recorded as `cancelled`.

Tool groups: `run_command`, `start_process`/`list_processes`/`stop_process`, the SFTP file tools,
`system_info`, the app-project tools (`app_create`, `app_list`, `app_test`, `app_run`, `app_stop`),
the `xdotool` desktop tools (`desktop_move`, `desktop_click` with button/count,
`desktop_scroll`, `desktop_type`, `desktop_key`, `desktop_windows`, `desktop_focus`, `launch_app`),
`desktop_screenshot` (vision) and the internet tools:

| Tool | Where the work happens | Notes |
|---|---|---|
| `web_search` | guest `curl` → DuckDuckGo lite | titles + absolute URLs, parsed host-side |
| `web_fetch` | guest `curl -L` | HTML stripped to readable text in the main process |
| `open_url` | guest → `/usr/local/bin/tagnest-open` → Firefox | reuses the live XFCE session's D-Bus address; succeeds only once a `firefox` process exists |

All three use the guest's own network path, i.e. the computer's connection, and fail with the real
network error. They are read-only/display-only, so they classify as `safe` and need no approval.

## Vision

`desktop_screenshot` runs `xfce4-screenshooter -f` inside the guest, reads the PNG back through
SFTP (`GuestClient.readBuffer`), and returns it as a tool image. The agent loop then collapses that
round into an assistant message plus one **user** message that carries the image with the textual
tool output, instead of the usual `tool`-result turn: several OpenAI-compatible gateways reject a
`user` turn directly after a `tool` turn, and this shape is valid for OpenAI, Anthropic and Gemini.
Each adapter maps the image to its native form — `image_url` data URL (Chat Completions),
`image`/`source.base64` block (Anthropic), `inlineData` part (Gemini). Screenshots are not written
to the conversation JSON; only a short text summary is persisted, so history stays small.

Vision only works with a model that accepts images. A text-only model rejects or ignores the
image; the app surfaces the provider error instead of pretending it saw something.

SSH clients keep a permanent `error` listener for their whole lifetime: ssh2 can emit a second
`error` while a failed handshake is closing (`Connection lost before handshake`), and an unhandled
`error` event would otherwise show Electron's fatal dialog. QEMU's `exit` handler only acts when the
exiting process is still the current one, so a stop/restart cannot let the old process clobber the
new VM.

## Provider interface

`ProviderAdapter.complete(request) → { text, toolCalls }`. Adding a provider means implementing
that interface and mapping the neutral transcript. OpenAI/OpenRouter/Ollama/custom share the
Chat Completions adapter; Anthropic and Gemini have dedicated adapters because their tool schemas
and message shapes differ.

### Model discovery

`src/main/agent/providers/models.ts` reads each provider's real model-list endpoint. Nothing is a
hardcoded catalogue; the only fallback is the manual **Custom model ID…** field.

| Provider | Endpoint | Notes |
|---|---|---|
| OpenAI / custom | `GET {baseUrl}/models` | OpenAI filters obvious non-chat IDs; custom servers are not filtered |
| Anthropic | `GET {baseUrl}/v1/models?limit=100` | follows `has_more` / `last_id` for up to 10 pages |
| Gemini | `GET {baseUrl}/models?pageSize=1000` | keeps models whose `supportedGenerationMethods` include `generateContent`; follows `nextPageToken` |
| OpenRouter | `GET {baseUrl}/models` | free flag from `:free` ID or zero prompt/completion price; capabilities from `supported_parameters` and input modalities |
| Ollama | `GET {baseUrl without /v1}/api/tags` | local tags; embedding-only tags are skipped |

The list is never cached across requests: opening Settings, saving/replacing a key, refreshing, or
changing provider each performs a real request. Failures return the provider's HTTP status, body and
a status-specific hint; an empty list is reported as empty rather than filled with invented models.
`listConfiguredProviderModels` is the IPC entry point, and the renderer only receives the catalog.

### Free — Automatic (OpenRouter)

`modelMode: 'free-auto'` is valid only when `provider === 'openrouter'`; the settings store resets it
on any other provider. In this mode the runtime does not trust a single saved ID:

1. Fetch `/models` and keep entries whose price is zero or whose ID ends in `:free`.
2. Rank tool-capable models first, then by context length (`rankFreeModels`). Tool support matters
   because the agent cannot operate Linux without tool calls.
3. Walk up to eight ranked candidates. 403 (listed but restricted to another harness), 404, 429 and
   5xx move to the next candidate; the activity line names the candidate being tried.
4. Persist the model that actually answered and broadcast the updated settings, so the footer and
   `Currently using:` stay truthful.

A free model can answer the connection test and still be rate-limited during a task; because the
list is re-fetched per run, a stale saved ID is not a hard dependency.

## Security boundaries

- Renderer: sandboxed, context-isolated, CSP, no navigation, no Node. The preload imports only
  `electron` and a dependency-free channel-name module.
- Main: the only privileged component; validates every IPC payload with zod.
- Guest: unprivileged `tagnest` user with passwordless sudo **inside the VM**, no host mounts,
  NAT-only networking. Approvals gate privileged guest actions.
- Secrets: OS credential store; never sent to the renderer; never logged.
- File bridge: renderer sends bytes, never host paths; host paths only come from native dialogs.
  Guest paths are resolved to their real path and must stay under `/home/tagnest/workspace`, so a
  workspace symlink cannot expose `/etc` or another user's files to the drawer or a download.
- See [SECURITY.md](SECURITY.md) for the detailed threat model and limits.
