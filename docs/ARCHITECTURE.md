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
      runtime.ts     lifecycle state machine, boot/provision/ready detection
      ssh.ts         SSH exec + SFTP wrapper, cancellation, output limits
      vnc.ts         token-authenticated WebSocket→TCP RFB bridge
    agent/
      agent.ts       task loop, tool execution, approvals, cancellation, persistence
      tools.ts       tool schemas + real guest implementations
      policy.ts      command risk classifier
      workspace.ts   file-tool path confinement
      prompts.ts     system prompt
      providers/     OpenAI-compatible, Anthropic, Gemini adapters
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
`system_info`, the `xdotool` desktop tools (`desktop_move`, `desktop_click` with button/count,
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

## Security boundaries

- Renderer: sandboxed, context-isolated, CSP, no navigation, no Node. The preload imports only
  `electron` and a dependency-free channel-name module.
- Main: the only privileged component; validates every IPC payload with zod.
- Guest: unprivileged `tagnest` user with passwordless sudo **inside the VM**, no host mounts,
  NAT-only networking. Approvals gate privileged guest actions.
- Secrets: OS credential store; never sent to the renderer; never logged.
- See [SECURITY.md](SECURITY.md) for the detailed threat model and limits.
