import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConversationStore } from './conversations'
import { SettingsStore } from './settings'
import type { SecretsStore } from './secrets'

const dirs: string[] = []

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tagnest-test-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('ConversationStore', () => {
  it('persists conversations and messages across instances', () => {
    const dir = tempDir()
    const store = new ConversationStore(dir)
    const conversation = store.create()
    conversation.title = 'Build a site'
    conversation.messages.push({
      id: 'message-1',
      role: 'assistant',
      content: 'Done',
      createdAt: Date.now(),
      toolCalls: []
    })
    store.save(conversation)

    const reopened = new ConversationStore(dir)
    const loaded = reopened.get(conversation.id)
    expect(loaded?.title).toBe('Build a site')
    expect(loaded?.messages).toHaveLength(1)
    expect(reopened.list()[0]).toMatchObject({ id: conversation.id, messageCount: 1 })

    expect(reopened.delete(conversation.id)).toBe(true)
    expect(reopened.get(conversation.id)).toBeUndefined()
  })

  it('tracks the active conversation only if it still exists', () => {
    const dir = tempDir()
    const store = new ConversationStore(dir)
    const conversation = store.create()
    store.setActiveId(conversation.id)
    expect(new ConversationStore(dir).getActiveId()).toBe(conversation.id)
    store.delete(conversation.id)
    expect(new ConversationStore(dir).getActiveId()).toBeNull()
  })

  it('rejects unsafe ids', () => {
    const store = new ConversationStore(tempDir())
    expect(store.get('../settings')).toBeUndefined()
    expect(store.delete('../../secrets')).toBe(false)
  })
})

describe('SettingsStore', () => {
  const secrets = { has: () => false } as unknown as SecretsStore

  it('provides provider-aware defaults', () => {
    const store = new SettingsStore(tempDir(), secrets)
    const settings = store.get()
    expect(settings.provider).toBe('openai')
    expect(settings.model).toBe('gpt-4.1-mini')
    expect(store.resolveBaseUrl()).toBe('https://api.openai.com/v1')
  })

  it('switches model and endpoint when the provider changes', () => {
    const store = new SettingsStore(tempDir(), secrets)
    store.update({ provider: 'anthropic' })
    expect(store.get().model).toBe('claude-sonnet-4-20250514')
    expect(store.resolveBaseUrl()).toBe('https://api.anthropic.com')

    store.update({ provider: 'ollama' })
    expect(store.resolveBaseUrl()).toBe('http://127.0.0.1:11434/v1')
    store.update({ baseUrl: 'http://127.0.0.1:1234/v1/' })
    expect(store.resolveBaseUrl()).toBe('http://127.0.0.1:1234/v1')
  })

  it('keeps free-auto only for OpenRouter and resets it on a provider switch', () => {
    const store = new SettingsStore(tempDir(), secrets)
    store.update({ provider: 'openrouter', modelMode: 'free-auto' })
    expect(store.get().modelMode).toBe('free-auto')
    store.update({ model: 'openrouter/manual-model', modelMode: 'manual' })
    expect(store.get().modelMode).toBe('manual')
    store.update({ provider: 'openai' })
    expect(store.get().modelMode).toBe('manual')
    store.update({ modelMode: 'free-auto' })
    expect(store.get().modelMode).toBe('manual')
  })

  it('clamps resource limits and persists them', () => {
    const dir = tempDir()
    const store = new SettingsStore(dir, secrets)
    store.update({ memoryMB: 999999, cpus: 0, diskGB: 3 })
    expect(store.get().memoryMB).toBe(16384)
    expect(store.get().cpus).toBe(1)
    expect(store.get().diskGB).toBe(8)
    const reopened = new SettingsStore(dir, secrets)
    expect(reopened.get().memoryMB).toBe(16384)
  })

  it('ignores unknown languages and providers', () => {
    const store = new SettingsStore(tempDir(), secrets)
    store.update({ language: 'fr' as never, provider: 'nope' as never })
    expect(store.get().language).toBe('en')
    expect(store.get().provider).toBe('openai')
  })
})
