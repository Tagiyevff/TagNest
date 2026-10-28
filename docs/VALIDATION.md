# Validation record

This file records what was actually executed on the development machine, with the observed
results. It is deliberately specific about what was **not** verified.

- Date: 2026-10-26 → 2026-10-28
- Host: Windows (Electron 45, Node 26.1.0, QEMU 11)
- Guest: Alpine Linux 3.24.3 (kernel 6.18.58-0-virt), XFCE, Xvnc `:1` at 1440×900
- Acceleration: WHPX (`-machine pc -accel whpx -cpu qemu64`), 2 vCPU, 3072 MB RAM, 20 GB sparse overlay

## Automated checks

```text
npm run typecheck   PASS
npm run lint        PASS (0 problems)
npm test            PASS (10 files, 89 tests)
npm run build       PASS (electron-vite, main + preload + renderer)
npm run package:win PASS (0.3.0, NSIS, release/TagNest-0.3.0-x64.exe, 119 MB; 0.4.0 not repackaged yet)
```

The 89 tests include the new app-project tests (name and port validation, starter file contents,
metadata parsing and rejection, HTML escaping), the update-check/version comparison, guest stats
parser, upload path sanitizer, workspace listing confinement (including a symlink that resolves to
`/etc`), download success/cancel with a mocked native dialog, and the real provider connection
check against a mock HTTP endpoint (success, missing key, 401, unreachable local server).

The unit tests cover the provider adapters against local mock HTTP servers (including a 401 mapped to
a credential error, a body with data appended after the JSON document, a non-JSON body and an empty
body), secret redaction, storage/settings persistence, path confinement helpers and the web helpers
(URL validation, HTML→text conversion, search-result parsing).

## 0.4.0 automatic model discovery and OpenRouter Free (2026-10-28)

### Unit tests, typecheck, lint

```text
npm run typecheck   PASS
npm run lint        PASS (0 problems)
npm test            PASS (10 files, 89 tests)
npm run build       PASS
```

`src/main/agent/providers/models.test.ts` covers the real response shapes of OpenAI, OpenRouter,
Anthropic, Gemini and Ollama (names, IDs, context, capabilities, free flags, pagination parsing),
URL/auth construction, error statuses and free-model ranking. `provider-test.test.ts` covers the
live connection test, including a 403 free model followed by a working one.

### Real OpenRouter model list

A one-off script called the production `fetchProviderModels` against
`https://openrouter.ai/api/v1/models` (no renderer, no mock):

```text
models: 464  free: 16  source: https://openrouter.ai/api/v1/models
- Thinking Machines: Inkling Small (free) (thinkingmachines/inkling-small:free) ctx=1048576 caps=chat,tools,vision
- NVIDIA: Nemotron 3 Ultra (free) (nvidia/nemotron-3-ultra-550b-a55b:free) ctx=1000000 caps=chat,tools
```

### Live Electron: model dropdown and Free — Automatic

The production bundle was launched and driven through CDP against the real VM. Switching the
provider to OpenRouter in the running app made the Settings dialog load the real 464-model list into
the `<select>`; the labels showed name · ID · context. Selecting **Free — Automatic** produced
`Currently using: thinkingmachines/inkling-small:free` and its explanatory note. Pressing
**Test connection** walked the ranked free models and returned the real provider reply:

```text
Connected to nvidia/nemotron-3-ultra-550b-a55b:free in 2873 ms.
Currently using: nvidia/nemotron-3-ultra-550b-a55b:free
```

The settings panel then persisted that model, and the dialog and footer agreed. The stored Gemini
configuration was restored afterwards from a file backup.

### Real agent task on the new build (Free — Automatic)

A fresh conversation was created through the preload bridge, the provider was switched to
OpenRouter **Free — Automatic**, and this task was sent:

> Run uname -r in the Linux terminal and report the exact output. Do not create or change files.

The agent fetched the free list, tried `thinkingmachines/inkling-small:free` and
`thinkingmachines/inkling:free` (both refused direct API traffic), then used
`nvidia/nemotron-3-ultra-550b-a55b:free`. It called `run_command` against the real guest and replied
with the actual output:

```text
`6.18.58-0-virt`
```

Task state ended `done` with no message errors. The settings store had been updated to
`nvidia/nemotron-3-ultra-550b-a55b:free`, proving the answered model is the one persisted. The test
conversation was deleted and the previous Gemini configuration restored.

An earlier session (visible in `tagnest.log`) had already completed a different free-model agent
task (`nvidia/nemotron-3.5-super-vl:free`) with a terminal and real kernel output, so this is
repeatable rather than a one-off.

### Not exercised in this version

- Saving a brand-new key and observing the automatic list refresh in the UI. The real key was
  already stored, so the code path was covered by the mount effect and unit tests, not clicked.
- Real model-list calls for OpenAI, Anthropic, Gemini and Ollama. Those endpoints were tested
  against recorded/mock HTTP shapes only; OpenRouter was the only live list endpoint.
- A 0.4.0 packaged installer. `npm run package:win` was last run for 0.3.0.

## 0.3.0 Linux app projects (2026-10-28)

### Unit tests and build

`npm test` ran 9 files / 74 tests, including 10 new tests for `src/main/apps/projects.ts`. They
check name normalization (`../etc`, slashes and uppercase rejected), port range validation, both
starter templates, executable test scripts, metadata mismatches/malformed JSON, HTML escaping and
that generated projects stay under `/home/tagnest/workspace/apps`. Typecheck, lint and the
production build passed.

### Real VM smoke test

`npx tsx .local/logs/app-projects-smoke.mts` booted the existing `.local/smoke-data` Alpine guest
(WHPX, 2 vCPU, 3 GB) and exercised the project module against the real guest over SSH/SFTP:

```text
app_create → Created "Smoke App" (web) … files: index.html, styles.css, app.js, test.sh, README.md, tagnest-app.json
app_test   → exit 0, stdout: web project OK: index.html 676 bytes
app_run    → Running "Smoke App" at http://127.0.0.1:8099/ (PID 2918). The page is open in Firefox …
wget       → <!doctype html> … <title>Smoke App</title>
xdotool    → 23068674|Smoke App — Mozilla Firefox
app_list   → smoke-app … web · port 8099 · running (PID 2918)
app_stop   → Stopped "Smoke App" (PID 2918)
wget       → down
```

CLI template in the same run:

```text
app_create → Created "Smoke CLI" (cli) …
app_test   → exit 0, stdout: CLI project OK: Hello, TagNest!
app_run    → Opened "Smoke CLI" in a terminal window on the Linux desktop (PID 3491)
xdotool    → window titled "TagNest: Smoke CLI" is visible
app_stop   → Stopped "Smoke CLI" (PID 3491)
```

Both test projects were removed after the run.

### Live Electron + model run

The production bundle was launched (`npx electron . --remote-debugging-port=9222`) with the real
provisioned VM, and the empty-chat suggestion **“Build me a small Linux app, test it and open it on
the desktop”** was clicked. Gemini 2.5 Flash called `app_list`, `app_create` (`my-first-app`, web),
`app_test` and `app_run`. The tool cards reported **Create: Done**, **Test: Done**, **Run: Done**,
and a CDP screenshot of the running app showed Firefox at `http://127.0.0.1:8080/` displaying
“My First App” with its working counter. No renderer mock was used.

A later request in the same session created `my-second-app`; `app_create` correctly refused the
existing `my-first-app` instead of overwriting it, and the new project tested and ran. The turn then
ended with Gemini HTTP 429 (free-tier requests-per-minute quota), not an app or runtime failure.
All test-created projects were removed afterwards.

The first attempt, against a build that still used `busybox httpd`, failed honestly: the model ran
`app_test` successfully, `app_run` failed with `httpd: applet not found`, and it asked to install
`busybox-extras` rather than claiming success. That is why the server moved to the preinstalled
Python `http.server`, and `app_run` now waits for a visible Firefox window before reporting.

### Packaged build

`npm run package:win` produced `release/TagNest-0.3.0-x64.exe` (119 MB, NSIS, unsigned) and
`release/win-unpacked`. Launching `release/win-unpacked/TagNest.exe --remote-debugging-port=9223`
started the real VM (WHPX, guest SSH ready), and the renderer reported:

```json
{"version":"0.3.0","phase":"running","provider":"gemini"}
```

The window was then closed and the app shut down cleanly. The installer itself was not run on a
clean Windows machine.

### Not exercised

- App metadata persistence across a full app restart (projects are ordinary files on the persistent
guest disk; the module reads that disk on every call).
- A native GTK/Qt desktop-bundle template, and running an app project on a second port while another
  app is already listening.
- App creation by providers other than Gemini.

## 0.2.0 file bridge, live stats, provider test and updates (2026-10-28)

The production bundle (`npx electron . --remote-debugging-port=9222`) was driven through the real
preload bridge with Chrome DevTools Protocol while the real provisioned VM was running
(WHPX, 2 vCPU, 3 GB). No renderer mocks were involved.

```text
TagNest 0.2.0 starting (win32, Electron 45.0.0)
QEMU started … guest SSH ready … guest is ready on ssh:…, vnc:…   (~30 s after start)
```

### Live guest resources

`window.tagnest.runtime.stats()` returned values read inside the guest, and the panel header showed
them without a reload:

```json
{"memoryUsedMB":424,"memoryTotalMB":2982,"diskUsedGB":1.2119,"diskTotalGB":18.6357,
 "load1":0.27,"cpus":2,"uptimeSeconds":33}
```

Header text: `Running · 2 CPU · 3 GB · RAM 14% · Disk 7%`. The poll stops when the VM is not running
and the values are cached for 4 s in the main process.

### File bridge

A real DOM `DragEvent` carrying a `File` (`bridge-drop.txt`, 17 bytes) was dispatched on
`.desktop-shell`; the renderer read the bytes, went through `workspace:upload` and SFTP. An
independent SSH session (the agent key, not the bridge) then read it:

```text
$ cat ~/workspace/bridge-drop.txt
 drop bridge test
$ ls -l ~/workspace/bridge-drop.txt
-rw-r--r-- 1 tagnest tagnest 17 … /home/tagnest/workspace/bridge-drop.txt
```

- Dropping the **same name again** produced `bridge-drop-1.txt` (12 bytes) and left the original
  file untouched.
- A nested upload (`relativePath: folder-a/nested.txt`) created the folder; the real drawer showed
  `folder-a` first, navigated to `~/workspace/folder-a`, listed `nested.txt`, and the **Up** button
  returned to `~/workspace` (disabled at the root).
- Files survived stopping the app and QEMU and relaunching the app (the same workspace.qcow2):
  `bridge-drop.txt`, `bridge-drop-1.txt` and `folder-a/` were still listed afterwards.
- `window.tagnest.files.download('/etc/passwd')` was refused **before** a save dialog opened:
  `Access denied: /etc/passwd is outside the TagNest workspace`.
- A symlink `~/workspace/escape-link -> /etc` was created inside the guest; listing it through the
  bridge was refused:
  `…/escape-link resolves outside the TagNest workspace and cannot be opened here.`
- 15 sequential `files.list()` calls each returned all 6 entries.

**Bug found and fixed by this test:** every SFTP operation opened a new channel and never closed
it. sshd's `MaxSessions` (10 by default) was exhausted after a few uploads, and the drawer failed
with `(SSH) Channel open failure: open failed`. `GuestClient` now opens one SFTP session lazily,
reuses it, closes it with the connection and rejects a session that arrives after a disconnect.
The 15-call run above passes with the fix; the agent's file tools share the same session.

### Provider connection test

The configured provider was Gemini (`gemini-2.5-flash`) with a stored key. The Settings button and
the IPC handler each sent one real request and returned:

```json
{"ok":true,"latencyMs":707,"model":"gemini-2.5-flash","reply":"OK",
 "message":"Connected to gemini-2.5-flash in 707 ms."}
```

The UI rendered it as `Connected to gemini-2.5-flash in 709 ms.` in the green state. Unit tests also
cover a missing key, a 401 with the provider's message, and an unreachable `127.0.0.1` endpoint.

### Update check

`window.tagnest.app.checkUpdates()` hit the real GitHub Releases API:

```json
{"current":"0.2.0","latest":"0.1.0","updateAvailable":false,
 "url":"https://github.com/Tagiyevff/TagNest/releases/tag/v0.1.0"}
```

Settings → About showed `TagNest 0.2.0` and, after clicking **Check for updates**,
`TagNest 0.2.0 is up to date.` with the release-notes disclosure. This is the correct result while
0.2.0 is not yet tagged. Rate limiting (403) and network failures produce explicit errors instead
of a false “up to date”.

### Packaged build

```text
npm run package:win  → release/TagNest-0.2.0-x64.exe (119 MB, NSIS, unsigned)
release/win-unpacked/TagNest.exe --remote-debugging-port=9223
  TagNest 0.2.0 starting (win32, Electron 45.0.0)
  guest is ready after 36.6 s
  runtime: {version: 0.2.0, phase: running, acceleration: whpx}
  drawer:  ~/workspace → 4 files, no error
  header:  RAM 9% · Disk 7%
```

The packaged app's window closed cleanly and both TagNest and QEMU exited. The installer itself was
not run, so install/uninstall is still untested.

### Not exercised

- Dragging from Windows Explorer with the OS pointer. The drop handler was exercised with a real
  DOM drop event and real file bytes, but folder-tree walking with `webkitGetAsEntry` was not
  exercised against Explorer.
- Clicking through the native **Save** dialog. `downloadWorkspaceFile` success and cancel are unit
  tested with a mocked `dialog.showSaveDialog`, and the outside-workspace refusal was exercised in
  the running app.
- The native **Upload** file picker (`dialog.showOpenDialog`). Its handler shares `uploadHostPaths`
  with the tested folder-upload path.

## Real VM smoke test

### Fresh workspace (2026-10-27)

`TAGNEST_SMOKE_CLEAN=1 npm run smoke:linux` deleted the test workspace and provisioned a brand-new
guest from the pinned image, exercising the updated first-boot script (which now installs Firefox):

```text
Linux is running (whpx) after 149.2s      # 151 MB image + cloud-init + XFCE + Firefox
Real command: Linux 6.18.58-0-virt / 3.24.3
SFTP: Wrote and verified smoke-test.txt (39 bytes)
Desktop 1440 900, xdotool moved the real pointer to (640,400)
RFB greeting received: RFB 003.008 through the token bridge
Cancelled a running command in 419ms
Restarted in 31.3s; workspace file persisted
No Windows host paths are mounted in the guest.
Total smoke test time: 213.0s
SMOKE_LINUX_EXIT:0
```

That freshly provisioned guest was then booted once more to confirm what the first-boot script
actually left behind:

```text
/usr/bin/firefox
Mozilla Firefox 151.0.3
--- helper
helper-present          # /usr/local/bin/tagnest-open (agent browser tool)
--- internet
http:200               # curl https://alpinelinux.org/ from inside the guest
CHECK_DONE  (exit 0)
```

### Existing workspace (2026-10-26/27)

`npm run smoke:linux` was also run against the same provisioned workspace used by the app
(`TAGNEST_SMOKE_DIR=%APPDATA%\TagNest`). Output (trimmed):

```text
[runtime] running: Linux is running — 1440×900 desktop · 2 CPU · 3072 MB RAM
Linux is running (whpx) after 29.8s
Memory: 654 MB (QEMU working set)

=== Real command execution inside Linux
Linux 6.18.58-0-virt x86_64
3.24.3

=== File creation and read-back through the agent file API (SFTP)
Wrote and verified /home/tagnest/workspace/smoke-test.txt (33 bytes)

=== Live desktop and synthetic mouse input
Desktop geometry 1440 900, x:640 y:400

=== Embedded VNC stream (RFB handshake through the token bridge)
RFB greeting received: RFB 003.008

=== Command cancellation
Cancelled a running command in 425ms

=== Stop the VM
[runtime] stopped: Linux is stopped

=== Restart and persistence
Restarted in 30.3s; workspace file persisted

=== Guest isolation
No Windows host paths are mounted in the guest.

Total smoke test time: 94.9s
SMOKE_EXIT:0
```

What this proves:

- QEMU boots the provisioned Alpine guest with WHPX; SSH becomes reachable.
- A real command runs in the guest and returns its real kernel and Alpine version.
- SFTP writes and reads a file that the guest shell can see.
- The X server is live at 1440×900, and `xdotool` moves the real guest pointer.
- The token-gated WebSocket bridge completes a real RFB handshake with Xvnc.
- Aborting a `sleep 20` command returns in **425 ms**, and the guest process group is killed
  (no lingering `sleep` process).
- The VM stops and restarts, and the workspace file survives.
- `/c`, `/mnt/host` and `/host_mnt` do not expose the Windows project folder.

## Application-level checks (real Electron window)

The app was launched from the built bundle (`npx electron .`), not a browser or a mock UI, and driven
through its real IPC surface while the VM ran.

| Check | Result |
|---|---|
| App window starts and reaches the split-panel UI | PASS — see `docs/tagnest-desktop.png` |
| Live XFCE desktop embedded in the right panel | PASS — panel, terminal window, clock and hostname are the guest's |
| Mouse/keyboard input through the embedded screen | PASS — clicked the guest terminal through noVNC and typed `echo TAGNEST_INPUT_OK`; the guest printed `TAGNEST_INPUT_OK` |
| Agent receives a task and calls tools | PASS — local OpenAI-compatible mock endpoint; the real agent loop ran `write_file` then `run_command` |
| Real file creation | PASS — `write_file` created `/home/tagnest/workspace/agent-e2e.txt` (30 bytes); verified with `ls`/`cat` over SSH |
| Real command output | PASS — tool returned `exit code: 0`, `TagNest agent end-to-end test`, `Linux 6.18.58-0-virt` |
| Task progress and tool cards in the UI | PASS — Write file / Run command cards show `Done`, the command and its real output |
| Persistence across app + VM restart | PASS — `agent-e2e.txt` still present after a full VM reboot and app relaunch |
| Cancellation during a running command | PASS — task → `cancelled`, tool state → `cancelled`, command killed (425 ms in the smoke test) |
| Provider failure reporting | PASS — pointing the custom provider at `http://127.0.0.1:9/v1` produced `Could not reach the local model server … (fetch failed)` in the chat; no command ran |
| Invalid credentials mapping | Covered by unit test (HTTP 401 → `ProviderError` with credential hint); no live key was available to test a hosted API end to end |
| Startup time (provisioned disk) | ≈ 30 s from `start()` to `running` |
| Memory | QEMU ≈ 0.65–0.97 GB working set; Electron ≈ 0.5 GB across its 4 processes |
| Windows installer build | PASS — `release/TagNest-0.1.0-x64.exe` (117 MB, NSIS, unsigned) |
| Packaged app launch | PASS — `release/win-unpacked/TagNest.exe` booted the real VM and rendered the live desktop; screenshot taken from the packaged app |

### Screenshots

- `docs/tagnest-desktop.png` — the packaged application with the live guest desktop.
- `docs/tagnest-agent.png` — a real agent task: Write file / Run command tool cards with the real
  output, next to the same live desktop.
- `docs/tagnest-web.png` — a real agent task using the internet tools, with Firefox open on alpinelinux.org
  in the guest.
- `screenshots/` (git-ignored) contains additional captures (raw keyboard input, final state).

## Internet, browser and agent web tools (2026-10-27)

Guest networking uses QEMU user-mode NAT, so the guest shares the computer's own connection.

```text
# from the host, over SSH into the running guest
curl -o /dev/null -w '%{http_code}' https://dl-cdn.alpinelinux.org/…   → 200 (0.6 s)
curl -o /dev/null -w '%{http_code}' https://example.com/               → 200
firefox: not installed before this change
```

Firefox is now part of the first-boot provisioning script and, for workspaces provisioned by an
older release, is installed by an idempotent startup step:

```text
[runtime] browser missing in the guest, installing Firefox
[runtime] Firefox installed in the guest (11279 ms)
```

The full agent loop was then exercised with the three new internet tools
(`npm run smoke:agent`, real guest, real network, mock OpenAI-compatible endpoint):

```text
[approval] rm -rf /home/tagnest/workspace/agent-smoke.txt -> denying
[agent] task=done tools=write_file:ok, run_command:ok, run_command:denied, web_fetch:ok, web_search:ok, open_url:ok
[verify] file after denial: present
[verify] web_fetch saw the real page: true
[verify] web_search returned real results: true
[verify] firefox process in the guest: running
AGENT SMOKE PASSED
```

Real tool output from that run:

```text
web_fetch   Source: https://example.com/ | HTTP 200 · text/html; charset=utf-8 · 577 bytes
            This domain is for use in documentation examples without needing permission…
web_search  1. Package index - Alpine Linux packages  https://pkgs.alpinelinux.org/packages
            3. index | Alpine Linux                  https://www.alpinelinux.org/
open_url    Opened https://example.com/ in Firefox. The page is loading on the Linux desktop…
```

Finally the same flow was driven through the real application window (composer → IPC → agent →
tools), which produced `docs/tagnest-web.png`: three green tool cards in the chat and two Firefox
windows loading `alpinelinux.org` inside the right-hand panel, with `curl` in the guest still
returning HTTP 200.

Not verified here: how DuckDuckGo behaves under sustained automated use (rate limiting), pages that
require JavaScript to render anything (`web_fetch` returns the raw HTML text only), and any
browser-automation/DOM tool — none exists.

## Real model through a local OpenAI-compatible router (2026-10-27)

The configured provider (custom, `openrouter/nvidia/nemotron-3-ultra-550b-a55b:free`) pointed at a
local OpenAI-compatible router running on the host, which forwards to a hosted model. The first
every attempt failed in the chat with:

```text
SyntaxError: Unexpected non-whitespace character after JSON at position 1159 (line 3 column 1149)
```

Diagnosis: the router answers with a complete JSON document **and then appends the SSE terminator**:

```text
[provider] trailing data after the JSON document (body 1111 bytes, JSON 1099 bytes): data: [DONE]
```

`response.json()` rejects anything after the JSON value, so the raw `SyntaxError` reached the user.
Fix: all three adapters now read the body through `readJsonBody()`, which parses the whole body,
falls back to the first complete JSON value (logging the trailing bytes), and otherwise raises a
`ProviderError` naming the HTTP status, content type, body size and a snippet — plus a hint to check
the base URL. The known `data: [DONE]` trailer is logged at debug level, anything else at warn.

Verified end to end through the real application window (composer → IPC → agent → provider → tools):

```text
message "Hello"      → "Hello! How can I help you today?"   (real model reply, task done)
message "…dosya olustur…" → tool calls: write_file:ok, read_file:ok
assistant: Done. Created /home/tagnest/workspace/9router-test.txt with content "ok"…
independent check over SSH:
  -rw-r--r-- 1 tagnest tagnest 2 …  /home/tagnest/workspace/9router-test.txt
  --- content:  ok
log: no provider errors, no warnings
```

This proves the OpenAI-compatible adapter, tool schema round-trip and real tool execution against an
actual hosted model. It does **not** exercise `api.openai.com`/`api.anthropic.com`/Gemini directly.

## Vision and human-like desktop control (2026-10-27)

`desktop_screenshot` captures the guest framebuffer with `xfce4-screenshooter -f` (≈160 KB PNG at
1440×900), reads it back over SFTP and sends it to a vision model. Verified through the real app
window against a live model reachable through the local router
(`cf/@cf/mistralai/mistral-small-3.1-24b-instruct`):

```text
prompt: "Ekrana bax (desktop_screenshot) ve ne gorduyunu soyle."
tools:  desktop_screenshot:ok
reply:  "The desktop is showing the XFCE desktop background with a panel at the bottom. The panel has
         icons for the file manager, web browser, terminal … There are no open windows or dialogs."

prompt: "Firefox-da alpinelinux.org sayfasini ac (open_url ile), sonra ekrana bax …"
tools:  open_url:ok, desktop_screenshot:ok
reply:  "The page is fully loaded and displays the Alpine Linux logo at the top … navigation links
         such as About, Documentation, and Downloads …"
```

Both descriptions match the screenshots (the first was an empty, freshly booted desktop; the second
is `docs/tagnest-vision.png`). The same run confirmed three new control tools in the guest:
`desktop_move`, `desktop_scroll`, `desktop_windows`/`desktop_focus`, `desktop_click` with
button/count, and that `open_url` adds a tab to the existing Firefox window instead of spawning a
second one.

Two real problems had to be fixed to get there:

1. Sending the image as a separate `user` turn right after a `tool` turn was rejected by a strict
gateway (`Unexpected role 'user' after role 'tool'`). Screenshot rounds are now collapsed into an
   assistant message plus a single user message carrying the image and the text output.
2. Not every model on the router accepts images: Llama-4-Maverick returned 503 (upstream key), the
   free Gemma model returned 429, and the multimodal Mistral model worked. The app reports the
   provider's error instead of pretending the screenshot was seen.

Unit tests cover the image mapping for all three adapters (data URL, base64 block, inlineData).

## Fixes made because of these tests

- The cloud-init seed server answered `/network-config` with 404, which made cloud-init abandon the
  seed and spend minutes probing public cloud metadata services. It now serves a valid network
  config, and the datasource uses `ds=nocloud`.
- The preload imported Zod through the IPC module; sandboxed preloads cannot require it, so the
  bridge failed and the UI showed a diagnostic screen. IPC channel names now live in a
  dependency-free module.
- `/run/tagnest` is on tmpfs and vanished on reboot, so the desktop service crashed on later boots.
  The root launcher creates it, and the runtime repairs it idempotently on start.
- Closing an SSH channel did not stop the guest command, and a late ssh2 `error` could crash the
  main process. Commands now run in their own process group and are killed on cancel/timeout; every
  ssh2 client keeps a permanent error listener.
- A late `exit` event from the previous QEMU cleared the reference to a newly spawned VM during
  restart. The handler now only acts on its own process.
- The Linux smoke script used top-level `await` in a CommonJS file; it is now `.mts`.
- `SettingsStore.update` dropped an endpoint that arrived in the same patch as a provider switch
  (`{ provider, baseUrl, model }` kept the provider default), so a configured custom base URL was
  silently lost. An endpoint sent with the switch is now honoured; the provider default is still
  the fallback.
- The destructive-command step of `npm run smoke:agent` was *approved* by the harness, so it deleted
  the file it was supposed to prove was protected. The harness now denies `rm -rf` and asserts
  `run_command:denied` plus the file still being present.

## Not verified

- **Direct hosted provider APIs with live keys.** OpenAI, Anthropic, Gemini and OpenRouter were
  exercised against local mock HTTP servers that mirror their request/response formats, and the
  OpenAI-compatible path was additionally exercised end to end against a local router forwarding to
  a real hosted model (see above). The official endpoints themselves — rate limits, model ids,
  billing, provider-specific quirks — were not tested, because no direct API key was available.
- **Installing the NSIS package.** The installer was built successfully and the packaged
  `win-unpacked` app was launched and verified, but the installer itself was not run, so the
  install/uninstall flow is untested. It is unsigned, so Windows SmartScreen will warn.
- **A prebuilt, downloadable TagNest Linux image.** The repository supports bundling a verified base
  image (`resources/linux/*.qcow2`, via `npm run provision:linux`) and can copy it into the data
  directory, but no such image is checked in or hosted here. As shipped in this repo, the first
  launch downloads the official Alpine cloud image and provisions the desktop automatically, which
  takes several minutes. See README “Known limitations”.
- **TCG (no WHPX) fallback.** The pinned kernel panicked under TCG on this machine earlier in
  development; software emulation is not presented as a working path.
- **Native drag from Explorer, native Save dialog and native Upload picker.** The file bridge
  itself (paths, confinement, overwrite protection, byte transfer, listing, navigation) was tested
  in the running app; the three OS-level interactions listed above were not clicked by a human.
- **Clipboard transfer and dynamic guest resolution.** Both are implemented (clipboard buttons,
  noVNC viewport scaling) but were not exercised in this test run.
- **DOM automation.** The agent sees the desktop through screenshots and acts with the real mouse
  and keyboard; it does not read the page's DOM or page source, and vision requires a model that
  accepts images.
- **macOS and Linux hosts.** Only Windows was tested.
- **Security auditing.** Isolation was checked behaviourally (no host mounts, NAT-only). No pen-test
  or QEMU-escape analysis was performed.

## Release pipeline

The published repository was tagged `v0.1.0`, which triggered the `Release` workflow on
`windows-latest`. Steps that actually ran and passed:

```text
npm ci                     OK
npm run typecheck          OK
npm run lint               OK
npm test                   4 files, 36 tests passed
npm run package:win        OK
```

The release asset list from the GitHub API, after the run:

```text
TagNest-0.1.0-x64.exe           118.8 MB
TagNest-0.1.0-x64.exe.blockmap    0.1 MB
```

Not verified: downloading that asset and installing it on a clean Windows machine, and code
signing (the installer is unsigned).
