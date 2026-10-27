export type RiskLevel = 'safe' | 'elevated' | 'destructive'

export interface CommandAssessment {
  risk: RiskLevel
  approvalRequired: boolean
  reason?: string
}

interface Rule {
  pattern: RegExp
  risk: RiskLevel
  reason: string
}

/**
 * Command policy applies to anything the agent runs in the guest. The guest is
 * an unprivileged user, but it has passwordless sudo inside its own VM, so
 * privilege changes, package installs and destructive file operations must be
 * confirmed by the person at the keyboard.
 */
const RULES: Rule[] = [
  {
    pattern: /\brm\s+(-[^\s]*[rR][^\s]*|--recursive)\b|find\b[^\n]*\s-delete\b/i,
    risk: 'destructive',
    reason: 'Recursive file deletion inside the Linux guest.'
  },
  {
    pattern: /\bmkfs(\.\w+)?\b|\bdd\s+[^\n]*\bof=\/dev\/|\bshred\b/i,
    risk: 'destructive',
    reason: 'Low-level disk or device modification.'
  },
  {
    pattern: /\b(poweroff|reboot|halt|shutdown)\b/i,
    risk: 'destructive',
    reason: 'Shuts down or restarts the Linux environment.'
  },
  {
    pattern: /\bsudo\b|\bdoas\b|\bsu\s+-?\s*(root)?\b/i,
    risk: 'elevated',
    reason: 'Runs with administrator privileges inside the Linux guest.'
  },
  {
    pattern: /\bapk\s+(add|del|upgrade|fix|policy)\b|\bapt(-get)?\s+(install|remove|purge)\b|\bnpm\s+(install|i)\s+-g\b|\bpip3?\s+install\b/i,
    risk: 'elevated',
    reason: 'Installs or removes system software inside the guest.'
  },
  {
    pattern: /\b(rc-service|rc-update|systemctl|service)\b|\b(iptables|nft|ufw|mount|umount|modprobe|sysctl|adduser|useradd|passwd|visudo)\b/i,
    risk: 'elevated',
    reason: 'Changes system services, users, firewall or mounts inside the guest.'
  },
  {
    pattern: /\b(curl|wget)\b[^\n|]*\|\s*(sh|bash|ash|python3?)\b/i,
    risk: 'elevated',
    reason: 'Pipes a downloaded script straight into a shell.'
  },
  {
    pattern: /\bgit\s+push\b/i,
    risk: 'elevated',
    reason: 'Publishes code to a remote Git repository.'
  },
  {
    pattern: />\s*\/(etc|usr|bin|sbin|boot)\//i,
    risk: 'elevated',
    reason: 'Overwrites a system file inside the guest.'
  }
]

export function assessCommand(command: string, options: { approveSafe: boolean }): CommandAssessment {
  const trimmed = command.trim()
  if (!trimmed) return { risk: 'safe', approvalRequired: false }

  for (const rule of RULES) {
    if (rule.pattern.test(trimmed)) {
      return {
        risk: rule.risk,
        approvalRequired: true,
        reason: rule.reason
      }
    }
  }
  return { risk: 'safe', approvalRequired: !options.approveSafe }
}
