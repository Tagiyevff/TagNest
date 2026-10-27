import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { Conversation, ConversationSummary } from '../../shared/types'
import { readJsonFile, writeJsonFileAtomic } from './json'
import { logger } from '../logger'

/**
 * Conversations are plain JSON files in the app data directory, one per task.
 * They are what the chat history panel reads on launch.
 */
export class ConversationStore {
  private readonly dir: string
  private readonly activeFile: string
  private cache = new Map<string, Conversation>()

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'conversations')
    this.activeFile = join(userDataDir, 'active-conversation.json')
    mkdirSync(this.dir, { recursive: true })
  }

  list(): ConversationSummary[] {
    const files = existsSync(this.dir) ? readdirSync(this.dir).filter((name) => name.endsWith('.json')) : []
    const summaries: ConversationSummary[] = []
    for (const file of files) {
      const conversation = this.get(file.replace(/\.json$/, ''))
      if (!conversation) continue
      summaries.push({
        id: conversation.id,
        title: conversation.title,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        messageCount: conversation.messages.length
      })
    }
    return summaries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  get(id: string): Conversation | undefined {
    const cached = this.cache.get(id)
    if (cached) return cached
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return undefined
    const file = join(this.dir, `${id}.json`)
    if (!existsSync(file)) return undefined
    const conversation = readJsonFile<Conversation | null>(file, null)
    if (!conversation) return undefined
    const normalized: Conversation = {
      ...conversation,
      messages: (conversation.messages ?? []).map((message) => ({
        ...message,
        toolCalls: message.toolCalls ?? []
      }))
    }
    this.cache.set(id, normalized)
    return normalized
  }

  create(): Conversation {
    const now = Date.now()
    const conversation: Conversation = {
      id: randomUUID(),
      title: 'New task',
      createdAt: now,
      updatedAt: now,
      messages: []
    }
    this.save(conversation)
    return conversation
  }

  save(conversation: Conversation): void {
    this.cache.set(conversation.id, conversation)
    writeJsonFileAtomic(join(this.dir, `${conversation.id}.json`), conversation)
  }

  delete(id: string): boolean {
    if (!/^[a-zA-Z0-9-]+$/.test(id)) return false
    const file = join(this.dir, `${id}.json`)
    this.cache.delete(id)
    if (!existsSync(file)) return false
    unlinkSync(file)
    logger.info('conversations', 'conversation deleted', id)
    return true
  }

  getActiveId(): string | null {
    const active = readJsonFile<{ id?: string }>(this.activeFile, {})
    if (!active.id) return null
    return this.get(active.id) ? active.id : null
  }

  setActiveId(id: string | null): void {
    writeJsonFileAtomic(this.activeFile, { id })
  }
}
