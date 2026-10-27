import type { JSX } from 'react'

/**
 * Small, safe markdown-ish renderer for assistant replies.
 * Supports fenced code blocks, inline code, bold text, links and bullet lists.
 * It never uses dangerouslySetInnerHTML.
 */
export function MarkdownText({ text }: { text: string }): JSX.Element {
  const blocks = text.split(/(```[\s\S]*?```)/g).filter((block) => block.length > 0)
  return (
    <div className="markdown">
      {blocks.map((block, index) => {
        if (block.startsWith('```')) {
          const match = block.match(/^```([^\n]*)\n?([\s\S]*?)```$/)
          const code = match?.[2] ?? block.slice(3, -3)
          return (
            <pre className="code-block" key={index}>
              <code>{code.replace(/\n$/, '')}</code>
            </pre>
          )
        }
        return (
          <div className="text-block" key={index}>
            {renderLines(block)}
          </div>
        )
      })}
    </div>
  )
}

function renderLines(text: string): JSX.Element[] {
  return text.split('\n').map((line, index) => {
    const trimmed = line.trim()
    if (!trimmed) return <div className="blank-line" key={index} />
    const bullet = /^[-*]\s+/.test(trimmed)
    const numbered = /^\d+\.\s+/.test(trimmed)
    const content = bullet || numbered ? trimmed.replace(/^([-*]|\d+\.)\s+/, '') : line
    return (
      <div className={bullet || numbered ? 'list-line' : 'text-line'} key={index}>
        {bullet ? <span className="bullet">•</span> : null}
        {numbered ? <span className="bullet">{trimmed.match(/^\d+/)?.[0]}.</span> : null}
        <span>{renderInline(content)}</span>
      </div>
    )
  })
}

function renderInline(text: string): Array<string | JSX.Element> {
  const tokens = text.split(/(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g)
  return tokens.map((token, index) => {
    if (!token) return ''
    if (token.startsWith('`') && token.endsWith('`')) {
      return (
        <code className="inline-code" key={index}>
          {token.slice(1, -1)}
        </code>
      )
    }
    if (token.startsWith('**') && token.endsWith('**')) {
      return <strong key={index}>{token.slice(2, -2)}</strong>
    }
    const link = token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/)
    if (link) {
      return (
        <a href={link[2]} key={index} target="_blank" rel="noreferrer">
          {link[1]}
        </a>
      )
    }
    return token
  })
}
