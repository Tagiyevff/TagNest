import type { DesktopPointer } from '../../shared/types'
import {
  createAppProject,
  listAppProjects,
  runAppProject,
  stopAppProject,
  testAppProject,
  type AppTemplate
} from '../apps/projects'
import type { GuestBrowser, BrowserPage } from '../linux/browser'
import { DESKTOP_HEIGHT, DESKTOP_WIDTH, GUEST_WORKSPACE } from '../linux/guest'
import type { GuestClient } from '../linux/ssh'
import { shellQuote } from '../linux/ssh'
import { assessCommand, type CommandAssessment } from './policy'
import type { ToolDefinition } from './providers/types'
import { resolveWorkspacePath } from './workspace'

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'run_command',
    description:
      'Run a shell command inside the local Linux guest and return its real stdout/stderr and exit code. Non-interactive commands only.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Shell command to run in the guest.' },
        cwd: {
          type: 'string',
          description: 'Working directory. Defaults to /home/tagnest/workspace.'
        },
        timeout_seconds: {
          type: 'number',
          description: 'Kill the command after this many seconds (default 120, max 600).'
        }
      },
      required: ['command']
    }
  },
  {
    name: 'read_file',
    description: 'Read a text file from the TagNest workspace. Returns real file contents.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path, absolute or relative to the workspace.' },
        start_line: { type: 'number', description: 'First line to return (1-based).' },
        end_line: { type: 'number', description: 'Last line to return (inclusive).' }
      },
      required: ['path']
    }
  },
  {
    name: 'write_file',
    description: 'Create or overwrite a text file in the TagNest workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Destination path in the workspace.' },
        content: { type: 'string', description: 'Complete file contents.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace exactly one occurrence of old_text with new_text in a workspace file. Fails if the text is missing or ambiguous.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File to edit.' },
        old_text: { type: 'string', description: 'Exact text to replace (must occur once).' },
        new_text: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'list_files',
    description: 'List files and folders in the TagNest workspace.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory path, default workspace root.' }
      }
    }
  },
  {
    name: 'search_files',
    description: 'Search file contents in the workspace with grep and return matching lines.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'Directory to search, default workspace root.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'system_info',
    description: 'Report real guest system information (distro, kernel, memory, disk, uptime).',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'start_process',
    description:
      'Start a long-running command in the background inside the guest (for example a dev server). Returns its PID and log path.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'Command to run in the background.' },
        name: { type: 'string', description: 'Short label used for the log file, e.g. "vite".' }
      },
      required: ['command']
    }
  },
  {
    name: 'list_processes',
    description: 'List running processes inside the guest.',
    parameters: {
      type: 'object',
      properties: { filter: { type: 'string', description: 'Optional text filter.' } }
    }
  },
  {
    name: 'app_create',
    description:
      'Create a real Linux app project in /home/tagnest/workspace/apps/<name> with starter files. Use this when the user asks you to build a Linux application: create the project, edit its files, test it with app_test, then run it with app_run. Template "web" is a small HTTP app (HTML/CSS/JS) served by Python http.server and shown in Firefox; template "cli" is a terminal app.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Project name: 1-32 lowercase letters, digits or hyphens (for example notes-app).'
        },
        title: { type: 'string', description: 'Human-readable app title shown in the window and on the page.' },
        template: { type: 'string', enum: ['web', 'cli'], description: 'Starter template: web or cli.' },
        port: {
          type: 'number',
          description: 'For web apps only: local port 1024-65535. Default 8080; use another port if it is taken.'
        }
      },
      required: ['name', 'template']
    }
  },
  {
    name: 'app_list',
    description:
      'List the app projects in /home/tagnest/workspace/apps with their template, port, running state and real URL.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'app_test',
    description:
      'Run the project test script (sh test.sh) inside a real Linux app project and return its actual output and exit code. Use it after editing app files; fix the code and test again until it passes.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App project name.' } },
      required: ['name']
    }
  },
  {
    name: 'app_run',
    description:
      'Run an app project in the Linux guest. Web apps start a local HTTP server and open the page in Firefox on the desktop; CLI apps open a terminal window. Returns the real URL, PID and startup result.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App project name.' } },
      required: ['name']
    }
  },
  {
    name: 'app_stop',
    description: 'Stop a running app project and its process group inside the Linux guest.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App project name.' } },
      required: ['name']
    }
  },
  {
    name: 'stop_process',
    description: 'Stop a guest process by PID (for example a server started earlier).',
    parameters: {
      type: 'object',
      properties: { pid: { type: 'number', description: 'Process ID to terminate.' } },
      required: ['pid']
    }
  },
  {
    name: 'desktop_click',
    description:
      'Move the mouse inside the Linux desktop and click. The user sees the AI cursor move. Coordinates are in guest pixels.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (0-1440).' },
        y: { type: 'number', description: 'Y coordinate (0-900).' },
        button: { type: 'number', description: '1 = left, 2 = middle, 3 = right.' },
        count: { type: 'number', description: 'Number of clicks: 1 = single, 2 = double click.' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'desktop_type',
    description: 'Type text into the focused application on the Linux desktop.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to type.' } },
      required: ['text']
    }
  },
  {
    name: 'desktop_key',
    description: 'Press a key or key combination on the Linux desktop (xdotool syntax, e.g. "Return", "ctrl+l").',
    parameters: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name or combination.' } },
      required: ['key']
    }
  },
  {
    name: 'launch_app',
    description:
      'Open an application window on the Linux desktop. Allowed apps: terminal, files, editor, image-viewer, browser, calculator.',
    parameters: {
      type: 'object',
      properties: {
        app: {
          type: 'string',
          description: 'One of: terminal, files, editor, image-viewer, browser, calculator.'
        }
      },
      required: ['app']
    }
  },
  {
    name: 'web_fetch',
    description:
      'Fetch an http(s) URL over the internet from inside the Linux guest and return the readable text of the page (HTML tags are stripped). Returns real network output, including errors.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Absolute http:// or https:// URL to fetch.' },
        max_bytes: {
          type: 'number',
          description: 'How much of the response to download (default 512000, max 2000000).'
        }
      },
      required: ['url']
    }
  },
  {
    name: 'web_search',
    description:
      'Search the web through DuckDuckGo from inside the guest and return up to 8 titles and URLs. Use it to find pages, then read them with web_fetch or open them with open_url.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Search query.' } },
      required: ['query']
    }
  },
  {
    name: 'open_url',
    description:
      'Open a URL in the visible TagNest browser on the Linux desktop. Reuses the same window and returns the loaded page. Prefer browser_open when you also want the page text and clickable elements in one step.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http:// or https:// URL to open.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_open',
    description:
      'Open a URL in the visible TagNest automation browser (Chromium) on the Linux desktop, wait for it to load, and return its real title, URL, visible text and numbered interactive elements. This reuses one window for the whole task, so the page you open is the page you later click and read.',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Absolute http:// or https:// URL to open.' } },
      required: ['url']
    }
  },
  {
    name: 'browser_read',
    description:
      'Read the page currently open in the TagNest browser: real title, URL, visible text and numbered interactive elements. Call it after navigation or after an action changes the page, before deciding what to click.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_click',
    description:
      'Click an element in the TagNest browser by its ref from browser_read, a CSS selector, or its visible text. Uses real mouse events at the element centre, so menus and JavaScript handlers behave like they do for a person. Returns the resulting URL and title.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Element number from the latest browser_read / browser_open result.' },
        selector: { type: 'string', description: 'CSS selector, if you know one.' },
        text: { type: 'string', description: 'Visible text of a link or button, case-insensitive.' }
      }
    }
  },
  {
    name: 'browser_type',
    description:
      'Type into a field in the TagNest browser, replacing its current contents with real keyboard input. Target it by ref, CSS selector, or nearby text; leave all targets empty to use the focused field. Optionally press Enter to submit.',
    parameters: {
      type: 'object',
      properties: {
        ref: { type: 'number', description: 'Field number from the latest browser_read / browser_open result.' },
        selector: { type: 'string', description: 'CSS selector for the field.' },
        text: { type: 'string', description: 'Text to type.' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false).' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture the page in the TagNest browser and look at it as an image. Use it when layout, images or visual state matter; use browser_read for text and element refs.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_back',
    description: 'Go back one page in the TagNest browser and return the page that is now open.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page in the TagNest browser and return the real scroll position.',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'up or down.' },
        amount: { type: 'number', description: 'Number of screens, default 1, max 10.' }
      },
      required: ['direction']
    }
  },
  {
    name: 'desktop_screenshot',
    description:
      'Take a real screenshot of the whole Linux desktop and look at it. The image comes back to you as an attachment, so you can see the browser, windows, dialogs and buttons before clicking. Take one after every action that changes the screen.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'desktop_move',
    description:
      'Move the mouse pointer inside the Linux desktop without clicking. The user sees the pointer move.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate in guest pixels (0-1439).' },
        y: { type: 'number', description: 'Y coordinate in guest pixels (0-899).' }
      },
      required: ['x', 'y']
    }
  },
  {
    name: 'desktop_scroll',
    description:
      'Scroll with the mouse wheel inside the Linux desktop, optionally at a given position (useful for long web pages).',
    parameters: {
      type: 'object',
      properties: {
        direction: { type: 'string', description: 'up, down, left or right.' },
        amount: { type: 'number', description: 'Wheel clicks, default 3, max 20.' },
        x: { type: 'number', description: 'Optional X coordinate to scroll at.' },
        y: { type: 'number', description: 'Optional Y coordinate to scroll at.' }
      },
      required: ['direction']
    }
  },
  {
    name: 'desktop_windows',
    description: 'List the windows currently open on the Linux desktop with their titles.',
    parameters: { type: 'object', properties: {} }
  },
  {
    name: 'desktop_focus',
    description:
      'Bring an open window to the front, matched by part of its title (for example "Mozilla Firefox" or "Terminal"). Use it before typing or clicking into an existing window.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Part of the window title (case-insensitive).' }
      },
      required: ['title']
    }
  }
]

export interface ToolCallDescription {
  title: string
  summary?: string
  command?: string
  assessment?: CommandAssessment
  pointer?: DesktopPointer
}

/** An image a tool produced; the agent loop forwards it to a vision-capable model. */
export interface ToolImage {
  mimeType: string
  base64: string
  width: number
  height: number
}

export interface ToolResult {
  output: string
  isError: boolean
  pointer?: DesktopPointer
  image?: ToolImage
}

const MAX_TOOL_OUTPUT = 24_000

export function describeToolCall(
  name: string,
  args: Record<string, unknown>,
  options: { approveSafe: boolean }
): ToolCallDescription {
  switch (name) {
    case 'run_command': {
      const command = String(args.command ?? '')
      const assessment = assessCommand(command, options)
      return {
        title: 'Run command in Linux',
        summary: command,
        command,
        assessment
      }
    }
    case 'start_process': {
      const command = String(args.command ?? '')
      const assessment = assessCommand(command, options)
      return {
        title: 'Start background process',
        summary: command,
        command,
        assessment
      }
    }
    case 'stop_process':
      return {
        title: 'Stop process',
        summary: `PID ${String(args.pid ?? '?')}`,
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'read_file':
      return { title: 'Read file', summary: String(args.path ?? ''), assessment: { risk: 'safe', approvalRequired: false } }
    case 'write_file':
      return {
        title: 'Write file',
        summary: String(args.path ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'edit_file':
      return {
        title: 'Edit file',
        summary: String(args.path ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'list_files':
      return { title: 'List files', summary: String(args.path ?? GUEST_WORKSPACE), assessment: { risk: 'safe', approvalRequired: false } }
    case 'search_files':
      return { title: 'Search files', summary: String(args.pattern ?? ''), assessment: { risk: 'safe', approvalRequired: false } }
    case 'system_info':
      return { title: 'Inspect Linux system', assessment: { risk: 'safe', approvalRequired: false } }
    case 'list_processes':
      return { title: 'List processes', assessment: { risk: 'safe', approvalRequired: false } }
    case 'app_create':
      return {
        title: 'Create a Linux app project',
        summary: `${String(args.name ?? '')} (${String(args.template ?? 'web')})`,
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'app_list':
      return { title: 'List Linux app projects', assessment: { risk: 'safe', approvalRequired: false } }
    case 'app_test':
      return {
        title: 'Test a Linux app project',
        summary: String(args.name ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'app_run':
      return {
        title: 'Run a Linux app project',
        summary: String(args.name ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'app_stop':
      return {
        title: 'Stop a Linux app project',
        summary: String(args.name ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'desktop_click': {
      const x = clampCoordinate(args.x, DESKTOP_WIDTH)
      const y = clampCoordinate(args.y, DESKTOP_HEIGHT)
      return {
        title: 'Click on the Linux desktop',
        summary: `${x}, ${y}`,
        assessment: { risk: 'safe', approvalRequired: false },
        pointer: { x, y, kind: 'click' }
      }
    }
    case 'desktop_type':
      return {
        title: 'Type on the Linux desktop',
        summary: previewText(String(args.text ?? '')),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'desktop_key':
      return {
        title: 'Press key on the Linux desktop',
        summary: String(args.key ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'launch_app':
      return {
        title: 'Open application',
        summary: String(args.app ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'web_fetch':
      return {
        title: 'Fetch a web page',
        summary: String(args.url ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'web_search':
      return {
        title: 'Search the web',
        summary: String(args.query ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'open_url':
    case 'browser_open':
      return {
        title: 'Open a page in the browser',
        summary: String(args.url ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'browser_read':
      return { title: 'Read the page', assessment: { risk: 'safe', approvalRequired: false } }
    case 'browser_click':
      return {
        title: 'Click on the page',
        summary:
          args.ref !== undefined
            ? `element ${String(args.ref)}`
            : String(args.text ?? args.selector ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'browser_type':
      return {
        title: 'Type on the page',
        summary: previewText(String(args.text ?? '')),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'browser_screenshot':
      return { title: 'Look at the page', assessment: { risk: 'safe', approvalRequired: false } }
    case 'browser_back':
      return { title: 'Go back one page', assessment: { risk: 'safe', approvalRequired: false } }
    case 'browser_scroll':
      return {
        title: 'Scroll the page',
        summary: `${String(args.direction ?? 'down')} × ${String(args.amount ?? 1)}`,
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'desktop_screenshot':
      return { title: 'Look at the screen', assessment: { risk: 'safe', approvalRequired: false } }
    case 'desktop_move': {
      const x = clampCoordinate(args.x, DESKTOP_WIDTH)
      const y = clampCoordinate(args.y, DESKTOP_HEIGHT)
      return {
        title: 'Move the mouse',
        summary: `${x}, ${y}`,
        assessment: { risk: 'safe', approvalRequired: false },
        pointer: { x, y, kind: 'click' }
      }
    }
    case 'desktop_scroll':
      return {
        title: 'Scroll the desktop',
        summary: `${String(args.direction ?? 'down')} × ${String(args.amount ?? 3)}`,
        assessment: { risk: 'safe', approvalRequired: false }
      }
    case 'desktop_windows':
      return { title: 'List desktop windows', assessment: { risk: 'safe', approvalRequired: false } }
    case 'desktop_focus':
      return {
        title: 'Focus a window',
        summary: String(args.title ?? ''),
        assessment: { risk: 'safe', approvalRequired: false }
      }
    default:
      return { title: name, assessment: { risk: 'elevated', approvalRequired: true, reason: 'Unknown tool.' } }
  }
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  guest: GuestClient,
  options: { signal?: AbortSignal; workspace?: string; browser?: GuestBrowser }
): Promise<ToolResult> {
  try {
    switch (name) {
      case 'run_command':
        return await runCommand(args, guest, options.signal)
      case 'read_file':
        return await readFileTool(args, guest)
      case 'write_file':
        return await writeFileTool(args, guest)
      case 'edit_file':
        return await editFileTool(args, guest)
      case 'list_files':
        return await listFilesTool(args, guest)
      case 'search_files':
        return await searchFilesTool(args, guest, options.signal)
      case 'system_info':
        return await systemInfoTool(guest)
      case 'start_process':
        return await startProcessTool(args, guest, options.signal)
      case 'list_processes':
        return await listProcessesTool(args, guest)
      case 'app_create':
        return await appCreateTool(args, guest)
      case 'app_list':
        return await appListTool(guest)
      case 'app_test':
        return await appTestTool(args, guest)
      case 'app_run':
        return await appRunTool(args, guest)
      case 'app_stop':
        return await appStopTool(args, guest)
      case 'stop_process':
        return await stopProcessTool(args, guest)
      case 'desktop_click':
        return await desktopClickTool(args, guest)
      case 'desktop_type':
        return await desktopTypeTool(args, guest)
      case 'desktop_key':
        return await desktopKeyTool(args, guest)
      case 'launch_app':
        return await launchAppTool(args, guest, options.browser)
      case 'desktop_screenshot':
        return await desktopScreenshotTool(guest)
      case 'desktop_move':
        return await desktopMoveTool(args, guest)
      case 'desktop_scroll':
        return await desktopScrollTool(args, guest)
      case 'desktop_windows':
        return await desktopWindowsTool(guest)
      case 'desktop_focus':
        return await desktopFocusTool(args, guest)
      case 'web_fetch':
        return await webFetchTool(args, guest, options.signal)
      case 'web_search':
        return await webSearchTool(args, guest, options.signal)
      case 'open_url':
        return await openUrlTool(args, guest, options.browser)
      case 'browser_open':
        return await browserOpenTool(args, requireBrowser(options.browser))
      case 'browser_read':
        return await browserReadTool(requireBrowser(options.browser))
      case 'browser_click':
        return await browserClickTool(args, requireBrowser(options.browser))
      case 'browser_type':
        return await browserTypeTool(args, requireBrowser(options.browser))
      case 'browser_screenshot':
        return await browserScreenshotTool(requireBrowser(options.browser))
      case 'browser_back':
        return await browserBackTool(requireBrowser(options.browser))
      case 'browser_scroll':
        return await browserScrollTool(args, requireBrowser(options.browser))
      default:
        return { output: `Unknown tool: ${name}`, isError: true }
    }
  } catch (error) {
    return { output: error instanceof Error ? error.message : String(error), isError: true }
  }
}

async function runCommand(
  args: Record<string, unknown>,
  guest: GuestClient,
  signal?: AbortSignal
): Promise<ToolResult> {
  const command = String(args.command ?? '').trim()
  if (!command) return { output: 'command is required', isError: true }
  const timeout = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 120)) * 1000
  const cwd = typeof args.cwd === 'string' && args.cwd.trim() ? args.cwd.trim() : GUEST_WORKSPACE
  const result = await guest.exec(command, { cwd, timeoutMs: timeout, signal })
  return {
    output: formatExecOutput(result),
    isError: result.exitCode !== 0 || result.timedOut
  }
}

async function readFileTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(String(args.path ?? ''))
  if (!resolved.ok) return { output: resolved.error ?? 'Invalid path', isError: true }
  const content = await guest.readFile(resolved.path)
  if (content.includes('\0')) return { output: 'This looks like a binary file.', isError: true }
  const lines = content.split('\n')
  const start = Math.max(1, Number(args.start_line) || 1)
  const end = Math.min(lines.length, Number(args.end_line) || lines.length)
  const slice = lines.slice(start - 1, end)
  return {
    output: `File: ${resolved.path}\nLines ${start}-${end} of ${lines.length}\n\n${slice.join('\n')}`,
    isError: false
  }
}

async function writeFileTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(String(args.path ?? ''))
  if (!resolved.ok) return { output: resolved.error ?? 'Invalid path', isError: true }
  const content = String(args.content ?? '')
  if (Buffer.byteLength(content) > 1024 * 1024) {
    return { output: 'Refusing to write more than 1 MB in one call.', isError: true }
  }
  const dir = resolved.path.split('/').slice(0, -1).join('/')
  if (dir) {
    const mkdir = await guest.exec(`mkdir -p ${shellQuote(dir)}`, { timeoutMs: 15000 })
    if (mkdir.exitCode !== 0) return { output: mkdir.stderr || 'Could not create directory', isError: true }
  }
  const existing = await guest.stat(resolved.path)
  await guest.writeFile(resolved.path, content)
  const lines = content.split('\n').length
  return {
    output: `${existing ? 'Updated' : 'Created'} ${resolved.path} (${Buffer.byteLength(content)} bytes, ${lines} lines).`,
    isError: false
  }
}

async function editFileTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(String(args.path ?? ''))
  if (!resolved.ok) return { output: resolved.error ?? 'Invalid path', isError: true }
  const oldText = String(args.old_text ?? '')
  const newText = String(args.new_text ?? '')
  if (!oldText) return { output: 'old_text is required', isError: true }
  const content = await guest.readFile(resolved.path)
  const occurrences = content.split(oldText).length - 1
  if (occurrences === 0) {
    return { output: `old_text was not found in ${resolved.path}. Read the file and use the exact text.`, isError: true }
  }
  if (occurrences > 1) {
    return {
      output: `old_text occurs ${occurrences} times in ${resolved.path}; include more context so the edit is unambiguous.`,
      isError: true
    }
  }
  const updated = content.replace(oldText, newText)
  await guest.writeFile(resolved.path, updated)
  return {
    output: `Edited ${resolved.path} (${occurrences} replacement). File is now ${Buffer.byteLength(updated)} bytes.`,
    isError: false
  }
}

async function listFilesTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const resolved = resolveWorkspacePath(String(args.path ?? GUEST_WORKSPACE))
  if (!resolved.ok) return { output: resolved.error ?? 'Invalid path', isError: true }
  const entries = await guest.list(resolved.path)
  if (entries.length === 0) return { output: `${resolved.path} is empty.`, isError: false }
  const formatted = entries
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'directory' ? -1 : 1))
    .slice(0, 300)
    .map(
      (entry) =>
        `${entry.type === 'directory' ? 'd' : entry.type === 'symlink' ? 'l' : '-'} ${entry.name}${
          entry.type === 'directory' ? '/' : ''
        } (${formatBytes(entry.size)}, ${new Date(entry.modified).toISOString().slice(0, 16).replace('T', ' ')})`
    )
  return { output: `Directory: ${resolved.path}\n${formatted.join('\n')}`, isError: false }
}

async function searchFilesTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  signal?: AbortSignal
): Promise<ToolResult> {
  const pattern = String(args.pattern ?? '')
  if (!pattern) return { output: 'pattern is required', isError: true }
  const resolved = resolveWorkspacePath(String(args.path ?? GUEST_WORKSPACE))
  if (!resolved.ok) return { output: resolved.error ?? 'Invalid path', isError: true }
  const result = await guest.exec(
    `grep -rnI --exclude-dir=.git --exclude-dir=node_modules -- ${shellQuote(pattern)} ${shellQuote(resolved.path)} | head -n 120`,
    { timeoutMs: 60000, signal }
  )
  if (result.exitCode === 1 && !result.stdout.trim()) {
    return { output: `No matches for ${pattern} in ${resolved.path}.`, isError: false }
  }
  return {
    output: trimOutput(result.stdout || result.stderr || 'No output.'),
    isError: result.exitCode !== 0 && result.exitCode !== 1
  }
}

async function systemInfoTool(guest: GuestClient): Promise<ToolResult> {
  const result = await guest.exec(
    [
      'echo "hostname: $(hostname)"',
      'echo "distro: $(cat /etc/alpine-release 2>/dev/null || cat /etc/os-release | head -2)"',
      'echo "kernel: $(uname -srm)"',
      'echo "user: $(id)"',
      'echo "cpus: $(nproc)"',
      'free -m | head -2',
      'df -h / /home/tagnest 2>/dev/null | tail -2',
      'uptime'
    ].join('; '),
    { timeoutMs: 20000 }
  )
  return { output: trimOutput(result.stdout || result.stderr), isError: result.exitCode !== 0 }
}

async function startProcessTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  signal?: AbortSignal
): Promise<ToolResult> {
  const command = String(args.command ?? '').trim()
  if (!command) return { output: 'command is required', isError: true }
  const rawName = String(args.name ?? 'process')
  const name = rawName.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 40) || 'process'
  const log = `${GUEST_WORKSPACE}/.tagnest-logs/${name}.log`
  const result = await guest.exec(
    `mkdir -p ${GUEST_WORKSPACE}/.tagnest-logs && cd ${GUEST_WORKSPACE} && nohup sh -c ${shellQuote(
      command
    )} > ${shellQuote(log)} 2>&1 & echo $!`,
    { timeoutMs: 20000, signal }
  )
  const pid = result.stdout.trim().split('\n').pop()
  if (!pid || !/^\d+$/.test(pid)) {
    return { output: `Could not start the process. ${result.stderr}`, isError: true }
  }
  return {
    output: `Started "${name}" with PID ${pid} in ${GUEST_WORKSPACE}.\nLog: ${log}\nUse read_file or run_command (tail) to inspect its output.`,
    isError: false
  }
}

async function listProcessesTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const filter = String(args.filter ?? '')
  const result = await guest.exec('ps aux 2>/dev/null || ps -ef', { timeoutMs: 20000 })
  let lines = result.stdout.split('\n')
  const header = lines.slice(0, 1)
  lines = lines.slice(1)
  if (filter) lines = lines.filter((line) => line.includes(filter))
  const shown = lines.slice(0, 60)
  return {
    output: trimOutput([...header, ...shown].join('\n')).concat(
      lines.length > shown.length ? `\n… ${lines.length - shown.length} more processes` : ''
    ),
    isError: result.exitCode !== 0
  }
}

async function stopProcessTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const pid = Number(args.pid)
  if (!Number.isInteger(pid) || pid <= 1) return { output: 'A valid PID greater than 1 is required.', isError: true }
  const result = await guest.exec(`kill ${pid} 2>&1 && echo stopped`, { timeoutMs: 15000 })
  return { output: result.stdout.trim() || result.stderr.trim(), isError: result.exitCode !== 0 }
}

async function desktopClickTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const x = clampCoordinate(args.x, DESKTOP_WIDTH)
  const y = clampCoordinate(args.y, DESKTOP_HEIGHT)
  const button = Math.min(3, Math.max(1, Number(args.button) || 1))
  const count = Math.min(3, Math.max(1, Math.round(Number(args.count) || 1)))
  const result = await guest.exec(
    `DISPLAY=:1 xdotool mousemove --sync ${x} ${y} click --repeat ${count} --delay 120 ${button}`,
    { timeoutMs: 15000 }
  )
  if (result.exitCode !== 0) {
    return { output: `Could not click: ${result.stderr.trim() || 'xdotool failed'}`, isError: true, pointer: { x, y, kind: 'click' } }
  }
  return {
    output: `${count > 1 ? 'Double-clicked' : 'Clicked'} at (${x}, ${y}) on the Linux desktop.`,
    isError: false,
    pointer: { x, y, kind: 'click' }
  }
}

async function desktopTypeTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const text = String(args.text ?? '')
  if (!text) return { output: 'text is required', isError: true }
  if (text.length > 2000) return { output: 'Refusing to type more than 2000 characters.', isError: true }
  const result = await guest.exec(
    `DISPLAY=:1 xdotool type --delay 12 --clearmodifiers ${shellQuote(text)}`,
    { timeoutMs: 60000 }
  )
  return {
    output:
      result.exitCode === 0
        ? `Typed ${text.length} characters into the focused Linux window.`
        : `Could not type: ${result.stderr.trim()}`,
    isError: result.exitCode !== 0
  }
}

async function desktopKeyTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const key = String(args.key ?? '').trim()
  if (!/^[A-Za-z0-9+_-]{1,20}$/.test(key)) {
    return { output: 'Invalid key. Use xdotool syntax such as Return or ctrl+l.', isError: true }
  }
  const result = await guest.exec(`DISPLAY=:1 xdotool key --clearmodifiers ${key}`, { timeoutMs: 15000 })
  return {
    output: result.exitCode === 0 ? `Pressed ${key} on the Linux desktop.` : `Could not press key: ${result.stderr.trim()}`,
    isError: result.exitCode !== 0
  }
}

/**
 * Validates an absolute http(s) URL before it is passed to curl or the guest
 * browser helper. Everything that reaches the guest shell is quoted, but a
 * tight allow-list keeps obviously malformed or hostile input out.
 */
export function validateHttpUrl(raw: string): string | null {
  const url = String(raw ?? '').trim()
  if (!url) return 'url is required.'
  if (!/^https?:\/\//i.test(url)) return 'Only absolute http:// or https:// URLs are supported.'
  if (url.length > 2048) return 'The URL is too long.'
  if (/[\s<>"'`\\]/.test(url)) return 'The URL contains whitespace or quote characters that are not allowed.'
  return null
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  copy: '©',
  reg: '®',
  trade: '™',
  lsquo: '‘',
  rsquo: '’',
  ldquo: '“',
  rdquo: '”',
  bull: '•',
  middot: '·'
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return ''
  try {
    return String.fromCodePoint(code)
  } catch {
    return ''
  }
}

export function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match)
}

/**
 * Turns an HTML document into readable text for the model: scripts, styles and
 * markup are removed, block boundaries become line breaks, entities decoded.
 */
export function htmlToText(html: string): string {
  const text = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|section|article|header|footer|main|nav|li|tr|h[1-6]|blockquote|pre|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  return decodeEntities(text)
    .replace(/\r/g, '')
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export interface WebResult {
  title: string
  url: string
}

function resolveResultUrl(href: string): string | null {
  const redirect = /[?&]uddg=([^&]+)/i.exec(href)
  if (redirect) {
    try {
      const decoded = decodeURIComponent(redirect[1])
      return /^https?:\/\//i.test(decoded) ? decoded : null
    } catch {
      return null
    }
  }
  if (/^https?:\/\/\S+$/i.test(href) && !/duckduckgo\.com/i.test(href)) return href
  return null
}

/**
 * Extracts real result URLs and titles from the DuckDuckGo lite HTML page.
 * Only absolute http(s) targets survive; DuckDuckGo's own links are skipped.
 */
export function parseSearchResults(html: string, limit = 8): WebResult[] {
  const results: WebResult[] = []
  const anchors = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null
  while ((match = anchors.exec(html)) !== null && results.length < limit) {
    const href = decodeEntities(match[1])
    const title = htmlToText(match[2]).replace(/\s+/g, ' ').trim()
    const url = resolveResultUrl(href)
    if (!url || !title) continue
    if (results.some((result) => result.url === url)) continue
    results.push({ title: title.slice(0, 140), url })
  }
  return results
}

async function webFetchTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  signal?: AbortSignal
): Promise<ToolResult> {
  const url = String(args.url ?? '').trim()
  const problem = validateHttpUrl(url)
  if (problem) return { output: problem, isError: true }
  const limit = Math.min(2_000_000, Math.max(4096, Math.round(Number(args.max_bytes) || 512_000)))
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  const outFile = `/tmp/tagnest-fetch-${stamp}`
  const errFile = `/tmp/tagnest-fetch-${stamp}.err`
  const command = [
    'rc=0',
    `meta=$(curl -sS -L --max-time 25 -A 'TagNest/0.1' -o ${shellQuote(outFile)} -w '%{http_code}|%{content_type}|%{size_download}' ${shellQuote(
      url
    )} 2>${shellQuote(errFile)}) || rc=$?`,
    'echo "META rc=$rc $meta"',
    `[ $rc -ne 0 ] && echo "FETCH_FAILED $(head -c 400 ${shellQuote(errFile)} 2>/dev/null)"`,
    `head -c ${limit} ${shellQuote(outFile)} 2>/dev/null`,
    `rm -f ${shellQuote(outFile)} ${shellQuote(errFile)}`
  ].join('; ')

  const result = await guest.exec(command, { timeoutMs: 45_000, signal })
  const raw = result.stdout
  const newline = raw.indexOf('\n')
  const header = (newline === -1 ? raw : raw.slice(0, newline)).trim()
  const body = newline === -1 ? '' : raw.slice(newline + 1)
  const parsed = /^META rc=(\d+)\s*(.*)$/.exec(header)
  if (!parsed) {
    return {
      output: `Fetching ${url} produced no response. ${trimOutput(result.stderr || raw || 'No output.')}`,
      isError: true
    }
  }
  const rc = Number(parsed[1])
  const [status, contentType = '', sizeText = ''] = parsed[2].split('|')
  if (rc !== 0) {
    const detail = body.includes('FETCH_FAILED') ? body.trim() : `curl exit code ${rc}`
    return { output: `Fetching ${url} failed: ${detail}`, isError: true }
  }
  if (!/^2\d\d$/.test(status)) {
    return {
      output: `${url} responded with HTTP ${status || 'unknown'}${contentType ? ` (${contentType})` : ''}.`,
      isError: true
    }
  }
  if (/^(image|audio|video|font)\//i.test(contentType) || /octet-stream|zip|pdf|gzip/i.test(contentType)) {
    return {
      output: `${url} returned binary content (${contentType || 'unknown type'}, ${sizeText} bytes). Use open_url to view it in the browser.`,
      isError: false
    }
  }
  const looksLikeHtml = /html|xml|svg/i.test(contentType) || /^\s*<(!doctype|html|head|body)/i.test(body)
  const text = looksLikeHtml ? htmlToText(body) : decodeEntities(body)
  if (!text.trim()) {
    return { output: `${url} returned an empty body (HTTP ${status}, ${sizeText} bytes).`, isError: false }
  }
  return {
    output: trimOutput(
      `Source: ${url}\nHTTP ${status} · ${contentType || 'unknown type'} · ${sizeText} bytes\n\n${text}`
    ),
    isError: false
  }
}

async function webSearchTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  signal?: AbortSignal
): Promise<ToolResult> {
  const query = String(args.query ?? '').trim()
  if (!query) return { output: 'query is required', isError: true }
  if (query.length > 300) return { output: 'Keep the search query under 300 characters.', isError: true }
  const outFile = `/tmp/tagnest-search-${Date.now()}`
  const command = [
    'rc=0',
    `curl -sS -L --max-time 25 -A 'Mozilla/5.0 (X11; Linux x86_64) TagNest/0.1' --data-urlencode ${shellQuote(
      `q=${query}`
    )} -o ${shellQuote(outFile)} https://lite.duckduckgo.com/lite/ || rc=$?`,
    'echo "META rc=$rc"',
    `head -c 600000 ${shellQuote(outFile)} 2>/dev/null`,
    `rm -f ${shellQuote(outFile)}`
  ].join('; ')

  const result = await guest.exec(command, { timeoutMs: 45_000, signal })
  const raw = result.stdout
  const newline = raw.indexOf('\n')
  const header = (newline === -1 ? raw : raw.slice(0, newline)).trim()
  const html = newline === -1 ? '' : raw.slice(newline + 1)
  const rc = Number(/^META rc=(\d+)/.exec(header)?.[1] ?? 1)
  if (rc !== 0) {
    return { output: `The web search failed (curl exit ${rc}). ${trimOutput(result.stderr || '')}`, isError: true }
  }
  const results = parseSearchResults(html)
  if (results.length === 0) {
    return {
      output: `No results for "${query}". DuckDuckGo may be rate-limiting this connection; retry, or fetch a known URL directly with web_fetch.`,
      isError: true
    }
  }
  return {
    output: results.map((entry, index) => `${index + 1}. ${entry.title}\n   ${entry.url}`).join('\n'),
    isError: false
  }
}

async function openUrlTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  browser?: GuestBrowser
): Promise<ToolResult> {
  const url = String(args.url ?? '').trim()
  const problem = validateHttpUrl(url)
  if (problem) return { output: problem, isError: true }
  if (browser) {
    try {
      const page = await browser.open(url)
      return {
        output: `Opened ${url} in the TagNest browser on the Linux desktop.\nTitle: ${page.title || '(none)'}\nURL: ${page.url}`,
        isError: false
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      const fallback = await openUrlInFirefox(url, guest)
      return {
        output: `The automation browser could not open the page: ${reason}\n\n${fallback.output}\n\nBrowser click/type tools will not work until the automation browser is available.`,
        isError: fallback.isError
      }
    }
  }
  return openUrlInFirefox(url, guest)
}

async function openUrlInFirefox(url: string, guest: GuestClient): Promise<ToolResult> {
  const helper = await guest.exec('test -x /usr/local/bin/tagnest-open && echo ready || echo missing', {
    timeoutMs: 15_000
  })
  if (!helper.stdout.includes('ready')) {
    return {
      output: 'The browser launcher is missing in this guest. Stop and start the Linux environment from the panel to install it.',
      isError: true
    }
  }
  const result = await guest.exec(`/usr/local/bin/tagnest-open ${shellQuote(url)}`, { timeoutMs: 45_000 })
  if (result.exitCode === 0 && result.stdout.includes('opened')) {
    return {
      output: `Opened ${url} in Firefox. The page is loading on the Linux desktop shown in TagNest.`,
      isError: false
    }
  }
  return {
    output: `Could not open ${url}: ${trimOutput((result.stderr || result.stdout).trim() || 'unknown error')}`,
    isError: true
  }
}

function requireBrowser(browser?: GuestBrowser): GuestBrowser {
  if (!browser) {
    throw new Error('The TagNest browser controller is unavailable. Start the Linux environment and try again.')
  }
  return browser
}

function formatBrowserPage(page: BrowserPage): string {
  const elements = page.elements
    .map(
      (element) =>
        `${element.ref}. <${element.tag}${element.type ? ` type=${element.type}` : ''}> ${element.label}${
          element.href ? ` → ${element.href}` : ''
        }${element.checked ? ' (checked)' : ''}`
    )
    .join('\n')
  // Put the refs before the page text: a long article can otherwise fill the
  // output budget and hide the elements the model needs to act on.
  return trimOutput(
    [
      `Title: ${page.title || '(none)'}`,
      `URL: ${page.url}`,
      '',
      `Interactive elements (${page.elements.length}):`,
      elements || '(none found)',
      '',
      'Visible text:',
      page.text || '(empty)'
    ].join('\n')
  )
}

async function browserOpenTool(args: Record<string, unknown>, browser: GuestBrowser): Promise<ToolResult> {
  const url = String(args.url ?? '').trim()
  const problem = validateHttpUrl(url)
  if (problem) return { output: problem, isError: true }
  const page = await browser.open(url)
  return {
    output: `${formatBrowserPage(page)}\n\nThe page is visible in the Linux panel. Use the refs above with browser_click and browser_type.`,
    isError: false
  }
}

async function browserReadTool(browser: GuestBrowser): Promise<ToolResult> {
  const page = await browser.read()
  return { output: formatBrowserPage(page), isError: false }
}

async function browserClickTool(
  args: Record<string, unknown>,
  browser: GuestBrowser
): Promise<ToolResult> {
  const ref = args.ref === undefined ? undefined : Math.round(Number(args.ref))
  const selector = typeof args.selector === 'string' ? args.selector.trim() : ''
  const text = typeof args.text === 'string' ? args.text.trim() : ''
  if (ref === undefined && !selector && !text) {
    return { output: 'Provide a ref from browser_read, a CSS selector, or the visible text to click.', isError: true }
  }
  if (ref !== undefined && (!Number.isInteger(ref) || ref <= 0)) {
    return { output: 'ref must be a positive element number from browser_read.', isError: true }
  }
  const result = await browser.click({ ref, selector: selector || undefined, text: text || undefined })
  return {
    output: `Clicked <${result.tag}> "${result.label || '(no label)'}".\nNow at: ${result.url || '(unknown URL)'}\nTitle: ${result.title || '(none)'}\nUse browser_read if the page changed and you need the new elements.`,
    isError: false
  }
}

async function browserTypeTool(args: Record<string, unknown>, browser: GuestBrowser): Promise<ToolResult> {
  const text = String(args.text ?? '')
  if (!text) return { output: 'text is required', isError: true }
  if (text.length > 10_000) return { output: 'Refusing to type more than 10000 characters.', isError: true }
  const ref = args.ref === undefined ? undefined : Math.round(Number(args.ref))
  if (ref !== undefined && (!Number.isInteger(ref) || ref <= 0)) {
    return { output: 'ref must be a positive element number from browser_read.', isError: true }
  }
  const result = await browser.type({
    ref,
    selector: typeof args.selector === 'string' && args.selector.trim() ? args.selector.trim() : undefined,
    text,
    submit: args.submit === true
  })
  return {
    output: `Typed ${text.length} characters into <${result.label || 'focused field'}>.\nField value: ${
      result.value || '(empty)'
    }\nPage: ${result.url}${args.submit === true ? '\nPressed Enter to submit.' : ''}`,
    isError: false
  }
}

async function browserScreenshotTool(browser: GuestBrowser): Promise<ToolResult> {
  const shot = await browser.screenshot()
  const buffer = Buffer.from(shot.base64, 'base64')
  if (buffer.length === 0) return { output: 'The browser returned an empty screenshot.', isError: true }
  if (buffer.length > MAX_SCREENSHOT_BYTES) {
    return {
      output: `The browser screenshot is too large to send (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`,
      isError: true
    }
  }
  return {
    output: `Screenshot of the page (${shot.width}×${shot.height}, ${Math.round(buffer.length / 1024)} KB PNG). The image is attached.`,
    isError: false,
    image: {
      mimeType: 'image/png',
      base64: shot.base64,
      width: shot.width,
      height: shot.height
    }
  }
}

async function browserBackTool(browser: GuestBrowser): Promise<ToolResult> {
  const page = await browser.back()
  return { output: formatBrowserPage(page), isError: false }
}

async function browserScrollTool(args: Record<string, unknown>, browser: GuestBrowser): Promise<ToolResult> {
  const direction = String(args.direction ?? 'down').toLowerCase() === 'up' ? 'up' : 'down'
  const amount = Math.min(10, Math.max(1, Math.round(Number(args.amount) || 1)))
  const position = await browser.scroll(direction, amount)
  return {
    output: `Scrolled ${direction} by ${amount} screen${amount === 1 ? '' : 's'}. Real scroll position: ${position}px.`,
    isError: false
  }
}

const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024

/**
 * Captures the real guest framebuffer and returns it as an image for the model.
 * The capture is exactly what the user sees in the Linux panel, so click
 * coordinates the model derives from it line up with the framebuffer.
 */
async function desktopScreenshotTool(guest: GuestClient): Promise<ToolResult> {
  const path = `/tmp/tagnest-screen-${Date.now()}.png`
  try {
    const capture = await guest.exec(`DISPLAY=:1 xfce4-screenshooter -f -s ${shellQuote(path)}`, {
      timeoutMs: 30_000
    })
    if (capture.exitCode !== 0) {
      return {
        output: `Could not capture the screen: ${(capture.stderr || capture.stdout).trim() || 'the screenshot command failed'}`,
        isError: true
      }
    }
    const buffer = await guest.readBuffer(path)
    if (buffer.length === 0) return { output: 'The screen capture produced an empty image.', isError: true }
    if (buffer.length > MAX_SCREENSHOT_BYTES) {
      return {
        output: `The screenshot is too large to send (${(buffer.length / 1024 / 1024).toFixed(1)} MB).`,
        isError: true
      }
    }
    return {
      output: `Screenshot of the ${DESKTOP_WIDTH}×${DESKTOP_HEIGHT} Linux desktop (${Math.round(
        buffer.length / 1024
      )} KB PNG). The image is attached to this result. Click coordinates are in this same frame.`,
      isError: false,
      image: {
        mimeType: 'image/png',
        base64: buffer.toString('base64'),
        width: DESKTOP_WIDTH,
        height: DESKTOP_HEIGHT
      }
    }
  } finally {
    await guest.exec(`rm -f ${shellQuote(path)}`, { timeoutMs: 10_000 }).catch(() => undefined)
  }
}

async function desktopMoveTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const x = clampCoordinate(args.x, DESKTOP_WIDTH)
  const y = clampCoordinate(args.y, DESKTOP_HEIGHT)
  const result = await guest.exec(`DISPLAY=:1 xdotool mousemove --sync ${x} ${y}`, { timeoutMs: 15_000 })
  return {
    output:
      result.exitCode === 0
        ? `Moved the mouse pointer to (${x}, ${y}).`
        : `Could not move the mouse: ${result.stderr.trim()}`,
    isError: result.exitCode !== 0,
    pointer: { x, y, kind: 'click' }
  }
}

async function desktopScrollTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const direction = String(args.direction ?? 'down').toLowerCase()
  const wheel = ({ up: 4, down: 5, left: 6, right: 7 } as Record<string, number>)[direction]
  if (!wheel) return { output: 'direction must be up, down, left or right.', isError: true }
  const amount = Math.min(20, Math.max(1, Math.round(Number(args.amount) || 3)))
  const parts = ['DISPLAY=:1 xdotool']
  let pointer: DesktopPointer | undefined
  if (args.x !== undefined && args.y !== undefined) {
    const x = clampCoordinate(args.x, DESKTOP_WIDTH)
    const y = clampCoordinate(args.y, DESKTOP_HEIGHT)
    parts.push(`mousemove --sync ${x} ${y}`)
    pointer = { x, y, kind: 'click' }
  }
  parts.push(`click --repeat ${amount} --delay 40 ${wheel}`)
  const result = await guest.exec(parts.join(' '), { timeoutMs: 20_000 })
  return {
    output:
      result.exitCode === 0
        ? `Scrolled ${direction} by ${amount} wheel click${amount === 1 ? '' : 's'}.`
        : `Could not scroll: ${result.stderr.trim()}`,
    isError: result.exitCode !== 0,
    pointer
  }
}

interface GuestWindow {
  id: string
  title: string
}

async function listVisibleWindows(guest: GuestClient): Promise<GuestWindow[]> {
  const script =
    'for id in $(DISPLAY=:1 xdotool search --onlyvisible --name \'.*\' 2>/dev/null); do ' +
    'name=$(DISPLAY=:1 xdotool getwindowname "$id" 2>/dev/null); ' +
    'if [ -n "$name" ]; then echo "$id|$name"; fi; done'
  const result = await guest.exec(script, { timeoutMs: 20_000 })
  const windows: GuestWindow[] = []
  for (const line of result.stdout.split('\n')) {
    const separator = line.indexOf('|')
    if (separator <= 0) continue
    const id = line.slice(0, separator).trim()
    const title = line.slice(separator + 1).trim()
    if (!/^\d+$/.test(id) || !title) continue
    windows.push({ id, title })
  }
  return windows
}

async function desktopWindowsTool(guest: GuestClient): Promise<ToolResult> {
  const windows = await listVisibleWindows(guest)
  if (windows.length === 0) {
    return { output: 'No titled windows are open on the desktop right now.', isError: false }
  }
  return {
    output: `Open windows:\n${windows
      .slice(0, 30)
      .map((entry) => `${entry.id} · ${entry.title}`)
      .join('\n')}`,
    isError: false
  }
}

async function desktopFocusTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const wanted = String(args.title ?? '').trim().toLowerCase()
  if (!wanted) return { output: 'title is required', isError: true }
  const windows = await listVisibleWindows(guest)
  const match = windows.find((entry) => entry.title.toLowerCase().includes(wanted))
  if (!match) {
    return {
      output: `No window title contains "${String(args.title ?? '')}". Open windows: ${
        windows.map((entry) => entry.title).join(' · ') || 'none'
      }`,
      isError: true
    }
  }
  const result = await guest.exec(
    `DISPLAY=:1 xdotool windowactivate --sync ${match.id} && DISPLAY=:1 xdotool windowfocus ${match.id}`,
    { timeoutMs: 15_000 }
  )
  return {
    output:
      result.exitCode === 0
        ? `Focused the window "${match.title}" (${match.id}).`
        : `Found "${match.title}" but could not focus it: ${result.stderr.trim()}`,
    isError: result.exitCode !== 0
  }
}

const APP_COMMANDS: Record<string, string> = {
  terminal: 'xfce4-terminal',
  files: 'thunar',
  editor: 'mousepad',
  'image-viewer': 'ristretto',
  browser: 'firefox',
  calculator: 'galculator'
}

async function launchAppTool(
  args: Record<string, unknown>,
  guest: GuestClient,
  browser?: GuestBrowser
): Promise<ToolResult> {
  const app = String(args.app ?? '').toLowerCase()
  if (app === 'browser' && browser) {
    try {
      await browser.open('about:blank')
      return { output: 'Opened the TagNest browser on the Linux desktop. It is ready for browser_open.', isError: false }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      return { output: `Could not open the TagNest browser: ${reason}`, isError: true }
    }
  }
  const command = APP_COMMANDS[app]
  if (!command) {
    return {
      output: `Unknown app "${app}". Available: ${Object.keys(APP_COMMANDS).join(', ')}.`,
      isError: true
    }
  }
  const check = await guest.exec(`command -v ${command} >/dev/null 2>&1 && echo yes || echo no`, { timeoutMs: 10000 })
  if (!check.stdout.includes('yes')) {
    return {
      output: `${app} is not installed in this Linux environment. You can install it with run_command after approval, or open an available app.`,
      isError: true
    }
  }
  if (app === 'browser') {
    // The helper resolves the running session's D-Bus address so the browser
    // attaches to the visible XFCE session instead of failing silently.
    const opened = await guest.exec('/usr/local/bin/tagnest-open about:blank', { timeoutMs: 45_000 })
    const ok = opened.exitCode === 0 && opened.stdout.includes('opened')
    return {
      output: ok
        ? 'Opened the browser on the Linux desktop.'
        : `Could not open the browser: ${trimOutput((opened.stderr || opened.stdout).trim() || 'unknown error')}`,
      isError: !ok
    }
  }
  const result = await guest.exec(
    `cd ${GUEST_WORKSPACE} && DISPLAY=:1 nohup ${command} >/dev/null 2>&1 & echo $!`,
    { timeoutMs: 15000 }
  )
  return {
    output: result.exitCode === 0 ? `Opened ${app} on the Linux desktop.` : `Could not open ${app}.`,
    isError: result.exitCode !== 0
  }
}

async function appCreateTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const template = String(args.template ?? 'web') as AppTemplate
  const result = await createAppProject(guest, {
    name: String(args.name ?? ''),
    title: typeof args.title === 'string' ? args.title : undefined,
    template,
    port: args.port === undefined ? undefined : Number(args.port)
  })
  return { output: result.message, isError: !result.ok }
}

async function appListTool(guest: GuestClient): Promise<ToolResult> {
  const projects = await listAppProjects(guest)
  if (projects.length === 0) {
    return {
      output:
        'No app projects yet. Create one with app_create (template "web" or "cli") in /home/tagnest/workspace/apps.',
      isError: false
    }
  }
  return {
    output: projects
      .map((project) => {
        const state = project.running ? `running (PID ${project.pid})` : 'stopped'
        return `${project.name} · ${project.title} · ${project.template}${
          project.port ? ` · port ${project.port}` : ''
        } · ${state}${project.url ? ` · ${project.url}` : ''}`
      })
      .join('\n'),
    isError: false
  }
}

async function appTestTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const result = await testAppProject(guest, String(args.name ?? ''))
  return {
    output: `${result.message}\ncommand: ${result.command}\n${result.output}`,
    isError: !result.ok
  }
}

async function appRunTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const result = await runAppProject(guest, String(args.name ?? ''))
  return { output: result.message, isError: !result.ok }
}

async function appStopTool(args: Record<string, unknown>, guest: GuestClient): Promise<ToolResult> {
  const result = await stopAppProject(guest, String(args.name ?? ''))
  return { output: result.message, isError: !result.ok }
}

function formatExecOutput(result: {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  truncated: boolean
  durationMs: number
}): string {
  const parts: string[] = []
  parts.push(`exit code: ${result.exitCode ?? 'unknown'} (${result.durationMs} ms)`)
  if (result.timedOut) parts.push('NOTE: command hit the timeout and was terminated.')
  if (result.truncated) parts.push('NOTE: output was truncated.')
  if (result.stdout.trim()) parts.push(`stdout:\n${result.stdout.trimEnd()}`)
  if (result.stderr.trim()) parts.push(`stderr:\n${result.stderr.trimEnd()}`)
  if (!result.stdout.trim() && !result.stderr.trim()) parts.push('(no output)')
  return trimOutput(parts.join('\n'))
}

function trimOutput(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT) return output
  return `${output.slice(0, MAX_TOOL_OUTPUT)}\n… output truncated (${output.length - MAX_TOOL_OUTPUT} characters omitted)`
}

function clampCoordinate(value: unknown, max: number): number {
  const number = Math.round(Number(value))
  if (!Number.isFinite(number)) return 0
  return Math.min(max - 1, Math.max(0, number))
}

function previewText(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}…` : text
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
