/**
 * Removes likely credentials before anything is written to a log file or
 * surfaced in the UI. This is intentionally conservative: when in doubt the
 * value is replaced.
 */
const PATTERNS: Array<[RegExp, string]> = [
  [/\b(sk|rk|pk)-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/\bsk-ant-[A-Za-z0-9_-]{12,}\b/g, '[redacted-key]'],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, '[redacted-key]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi, 'Bearer [redacted]'],
  [/(authorization["']?\s*[:=]\s*["']?)[^\s"',}]{8,}/gi, '$1[redacted]'],
  [/((?:api[_-]?key|apikey|token|secret|password)["']?\s*[:=]\s*["']?)[^\s"',}]{4,}/gi, '$1[redacted]'],
  [/([?&](?:key|token|apikey)=)[^\s&"']{4,}/gi, '$1[redacted]']
]

export function redactSecrets(input: string): string {
  let output = input
  for (const [pattern, replacement] of PATTERNS) {
    output = output.replace(pattern, replacement)
  }
  return output
}
