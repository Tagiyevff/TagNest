/**
 * Real end-to-end runtime test. Requires QEMU installed on the host.
 *
 *   npm run smoke:linux
 *
 * It provisions a fresh guest on first run (downloads the Alpine image),
 * then verifies: boot, real command output, SFTP file create/read, desktop
 * geometry + mouse control through xdotool, the RFB display stream, command
 * cancellation, VM restart and file persistence.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import WebSocket from 'ws'
import { LinuxRuntime } from '../src/main/linux/runtime'
import type { AppSettings } from '../src/shared/types'

const dataDir = resolve(process.env.TAGNEST_SMOKE_DIR ?? '.local/smoke-data')
if (process.env.TAGNEST_SMOKE_CLEAN === '1' && existsSync(dataDir)) {
  rmSync(dataDir, { recursive: true, force: true })
}

const settings: AppSettings = {
  provider: 'openai',
  model: 'gpt-4.1-mini',
  modelMode: 'manual',
  baseUrl: '',
  language: 'en',
  memoryMB: Number(process.env.TAGNEST_SMOKE_MEMORY ?? 3072),
  cpus: Number(process.env.TAGNEST_SMOKE_CPUS ?? 2),
  diskGB: 20,
  autoStartLinux: false,
  approveSafeCommands: true
}

const runtime = new LinuxRuntime(dataDir, () => settings)
let lastPhase = ''
runtime.onState((state) => {
  if (state.phase !== lastPhase) {
    console.log(`[runtime] ${state.phase}: ${state.message}${state.detail ? ` — ${state.detail}` : ''}`)
    lastPhase = state.phase
  }
})

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`ASSERTION FAILED: ${message}`)
}

function section(title: string): void {
  console.log(`\n=== ${title}`)
}

function qemuMemoryMB(): string {
  const result = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      '(Get-Process qemu-system-x86_64 -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum'
    ],
    { encoding: 'utf8' }
  )
  const bytes = Number(result.stdout.trim())
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unknown'
  return `${(bytes / 1024 / 1024).toFixed(0)} MB (QEMU working set)`
}

async function waitForVnc(url: string): Promise<string> {
  return new Promise<string>((resolveVersion, reject) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => {
      socket.terminate()
      reject(new Error('Timed out waiting for the RFB version handshake'))
    }, 10000)
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.once('message', (data) => {
      clearTimeout(timer)
      resolveVersion(data.toString().slice(0, 12))
      socket.close()
    })
  })
}

const markerContent = `tagnest smoke ${new Date().toISOString()}`
let exitCode = 0
const startedAt = Date.now()

try {
  section('Start the local Linux environment')
  await runtime.start()
  const firstStartSeconds = ((Date.now() - startedAt) / 1000).toFixed(1)
  const state = runtime.getState()
  if (state.phase !== 'running') {
    throw new Error(`Runtime failed to start: ${state.error?.message ?? state.message} ${state.error?.hint ?? ''}`)
  }
  console.log(`Linux is running (${state.acceleration}) after ${firstStartSeconds}s`)
  console.log(`Memory: ${qemuMemoryMB()}`)

  const guest = runtime.getGuest()

  section('Real command execution inside Linux')
  const uname = await runtime.exec('uname -srm && cat /etc/alpine-release')
  console.log(uname.stdout.trim())
  assert(uname.exitCode === 0, 'uname should exit 0')
  assert(/Linux/.test(uname.stdout), 'guest should report Linux')
  assert(/3\.24/.test(uname.stdout), 'guest should be Alpine 3.24')

  section('File creation and read-back through the agent file API (SFTP)')
  const testFile = '/home/tagnest/workspace/smoke-test.txt'
  await guest.writeFile(testFile, `${markerContent}\n`)
  const contents = await guest.readFile(testFile)
  assert(contents.includes(markerContent), 'file contents should round-trip')
  const cat = await runtime.exec('cat /home/tagnest/workspace/smoke-test.txt && echo $((6*7))')
  assert(cat.stdout.includes(markerContent), 'cat should show the file written through SFTP')
  assert(cat.stdout.includes('42'), 'shell arithmetic should run in the guest')
  const stat = await guest.stat(testFile)
  assert(stat && stat.size > 0, 'stat should report the file')
  console.log(`Wrote and verified ${testFile} (${stat?.size} bytes)`)

  section('Live desktop and synthetic mouse input')
  const geometry = await runtime.exec('DISPLAY=:1 xdotool getdisplaygeometry')
  assert(geometry.exitCode === 0, 'xdotool should be able to query the desktop')
  assert(geometry.stdout.trim() === '1440 900', `desktop should be 1440x900, got ${geometry.stdout.trim()}`)
  const mouse = await runtime.exec('DISPLAY=:1 xdotool mousemove --sync 640 400 click 1 && DISPLAY=:1 xdotool getmouselocation')
  assert(/x:640/.test(mouse.stdout) && /y:400/.test(mouse.stdout), 'mouse should move to the requested point')
  console.log(`Desktop geometry ${geometry.stdout.trim()}, ${mouse.stdout.trim()}`)

  section('Embedded VNC stream (RFB handshake through the token bridge)')
  const vncUrl = runtime.getState().vncUrl
  assert(vncUrl, 'runtime should expose a VNC websocket URL')
  const version = await waitForVnc(vncUrl)
  assert(version.startsWith('RFB '), `expected an RFB greeting, got ${version}`)
  console.log(`RFB greeting received: ${version.trim()}`)

  section('Command cancellation')
  const controller = new AbortController()
  const cancelStarted = Date.now()
  const cancelTimer = setTimeout(() => controller.abort(), 400)
  const slow = await runtime.exec('sleep 20; echo should-not-print', {
    signal: controller.signal,
    timeoutMs: 30000
  })
  clearTimeout(cancelTimer)
  const cancelDuration = Date.now() - cancelStarted
  assert(cancelDuration < 6000, `cancellation should return quickly, took ${cancelDuration}ms`)
  assert(!slow.stdout.includes('should-not-print'), 'cancelled command should not finish')
  console.log(`Cancelled a running command in ${cancelDuration}ms`)

  section('Stop the VM')
  await runtime.stop()
  assert(runtime.getState().phase === 'stopped', 'runtime should be stopped')

  section('Restart and persistence')
  const restartAt = Date.now()
  await runtime.start()
  if (runtime.getState().phase !== 'running') {
    throw new Error(`Restart failed: ${runtime.getState().error?.message ?? ''}`)
  }
  const restartSeconds = ((Date.now() - restartAt) / 1000).toFixed(1)
  const persisted = await runtime.exec('cat /home/tagnest/workspace/smoke-test.txt')
  assert(persisted.stdout.includes(markerContent), 'workspace file should survive a VM restart')
  console.log(`Restarted in ${restartSeconds}s; workspace file persisted`)

  section('Guest isolation')
  const hostPaths = await runtime.exec('ls /c /mnt/host /host_mnt 2>&1')
  assert(!hostPaths.stdout.includes('project'), 'guest must not see the Windows project folder')
  console.log('No Windows host paths are mounted in the guest.')

  section('Shutdown')
  await runtime.stop()
  console.log(`Total smoke test time: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
} catch (error) {
  exitCode = 1
  console.error('\nSMOKE TEST FAILED')
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  const state = runtime.getState()
  console.error(`runtime state: ${state.phase} ${state.message} ${state.error?.hint ?? ''}`)
  if (state.logPath && existsSync(state.logPath)) {
    console.error('last serial log lines:')
    const log = spawnSync('powershell', ['-NoProfile', '-Command', `Get-Content '${state.logPath}' -Tail 25`], {
      encoding: 'utf8'
    })
    console.error(log.stdout)
  }
  await runtime.stop().catch(() => undefined)
} finally {
  console.log(`data directory: ${join(dataDir, 'linux')}`)
}

process.exit(exitCode)
