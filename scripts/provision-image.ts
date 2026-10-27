/**
 * Optional packaging helper: downloads the pinned Alpine cloud image into
 * resources/linux/ so installers can ship a preconfigured base image instead
 * of downloading it on first launch. User data still lives in a separate
 * qcow2 overlay, so the base image can be replaced without touching files.
 *
 *   npm run provision:linux
 */
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { BASE_IMAGE } from '../src/main/linux/config'

const targetDir = resolve('resources/linux')
const target = join(targetDir, BASE_IMAGE.fileName)

async function verify(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash('sha512')
    const stream = createReadStream(path)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolveHash(hash.digest('hex')))
  })
}

async function main(): Promise<void> {
  mkdirSync(targetDir, { recursive: true })
  if (existsSync(target)) {
    const digest = await verify(target)
    if (digest === BASE_IMAGE.sha512) {
      console.log(`Already present and verified: ${target}`)
      return
    }
    console.log('Existing image failed verification and will be replaced.')
    unlinkSync(target)
  }

  console.log(`Downloading ${BASE_IMAGE.url}`)
  const response = await fetch(BASE_IMAGE.url)
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length')) || BASE_IMAGE.downloadBytes
  const partial = `${target}.part`
  const hash = createHash('sha512')
  let received = 0
  const file = createWriteStream(partial)
  const body = Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>)
  body.on('data', (chunk: Buffer) => {
    hash.update(chunk)
    received += chunk.length
    if (received % (16 * 1024 * 1024) < chunk.length) {
      process.stdout.write(`\r${(received / 1024 / 1024).toFixed(0)} / ${(total / 1024 / 1024).toFixed(0)} MB`)
    }
  })
  await new Promise<void>((resolvePipe, reject) => {
    body.on('error', reject)
    file.on('error', reject)
    file.on('finish', resolvePipe)
    body.pipe(file)
  })
  process.stdout.write('\n')

  const digest = hash.digest('hex')
  if (digest !== BASE_IMAGE.sha512) {
    unlinkSync(partial)
    throw new Error('SHA-512 mismatch: the image was discarded.')
  }
  renameSync(partial, target)
  console.log(`Verified and stored: ${target}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
