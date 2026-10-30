# Security model

TagNest runs an AI agent that can execute commands and manipulate files. This document describes
what the design protects, what it does not, and the decisions behind it.

## Layers

| Layer | Protection |
|---|---|
| Renderer | `contextIsolation: true`, `sandbox: true`, no Node integration, strict CSP, navigation and new windows blocked, narrow typed preload API. |
| IPC | Every handler validates input with a zod schema; the renderer cannot choose QEMU arguments, ports, paths or provider endpoints outside settings fields. |
| Main process | Owns QEMU, SSH keys, VNC bridge, encrypted secrets. Runs as the normal desktop user. |
| Guest VM | Alpine Linux, unprivileged `tagnest` user, no host filesystem shares, user-mode NAT network. |
| Agent actions | Risk classifier + explicit approval for privileged/destructive commands. |
| Phone access | Loopback-only HTTP server, short-lived pairing code, per-device tokens, optional outbound tunnel; no raw VNC/SSH exposure. |

## What the VM isolates

- Guest processes run on virtual hardware emulated by QEMU, not on Windows. The guest cannot call
  Windows APIs, read `C:\` or the app's data directory.
- No 9p/virtiofs/shared folders are configured. The only host files the guest can reach are the
  cloud-init seed served on loopback during first boot.
- Networking is QEMU user-mode (SLIRP): outbound NAT only. Inbound connections exist only for the
  random loopback forwards to guest SSH and VNC; other machines on the LAN cannot connect.
- The disk is a qcow2 file owned by the app's user. A malicious guest can corrupt that file, not the
  host filesystem.

## What it is not

- **Not a certified security boundary.** QEMU and the guest kernel are large attack surfaces. A VM
  escape or emulator bug could reach the host. Treat the guest as untrusted-ish, not as a vault.
- **Passwordless sudo inside the guest.** The guest user can become root *in the VM* without a
  password so the agent can install packages and run services. TagNest gates those commands behind
  user approval, but that gate is a guardrail, not a jail: a crafted shell command could do more
  than its visible description suggests. Read approval prompts before allowing them.
- **The model is not trusted.** Prompt injection can come from files the agent reads, web pages it
  downloads, or tool output. The approval prompts and the fixed tool surface limit impact, but do
  not eliminate it. Do not point the agent at secrets you are not willing to expose to your chosen
  model provider.
- **No anti-virus or network filtering.** The guest has normal internet access. Malicious packages
  installed with approval can do anything inside the VM.

## Approval policy

`src/main/agent/policy.ts` requires confirmation for (non-exhaustive):

- `sudo`, `doas`, root shells
- `apk add/del/upgrade`, `apt install`, global npm/pip installs
- service/user/firewall/mount changes (`rc-service`, `rc-update`, `systemctl`, `mount`, `useradd`,
  `iptables`, …)
- recursive deletion (`rm -r`, `rm -rf`, `find -delete`)
- disk/device writes (`mkfs`, `dd of=/dev/...`, `shred`)
- shutdown/reboot
- downloads piped directly to a shell (`curl … | sh`)
- `git push`
- overwriting system paths with shell redirection

Safe commands run without prompting when "Run low-risk commands without asking" is enabled
(default). Turning it off makes every guest command require approval. The file tools (`read_file`,
`write_file`, `edit_file`, `list_files`, `search_files`) are confined to
`/home/tagnest/workspace`; the agent must use a shell command to touch anything else, which is
subject to policy.

Cancellation is not a privilege boundary: aborting a command kills its process group in the guest.
This stops the command; it does not undo changes the command already made.

## Display and clipboard

Xvnc inside the guest accepts unauthenticated RFB. It is not exposed beyond QEMU's loopback forward,
and the host-side WebSocket bridge requires a random 48-hex-character token generated for each
runtime session. Other local processes cannot attach without the token, and the renderer is the only
client. Clipboard transfer is explicit (paste/copy buttons) and limited to text.

## Phone access

The phone interface is a second network entrance to the same agent, so it is deliberately narrow:

- The HTTP server listens on `127.0.0.1` in tunnel and custom modes. **Home network** is the one
  mode that deliberately binds the port on the LAN, and only after the user selects it; there is no
  inbound router port in tunnel mode because the client connects *out* to Cloudflare. The guest has
  no route to the server and the server cannot execute guest commands by itself.
- Pairing needs a 6-digit code generated when remote access starts. The code expires after 15
  minutes, is compared in constant time and is rate-limited (a global attempt budget per window). A
  correct code returns a random 32-byte device token; the server stores only its SHA-256 hash.
- Every API route except `/api/health`, `/api/pair` and the static desktop page requires either
  `Authorization: Bearer <token>` or the `HttpOnly`, `SameSite=Strict` session cookie. The WebSocket
  upgrade is authenticated the same way and then bridged to the existing random-token VNC bridge.
  The guest's raw VNC port, SSH port and QMP socket are never exposed by this server.
- CORS is absent, mutations require same-origin JSON or the native pairing header, and API responses
  are `no-store`. Provider keys are never part of remote state, and remote commands go through the
  same `AgentRuntime` approval path as the desktop UI.
- A quick-tunnel address is public to anyone who learns it, but without a paired token it only
  returns 401. Treat the address and pairing code as credentials. For a permanent public endpoint,
  use your own named tunnel and keep the token private; the app cannot make a quick tunnel stable
  across restarts.
- The Android app stores its device token in app-private preferences. **Forget this phone** calls the
  revoke endpoint and removes the local token. There is no TagNest account and no server-side copy
  of the token.

## Browser automation

`linux/browser.ts` starts Chromium inside the guest with `--remote-debugging-port` and talks CDP over
an SSH tunnel to the host. Nothing listens on the LAN:

- Chromium binds DevTools to guest loopback only. A guest-side `socat` bridge accepts connections on
  the guest's NAT address, which QEMU forwards to a random **host loopback** port. No other machine
  can reach either end.
- The page is untrusted input. `browser_read` extracts text and element metadata; the model does not
  get to execute arbitrary JavaScript in the guest browser, and only fixed CDP commands
  (navigate, mouse, key, screenshot, scroll) are issued from main.
- Chromium runs with `--no-sandbox` inside the VM. That is a deliberate trade: the browser is already
  inside a QEMU VM, and Alpine's Chromium needs the flag in this rootless, container-less setup. It
  does **not** relax the host boundary; the guest remains the boundary. The browser also uses
  `--password-store=basic --use-mock-keychain` so no keyring dialog can block the desktop.
- Page content can contain prompt injection. Text read from a page is passed to the model as tool
  output; the approval policy still applies to every command the model then requests, and the
  browser tools cannot write host files.

## QEMU installation

The **Install QEMU** button runs one fixed command, never model or renderer input:

```text
powershell -Command Start-Process winget.exe -ArgumentList 'install --id SoftwareFreedomConservancy.QEMU -e …' -Verb RunAs -Wait
```

Windows displays the UAC prompt; TagNest does not bypass it, does not run an elevated helper of its
own, and verifies `qemu-system-x86_64` after winget returns. Cancelling UAC or a winget failure is
reported in the panel and nothing is installed. The app only offers this on Windows when `winget` is
available.

## QEMU control socket and restore points

QEMU exposes QMP on `127.0.0.1:<random>` (random per boot, `server,nowait`). It is loopback-only and
the port is only known to the main process; the renderer and the model cannot reach it. QMP is
unauthenticated, like the existing loopback SSH/VNC forwards, so a local process that discovers the
port could control the VM. That is the same local trust boundary the app already relies on for
loopback forwards.

A restore point starts a copy-on-write qcow2 overlay under `%APPDATA%\TagNest\linux\checkpoints`.
It contains guest disk data (like the main workspace disk) and is not encrypted; it is removed on
**Restore** and merged then removed on **Keep changes**. It is never uploaded anywhere.

## Diagnostics

The diagnostics report is written only when the user picks a path in the native Save dialog. It
contains versions, runtime state, sanitized settings, provider key presence flags (never values), and
log tails. The logger and the report both run `redactSecrets`; the report additionally replaces the
home, data and project paths with `<path>`. The VNC token is excluded entirely.

## Automatic updates

`electron-updater` is enabled only in a packaged Windows build. It reads the public GitHub Release
feed for this repository and verifies the downloaded package's checksum (`latest.yml`), but the
installer is **not code-signed** — Authenticode verification is therefore not a protection you
should rely on. If you need that guarantee, use a signed fork or install releases manually. The
updater sends no telemetry and no credentials; it is an ordinary HTTPS request to GitHub.

## Credentials and logs

- Provider keys are encrypted with Electron `safeStorage` — DPAPI on Windows — and stored in
  `secrets.json` as opaque ciphertext. If the OS store is unavailable, TagNest refuses to persist a
  key instead of writing plaintext.
- Keys are never sent to the renderer (`hasApiKey` is a boolean), never included in prompts, and
  never written to logs. `src/main/redact.ts` strips common key/token patterns from tool output,
  error messages and log lines before display or persistence.
- When a hosted provider is selected, prompts, tool results and file excerpts **are** sent to that
  provider. The Settings screen says so explicitly. Local Ollama keeps everything on the machine.

## Guest operations the runtime performs without an approval prompt

The approval gate covers **model-requested** commands. The runtime itself performs a small, fixed
set of guest maintenance operations over SSH as the unprivileged `tagnest` user, using the guest's
passwordless sudo non-interactively:

- create `/run/tagnest` (tmpfs state needed by Xvnc) and give it to `tagnest`;
- restart the `tagnest-desktop` service if Xvnc is not running.

These run on every start, are idempotent, take no input from the model, and cannot be repurposed by
a prompt. The guest user's sudo is required because `/run` is root-owned. Everything else the agent
runs goes through the policy/approval path.

## Host operations the app performs

- Download (once) and SHA-512-verify the official Alpine image.
- Run `qemu-system-x86_64` and `qemu-img` from a fixed set of locations, never from model input.
- Open loopback TCP ports for SSH/VNC forwards and a loopback WebSocket server.
- Read and write files under the app data directory and open log folders on request.
- Offer the fixed winget QEMU install described above, only after the user clicks the button.
- Contact GitHub Releases for update checks in packaged builds.
- Generate an SSH keypair for the guest (private key in the app data directory, mode 600; Windows
  ACLs are applied by libuv and are best-effort).
- Start/stop the QEMU process and its loopback forwards; all model-driven execution stays inside the
  guest.

It does not request administrator rights, install services, modify the registry, mount host folders
or execute model-provided commands on Windows. All agent execution happens inside the guest.

## Reporting

Please do not open a public issue for a vulnerability. Contact the maintainers privately (see the
repository's security policy) with reproduction steps and the TagNest version.
