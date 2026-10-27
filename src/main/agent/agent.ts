import { randomUUID } from 'node:crypto'
import type {
  AgentEvent,
  ApprovalRequest,
  ChatMessage,
  Conversation,
  TaskState,
  ToolCallView
} from '../../shared/types'
import { PROVIDERS } from '../../shared/types'
import type { ConversationStore } from '../storage/conversations'
import type { SecretsStore } from '../storage/secrets'
import type { SettingsStore } from '../storage/settings'
import { logger } from '../logger'
import { redactSecrets } from '../redact'
import type { ExecResult } from '../linux/ssh'
import type { LinuxRuntime } from '../linux/runtime'
import { buildSystemPrompt, fallbackSummary } from './prompts'
import { createProviderAdapter, ProviderError, type AgentTurn, type ProviderToolCall } from './providers'
import { describeToolCall, executeTool, TOOL_DEFINITIONS, type ToolImage, type ToolResult } from './tools'

const MAX_ROUNDS = 12
const APPROVAL_TIMEOUT_MS = 10 * 60 * 1000

interface ActiveRun {
  conversationId: string
  messageId: string
  controller: AbortController
}

interface PendingApproval {
  request: ApprovalRequest
  resolve: (approved: boolean) => void
  timer: NodeJS.Timeout
}

/**
 * Agent orchestration: one task at a time, real tool execution in the guest,
 * explicit approvals, cancellation, and durable conversation state.
 */
export class AgentRuntime {
  private active: ActiveRun | null = null
  private task: TaskState = { conversationId: null, status: 'idle' }
  private readonly pendingApprovals = new Map<string, PendingApproval>()

  private emit: (event: AgentEvent) => void = () => undefined

  constructor(
    private readonly conversations: ConversationStore,
    private readonly settings: SettingsStore,
    private readonly secrets: SecretsStore,
    private readonly runtime: LinuxRuntime
  ) {}

  setEmitter(emit: (event: AgentEvent) => void): void {
    this.emit = emit
  }

  getTask(): TaskState {
    return { ...this.task }
  }

  isBusy(): boolean {
    return this.active !== null
  }

  async send(input: { conversationId?: string; text: string }): Promise<{ conversationId: string }> {
    if (this.active) throw new Error('TagNest is already working on a task. Stop it before sending another message.')
    const conversation = input.conversationId
      ? this.conversations.get(input.conversationId)
      : this.conversations.create()
    if (!conversation) throw new Error('That conversation no longer exists.')

    const userMessage: ChatMessage = {
      id: randomUUID(),
      role: 'user',
      content: input.text.trim(),
      createdAt: Date.now(),
      toolCalls: []
    }
    conversation.messages.push(userMessage)
    if (!conversation.title || conversation.title === 'New task') {
      conversation.title = truncateTitle(input.text)
    }
    this.touch(conversation)

    const assistant = this.newAssistantMessage()
    conversation.messages.push(assistant)

    this.conversations.save(conversation)
    this.emit({ type: 'conversation', conversation })
    void this.run(conversation, assistant)
    return { conversationId: conversation.id }
  }

  async retry(conversationId: string): Promise<void> {
    if (this.active) throw new Error('TagNest is already working on a task.')
    const conversation = this.conversations.get(conversationId)
    if (!conversation) throw new Error('That conversation no longer exists.')
    while (conversation.messages.length > 0) {
      const last = conversation.messages[conversation.messages.length - 1]
      if (last.role === 'assistant' && (last.error || last.cancelled || !last.content.trim())) {
        conversation.messages.pop()
      } else {
        break
      }
    }
    if (!conversation.messages.some((message) => message.role === 'user')) {
      throw new Error('There is nothing to retry in this conversation.')
    }
    const assistant = this.newAssistantMessage()
    conversation.messages.push(assistant)
    this.touch(conversation)
    this.emit({ type: 'conversation', conversation })
    void this.run(conversation, assistant)
  }

  cancel(): void {
    if (!this.active) return
    this.setTask({ status: 'cancelling', activity: 'Stopping…' })
    this.active.controller.abort()
    for (const [id, pending] of this.pendingApprovals) {
      this.resolveApproval(id, false, pending)
    }
  }

  respondApproval(requestId: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(requestId)
    if (!pending) return
    this.resolveApproval(requestId, approved, pending)
  }

  dispose(): void {
    this.cancel()
    for (const [id, pending] of this.pendingApprovals) {
      this.resolveApproval(id, false, pending)
    }
  }

  private async run(conversation: Conversation, assistant: ChatMessage): Promise<void> {
    const controller = new AbortController()
    this.active = { conversationId: conversation.id, messageId: assistant.id, controller }
    const settings = this.settings.get()
    const modelInfo = PROVIDERS.find((provider) => provider.id === settings.provider)
    this.setTask({
      conversationId: conversation.id,
      status: 'planning',
      activity: 'Planning the task',
      model: settings.model,
      startedAt: Date.now()
    })

    try {
      if (this.runtime.getState().phase !== 'running') {
        throw new ProviderError(
          'The TagNest Linux environment is not running.',
          undefined,
          'Start Linux in the right-hand panel, then send the message again.'
        )
      }
      const apiKey = this.secrets.get(settings.provider)
      if (modelInfo?.requiresApiKey && !apiKey) {
        throw new ProviderError(
          `No ${modelInfo.label} API key is configured.`,
          undefined,
          'Open Settings and add an API key for the selected provider.'
        )
      }
      if (!settings.model) {
        throw new ProviderError('No model is selected.', undefined, 'Open Settings and choose a model.')
      }

      const adapter = createProviderAdapter(settings.provider)
      const baseUrl = this.settings.resolveBaseUrl()
      const history = this.historyTurns(conversation, assistant.id)
      const system = buildSystemPrompt()
      let text = assistant.content
      let rounds = 0

      while (rounds < MAX_ROUNDS) {
        rounds += 1
        if (controller.signal.aborted) throw new AbortError()
        this.setTask({ status: 'running', activity: rounds === 1 ? 'Thinking' : 'Reviewing tool results' })

        const turns = [...history]
        const response = await adapter.complete({
          model: settings.model,
          system,
          turns,
          tools: TOOL_DEFINITIONS,
          baseUrl,
          apiKey,
          signal: controller.signal
        })

        if (response.text) {
          text = text ? `${text}\n\n${response.text}` : response.text
          assistant.content = text
          this.persistMessage(conversation, assistant)
        }

        if (response.toolCalls.length === 0) break

        const results: Array<{ turn: AgentTurn; image?: ToolImage }> = []
        for (const call of response.toolCalls) {
          if (controller.signal.aborted) throw new AbortError()
          const output = await this.executeCall(conversation, assistant, call, controller.signal)
          if (output.turn.role === 'tool' && output.turn.isError) {
            // A failed tool should not hide the reason from the next round.
            this.setTask({ status: 'running', activity: 'A tool call failed, reading the error' })
          }
          results.push(output)
        }

        const images = results
          .map((result) => result.image)
          .filter((image): image is ToolImage => Boolean(image))
        if (images.length > 0) {
          // Vision: strict gateways reject a `user` turn directly after a `tool`
          // turn, so a round that produced a screenshot is represented as an
          // assistant message plus one user message carrying the image and the
          // textual tool output instead of tool_call/tool pairs.
          history.push({
            role: 'assistant',
            text: response.text || 'I looked at the Linux desktop.',
            toolCalls: []
          })
          const textResults = results
            .map((result) => (result.turn.role === 'tool' ? `${result.turn.name}: ${result.turn.content}` : ''))
            .filter(Boolean)
          history.push({
            role: 'user',
            text: `Tool results from that step:\n${textResults.join('\n')}`,
            images
          })
        } else {
          history.push({ role: 'assistant', text: response.text, toolCalls: response.toolCalls })
          for (const result of results) history.push(result.turn)
        }
      }

      if (rounds >= MAX_ROUNDS) {
        text = text
          ? `${text}\n\n_Stopped after ${MAX_ROUNDS} tool rounds to avoid a runaway loop._`
          : `Stopped after ${MAX_ROUNDS} tool rounds to avoid a runaway loop.`
      }

      assistant.content = text.trim() ? text.trim() : fallbackSummary(assistant.toolCalls)
      assistant.model = settings.model
      this.touch(conversation)
      this.persistMessage(conversation, assistant)
      this.setTask({ status: 'done', activity: undefined })
    } catch (error) {
      if (error instanceof AbortError || controller.signal.aborted || isAbortError(error)) {
        assistant.cancelled = true
        assistant.content = assistant.content || 'Task cancelled.'
        this.touch(conversation)
        this.persistMessage(conversation, assistant)
        this.setTask({ status: 'cancelled', activity: undefined })
        this.emit({ type: 'notice', level: 'info', message: 'Task cancelled.' })
      } else {
        const message = error instanceof Error ? error.message : String(error)
        const hint = error instanceof ProviderError ? error.hint : undefined
        assistant.error = redactSecrets(hint ? `${message} ${hint}` : message)
        if (!assistant.content.trim()) assistant.content = ''
        this.touch(conversation)
        this.persistMessage(conversation, assistant)
        this.setTask({ status: 'error', activity: undefined })
        logger.error('agent', 'task failed', error)
        this.emit({ type: 'notice', level: 'error', message: redactSecrets(message) })
      }
    } finally {
      this.active = null
      for (const [id, pending] of this.pendingApprovals) {
        this.resolveApproval(id, false, pending)
      }
      this.emit({ type: 'task-state', task: this.getTask() })
    }
  }

  private async executeCall(
    conversation: Conversation,
    assistant: ChatMessage,
    call: ProviderToolCall,
    signal: AbortSignal
  ): Promise<{ turn: AgentTurn; image?: ToolImage }> {
    const settings = this.settings.get()
    const description = describeToolCall(call.name, call.arguments, {
      approveSafe: settings.approveSafeCommands
    })
    const view: ToolCallView = {
      id: call.id,
      name: call.name,
      title: description.title,
      summary: description.summary,
      command: description.command,
      state: description.assessment?.approvalRequired ? 'awaiting-approval' : 'running',
      startedAt: Date.now(),
      pointer: description.pointer
    }
    assistant.toolCalls.push(view)
    this.persistMessage(conversation, assistant)

    if (description.assessment?.approvalRequired) {
      const request: ApprovalRequest = {
        id: randomUUID(),
        toolName: call.name,
        title: description.title,
        command: description.command ?? description.summary,
        reason: description.assessment.reason ?? 'This operation needs your confirmation.',
        requestedAt: Date.now()
      }
      this.setTask({ status: 'waiting-approval', activity: 'Waiting for your approval' })
      const approved = await this.awaitApproval(request, signal)
      if (!approved) {
        view.state = 'denied'
        view.output = 'Denied by the user. This operation was not executed.'
        view.finishedAt = Date.now()
        this.persistMessage(conversation, assistant)
        this.setTask({ status: 'running', activity: 'Continuing without that operation' })
        return {
          turn: {
            role: 'tool',
            toolCallId: call.id,
            name: call.name,
            content:
              'The user denied this operation. It was not executed. Do not retry it silently; explain what is blocked.',
            isError: true
          }
        }
      }
      view.state = 'running'
      this.persistMessage(conversation, assistant)
    }

    this.setTask({
      status: 'running',
      activity: describeActivity(description.title, description.summary)
    })

    let result: ToolResult
    try {
      result = await executeTool(call.name, call.arguments, this.runtime.getGuest(), { signal })
    } catch (error) {
      result = { output: error instanceof Error ? error.message : String(error), isError: true }
    }

    view.state = signal.aborted ? 'cancelled' : result.isError ? 'error' : 'ok'
    view.output = redactSecrets(signal.aborted ? result.output || 'Cancelled by the user.' : result.output)
    view.pointer = result.pointer ?? view.pointer
    view.finishedAt = Date.now()
    this.persistMessage(conversation, assistant)
    this.setTask({ status: 'running', activity: 'Thinking about the result' })

    return {
      turn: {
        role: 'tool',
        toolCallId: call.id,
        name: call.name,
        content: view.output,
        isError: result.isError
      },
      image: result.image
    }
  }

  private awaitApproval(request: ApprovalRequest, signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const finish = (approved: boolean): void => {
        this.finishApproval(request.id, approved)
      }
      const timer = setTimeout(() => finish(false), APPROVAL_TIMEOUT_MS)
      this.pendingApprovals.set(request.id, {
        request,
        resolve: (approved) => {
          clearTimeout(timer)
          resolve(approved)
        },
        timer
      })
      const onAbort = (): void => finish(false)
      signal.addEventListener('abort', onAbort, { once: true })
      this.emit({ type: 'approval-request', request })
    })
  }

  private resolveApproval(id: string, approved: boolean, pending: PendingApproval): void {
    this.pendingApprovals.delete(id)
    clearTimeout(pending.timer)
    pending.resolve(approved)
    this.emit({ type: 'approval-resolved', requestId: id, approved })
  }

  /** Handles the timeout path without double-resolving. */
  private finishApproval(id: string, approved: boolean): void {
    const pending = this.pendingApprovals.get(id)
    if (!pending) return
    this.resolveApproval(id, approved, pending)
  }

  private historyTurns(conversation: Conversation, assistantId: string): AgentTurn[] {
    const turns: AgentTurn[] = []
    for (const message of conversation.messages) {
      if (message.id === assistantId) break
      if (message.role === 'user') {
        turns.push({ role: 'user', text: message.content })
      } else if (message.content.trim()) {
        turns.push({ role: 'assistant', text: message.content, toolCalls: [] })
      }
    }
    return turns.slice(-20)
  }

  private newAssistantMessage(): ChatMessage {
    return {
      id: randomUUID(),
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
      toolCalls: []
    }
  }

  private touch(conversation: Conversation): void {
    conversation.updatedAt = Date.now()
    this.conversations.save(conversation)
  }

  private persistMessage(conversation: Conversation, message: ChatMessage): void {
    conversation.updatedAt = Date.now()
    this.conversations.save(conversation)
    this.emit({ type: 'message-updated', conversationId: conversation.id, message })
    this.emit({ type: 'conversation', conversation })
  }

  private setTask(patch: Partial<TaskState>): void {
    this.task = { ...this.task, ...patch }
    this.emit({ type: 'task-state', task: this.getTask() })
  }
}

class AbortError extends Error {
  constructor() {
    super('Cancelled')
    this.name = 'AbortError'
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || /aborted|abort/i.test(error.message))
}

function truncateTitle(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim()
  return single.length > 52 ? `${single.slice(0, 49)}…` : single || 'New task'
}

function describeActivity(title: string, summary?: string): string {
  if (!summary) return title
  const short = summary.length > 70 ? `${summary.slice(0, 67)}…` : summary
  return `${title}: ${short}`
}

export type { ExecResult }
