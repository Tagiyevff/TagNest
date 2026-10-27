import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { utils as sshUtils } from 'ssh2'
import { logger } from '../logger'
import { BASE_IMAGE } from './config'
import { buildMetaData, buildUserData } from './guest'
import { findQemuImgBinary } from './qemu'
import { writeJsonFileAtomic, readJsonFile } from '../storage/json'

export interface LinuxPaths {
  root: string
  baseDir: string
  baseImage: string
  diskDir: string
  disk: string
  sshDir: string
  privateKey: string
  publicKey: string
  logsDir: string
  serialLog: string
  stderrLog: string
  stateFile: string
}

export function linuxPaths(userDataDir: string): LinuxPaths {
  const root = join(userDataDir, 'linux')
  return {
    root,
    baseDir: join(root, 'base'),
    baseImage: join(root, 'base', BASE_IMAGE.fileName),
    diskDir: join(root, 'disk'),
    disk: join(root, 'disk', 'workspace.qcow2'),
    sshDir: join(root, 'ssh'),
    privateKey: join(root, 'ssh', 'id_ed25519'),
    publicKey: join(root, 'ssh', 'id_ed25519.pub'),
    logsDir: join(root, 'logs'),
    serialLog: join(root, 'logs', 'serial.log'),
    stderrLog: join(root, 'logs', 'qemu-stderr.log'),
    stateFile: join(root, 'runtime-state.json')
  }
}

interface RuntimeStateFile {
  instanceId?: string
}

export class LinuxProvisioner {
  private seedServer: Server | null = null

  constructor(readonly paths: LinuxPaths) {}

  /** Creates the SSH keypair used by the agent control channel. */
  ensureSshKey(): { privateKeyPath: string; publicKey: string } {
    mkdirSync(this.paths.sshDir, { recursive: true })
    if (!existsSync(this.paths.privateKey) || !existsSync(this.paths.publicKey)) {
      const pair = sshUtils.generateKeyPairSync('ed25519')
      writeFileSync(this.paths.privateKey, `${pair.private}\n`, { mode: 0o600 })
      writeFileSync(this.paths.publicKey, `${pair.public}\n`, { mode: 0o644 })
      try {
        chmodSync(this.paths.privateKey, 0o600)
      } catch {
        /* Windows ACLs are applied by libuv; this is best effort. */
      }
      logger.info('provision', 'generated guest SSH keypair')
    }
    return {
      privateKeyPath: this.paths.privateKey,
      publicKey: readFileSync(this.paths.publicKey, 'utf8').trim()
    }
  }

  /**
   * Ensures an official Alpine cloud image is present and verified.
   * Downloads are checksum-verified against a pinned SHA-512.
   */
  async ensureBaseImage(onProgress: (received: number, total: number) => void): Promise<string> {
    mkdirSync(this.paths.logsDir, { recursive: true })
    const override = process.env.TAGNEST_BASE_IMAGE
    if (override && existsSync(override)) {
      logger.info('provision', `using base image from TAGNEST_BASE_IMAGE: ${override}`)
      return override
    }
    mkdirSync(this.paths.baseDir, { recursive: true })

    // Installers may ship the verified base image next to the app; copy it into
    // the data directory once so the disk overlay has a stable backing path.
    const bundled = bundledBaseImagePath()
    if (bundled && !existsSync(this.paths.baseImage)) {
      const { copyFileSync } = await import('node:fs')
      logger.info('provision', 'copying bundled Linux base image into the data directory')
      copyFileSync(bundled, this.paths.baseImage)
      writeJsonFileAtomic(`${this.paths.baseImage}.verified.json`, {
        sha512: BASE_IMAGE.sha512,
        source: 'bundled'
      })
      onProgress(BASE_IMAGE.downloadBytes, BASE_IMAGE.downloadBytes)
      return this.paths.baseImage
    }
    if (existsSync(this.paths.baseImage)) {
      const verified = readJsonFile<{ sha512?: string }>(`${this.paths.baseImage}.verified.json`, {})
      if (verified.sha512 === BASE_IMAGE.sha512) return this.paths.baseImage
      // A partial or untrusted file: re-verify before using it.
      const actual = await sha512File(this.paths.baseImage)
      if (actual === BASE_IMAGE.sha512) {
        writeJsonFileAtomic(`${this.paths.baseImage}.verified.json`, {
          sha512: actual,
          downloadedAt: new Date().toISOString()
        })
        return this.paths.baseImage
      }
      unlinkSync(this.paths.baseImage)
    }

    const partial = `${this.paths.baseImage}.part`
    if (existsSync(partial)) unlinkSync(partial)

    logger.info('provision', `downloading base image ${BASE_IMAGE.fileName}`)
    const response = await fetch(BASE_IMAGE.url, { redirect: 'follow' })
    if (!response.ok || !response.body) {
      throw new Error(`Could not download the Linux image (HTTP ${response.status}). Check your internet connection.`)
    }
    const total = Number(response.headers.get('content-length')) || BASE_IMAGE.downloadBytes
    const hash = createHash('sha512')
    let received = 0
    const file = await import('node:fs').then(({ createWriteStream }) => createWriteStream(partial, { mode: 0o644 }))
    const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
    await new Promise<void>((resolve, reject) => {
      body.on('data', (chunk: Buffer) => {
        hash.update(chunk)
        received += chunk.length
        onProgress(received, total)
      })
      body.on('error', reject)
      file.on('error', reject)
      file.on('finish', resolve)
      body.pipe(file)
    })

    const digest = hash.digest('hex')
    if (digest !== BASE_IMAGE.sha512) {
      unlinkSync(partial)
      throw new Error(
        'The downloaded Linux image failed its checksum check and was discarded. Please try again.'
      )
    }
    renameSync(partial, this.paths.baseImage)
    writeJsonFileAtomic(`${this.paths.baseImage}.verified.json`, {
      sha512: digest,
      downloadedAt: new Date().toISOString()
    })
    logger.info('provision', 'base image verified and stored')
    return this.paths.baseImage
  }

  /**
   * Creates (once) the writable qcow2 overlay that holds all guest state.
   * An existing overlay is never recreated or resized here.
   */
  async ensureDisk(diskGB: number, baseImage = this.paths.baseImage): Promise<{ diskPath: string; created: boolean }> {
    mkdirSync(this.paths.diskDir, { recursive: true })
    if (existsSync(this.paths.disk)) return { diskPath: this.paths.disk, created: false }
    const qemuImg = findQemuImgBinary()
    if (!qemuImg) {
      throw new Error('qemu-img was not found. Install QEMU and restart TagNest.')
    }
    logger.info('provision', `creating ${diskGB} GB guest disk overlay`)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        qemuImg,
        [
          'create',
          '-f',
          'qcow2',
          '-F',
          'qcow2',
          '-b',
          baseImage,
          this.paths.disk,
          `${diskGB}G`
        ],
        { windowsHide: true }
      )
      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()))
      child.on('error', reject)
      child.on('exit', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`qemu-img failed (${code}): ${stderr.trim()}`))
      })
    })
    return { diskPath: this.paths.disk, created: true }
  }

  readInstanceId(): string {
    const state = readJsonFile<RuntimeStateFile>(this.paths.stateFile, {})
    return state.instanceId ?? 'tagnest-1'
  }

  /** A new instance id makes cloud-init re-run the first-boot provisioning. */
  newInstanceId(): string {
    const instanceId = `tagnest-${Date.now()}-${randomBytes(3).toString('hex')}`
    const state = readJsonFile<RuntimeStateFile>(this.paths.stateFile, {})
    writeJsonFileAtomic(this.paths.stateFile, { ...state, instanceId })
    return instanceId
  }

  /**
   * Serves cloud-init NoCloud data over the QEMU user-mode network. The guest
   * reaches the host at 10.0.2.2; QEMU passes the seed URL via SMBIOS serial,
   * which cloud-init on the Alpine cloud image understands.
   */
  async startSeedServer(
    sshPublicKey: string,
    instanceId: string,
    onStep: (step: string) => void
  ): Promise<{ port: number; close: () => Promise<void> }> {
    await this.stopSeedServer()
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      logger.info('provision', `seed request ${url.pathname}`)
      response.setHeader('content-type', 'text/plain; charset=utf-8')
      if (url.pathname === '/meta-data') {
        response.end(buildMetaData(instanceId))
        return
      }
      if (url.pathname === '/vendor-data') {
        // An empty vendor-data document is valid; a 404 here makes cloud-init
        // treat the whole seed as broken on some versions.
        response.end('')
        return
      }
      if (url.pathname === '/network-config') {
        // NoCloud reads network-config first. Answering 404 aborts the seed
        // read and sends cloud-init into minutes of public-cloud probing.
        response.end('version: 2\nethernets:\n  eth0:\n    dhcp4: true\n')
        return
      }
      if (url.pathname === '/user-data') {
        const port = (server.address() as { port?: number } | null)?.port
        if (!port) {
          response.statusCode = 503
          response.end('seed server not ready')
          return
        }
        response.end(
          buildUserData({ sshPublicKey, seedPort: port, instanceId })
        )
        return
      }
      if (url.pathname === '/progress') {
        const step = url.searchParams.get('step') ?? 'working'
        onStep(step)
        logger.info('provision', `guest step: ${step}`)
        response.end('ok')
        return
      }
      response.statusCode = 404
      response.end('not found')
    })

    await new Promise<void>((resolve, reject) => {
      server.on('clientError', (error, socket) => {
        logger.warn('provision', 'seed client error', error.message)
        socket.destroy()
      })
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    this.seedServer = server
    const port = (server.address() as { port: number }).port
    logger.info('provision', `seed server listening on ${port}`)
    return {
      port,
      close: () => this.stopSeedServer()
    }
  }

  async stopSeedServer(): Promise<void> {
    const server = this.seedServer
    this.seedServer = null
    if (!server) return
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

function bundledBaseImagePath(): string | null {
  const candidates: string[] = []
  if (process.resourcesPath) candidates.push(join(process.resourcesPath, 'linux', BASE_IMAGE.fileName))
  candidates.push(join(process.cwd(), 'resources', 'linux', BASE_IMAGE.fileName))
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

async function sha512File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  return new Promise<string>((resolve, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}
