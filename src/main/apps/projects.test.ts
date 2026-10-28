import { describe, expect, it } from 'vitest'
import {
  APPS_DIR,
  buildTemplateFiles,
  escapeHtml,
  normalizeAppName,
  normalizePort,
  parseAppMetadata
} from './projects'

describe('normalizeAppName', () => {
  it('accepts lowercase names with digits and hyphens', () => {
    expect(normalizeAppName('hello')).toBe('hello')
    expect(normalizeAppName('  Notes-App-2 ')).toBe('notes-app-2')
  })

  it('rejects unsafe names', () => {
    for (const name of ['', '../etc', 'a/b', 'UPPER!', '-leading', 'trailing-', 'a'.repeat(40)]) {
      expect(normalizeAppName(name)).toBeNull()
    }
  })
})

describe('normalizePort', () => {
  it('accepts unprivileged ports', () => {
    expect(normalizePort(8080)).toBe(8080)
    expect(normalizePort('8090')).toBe(8090)
    expect(normalizePort(65535)).toBe(65535)
  })

  it('rejects invalid ports', () => {
    for (const port of [80, 0, 70000, 12.5, Number.NaN, 'abc', undefined]) {
      expect(normalizePort(port)).toBeNull()
    }
  })
})

describe('buildTemplateFiles', () => {
  it('creates a runnable web project with metadata', () => {
    const files = buildTemplateFiles({
      name: 'hello',
      title: 'Hello <World>',
      template: 'web',
      port: 8080,
      now: 1_700_000_000_000
    })
    const names = files.map((file) => file.name)
    expect(names).toEqual(['index.html', 'styles.css', 'app.js', 'test.sh', 'README.md', 'tagnest-app.json'])

    const metadata = parseAppMetadata(
      files.find((file) => file.name === 'tagnest-app.json')!.content,
      'hello'
    )
    expect(metadata).toMatchObject({
      format: 1,
      name: 'hello',
      title: 'Hello <World>',
      template: 'web',
      port: 8080,
      createdAt: 1_700_000_000_000
    })

    const index = files.find((file) => file.name === 'index.html')!.content
    expect(index).toContain('<title>Hello &lt;World&gt;</title>')
    expect(index).toContain('id="counter"')
    expect(files.find((file) => file.name === 'test.sh')!.mode).toBe(0o755)
  })

  it('creates a CLI project without a port', () => {
    const files = buildTemplateFiles({ name: 'hello-cli', title: 'Hello CLI', template: 'cli' })
    expect(files.map((file) => file.name)).toContain('app.sh')
    const metadata = parseAppMetadata(
      files.find((file) => file.name === 'tagnest-app.json')!.content,
      'hello-cli'
    )
    expect(metadata?.template).toBe('cli')
    expect(metadata?.port).toBeUndefined()
  })

  it('keeps template paths inside the workspace apps folder', () => {
    expect(APPS_DIR.endsWith('/workspace/apps')).toBe(true)
    const files = buildTemplateFiles({ name: 'x', title: 'X', template: 'web', port: 8081 })
    for (const file of files) {
      expect(file.content).not.toMatch(/\/etc\//)
    }
  })
})

describe('parseAppMetadata', () => {
  it('rejects mismatched names and malformed JSON', () => {
    const good = JSON.stringify({
      format: 1,
      name: 'hello',
      title: 'Hello',
      template: 'web',
      port: 8080,
      createdAt: 1,
      updatedAt: 1
    })
    expect(parseAppMetadata(good, 'other')).toBeNull()
    expect(parseAppMetadata('{')).toBeNull()
    expect(parseAppMetadata(JSON.stringify({ format: 1, name: '../x', title: 'x', template: 'web' }))).toBeNull()
  })

  it('rejects a web project without a valid port', () => {
    const raw = JSON.stringify({
      format: 1,
      name: 'hello',
      title: 'Hello',
      template: 'web',
      port: 80,
      createdAt: 1,
      updatedAt: 1
    })
    expect(parseAppMetadata(raw)).toBeNull()
  })
})

describe('escapeHtml', () => {
  it('escapes markup and quotes', () => {
    expect(escapeHtml(`<a href="x">&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;')
  })
})
