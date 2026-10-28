import { GUEST_WORKSPACE } from '../linux/guest'
import { shellQuote, type GuestClient } from '../linux/ssh'

export const APPS_DIR = `${GUEST_WORKSPACE}/apps`
export type AppTemplate = 'web' | 'cli'

export interface AppProject {
  name: string
  title: string
  template: AppTemplate
  path: string
  port?: number
  url?: string
  running: boolean
  pid?: number
  createdAt: number
  updatedAt: number
}

export interface CreateAppInput {
  name: string
  title?: string
  template: AppTemplate
  port?: number
}

export interface CreateAppResult {
  ok: boolean
  message: string
  project?: AppProject
  files?: string[]
}

export interface AppTestResult {
  ok: boolean
  message: string
  command: string
  exitCode: number | null
  durationMs: number
  output: string
}

export interface AppRunResult {
  ok: boolean
  message: string
  project?: AppProject
  pid?: number
  url?: string
  opened?: boolean
}

export interface AppStopResult {
  ok: boolean
  message: string
}

export interface AppMetadataFile {
  format: 1
  name: string
  title: string
  template: AppTemplate
  port?: number
  createdAt: number
  updatedAt: number
}

interface TemplateFile {
  name: string
  content: string
  mode: number
}

export function normalizeAppName(input: string): string | null {
  const name = String(input ?? '').trim().toLowerCase()
  if (!/^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/.test(name)) return null
  return name
}

export function normalizePort(input: unknown): number | null {
  const port = Math.round(Number(input))
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return null
  return port
}

function sanitizeTitle(input: string | undefined, name: string): string {
  const raw = Array.from(String(input ?? ''))
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0
      return code >= 32 && code !== 127
    })
    .join('')
    .trim()
    .slice(0, 80)
  if (raw) return raw
  return name
    .split('-')
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : ''))
    .join(' ')
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

export function parseAppMetadata(raw: string, expectedName?: string): AppMetadataFile | null {
  let value: Partial<AppMetadataFile>
  try {
    value = JSON.parse(raw) as Partial<AppMetadataFile>
  } catch {
    return null
  }
  if (!value || typeof value !== 'object') return null
  if (value.format !== 1) return null
  if (typeof value.name !== 'string' || !normalizeAppName(value.name)) return null
  if (expectedName && value.name !== expectedName) return null
  if (typeof value.title !== 'string' || !value.title.trim()) return null
  if (value.template !== 'web' && value.template !== 'cli') return null
  if (!Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) return null
  const port = value.template === 'web' ? normalizePort(value.port) : undefined
  if (value.template === 'web' && port === null) return null
  return {
    format: 1,
    name: value.name,
    title: value.title.trim().slice(0, 80),
    template: value.template,
    port: port ?? undefined,
    createdAt: Number(value.createdAt),
    updatedAt: Number(value.updatedAt)
  }
}

const WEB_INDEX = (title: string): string => `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <link rel="stylesheet" href="styles.css" />
  </head>
  <body>
    <main class="card">
      <p class="eyebrow">TagNest Linux app</p>
      <h1>${escapeHtml(title)}</h1>
      <p class="lead">This page is served from a real folder inside Alpine Linux.</p>
      <button id="counter" type="button">Clicked <span id="count">0</span> times</button>
      <p class="hint" id="hint">Edit index.html, styles.css and app.js, then run sh test.sh.</p>
    </main>
    <script src="app.js"></script>
  </body>
</html>
`

const WEB_STYLES = `:root {
  color-scheme: light;
  font-family: 'Inter', 'Segoe UI', system-ui, sans-serif;
  background: #eef1f4;
  color: #12171b;
}

* {
  box-sizing: border-box;
}

body {
  display: grid;
  min-height: 100vh;
  margin: 0;
  place-items: center;
  padding: 32px;
  background: #eef1f4;
}

.card {
  width: min(560px, 100%);
  padding: 36px;
  border: 1px solid rgba(18, 23, 27, 0.1);
  border-radius: 20px;
  background: #f8fafb;
  box-shadow: 0 20px 50px rgba(20, 30, 40, 0.08);
}

.eyebrow {
  margin: 0 0 10px;
  color: #6b7680;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1 {
  margin: 0 0 10px;
  font-size: clamp(30px, 6vw, 44px);
  letter-spacing: -0.04em;
}

.lead {
  margin: 0 0 26px;
  color: #3a444d;
  line-height: 1.6;
}

button {
  padding: 11px 18px;
  border: 0;
  border-radius: 999px;
  background: #12171b;
  color: #f2f5f7;
  font: inherit;
  font-weight: 600;
  cursor: pointer;
}

button:hover {
  background: #283038;
}

.hint {
  margin: 20px 0 0;
  color: #6b7680;
  font-size: 12px;
  line-height: 1.55;
}

code {
  font-family: 'Cascadia Code', ui-monospace, monospace;
}
`

const WEB_SCRIPT = `const button = document.getElementById('counter')
const count = document.getElementById('count')
const hint = document.getElementById('hint')
let clicks = 0

button?.addEventListener('click', () => {
  clicks += 1
  if (count) count.textContent = String(clicks)
  if (hint) {
    hint.textContent =
      clicks === 1
        ? 'The app is real and running inside Linux.'
        : 'You clicked ' + clicks + ' times.'
  }
})
`

const WEB_TEST = `#!/bin/sh
set -eu
for file in index.html styles.css app.js test.sh; do
  test -f "$file" || { echo "missing $file" >&2; exit 1; }
done
grep -q '<!doctype html' index.html
grep -q 'app.js' index.html
grep -q 'id="counter"' index.html
echo "web project OK: index.html $(wc -c < index.html) bytes"
`

const CLI_APP = `#!/bin/sh
set -eu

case "\${1:-}" in
  -h|--help)
    echo "Usage: ./app.sh [name]"
    exit 0
    ;;
esac

name="\${1:-world}"
echo "Hello, $name!"
`

const CLI_RUN = `#!/bin/sh
cd "$(dirname "$0")"
./app.sh "$@"
printf '\\nPress Enter to close…'
read _ || true
`

const CLI_TEST = `#!/bin/sh
set -eu
sh -n app.sh
sh -n run.sh
output=$(./app.sh TagNest)
[ "$output" = "Hello, TagNest!" ]
./app.sh --help | grep -q "Usage:"
echo "CLI project OK: $output"
`

export function buildTemplateFiles(input: {
  name: string
  title: string
  template: AppTemplate
  port?: number
  now?: number
}): TemplateFile[] {
  const now = input.now ?? Date.now()
  const metadata: AppMetadataFile = {
    format: 1,
    name: input.name,
    title: input.title,
    template: input.template,
    port: input.template === 'web' ? input.port : undefined,
    createdAt: now,
    updatedAt: now
  }
  const metaFile: TemplateFile = {
    name: 'tagnest-app.json',
    content: `${JSON.stringify(metadata, null, 2)}\n`,
    mode: 0o644
  }

  if (input.template === 'web') {
    const port = input.port ?? 8080
    return [
      { name: 'index.html', content: WEB_INDEX(input.title), mode: 0o644 },
      { name: 'styles.css', content: WEB_STYLES, mode: 0o644 },
      { name: 'app.js', content: WEB_SCRIPT, mode: 0o644 },
      { name: 'test.sh', content: WEB_TEST, mode: 0o755 },
      {
        name: 'README.md',
        content: `# ${input.title}\n\nA real web app project created by TagNest inside the Linux workspace.\n\n- Folder: \`${APPS_DIR}/${input.name}\`\n- Served on: \`http://127.0.0.1:${port}/\`\n- Test: \`sh test.sh\`\n\nRun it with the TagNest **app_run** tool, or manually:\n\n\`\`\`sh\npython3 -m http.server ${port} --bind 127.0.0.1\n\`\`\`\n`,
        mode: 0o644
      },
      metaFile
    ]
  }

  return [
    { name: 'app.sh', content: CLI_APP, mode: 0o755 },
    { name: 'run.sh', content: CLI_RUN, mode: 0o755 },
    { name: 'test.sh', content: CLI_TEST, mode: 0o755 },
    {
      name: 'README.md',
      content: `# ${input.title}\n\nA real command-line app project created by TagNest inside the Linux workspace.\n\n- Folder: \`${APPS_DIR}/${input.name}\`\n- Run: \`./run.sh\`\n- Test: \`sh test.sh\`\n\nEdit \`app.sh\`, then test and run it from TagNest.\n`,
      mode: 0o644
    },
    metaFile
  ]
}

async function portInUse(guest: GuestClient, port: number): Promise<boolean> {
  const result = await guest.exec(
    `netstat -ltn 2>/dev/null | grep -qE "[:.]${port}[[:space:]]" && echo in-use || echo free`,
    { timeoutMs: 15_000 }
  )
  return result.stdout.includes('in-use')
}

async function readPid(
  guest: GuestClient,
  directory: string,
  marker: string
): Promise<number | null> {
  let raw: string
  try {
    raw = await guest.readFile(`${directory}/.tagnest.pid`, 64)
  } catch {
    return null
  }
  const pid = Number(raw.trim())
  if (!Number.isInteger(pid) || pid <= 1) return null
  // A PID can be reused after a reboot, so verify it is still the process we
  // started before reporting it as running (or letting app_stop kill it).
  const result = await guest.exec(
    `if kill -0 ${pid} 2>/dev/null; then ` +
      `cmd=$(tr '\\0' ' ' < /proc/${pid}/cmdline 2>/dev/null); ` +
      `printf '%s' "$cmd" | grep -F ${shellQuote(marker)} >/dev/null 2>&1 && echo alive || echo stale; ` +
      `else echo dead; fi`,
    { timeoutMs: 10_000 }
  )
  return result.stdout.includes('alive') ? pid : null
}

async function readLogTail(guest: GuestClient, directory: string): Promise<string> {
  try {
    const raw = await guest.readFile(`${directory}/.tagnest-run.log`, 8 * 1024)
    return raw.trim().split('\n').slice(-8).join('\n')
  } catch {
    return ''
  }
}

export async function readAppProject(guest: GuestClient, nameInput: string): Promise<AppProject | null> {
  const name = normalizeAppName(nameInput)
  if (!name) return null
  const directory = `${APPS_DIR}/${name}`
  let raw: string
  try {
    raw = await guest.readFile(`${directory}/tagnest-app.json`, 64 * 1024)
  } catch {
    return null
  }
  const metadata = parseAppMetadata(raw, name)
  if (!metadata) return null
  const marker = metadata.template === 'web' ? `http.server ${metadata.port}` : 'xfce4-terminal'
  const pid = await readPid(guest, directory, marker)
  return {
    name,
    title: metadata.title,
    template: metadata.template,
    path: directory,
    port: metadata.port,
    url: metadata.template === 'web' && metadata.port ? `http://127.0.0.1:${metadata.port}/` : undefined,
    running: pid !== null,
    pid: pid ?? undefined,
    createdAt: metadata.createdAt,
    updatedAt: metadata.updatedAt
  }
}

export async function listAppProjects(guest: GuestClient): Promise<AppProject[]> {
  let entries: Awaited<ReturnType<GuestClient['list']>>
  try {
    entries = await guest.list(APPS_DIR)
  } catch {
    return []
  }
  const projects: AppProject[] = []
  for (const entry of entries) {
    if (entry.type !== 'directory') continue
    if (entry.name.startsWith('.')) continue
    const project = await readAppProject(guest, entry.name)
    if (project) projects.push(project)
  }
  return projects.sort((left, right) => right.updatedAt - left.updatedAt)
}

export async function createAppProject(
  guest: GuestClient,
  input: CreateAppInput
): Promise<CreateAppResult> {
  const name = normalizeAppName(input.name)
  if (!name) {
    return {
      ok: false,
      message:
        'Invalid app name. Use 1–32 lowercase letters, digits or hyphens, starting and ending with a letter or digit.'
    }
  }
  if (input.template !== 'web' && input.template !== 'cli') {
    return { ok: false, message: 'template must be "web" or "cli".' }
  }
  const port = input.template === 'web' ? normalizePort(input.port ?? 8080) : undefined
  if (input.template === 'web' && port === null) {
    return { ok: false, message: 'Port must be a whole number between 1024 and 65535.' }
  }
  const directory = `${APPS_DIR}/${name}`
  if (await guest.stat(directory)) {
    return { ok: false, message: `An app project named "${name}" already exists.` }
  }
  if (port && (await portInUse(guest, port))) {
    return {
      ok: false,
      message: `Port ${port} is already in use inside Linux. Choose another port with the port argument (for example 8090).`
    }
  }

  const title = sanitizeTitle(input.title, name)
  const mkdir = await guest.exec(`mkdir -p ${shellQuote(APPS_DIR)} ${shellQuote(directory)}`, {
    timeoutMs: 15_000
  })
  if (mkdir.exitCode !== 0) {
    return {
      ok: false,
      message: `Could not create the project folder: ${mkdir.stderr.trim() || 'mkdir failed'}`
    }
  }

  const files = buildTemplateFiles({ name, title, template: input.template, port: port ?? undefined })
  try {
    for (const file of files) {
      await guest.writeFile(`${directory}/${file.name}`, file.content, file.mode)
    }
  } catch (error) {
    return {
      ok: false,
      message: `Could not write the starter files: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const project = await readAppProject(guest, name)
  return {
    ok: true,
    message: `Created "${title}" (${input.template}) in ${directory}. Files: ${files
      .map((file) => file.name)
      .join(', ')}.${port ? ` It will listen on http://127.0.0.1:${port}/.` : ''}`,
    project: project ?? undefined,
    files: files.map((file) => file.name)
  }
}

function formatExecOutput(result: {
  exitCode: number | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}): string {
  const parts = [`exit code: ${result.exitCode ?? 'unknown'} (${result.durationMs} ms)`]
  if (result.timedOut) parts.push('NOTE: the test hit the timeout and was terminated.')
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)')
  return parts.join('\n').slice(0, 12_000)
}

export async function testAppProject(guest: GuestClient, name: string): Promise<AppTestResult> {
  const project = await readAppProject(guest, name)
  if (!project) {
    return {
      ok: false,
      message: `No app project named "${name}". Use app_list to see the projects.`,
      command: 'sh test.sh',
      exitCode: null,
      durationMs: 0,
      output: ''
    }
  }
  const result = await guest.exec('sh test.sh', { cwd: project.path, timeoutMs: 180_000 })
  const output = formatExecOutput(result)
  return {
    ok: result.exitCode === 0 && !result.timedOut,
    message:
      result.exitCode === 0
        ? `Tests passed for "${project.title}".`
        : `Tests failed for "${project.title}" (exit code ${result.exitCode ?? 'unknown'}).`,
    command: 'sh test.sh',
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    output
  }
}

async function openInBrowser(guest: GuestClient, url: string): Promise<boolean> {
  try {
    const result = await guest.exec(
      `test -x /usr/local/bin/tagnest-open && /usr/local/bin/tagnest-open ${shellQuote(url)}`,
      { timeoutMs: 45_000 }
    )
    return result.exitCode === 0 && result.stdout.includes('opened')
  } catch {
    return false
  }
}

/**
 * Waits for a visible Firefox window after the launcher returns. The helper
 * reports the process, not the window, and a newly started browser needs a
 * moment to map its first window; the model should not screenshot before it.
 */
async function waitForBrowserWindow(guest: GuestClient): Promise<boolean> {
  const result = await guest.exec(
    'i=0; while [ "$i" -lt 24 ]; do ' +
      'DISPLAY=:1 xdotool search --onlyvisible --class firefox >/dev/null 2>&1 && { echo ready; exit 0; }; ' +
      'i=$((i+1)); sleep 0.5; done; echo timeout',
    { timeoutMs: 20_000 }
  )
  return result.stdout.includes('ready')
}

export async function runAppProject(guest: GuestClient, name: string): Promise<AppRunResult> {
  const project = await readAppProject(guest, name)
  if (!project) {
    return { ok: false, message: `No app project named "${name}". Use app_list to see the projects.` }
  }

  if (project.running) {
    if (project.url) {
      const opened = await openInBrowser(guest, project.url)
      return {
        ok: true,
        message: `"${project.title}" is already running at ${project.url}.${
          opened ? ' Reopened it in Firefox.' : ''
        }`,
        project,
        pid: project.pid,
        url: project.url,
        opened
      }
    }
    return {
      ok: true,
      message: `"${project.title}" is already running (PID ${project.pid}).`,
      project,
      pid: project.pid
    }
  }

  const directory = project.path
  const log = `${directory}/.tagnest-run.log`
  const pidFile = `${directory}/.tagnest.pid`

  if (project.template === 'web') {
    if (!project.port || !project.url) {
      return { ok: false, message: 'This web project has no usable port in its metadata.' }
    }
    if (await portInUse(guest, project.port)) {
      return {
        ok: false,
        message: `Port ${project.port} is already in use inside Linux. Stop the other process or create the app on another port.`
      }
    }
    const command = `cd ${shellQuote(directory)}; setsid sh -c ${shellQuote(
      `exec python3 -m http.server ${project.port} --bind 127.0.0.1`
    )} > ${shellQuote(log)} 2>&1 & echo $!`
    const started = await guest.exec(command, { timeoutMs: 20_000 })
    const pid = Number(started.stdout.trim().split('\n').pop())
    if (!Number.isInteger(pid) || pid <= 1) {
      return { ok: false, message: `Could not start the web server: ${started.stderr.trim() || 'no PID'}` }
    }
    const probe = await guest.exec(
      `i=0; while [ "$i" -lt 20 ]; do wget -q -O /dev/null --timeout=1 ${shellQuote(
        project.url
      )} 2>/dev/null && { echo ready; exit 0; }; i=$((i+1)); sleep 0.5; done; echo timeout`,
      { timeoutMs: 30_000 }
    )
    if (!probe.stdout.includes('ready')) {
      await guest.exec(`kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null || true`, {
        timeoutMs: 10_000
      })
      const tail = await readLogTail(guest, directory)
      return {
        ok: false,
        message: `The server did not answer at ${project.url} within 10 seconds.${
          tail ? `\nLast log lines:\n${tail}` : ''
        }`
      }
    }
    await guest.writeFile(pidFile, `${pid}\n`)
    const opened = await openInBrowser(guest, project.url)
    const visible = opened ? await waitForBrowserWindow(guest) : false
    return {
      ok: true,
      message: `Running "${project.title}" at ${project.url} (PID ${pid}).${
        visible
          ? ' The page is open in Firefox on the Linux desktop; take a screenshot to see it.'
          : opened
            ? ' Firefox started, but its window was not visible yet; take a screenshot to check.'
            : ' The page is reachable, but Firefox could not be opened automatically.'
      }`,
      project: { ...project, running: true, pid },
      pid,
      url: project.url,
      opened
    }
  }

  // CLI projects already open a real terminal window on the desktop.
  const command = `cd ${shellQuote(directory)}; DISPLAY=:1 setsid xfce4-terminal --disable-server --maximize --title ${shellQuote(
    `TagNest: ${project.title}`
  )} -e ${shellQuote(`sh ${directory}/run.sh`)} > ${shellQuote(log)} 2>&1 & echo $!`
  const started = await guest.exec(command, { timeoutMs: 20_000 })
  const pid = Number(started.stdout.trim().split('\n').pop())
  if (!Number.isInteger(pid) || pid <= 1) {
    return { ok: false, message: `Could not open a terminal: ${started.stderr.trim() || 'no PID'}` }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500))
  const alive = await guest.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, {
    timeoutMs: 10_000
  })
  if (!alive.stdout.includes('alive')) {
    const tail = await readLogTail(guest, directory)
    return {
      ok: false,
      message: `The terminal exited immediately.${tail ? `\nLast log lines:\n${tail}` : ''}`
    }
  }
  await guest.writeFile(pidFile, `${pid}\n`)
  return {
    ok: true,
    message: `Opened "${project.title}" in a terminal window on the Linux desktop (PID ${pid}).`,
    project: { ...project, running: true, pid },
    pid
  }
}

export async function stopAppProject(guest: GuestClient, name: string): Promise<AppStopResult> {
  const project = await readAppProject(guest, name)
  if (!project) {
    return { ok: false, message: `No app project named "${name}". Use app_list to see the projects.` }
  }
  if (!project.pid) {
    return { ok: true, message: `"${project.title}" is not running.` }
  }
  const pid = project.pid
  await guest.exec(`kill -TERM -- -${pid} 2>/dev/null || kill -TERM ${pid} 2>/dev/null || true`, {
    timeoutMs: 10_000
  })
  await new Promise((resolve) => setTimeout(resolve, 800))
  const check = await guest.exec(`kill -0 ${pid} 2>/dev/null && echo alive || echo dead`, {
    timeoutMs: 10_000
  })
  if (check.stdout.includes('alive')) {
    await guest.exec(`kill -KILL -- -${pid} 2>/dev/null || kill -KILL ${pid} 2>/dev/null || true`, {
      timeoutMs: 10_000
    })
  }
  await guest.exec(`rm -f ${shellQuote(`${project.path}/.tagnest.pid`)}`, { timeoutMs: 10_000 })
  return { ok: true, message: `Stopped "${project.title}" (PID ${pid}).` }
}
