import { describe, expect, it } from 'vitest'
import { htmlToText, parseSearchResults, validateHttpUrl } from './tools'

describe('validateHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(validateHttpUrl('https://example.com/docs?a=1')).toBeNull()
    expect(validateHttpUrl('http://127.0.0.1:5173/')).toBeNull()
  })

  it('rejects missing, non-http and shell-hostile input', () => {
    expect(validateHttpUrl('')).toMatch(/required/)
    expect(validateHttpUrl('example.com')).toMatch(/http/)
    expect(validateHttpUrl('javascript:alert(1)')).toMatch(/http/)
    expect(validateHttpUrl('https://example.com/a b')).toMatch(/whitespace/)
    expect(validateHttpUrl('https://example.com/`id`')).toMatch(/whitespace/)
    expect(validateHttpUrl(`https://example.com/'; rm -rf /`)).toMatch(/whitespace/)
  })
})

describe('htmlToText', () => {
  it('drops scripts, styles and tags, keeps readable text', () => {
    const html = `<!doctype html><html><head><title>Docs</title>
      <style>body { color: red }</style>
      <script>window.tracker = 1</script></head>
      <body><h1>Getting started</h1><p>Install & run.</p>
      <ul><li>first</li><li>second</li></ul></body></html>`
    const text = htmlToText(html)
    expect(text).toContain('Getting started')
    expect(text).toContain('Install & run.')
    expect(text).toContain('first')
    expect(text).not.toContain('tracker')
    expect(text).not.toContain('color: red')
    expect(text).not.toContain('<')
  })

  it('decodes numeric entities and collapses blank space', () => {
    expect(htmlToText('<p>caf&#233; &#x1F600;</p>')).toBe('café \u{1F600}')
    expect(htmlToText('<div>a</div><div>b</div>')).toBe('a\nb')
  })
})

describe('parseSearchResults', () => {
  const litePage = `
    <html><body>
    <a rel="nofollow" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&rut=abc">Python 3 documentation</a>
    <a rel="nofollow" href="https://example.org/page">Example & Co</a>
    <a href="https://duckduckgo.com/about">About DuckDuckGo</a>
    <a href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2F&rut=dup">Python 3 documentation</a>
    <a href="/lite/?q=other">navigation</a>
    </body></html>`

  it('returns real titles and absolute URLs, skipping the search site itself', () => {
    const results = parseSearchResults(litePage)
    expect(results.map((entry) => entry.url)).toEqual([
      'https://docs.python.org/3/',
      'https://example.org/page'
    ])
    expect(results[0].title).toBe('Python 3 documentation')
    expect(results[1].title).toBe('Example & Co')
  })

  it('honours the result limit and returns nothing for a block page', () => {
    expect(parseSearchResults(litePage, 1)).toHaveLength(1)
    expect(parseSearchResults('<html><body>please solve this captcha</body></html>')).toEqual([])
  })
})