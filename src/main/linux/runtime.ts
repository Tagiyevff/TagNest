import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { AppSettings, GuestStats, RuntimeState } from '../../shared/types'
import { logger } from '../logger'
import { readJsonFile, writeJsonFileAtomic } from '../storage/json'
import { GUEST_VNC_PORT, QEMU_DOWNLOAD_URL } from './config'
import {
  BROWSER_INSTALL_COMMAND,
  DESKTOP_HEIGHT,
  DESKTOP_WIDTH,
  GUEST_USER,
  PROVISION_MARKER,
  guestHelperInstallCommand
} from './guest'
import { detectAcceleration, findQemuBinary } from './qemu'
import { LinuxProvisioner, linuxPaths } from './provision'
import { GuestClient, type ExecOptions, type ExecResult } from './ssh'
import { readGuestStats } from './stats'
import { VncBridge, getFreeLoopbackPort, waitForTcpPort } from './vnc'

type StateListener = (state: RuntimeState) => void

interface ProvisionStateFile {
  instanceId?: string
  provisioned?: boolean
}

const ACTIVE_PHASES = new Set(['preparing', 'downloading-image', 'creating-disk', 'starting', 'provisioning', 'connecting', 'stopping'])

const STEP_MESSAGES: Record<string, string> = {
  packages: 'Downloading the Linux packages (first run only)',
  account: 'Configuring the guest user and SSH access',
  desktop: 'Installing the XFCE desktop and tools (first run only)',
  done: 'Finishing up the Linux workspace'
}

/**
 * Owns the local QEMU VM: image provisioning, process lifecycle, guest SSH and
 * the embedded display bridge. All privileged runtime control stays here in the
 * main process; the renderer can only call the narrow IPC surface.
 */
export class LinuxRuntime {
  private state: RuntimeState
  private qemu: ChildProcess | null = null
  private readonly guest: GuestClient
  private readonly provisioner: LinuxProvisioner
  private bridge: VncBridge | null = null
  private seed: { port: number; close: () => Promise<void> } | null = null
  private listeners = new Set<StateListener>()
  private starting: Promise<void> | null = null
  private stopping = false
  private lastGuestStep = ''
  private sshHostPort: number | null = null
  private accelCache: { acceleration: RuntimeState['acceleration']; warning?: string } | null = null
  private statsCache: { at: number; startedAt?: number; value: GuestStats | null } | null = null

  constructor(
    userDataDir: string,
    private readonly getSettings: () => AppSettings
  ) {
    const paths = linuxPaths(userDataDir)
    this.provisioner = new LinuxProvisioner(paths)
    this.guest = new GuestClient(paths.privateKey)
    this.state = {
      phase: 'stopped',
      message: 'Linux is not running',
      acceleration: 'unknown',
      memoryMB: getSettings().memoryMB,
      cpus: getSettings().cpus,
      logPath: paths.serialLog
    }
  }

  onState(listener: StateListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getState(): RuntimeState {
    return { ...this.state }
  }

  getGuest(): GuestClient {
    if (this.state.phase !== 'running' || !this.guest.isConnected) {
      throw new Error('The TagNest Linux environment is not running. Start it from the Linux panel.')
    }
    return this.guest
  }

  async exec(command: string, options?: ExecOptions): Promise<ExecResult> {
    const guest = this.getGuest()
    const result = await guest.exec(command, options)
    return result
  }

  /**
   * Live guest memory/disk/load readings for the panel header. Cached for a
   * few seconds so several views cannot turn into an SSH polling loop. Returns
   * null instead of fake zeros when the guest cannot answer.
   */
  async getStats(): Promise<GuestStats | null> {
    if (this.state.phase !== 'running' || !this.guest.isConnected) return null
    const now = Date.now()
    const cache = this.statsCache
    if (cache && cache.startedAt === this.state.startedAt && now - cache.at < 4000) return cache.value
    const value = await readGuestStats(this.guest)
    this.statsCache = { at: Date.now(), startedAt: this.state.startedAt, value }
    return value
  }

  getLogsDirectory(): string {
    return this.provisioner.paths.logsDir
  }

  async getLogs(): Promise<{ logPath: string; tail: string }> {
    const serial = tailFile(this.provisioner.paths.serialLog, 160)
    const stderr = tailFile(this.provisioner.paths.stderrLog, 50)
    return {
      logPath: this.provisioner.paths.logsDir,
      tail: `=== Linux serial console ===\n${serial || '(empty)'}\n\n=== QEMU stderr ===\n${stderr || '(empty)'}`
    }
  }

  async start(): Promise<void> {
    if (this.state.phase === 'running') return
    if (this.starting) return this.starting
    if (this.state.phase === 'stopping') {
      await new Promise((resolve) => setTimeout(resolve, 800))
    }
    this.starting = this.doStart().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stop(): Promise<void> {
    if (this.state.phase === 'stopped') return
    this.stopping = true
    this.setState({ phase: 'stopping', message: 'Stopping Linux…', error: undefined })
    try {
      if (this.guest.isConnected) {
        await this.guest.exec('poweroff', { timeoutMs: 4000 }).catch(() => undefined)
      }
    } finally {
      await this.waitForQemuExit(15000)
      this.killQemu()
      await this.guest.disconnect().catch(() => undefined)
      await this.bridge?.close().catch(() => undefined)
      this.bridge = null
      await this.seed?.close().catch(() => undefined)
      this.seed = null
      this.qemu = null
    this.stopping = false
    this.statsCache = null
    this.setState({
      phase: 'stopped',
        message: 'Linux is stopped',
        vncUrl: undefined,
        sshPort: undefined,
        startedAt: undefined,
        progress: undefined,
        detail: undefined
      })
    }
  }

  async restart(): Promise<void> {
    await this.stop()
    await this.start()
  }

  async dispose(): Promise<void> {
    await this.stop()
  }

  private async doStart(): Promise<void> {
    const settings = this.getSettings()
    const qemuBinary = findQemuBinary()
    if (!qemuBinary) {
      this.fail(
        'QEMU was not found on this computer.',
        `TagNest needs the QEMU emulator to run the Linux desktop. Install it (for example "winget install SoftwareFreedomConservancy.QEMU") or set TAGNEST_QEMU to the qemu-system-x86_64 executable. Download: ${QEMU_DOWNLOAD_URL}`
      )
      return
    }

    try {
      this.setState({
        phase: 'preparing',
        message: 'Preparing the Linux runtime…',
        memoryMB: settings.memoryMB,
        cpus: settings.cpus,
        error: undefined,
        warning: undefined,
        detail: 'Checking hardware acceleration'
      })

      if (!this.accelCache) {
        this.accelCache = await detectAcceleration(qemuBinary)
        logger.info('runtime', `acceleration: ${this.accelCache.acceleration}`)
      }
      if (this.accelCache.warning) this.setState({ warning: this.accelCache.warning })
      this.setState({ acceleration: this.accelCache.acceleration })

      const { publicKey } = this.provisioner.ensureSshKey()

      this.setState({ detail: 'Checking the Linux base image' })
      const baseImage = await this.provisioner.ensureBaseImage((received, total) => {
        const progress = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : undefined
        this.setState({
          phase: 'downloading-image',
          message: 'Downloading the Linux base image…',
          detail: `${(received / 1024 / 1024).toFixed(0)} MB of ${(total / 1024 / 1024).toFixed(0)} MB`,
          progress
        })
      })
      logger.info('runtime', `base image ready: ${baseImage}`)

      this.setState({
        phase: 'creating-disk',
        message: 'Preparing the Linux workspace disk…',
        detail: 'Your files persist in this disk between launches',
        progress: undefined
      })
      const { created } = await this.provisioner.ensureDisk(settings.diskGB, baseImage)

      const stateFile = this.readProvisionState()
      const firstBoot = created || !stateFile.provisioned || !stateFile.instanceId
      const instanceId = firstBoot
        ? this.provisioner.newInstanceId()
        : stateFile.instanceId ?? this.provisioner.newInstanceId()

      const sshPort = await getFreeLoopbackPort()
      this.sshHostPort = sshPort
      const vncPort = await getFreeLoopbackPort()
      this.bridge = new VncBridge()
      const bridge = await this.bridge.start(vncPort)
      this.seed = await this.provisioner.startSeedServer(publicKey, instanceId, (step) => {
        this.lastGuestStep = step
        if (this.state.phase === 'provisioning') {
          this.setState({
            message: STEP_MESSAGES[step] ?? 'Provisioning the Linux workspace…',
            detail: 'This happens only on the first launch'
          })
        }
      })

      const debugVnc = process.env.TAGNEST_QEMU_VNC
      const args = [
        '-name',
        'TagNest',
        '-machine',
        'pc',
        '-accel',
        this.accelCache.acceleration === 'whpx' ? 'whpx' : 'tcg,thread=multi',
        '-cpu',
        'qemu64',
        '-smp',
        String(settings.cpus),
        '-m',
        String(settings.memoryMB),
        '-drive',
        `file=${this.provisioner.paths.disk},if=virtio,format=qcow2`,
        '-netdev',
        `user,id=net0,hostfwd=tcp:127.0.0.1:${sshPort}-:22,hostfwd=tcp:127.0.0.1:${vncPort}-:${GUEST_VNC_PORT}`,
        '-device',
        'virtio-net-pci,netdev=net0',
        '-smbios',
        `type=1,serial=ds=nocloud;s=http://10.0.2.2:${this.seed.port}/`,
        '-display',
        'none',
        ...(debugVnc ? ['-vnc', debugVnc] : []),
        '-serial',
        `file:${this.provisioner.paths.serialLog}`,
        '-no-reboot'
      ]

      writeFileSync(this.provisioner.paths.serialLog, '')
      writeFileSync(this.provisioner.paths.stderrLog, '')
      this.setState({
        phase: 'starting',
        message: firstBoot ? 'Preparing your Linux workspace…' : 'Starting Linux…',
        detail: firstBoot
          ? 'First launch: cloud-init configures the guest, then TagNest installs the desktop. This can take several minutes.'
          : 'Booting the virtual machine',
        progress: undefined
      })

      const qemu = spawn(qemuBinary, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      this.qemu = qemu
      logger.info('runtime', `QEMU started with pid ${qemu.pid ?? '?'}`)
      qemu.stderr?.on('data', (chunk: Buffer) => {
        const text = chunk.toString()
        logger.warn('qemu', text.trim())
        try {
          writeFileSync(this.provisioner.paths.stderrLog, text, { flag: 'a' })
        } catch {
          /* ignore */
        }
      })
      qemu.on('exit', (code, signal) => {
        logger.info('runtime', `QEMU exited (${code ?? signal ?? 'unknown'})`)
        // A stop/restart can spawn the next VM before the previous process
        // reports its exit. Only the process that is still current may clear
        // the reference or fail the runtime.
        if (this.qemu !== qemu) return
        this.qemu = null
        if (!this.stopping && this.state.phase !== 'stopped') {
          this.fail(
            'The Linux virtual machine stopped unexpectedly.',
            `QEMU exited with code ${code ?? signal}. See the log at ${this.provisioner.paths.serialLog}.`
          )
        }
      })

      // A fresh disk spends several minutes in cloud-init datasource discovery
      // before the seed is applied; later boots only need a short wait.
      const sshReady = await this.waitForSsh(sshPort, firstBoot ? 900_000 : 180_000)
      if (!sshReady) {
        this.fail(
          'Linux did not finish booting.',
          this.describeBootFailure()
        )
        return
      }

      const stateAfterBoot = this.readProvisionState()
      const markerPresent = await this.hasProvisionMarker()
      if (!markerPresent) {
        this.setState({
          phase: 'provisioning',
          message: 'Setting up your Linux workspace…',
          detail: 'First launch only: installing the desktop, terminal and tools'
        })
        const provisioned = await this.waitForProvisioning(1_800_000)
        if (!provisioned) {
          this.fail(
            'Linux provisioning did not complete.',
            `The guest did not create its completion marker. Check the guest log with "Open logs" (serial console) or ${this.provisioner.paths.serialLog}.`
          )
          return
        }
      }
      // The marker is authoritative; keep the local state file in sync so a
      // later boot does not briefly report a first-run install again.
      if (!stateAfterBoot.provisioned) {
        writeJsonFileAtomic(this.provisioner.paths.stateFile, {
          instanceId,
          provisioned: true
        })
      }

      this.setState({
        phase: 'connecting',
        message: 'Connecting to the desktop…',
        detail: 'Waiting for the XFCE session'
      })

      // Repair state that lives on tmpfs or was created by an older release:
      // /run/tagnest disappears on every boot and the XFCE session needs it.
      await this.ensureDesktopService()

      // Older releases provisioned without a browser. Install it once so the
      // guest (and the agent's open_url tool) can actually browse the web.
      await this.ensureGuestHelpers()
      await this.ensureBrowser()

      const vncUp = await waitForTcpPort(vncPort, 60_000)
      if (!vncUp) {
        this.fail(
          'The Linux desktop did not start.',
          'Xvnc is not accepting connections. Read /var/log/tagnest-xvnc.log inside the guest, or restart the Linux environment.'
        )
        return
      }

      const desktopUp = await this.waitForDesktop(90_000)
      if (!desktopUp) {
        const log = await this.guest
          .exec('tail -30 /var/log/tagnest-xvnc.log /var/log/tagnest-desktop.log 2>&1', { timeoutMs: 10000 })
          .then((result) => result.stdout)
          .catch(() => '')
        logger.warn('runtime', 'desktop did not report ready', log)
        this.fail(
          'The Linux desktop session failed to start.',
          `Xvnc is running but XFCE did not become ready. Check the Linux panel logs or restart the environment. ${log.slice(0, 500)}`
        )
        return
      }

      this.lastGuestStep = ''
      this.setState({
        phase: 'running',
        message: 'Linux is running',
        detail: `${DESKTOP_WIDTH}×${DESKTOP_HEIGHT} desktop · ${settings.cpus} CPU · ${settings.memoryMB} MB RAM`,
        vncUrl: bridge.url,
        sshPort,
        startedAt: Date.now(),
        progress: undefined,
        error: undefined,
        warning:
          [this.accelCache?.warning, this.state.warning].filter(Boolean).join(' ') || undefined,
      })
      logger.info('runtime', `guest is ready on ssh:${sshPort}, vnc:${vncPort}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('runtime', 'start failed', error)
      this.fail('TagNest could not start Linux.', message)
    }
  }

  private async waitForSsh(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    let attempt = 0
    while (Date.now() < deadline) {
      if (!this.qemu) return false
      const panic = this.detectSerialPanic()
      if (panic) {
        this.fail('The Linux kernel failed to boot on this computer.', panic)
        return false
      }
      attempt += 1
      try {
        await this.guest.connect({ port, username: GUEST_USER, timeoutMs: 8000 })
        logger.info('runtime', `guest SSH ready after ${attempt} attempt(s)`)
        return true
      } catch (error) {
        if (attempt === 1 || attempt % 10 === 0) {
          logger.info('runtime', `waiting for guest SSH (attempt ${attempt})`)
          logger.debug('runtime', 'SSH attempt failed', error)
        }
        await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    }
    return false
  }

  private async waitForProvisioning(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!this.qemu) return false
      try {
        if (!this.guest.isConnected && this.sshHostPort) {
          await this.guest.connect({ port: this.sshHostPort, username: GUEST_USER, timeoutMs: 8000 })
        }
        if (this.guest.isConnected) {
          const result = await this.guest.exec(`test -f ${PROVISION_MARKER} && echo ready`, { timeoutMs: 15000 })
          if (result.stdout.includes('ready')) return true
          const guestState = this.readProvisionState()
          if (!guestState.provisioned) {
            // keep the UI informed while the long apk install runs
            this.setState({ detail: STEP_MESSAGES[this.lastGuestStep] ?? 'Installing the Linux desktop (first run)' })
          }
        }
      } catch (error) {
        logger.debug('runtime', 'provisioning poll failed', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 4000))
    }
    return false
  }

  /**
   * Idempotently prepares the guest desktop service. Runs as the unprivileged
   * guest user, using the guest's passwordless sudo (the same account the
   * approved-tool path uses). Never deletes user files.
   */
  private async ensureDesktopService(): Promise<void> {
    try {
      const result = await this.guest.exec(
        'sudo -n mkdir -p /run/tagnest && sudo -n chown tagnest:tagnest /run/tagnest && sudo -n chmod 700 /run/tagnest\n' +
          'if ! pgrep -u tagnest -x Xvnc >/dev/null 2>&1; then sudo -n rc-service tagnest-desktop restart >/dev/null 2>&1 || true; fi',
        { timeoutMs: 30_000 }
      )
      if (result.exitCode !== 0) {
        logger.warn('runtime', 'desktop service repair returned an error', result.stderr.trim())
      }
    } catch (error) {
      logger.warn('runtime', 'could not prepare the desktop service', error)
    }
  }

  /**
   * Makes sure the guest has a real web browser. Provisions that were run by
   * an older release predate Firefox, and a browser without a working package
   * index (for example an offline first boot) can be missing too. Never fatal:
   * the desktop still works without it, so a failure only produces a warning.
   */
  /**
   * Installs the small guest-side helper used by the agent's browser tools.
   * Idempotent and cheap, so it runs on every boot and stays in sync with the
   * application version.
   */
  private async ensureGuestHelpers(): Promise<void> {
    try {
      const result = await this.guest.exec(guestHelperInstallCommand(), { timeoutMs: 30_000 })
      if (result.exitCode !== 0) {
        logger.warn('runtime', 'guest helper install failed', result.stderr.trim())
      }
    } catch (error) {
      logger.warn('runtime', 'guest helper install could not run', error)
    }
  }

  private async ensureBrowser(): Promise<void> {
    try {
      const check = await this.guest.exec('command -v firefox >/dev/null 2>&1 && echo yes || echo no', {
        timeoutMs: 15_000
      })
      if (check.stdout.includes('yes')) return

      this.setState({
        detail: 'Installing the web browser in Linux (one time, about 90 MB)'
      })
      logger.info('runtime', 'browser missing in the guest, installing Firefox')
      const started = Date.now()
      const install = await this.guest.exec(BROWSER_INSTALL_COMMAND, { timeoutMs: 480_000 })
      if (install.exitCode !== 0) {
        const reason = (install.stderr || install.stdout).trim().slice(-400)
        logger.warn('runtime', `browser install failed (${Date.now() - started} ms)`, reason)
        this.setState({
          warning:
            'The web browser could not be installed automatically. Internet access inside Linux still works; when you are online, run "sudo apk add firefox" in the Linux terminal.'
        })
        return
      }
      logger.info('runtime', `Firefox installed in the guest (${Date.now() - started} ms)`)
    } catch (error) {
      logger.warn('runtime', 'browser install could not run', error)
    }
  }

  private async hasProvisionMarker(): Promise<boolean> {
    try {
      const result = await this.guest.exec(`test -f ${PROVISION_MARKER} && echo ready`, { timeoutMs: 15000 })
      return result.stdout.includes('ready')
    } catch {
      return false
    }
  }

  private async waitForDesktop(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      try {
        const result = await this.guest.exec(
          'DISPLAY=:1 xrandr --query 2>/dev/null | head -3; pgrep -u tagnest -x xfwm4 >/dev/null && echo WM_READY',
          { timeoutMs: 10000 }
        )
        if (result.exitCode === 0 && /connected|screen/i.test(result.stdout) && result.stdout.includes('WM_READY')) {
          return true
        }
      } catch (error) {
        logger.debug('runtime', 'desktop readiness probe failed', error)
      }
      await new Promise((resolve) => setTimeout(resolve, 2000))
    }
    return false
  }

  private readProvisionState(): ProvisionStateFile {
    return readJsonFile<ProvisionStateFile>(this.provisioner.paths.stateFile, {})
  }

  private detectSerialPanic(): string | null {
    try {
      if (!existsSync(this.provisioner.paths.serialLog)) return null
      const content = readFileSync(this.provisioner.paths.serialLog, 'utf8')
      const panicIndex = content.indexOf('Kernel panic')
      if (panicIndex === -1) return null
      const line = content
        .slice(panicIndex)
        .split('\n')
        .find((entry) => entry.includes('Kernel panic'))
      return `${line?.trim() ?? 'Kernel panic'}\n\nThis usually means the host CPU virtualization support is unavailable or misconfigured. Enable "Windows Hypervisor Platform" in Windows features and restart the computer. Serial log: ${this.provisioner.paths.serialLog}`
    } catch {
      return null
    }
  }

  private describeBootFailure(): string {
    const panic = this.detectSerialPanic()
    if (panic) return panic
    try {
      const stderr = readFileSync(this.provisioner.paths.stderrLog, 'utf8').trim()
      if (stderr) return stderr.split('\n').slice(-4).join('\n')
    } catch {
      /* ignore */
    }
    return `The guest did not become reachable over SSH. Serial console log: ${this.provisioner.paths.serialLog}`
  }

  private async waitForQemuExit(timeoutMs: number): Promise<void> {
    if (!this.qemu) return
    const deadline = Date.now() + timeoutMs
    while (this.qemu && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
  }

  private killQemu(): void {
    const qemu = this.qemu
    if (!qemu) return
    try {
      qemu.kill('SIGKILL')
    } catch {
      /* ignore */
    }
    this.qemu = null
  }

  private fail(message: string, hint?: string): void {
    const detail = this.state.detail
    void this.cleanupAfterFailure()
    this.setState({
      phase: 'error',
      message,
      error: { message, hint, detail },
      vncUrl: undefined,
      progress: undefined,
      startedAt: undefined
    })
  }

  private async cleanupAfterFailure(): Promise<void> {
    this.stopping = true
    this.killQemu()
    await this.guest.disconnect().catch(() => undefined)
    await this.bridge?.close().catch(() => undefined)
    this.bridge = null
    await this.seed?.close().catch(() => undefined)
    this.seed = null
    this.stopping = false
  }

  private setState(patch: Partial<RuntimeState>): void {
    this.state = { ...this.state, ...patch }
    for (const listener of this.listeners) {
      try {
        listener(this.getState())
      } catch (error) {
        logger.warn('runtime', 'state listener failed', error)
      }
    }
  }
}

function tailFile(path: string, lines: number): string {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n').trim()
  } catch {
    return ''
  }
}

export { ACTIVE_PHASES }
