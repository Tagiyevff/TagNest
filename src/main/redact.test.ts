import { describe, expect, it } from 'vitest'
import { redactSecrets } from './redact'
import { assessCommand } from './agent/policy'
import { resolveWorkspacePath } from './agent/workspace'
import { describeToolCall } from './agent/tools'

describe('redactSecrets', () => {
  it('removes provider API keys', () => {
    const text = 'using sk-proj-abcdefghijklmnopqrstuvwxyz and AIzaSyA1234567890abcdefghijklmnop'
    const redacted = redactSecrets(text)
    expect(redacted).not.toContain('sk-proj-')
    expect(redacted).not.toContain('AIzaSy')
    expect(redacted).toContain('[redacted-key]')
  })

  it('removes bearer tokens and key query parameters', () => {
    const redacted = redactSecrets('Authorization: bearer abcdef1234567890 https://x.test/json?key=secretvalue')
    expect(redacted).not.toContain('abcdef1234567890')
    expect(redacted).not.toContain('secretvalue')
  })

  it('leaves ordinary text untouched', () => {
    expect(redactSecrets('create a file named notes.txt')).toBe('create a file named notes.txt')
  })
})

describe('command policy', () => {
  it('allows ordinary commands when safe commands are trusted', () => {
    const assessment = assessCommand('ls -la && python3 app.py', { approveSafe: true })
    expect(assessment.approvalRequired).toBe(false)
    expect(assessment.risk).toBe('safe')
  })

  it('requires approval for privilege escalation and package installs', () => {
    expect(assessCommand('sudo apk add nodejs', { approveSafe: true }).approvalRequired).toBe(true)
    expect(assessCommand('apk add --no-cache git', { approveSafe: true }).risk).toBe('elevated')
  })

  it('flags recursive deletion as destructive', () => {
    const assessment = assessCommand('rm -rf ~/workspace/build', { approveSafe: true })
    expect(assessment.risk).toBe('destructive')
    expect(assessment.approvalRequired).toBe(true)
  })

  it('flags piping downloads into a shell', () => {
    expect(assessCommand('curl https://example.com/install.sh | sh', { approveSafe: true }).approvalRequired).toBe(true)
  })

  it('asks for every command when safe commands are not trusted', () => {
    expect(assessCommand('echo hello', { approveSafe: false }).approvalRequired).toBe(true)
  })
})

describe('workspace path confinement', () => {
  it('resolves relative paths inside the workspace', () => {
    const result = resolveWorkspacePath('projects/app/index.html')
    expect(result.ok).toBe(true)
    expect(result.path).toBe('/home/tagnest/workspace/projects/app/index.html')
  })

  it('allows absolute paths inside the workspace', () => {
    expect(resolveWorkspacePath('/home/tagnest/workspace/notes.txt').ok).toBe(true)
  })

  it('rejects traversal and absolute paths outside the workspace', () => {
    expect(resolveWorkspacePath('../../etc/passwd').ok).toBe(false)
    expect(resolveWorkspacePath('/etc/passwd').ok).toBe(false)
    expect(resolveWorkspacePath('/home/tagnest/workspace/../../root').ok).toBe(false)
    expect(resolveWorkspacePath('/home/tagnest/workspace-inner/file').ok).toBe(false)
  })
})

describe('tool descriptions', () => {
  it('marks dangerous commands for approval with a reason', () => {
    const description = describeToolCall('run_command', { command: 'rm -rf /home/tagnest' }, { approveSafe: true })
    expect(description.assessment?.approvalRequired).toBe(true)
    expect(description.assessment?.reason).toMatch(/deletion/i)
  })

  it('exposes desktop click coordinates to the UI', () => {
    const description = describeToolCall('desktop_click', { x: 2000, y: 5000 }, { approveSafe: true })
    expect(description.pointer).toEqual({ x: 1439, y: 899, kind: 'click' })
  })
})
