/**
 * Agent loop smoke test with a scripted OpenAI-compatible server.
 *
 * It does not call a hosted model. It proves that the agent runtime, approval
 * gate, real guest tool execution and conversation persistence work together.
 * Requires a running TagNest VM (started by `npm run smoke:linux` first, or
 * use the data directory created by that run).
 */
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { AgentRuntime } from '../src/main/agent/agent'
import { LinuxRuntime } from '../src/main/linux/runtime'
import { ConversationStore } from '../src/main/storage/conversations'
import { SettingsStore } from '../src/main/storage/settings'
import type { SecretsStore } from '../src/main/storage/secrets'
import type { AgentEvent, AppSettings } from '../src/shared/types'

const dataDir = resolve(process.env.TAGNEST_AGENT_SMOKE_DIR ?? '.local/agent-smoke-data')
const runtimeDataDir = resolve(process.env.TAGNEST_SMOKE_DIR ?? '.local/smoke-data')

const settings: AppSettings = {
  provider: 'custom',
  model: 'mock-model',
  modelMode: 'manual',
  baseUrl: 'http://127.0.0.1:0/v1',
  language: 'en',
  memoryMB: 3072,
  cpus: 2,
  diskGB: 20,
  autoStartLinux: false,
  approveSafeCommands: true,
  launchAtLogin: false
}

const server = createServer((request, response) => {
  const chunks: Buffer[] = []
  request.on('data', (chunk: Buffer) => chunks.push(chunk))
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as {
      messages?: Array<{ role: string; content?: string; tool_calls?: Array<{ id: string }> }>
    }
    const messages = body.messages ?? []
    const toolMessages = messages.filter((message) => message.role === 'tool')
    const lastTool = toolMessages[toolMessages.length - 1]?.content ?? ''
    let payload: unknown

    if (toolMessages.length === 0) {
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Creating the file inside Linux.',
              tool_calls: [
                {
                  id: 'call_write',
                  type: 'function',
                  function: {
                    name: 'write_file',
                    arguments: JSON.stringify({
                      path: 'agent-smoke.txt',
                      content: 'written by the TagNest agent loop\n'
                    })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 1) {
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_read',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: 'cat agent-smoke.txt && echo $$' })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 2) {
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_danger',
                  type: 'function',
                  function: {
                    name: 'run_command',
                    arguments: JSON.stringify({ command: 'rm -rf /home/tagnest/workspace/agent-smoke.txt' })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 3) {
      // Internet: fetch a real page through the guest's own connection.
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: 'Reading the page first.',
              tool_calls: [
                {
                  id: 'call_fetch',
                  type: 'function',
                  function: {
                    name: 'web_fetch',
                    arguments: JSON.stringify({ url: 'https://example.com/' })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 4) {
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_search',
                  type: 'function',
                  function: {
                    name: 'web_search',
                    arguments: JSON.stringify({ query: 'alpine linux official website' })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 5) {
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_browser_open',
                  type: 'function',
                  function: {
                    name: 'browser_open',
                    arguments: JSON.stringify({ url: 'https://example.com/' })
                  }
                }
              ]
            }
          }
        ]
      }
    } else if (toolMessages.length === 6) {
      // Read the page the browser just opened; the refs and text must be real.
      payload = {
        choices: [
          {
            finish_reason: 'tool_calls',
            message: {
              content: '',
              tool_calls: [
                {
                  id: 'call_browser_read',
                  type: 'function',
                  function: {
                    name: 'browser_read',
                    arguments: JSON.stringify({})
                  }
                }
              ]
            }
          }
        ]
      }
    } else {
      payload = {
        choices: [
          {
            finish_reason: 'stop',
            message: {
              content: `Finished. The read tool returned: ${lastTool.slice(0, 120).replace(/\n/g, ' ')}`
            }
          }
        ]
      }
    }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(payload))
  })
})

async function main(): Promise<void> {
  await new Promise<void>((resolveListen) => server.listen(0, '127.0.0.1', () => resolveListen()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock server failed')
  settings.baseUrl = `http://127.0.0.1:${address.port}/v1`

  const runtime = new LinuxRuntime(runtimeDataDir, () => settings)
  const conversations = new ConversationStore(dataDir)
  const secrets = { has: () => false, get: () => undefined } as unknown as SecretsStore
  const store = new SettingsStore(dataDir, secrets)
  store.update({ provider: 'custom', baseUrl: settings.baseUrl, model: 'mock-model' })

  const events: AgentEvent[] = []
  const agent = new AgentRuntime(conversations, store, secrets, runtime)
  agent.setEmitter((event) => {
    events.push(event)
    if (event.type === 'approval-request') {
      // Destructive commands must be blocked by the gate; everything else is
      // allowed so the loop can continue.
      const command = event.request.command ?? ''
      const deny = /^rm\s+-rf/.test(command)
      console.log(`[approval] ${command} -> ${deny ? 'denying' : 'approving in 300ms'}`)
      setTimeout(() => agent.respondApproval(event.request.id, !deny), 300)
    }
    if (event.type === 'task-state') console.log(`[task] ${event.task.status} ${event.task.activity ?? ''}`)
    if (event.type === 'notice') console.log(`[notice] ${event.message}`)
  })

  console.log('[runtime] starting/connecting to the guest…')
  await runtime.start()
  if (runtime.getState().phase !== 'running') {
    throw new Error(`Runtime unavailable: ${runtime.getState().error?.message ?? runtime.getState().message}`)
  }

  console.log('[agent] sending the task')
  const { conversationId } = await agent.send({
    text: 'Create a file, read it back, try to delete it, then fetch a page, search the web, open it in the browser and read the open page.'
  })

  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const task = agent.getTask()
    if (task.status === 'done' || task.status === 'error' || task.status === 'cancelled') break
    await new Promise((resolveWait) => setTimeout(resolveWait, 500))
  }

  const conversation = conversations.get(conversationId)
  const assistant = conversation?.messages.filter((message) => message.role === 'assistant').pop()
  const states = assistant?.toolCalls.map((call) => `${call.name}:${call.state}`) ?? []
  console.log(`[agent] task=${agent.getTask().status} tools=${states.join(', ')}`)
  console.log(`[agent] reply: ${assistant?.content ?? assistant?.error ?? '(none)'}`)

  const file = await runtime.exec('test -f /home/tagnest/workspace/agent-smoke.txt && echo present || echo missing')
  console.log(`[verify] file after denial: ${file.stdout.trim()}`)

  const toolCalls = conversation?.messages.flatMap((message) => message.toolCalls) ?? []
  const fetchOutput = toolCalls.find((call) => call.name === 'web_fetch')?.output ?? ''
  const searchOutput = toolCalls.find((call) => call.name === 'web_search')?.output ?? ''
  const browserOpenOutput = toolCalls.find((call) => call.name === 'browser_open')?.output ?? ''
  const browserReadOutput = toolCalls.find((call) => call.name === 'browser_read')?.output ?? ''
  // The real page must come back over HTTP with readable text, not a stub.
  const fetchedPage = /HTTP 200/.test(fetchOutput) && fetchOutput.length > 200
  const searchResults = /https:\/\/alpinelinux\.org/.test(searchOutput)
  // The browser must report the real page and its real interactive elements.
  const browserPage =
    /Title: Example Domain/.test(browserOpenOutput) &&
    /https:\/\/example\.com\//.test(browserOpenOutput) &&
    /Interactive elements \(\d+\):/.test(browserOpenOutput)
  const browserReread = /Title: Example Domain/.test(browserReadOutput)
  const browserRunning = await runtime.exec(
    "pgrep -u tagnest -x chromium >/dev/null 2>&1 && echo running || echo absent"
  )
  console.log(`[verify] web_fetch saw the real page: ${fetchedPage}`)
  console.log(`[verify] web_search returned real results: ${searchResults}`)
  console.log(`[verify] browser_open saw the real page: ${browserPage}`)
  console.log(`[verify] browser_read re-read it: ${browserReread}`)
  console.log(`[verify] chromium process in the guest: ${browserRunning.stdout.trim()}`)

  const ok =
    agent.getTask().status === 'done' &&
    states.some((state) => state === 'write_file:ok') &&
    states.some((state) => state === 'run_command:ok') &&
    states.some((state) => state === 'run_command:denied') &&
    states.some((state) => state === 'web_fetch:ok') &&
    states.some((state) => state === 'web_search:ok') &&
    states.some((state) => state === 'browser_open:ok') &&
    states.some((state) => state === 'browser_read:ok') &&
    file.stdout.includes('present') &&
    fetchedPage &&
    searchResults &&
    browserPage &&
    browserReread &&
    browserRunning.stdout.includes('running') &&
    Boolean(assistant?.content.includes('Finished'))

  await runtime.stop()
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  console.log(ok ? 'AGENT SMOKE PASSED' : 'AGENT SMOKE FAILED')
  process.exit(ok ? 0 : 1)
}

main().catch(async (error) => {
  console.error('AGENT SMOKE FAILED', error)
  server.close()
  process.exit(1)
})
