import { WebSocket } from 'ws'
import { logger } from '../logger'
import { BROWSER_DEBUG_PORT, BROWSER_PROXY_PORT } from './config'
import type { GuestClient } from './ssh'

/**
 * Chromium is the agent's automation browser. Firefox remains the browser the
 * user can open by hand; this one is launched once with the DevTools protocol
 * enabled and then reused for every page the agent visits, so commands act on
 * the same visible window instead of spawning a new browser each time.
 *
 * Chromium binds its DevTools port to guest loopback (Chrome refuses other
 * addresses). A socat bridge exposes it on the guest's private NAT address,
 * and QEMU forwards that to 127.0.0.1 on the host. It is never reachable from
 * the host's network interfaces or from the local network.
 */
const DEBUG_PORT = BROWSER_DEBUG_PORT
const PROFILE_DIR = '/home/tagnest/.config/tagnest-browser'
const LOG_FILE = '/tmp/tagnest-browser.log'

const COMMUNITY_REPO_SETUP =
  'if ! grep -q /community /etc/apk/repositories; then ' +
  'main=$(grep /main /etc/apk/repositories | head -n1); ' +
  '[ -n "$main" ] && printf "%s\\n" "${main%/main}/community" | sudo -n tee -a /etc/apk/repositories >/dev/null; ' +
  'fi'

const CHROMIUM_INSTALL_COMMAND =
  `${COMMUNITY_REPO_SETUP}; sudo -n apk update >/dev/null && ` +
  '(sudo -n apk add --no-cache chromium || sudo -n apk add --no-cache chromium-browser)'

const LAUNCH_SCRIPT = `export DISPLAY=:1
export HOME=/home/tagnest
export XDG_RUNTIME_DIR=/run/tagnest
bin=$(command -v chromium || command -v chromium-browser) || { echo "chromium is not installed" >&2; exit 3; }
session=$(pgrep -u tagnest -x xfce4-session | head -n1)
if [ -n "$session" ]; then
  bus=$(tr '\\0' '\\n' < "/proc/$session/environ" 2>/dev/null | sed -n 's/^DBUS_SESSION_BUS_ADDRESS=//p' | head -n1)
  if [ -n "$bus" ]; then export DBUS_SESSION_BUS_ADDRESS="$bus"; fi
fi
mkdir -p ${PROFILE_DIR}
# A VM that was powered off or killed can leave Chromium's singleton lock
# behind; a stale lock makes the next launch exit without opening a window.
rm -f "$PROFILE_DIR/SingletonLock" "$PROFILE_DIR/SingletonSocket" "$PROFILE_DIR/SingletonCookie"
start_dir=/home/tagnest/.config/tagnest-browser-start
mkdir -p "$start_dir"
printf '%s' '<!doctype html><html><head><meta charset="utf-8"><title>TagNest browser</title></head><body style="font-family:sans-serif;padding:40px"><h1>TagNest browser is ready</h1><p>The assistant will open pages here.</p></body></html>' > "$start_dir/index.html"
if ! curl -s --max-time 1 http://127.0.0.1:39224/ >/dev/null 2>&1; then
  (cd "$start_dir" && setsid python3 -m http.server 39224 >/tmp/tagnest-browser-start.log 2>&1 </dev/null &)
  sleep 0.5
fi
nohup "$bin" \\
  --remote-debugging-port=${DEBUG_PORT} \\
  --remote-debugging-address=127.0.0.1 \\
  --remote-allow-origins=* \\
  --user-data-dir=${PROFILE_DIR} \\
  --no-sandbox \\
  --disable-setuid-sandbox \\
  --password-store=basic \\
  --use-mock-keychain \\
  --hide-crash-restore-bubble \\
  --no-first-run \\
  --no-default-browser-check \\
  --disable-dev-shm-usage \\
  --disable-gpu \\
  --window-size=1420,840 \\
  --window-position=0,0 \\
  http://127.0.0.1:39224/ >${LOG_FILE} 2>&1 &
echo $!`

const FOCUS_SCRIPT = `export DISPLAY=:1
wid=$(xdotool search --onlyvisible --class chromium 2>/dev/null | head -n1)
[ -z "$wid" ] && wid=$(xdotool search --onlyvisible --class Chromium 2>/dev/null | head -n1)
if [ -n "$wid" ]; then
  xdotool windowactivate --sync "$wid" >/dev/null 2>&1 || true
  xdotool windowsize "$wid" 100% 100% >/dev/null 2>&1 || true
fi
echo focused`

export interface BrowserElement {
  ref: number
  tag: string
  label: string
  type?: string
  href?: string
  checked?: boolean
}

export interface BrowserPage {
  title: string
  url: string
  text: string
  elements: BrowserElement[]
}

export interface CdpTarget {
  id?: string
  type?: string
  url?: string
  title?: string
  webSocketDebuggerUrl?: string
}

/** Only real web pages may be navigated; file:, chrome: and javascript: are refused. */
export function validateBrowserUrl(raw: string): string | null {
  const url = String(raw ?? '').trim()
  if (!url) return 'url is required.'
  if (!/^https?:\/\//i.test(url)) return 'Only absolute http:// or https:// URLs are supported.'
  if (url.length > 2048) return 'The URL is too long.'
  if (/[\s<>"'`\\]/.test(url)) return 'The URL contains whitespace or quote characters that are not allowed.'
  return null
}

/**
 * Picks the visible page target. Extension/service workers also appear in the
 * target list; navigating one of those would leave the window on about:blank.
 */
export function pickPageTarget(targets: CdpTarget[]): CdpTarget | null {
  const pages = targets.filter((target) => target.type === 'page' && typeof target.webSocketDebuggerUrl === 'string')
  if (pages.length === 0) return null
  return pages.find((target) => typeof target.url === 'string' && /^https?:/i.test(target.url)) ?? pages[0]
}

/** Rewrites the guest's ws://127.0.0.1:9222 URL to the local forwarded port. */
export function rewriteWebSocketUrl(raw: string, localPort: number): string | null {
  try {
    const parsed = new URL(raw)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return null
    if (!parsed.pathname.startsWith('/devtools/')) return null
    return `ws://127.0.0.1:${localPort}${parsed.pathname}${parsed.search}`
  } catch {
    return null
  }
}

/** Extracts a JSON array from curl output that may contain a trailing newline. */
export function parseTargetList(stdout: string): CdpTarget[] {
  const text = stdout.trim()
  if (!text) return []
  try {
    const parsed: unknown = JSON.parse(text)
    return Array.isArray(parsed) ? (parsed as CdpTarget[]) : []
  } catch {
    return []
  }
}

interface CdpResponse {
  id?: number
  result?: unknown
  error?: { message?: string }
}

class CdpConnection {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  private closed = false

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => this.onMessage(data.toString()))
    socket.on('close', () => this.failAll(new Error('The browser control connection closed.')))
    socket.on('error', (error: Error) => this.failAll(error))
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === WebSocket.OPEN
  }

  send<T>(method: string, params: Record<string, unknown> = {}, timeoutMs = 30_000): Promise<T> {
    if (!this.isOpen) return Promise.reject(new Error('The browser control connection is not open.'))
    const id = this.nextId
    this.nextId += 1
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`The browser did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer })
      this.socket.send(JSON.stringify({ id, method, params }), (error) => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        reject(error)
      })
    })
  }

  close(): void {
    this.closed = true
    this.failAll(new Error('The browser control connection was closed.'))
    try {
      this.socket.close()
    } catch {
      /* already closed */
    }
  }

  private onMessage(raw: string): void {
    let message: CdpResponse
    try {
      message = JSON.parse(raw) as CdpResponse
    } catch {
      return
    }
    if (typeof message.id !== 'number') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    this.pending.delete(message.id)
    clearTimeout(entry.timer)
    if (message.error) entry.reject(new Error(message.error.message || 'The browser rejected the command.'))
    else entry.resolve(message.result)
  }

  private failAll(error: Error): void {
    for (const [id, entry] of this.pending) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.reject(error)
    }
  }
}

const PAGE_SUMMARY_SCRIPT = `(() => {
  const flat = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    if (rect.bottom < 0 || rect.top > innerHeight * 1.2 || rect.right < 0 || rect.left > innerWidth * 1.2) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) !== 0;
  };
  const elements = [];
  let ref = 0;
  const nodes = document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[contenteditable="true"]');
  for (const el of nodes) {
    if (!visible(el)) continue;
    const tag = el.tagName.toLowerCase();
    const label = flat(el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '');
    if (!label && tag !== 'input') continue;
    ref += 1;
    if (ref > 80) break;
    el.setAttribute('data-tagnest-ref', String(ref));
    elements.push({
      ref,
      tag,
      label: label.slice(0, 90),
      type: el.getAttribute('type') || undefined,
      href: el.href || undefined,
      checked: typeof el.checked === 'boolean' ? el.checked : undefined
    });
  }
  const body = document.body ? document.body.innerText : '';
  return {
    title: document.title,
    url: location.href,
    text: String(body || '').replace(/\\n{3,}/g, '\\n\\n').trim().slice(0, 9000),
    elements
  };
})()`

function finderScript(target: { ref?: number; selector?: string; text?: string }): string {
  return `((target) => {
    const flat = (value) => String(value || '').replace(/\\s+/g, ' ').trim().toLowerCase();
    let el = null;
    if (target.ref) el = document.querySelector('[data-tagnest-ref="' + Number(target.ref) + '"]');
    if (!el && target.selector) {
      try { el = document.querySelector(target.selector); }
      catch (error) { return { ok: false, error: 'Invalid selector: ' + error.message }; }
    }
    if (!el && target.text) {
      const wanted = flat(target.text);
      const candidates = Array.from(document.querySelectorAll('a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],label,summary'));
      el = candidates.find((node) => flat(node.innerText || node.value || node.getAttribute('aria-label') || node.getAttribute('placeholder') || node.title).includes(wanted)) || null;
      if (!el) {
        el = Array.from(document.querySelectorAll('body *')).find((node) => !node.children.length && flat(node.textContent) === wanted) || null;
      }
    }
    if (!el && !target.ref && !target.selector && !target.text) {
      const active = document.activeElement;
      if (active && active !== document.body) el = active;
    }
    if (!el) return { ok: false, error: 'No element matched the ref, selector or text.' };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity) === 0) {
      return { ok: false, error: 'The element is hidden.' };
    }
    const tag = el.tagName.toLowerCase();
    if (el.disabled) return { ok: false, error: 'The matched ' + tag + ' is disabled.' };
    try { el.focus({ preventScroll: true }); } catch (error) {}
    try { if (typeof el.select === 'function') el.select(); } catch (error) {}
    return {
      ok: true,
      tag,
      label: String(el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 140),
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2)
    };
  })(${JSON.stringify(target)})`
}

type ElementMatch =
  | { ok: false; error: string }
  | { ok: true; tag: string; label: string; x: number; y: number }

export class GuestBrowser {
  private socket: WebSocket | null = null
  private cdp: CdpConnection | null = null
  private ready: Promise<void> | null = null
  private disposed = false

  constructor(
    private readonly guest: GuestClient,
    private readonly getHostPort: () => number | null
  ) {}

  async open(rawUrl: string): Promise<BrowserPage> {
    const problem = validateBrowserUrl(rawUrl)
    if (problem) throw new Error(problem)
    await this.ensureReady()
    // Navigate through the page's own location rather than Page.navigate.
    // This works on the attached page target and keeps one code path for all
    // navigations. Scheduling it briefly lets the evaluate response arrive
    // before the old execution context is torn down.
    const started = await this.evaluate<string>(
      `(() => { const url = ${JSON.stringify(rawUrl.trim())}; setTimeout(() => { location.assign(url); }, 50); return 'scheduled'; })()`
    )
    if (started !== 'scheduled') throw new Error(`Could not start loading ${rawUrl}.`)
    await new Promise((resolve) => setTimeout(resolve, 900))
    await this.waitForLoad(20_000)
    await this.focusWindow()
    return this.readPage()
  }

  async read(): Promise<BrowserPage> {
    await this.ensureReady()
    return this.readPage()
  }

  async click(target: { ref?: number; selector?: string; text?: string }): Promise<{
    label: string
    tag: string
    url: string
    title: string
  }> {
    await this.ensureReady()
    const match = await this.evaluate<ElementMatch>(finderScript(target))
    if (!match || typeof match !== 'object' || match.ok !== true) {
      throw new Error(match && 'error' in match ? match.error : 'No element matched.')
    }
    const cdp = this.requireCdp()
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: match.x, y: match.y })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: match.x,
      y: match.y,
      button: 'left',
      clickCount: 1
    })
    await cdp.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: match.x,
      y: match.y,
      button: 'left',
      clickCount: 1
    })
    await new Promise((resolve) => setTimeout(resolve, 500))
    await this.waitForLoad(10_000).catch(() => undefined)
    const page = await this.readPage()
    return { label: match.label, tag: match.tag, url: page.url, title: page.title }
  }

  async type(target: { ref?: number; selector?: string; text: string; submit?: boolean }): Promise<{
    label: string
    value: string
    url: string
  }> {
    await this.ensureReady()
    const match = await this.evaluate<ElementMatch>(finderScript(target))
    if (!match || typeof match !== 'object' || match.ok !== true) {
      throw new Error(match && 'error' in match ? match.error : 'No field matched.')
    }
    const cdp = this.requireCdp()
    // Select the existing contents, then replace them with real text input so
    // React/Vue controlled fields receive the same events a person produces.
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: 2,
      key: 'a',
      code: 'KeyA',
      windowsVirtualKeyCode: 65
    })
    await cdp.send('Input.insertText', { text: String(target.text ?? '') })
    if (target.submit) {
      await this.pressEnter(cdp)
      await new Promise((resolve) => setTimeout(resolve, 600))
      await this.waitForLoad(10_000).catch(() => undefined)
    }
    const value = await this.evaluate<string>(
      `(() => { const el = document.activeElement; return el && ('value' in el) ? String(el.value) : ''; })()`
    ).catch(() => '')
    const page = await this.readPage()
    return { label: match.label, value: value ?? '', url: page.url }
  }

  async pressKey(key: 'Enter' | 'Tab' | 'Escape'): Promise<void> {
    await this.ensureReady()
    const cdp = this.requireCdp()
    const codes: Record<string, { code: string; vk: number }> = {
      Enter: { code: 'Enter', vk: 13 },
      Tab: { code: 'Tab', vk: 9 },
      Escape: { code: 'Escape', vk: 27 }
    }
    const info = codes[key]
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.vk
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code: info.code,
      windowsVirtualKeyCode: info.vk
    })
  }

  async scroll(direction: 'up' | 'down', amount: number): Promise<number> {
    await this.ensureReady()
    const distance = Math.max(1, Math.min(20, Math.round(amount))) * 600 * (direction === 'up' ? -1 : 1)
    const position = await this.evaluate<number>(
      `(() => { window.scrollBy({ top: ${distance}, left: 0, behavior: 'auto' }); return Math.round(window.scrollY); })()`
    )
    return typeof position === 'number' ? position : 0
  }

  async back(): Promise<BrowserPage> {
    await this.ensureReady()
    await this.evaluate(`(() => { history.back(); return true; })()`)
    await new Promise((resolve) => setTimeout(resolve, 400))
    await this.waitForLoad(15_000).catch(() => undefined)
    return this.readPage()
  }

  async screenshot(): Promise<{ base64: string; width: number; height: number }> {
    await this.ensureReady()
    const cdp = this.requireCdp()
    const capture = await cdp.send<{ data?: string }>('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false
    })
    if (!capture.data) throw new Error('The browser returned an empty screenshot.')
    const size = await this.evaluate<{ width: number; height: number }>(
      '({ width: window.innerWidth, height: window.innerHeight })'
    ).catch(() => ({ width: 0, height: 0 }))
    return { base64: capture.data, width: size?.width ?? 0, height: size?.height ?? 0 }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    this.cdp?.close()
    this.cdp = null
    try {
      this.socket?.close()
    } catch {
      /* already closed */
    }
    this.socket = null
  }

  private async ensureReady(): Promise<void> {
    if (this.disposed) throw new Error('The browser controller was shut down with the Linux environment.')
    if (this.cdp?.isOpen) return
    if (this.ready) return this.ready
    this.ready = this.start().finally(() => {
      this.ready = null
    })
    return this.ready
  }

  private async start(): Promise<void> {
    const hostPort = this.getHostPort()
    if (!hostPort) throw new Error('The browser control port is not available. Start the Linux environment first.')
    await this.ensureChromium()
    await this.ensureProxy()
    await this.ensureBrowserProcess(hostPort)
    const targets = await this.listTargets()
    let target = pickPageTarget(targets)
    if (!target) {
      const created = await this.guest.exec(
        `curl -s -X PUT --max-time 5 http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`,
        { timeoutMs: 10_000 }
      )
      target = parseTargetList(created.stdout)[0] ?? null
    }
    if (!target?.webSocketDebuggerUrl) {
      throw new Error('Chromium is running but exposes no page to control. Restart the Linux environment and try again.')
    }
    const localUrl = rewriteWebSocketUrl(target.webSocketDebuggerUrl, hostPort)
    if (!localUrl) throw new Error('Chromium returned an unexpected debugging address.')
    const socket = new WebSocket(localUrl, { perMessageDeflate: false, handshakeTimeout: 10_000 })
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Connecting to the browser control port timed out.')), 12_000)
      socket.once('open', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error: Error) => {
        clearTimeout(timer)
        reject(new Error(`Could not connect to Chromium: ${error.message}`))
      })
    })
    this.socket = socket
    this.cdp = new CdpConnection(socket)
    logger.info('browser', 'Chromium automation session connected')
  }

  private async ensureChromium(): Promise<void> {
    const check = await this.guest.exec('command -v chromium || command -v chromium-browser || true', {
      timeoutMs: 15_000
    })
    if (check.stdout.trim()) return
    logger.info('browser', 'Chromium is missing in the guest, installing it once')
    const install = await this.guest.exec(CHROMIUM_INSTALL_COMMAND, { timeoutMs: 600_000 })
    if (install.exitCode !== 0) {
      const detail = (install.stderr || install.stdout).trim().slice(-500)
      throw new Error(
        `The automation browser (Chromium) could not be installed in Linux. ${detail || 'apk returned an error.'}`
      )
    }
    const verify = await this.guest.exec('command -v chromium || command -v chromium-browser || true', {
      timeoutMs: 15_000
    })
    if (!verify.stdout.trim()) throw new Error('Chromium was installed but its executable was not found.')
    logger.info('browser', 'Chromium installed in the guest')
  }

  /**
   * Chrome refuses to bind its DevTools port anywhere but loopback, while QEMU
   * can only forward to the guest's network address. A tiny socat bridge in
   * the guest connects the two; QEMU still exposes it only on host loopback.
   */
  private async ensureProxy(): Promise<void> {
    const check = await this.guest.exec('command -v socat || true', { timeoutMs: 15_000 })
    if (!check.stdout.trim()) {
      logger.info('browser', 'socat is missing in the guest, installing it once')
      const install = await this.guest.exec(`${COMMUNITY_REPO_SETUP}; sudo -n apk add --no-cache socat`, {
        timeoutMs: 180_000
      })
      if (install.exitCode !== 0) {
        throw new Error(
          `The browser bridge (socat) could not be installed: ${(install.stderr || install.stdout).trim().slice(-300)}`
        )
      }
    }
    const start = await this.guest.exec(
      'for pid in $(pgrep -x socat); do ' +
        `tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q 'TCP-LISTEN:${BROWSER_PROXY_PORT}' && kill "$pid" 2>/dev/null || true; ` +
        'done; sleep 0.3; ' +
        `setsid socat TCP-LISTEN:${BROWSER_PROXY_PORT},fork,reuseaddr,bind=0.0.0.0 TCP:127.0.0.1:${BROWSER_DEBUG_PORT} ` +
        '>/tmp/tagnest-browser-proxy.log 2>&1 </dev/null & echo started $!',
      { timeoutMs: 20_000 }
    )
    if (!start.stdout.includes('started')) {
      throw new Error('The browser bridge could not start inside Linux.')
    }
    await new Promise((resolve) => setTimeout(resolve, 400))
    const alive = await this.guest.exec('pgrep -x socat >/dev/null 2>&1 && echo yes || echo no', {
      timeoutMs: 10_000
    })
    if (!alive.stdout.includes('yes')) {
      const log = await this.guest
        .exec('tail -n 20 /tmp/tagnest-browser-proxy.log 2>/dev/null || true', { timeoutMs: 10_000 })
        .then((result) => result.stdout.trim())
        .catch(() => '')
      throw new Error(`The browser bridge did not stay running.${log ? `\n${log}` : ''}`)
    }
  }

  private async ensureBrowserProcess(hostPort: number): Promise<void> {
    if (await this.debugPortAnswers(hostPort)) return
    // If our own profile is running without the debugging port (for example a
    // previous launch raced Chromium), restart only that profile.
    const profile = await this.guest.exec(
      'pgrep -u tagnest -x chromium >/dev/null 2>&1 && echo running || echo absent',
      { timeoutMs: 10_000 }
    )
    if (profile.stdout.includes('running')) {
      // Match by the process's own command line, never by a pattern that also
      // appears in this shell command (pkill -f would kill this shell too).
      await this.guest.exec(
        'for pid in $(pgrep -u tagnest -x chromium); do ' +
          `tr '\\0' ' ' < /proc/$pid/cmdline 2>/dev/null | grep -q 'tagnest-browser' && kill "$pid" 2>/dev/null || true; ` +
          'done; sleep 1',
        { timeoutMs: 15_000 }
      )
    }
    const launch = await this.guest.exec(LAUNCH_SCRIPT, { timeoutMs: 30_000 })
    if (launch.exitCode !== 0) {
      throw new Error(`Chromium did not start: ${(launch.stderr || launch.stdout).trim().slice(-500)}`)
    }
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await this.debugPortAnswers(hostPort)) {
        await this.focusWindow()
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    const log = await this.guest
      .exec(`tail -n 25 ${LOG_FILE} 2>/dev/null || true`, { timeoutMs: 10_000 })
      .then((result) => result.stdout.trim())
      .catch(() => '')
    throw new Error(`Chromium did not open its control port.${log ? `\n${log}` : ''}`)
  }

  private async debugPortAnswers(hostPort: number): Promise<boolean> {
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/json/version`, {
        signal: AbortSignal.timeout(2500)
      })
      if (!response.ok) return false
      return (await response.text()).includes('webSocketDebuggerUrl')
    } catch {
      return false
    }
  }

  private async listTargets(): Promise<CdpTarget[]> {
    const hostPort = this.getHostPort()
    if (!hostPort) return []
    try {
      const response = await fetch(`http://127.0.0.1:${hostPort}/json/list`, {
        signal: AbortSignal.timeout(5000)
      })
      if (!response.ok) return []
      return parseTargetList(await response.text())
    } catch {
      return []
    }
  }

  private async focusWindow(): Promise<void> {
    await this.guest.exec(FOCUS_SCRIPT, { timeoutMs: 15_000 }).catch(() => undefined)
  }

  private async waitForLoad(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs
    let last: { state?: string; url?: string; title?: string } = {}
    let lastError = ''
    while (Date.now() < deadline) {
      try {
        const info = await this.evaluate<{ state: string; url: string; title: string }>(
          '({ state: document.readyState, url: location.href, title: document.title })',
          3000
        )
        if (info) {
          last = info
          if (info.state === 'complete') return
        }
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error)
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    throw new Error(
      `The page did not finish loading in time (state=${last.state ?? 'no answer'}, url=${
        last.url ?? 'unknown'
      }${last.title ? `, title=${JSON.stringify(last.title)}` : ''}${lastError ? `, error=${lastError}` : ''}).`
    )
  }

  private async readPage(): Promise<BrowserPage> {
    const page = await this.evaluate<BrowserPage>(PAGE_SUMMARY_SCRIPT)
    if (!page || typeof page !== 'object') throw new Error('The browser returned no page information.')
    return {
      title: String(page.title ?? ''),
      url: String(page.url ?? ''),
      text: String(page.text ?? ''),
      elements: Array.isArray(page.elements) ? page.elements.slice(0, 80) : []
    }
  }

  private async evaluate<T>(expression: string, timeoutMs = 30_000): Promise<T> {
    const cdp = this.requireCdp()
    const response = await cdp.send<{
      result?: { value?: unknown }
      exceptionDetails?: { text?: string; exception?: { description?: string } }
    }>('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true
    }, timeoutMs)
    if (response.exceptionDetails) {
      const detail =
        response.exceptionDetails.exception?.description ||
        response.exceptionDetails.text ||
        'The page script threw an error.'
      throw new Error(detail)
    }
    return response.result?.value as T
  }

  private async pressEnter(cdp: CdpConnection): Promise<void> {
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Enter',
      code: 'Enter',
      windowsVirtualKeyCode: 13
    })
  }

  private requireCdp(): CdpConnection {
    if (!this.cdp?.isOpen) throw new Error('The browser control connection is not open.')
    return this.cdp
  }
}
